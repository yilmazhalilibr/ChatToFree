import { sitesForPhase, resolveSite, NEEDS_FOREGROUND } from "./config.js";
import { Limits, parseResetTime } from "./limits.js";
import { sharedDeepSeek, hasAuth } from "./deepseek-http.js";

/** "step 2 round 1" -> "step", "verify 3" -> "verify", "plan-retry" -> "plan". */
export function phaseOf(label = "") {
  const l = String(label).toLowerCase();
  for (const p of ["design", "critique", "plan", "step", "verify"]) if (l.startsWith(p)) return p;
  return "step";
}

/** "prepare 0.3s · type 0.1s · first token 3.2s · stream 9.8s" from the extension's timings. */
export function fmtTimings(t) {
  if (!t) return "";
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const parts = [];
  if (t.prepare != null) parts.push(`prepare ${s(t.prepare)}`);
  if (t.type != null) parts.push(`type ${s(t.type)}`);
  if (t.send != null) parts.push(`send ${s(t.send)}`);
  if (t.firstToken != null) parts.push(`first token ${s(t.firstToken)}`);
  if (t.stream != null) parts.push(`stream ${s(t.stream)}`);
  return parts.join(" · ");
}

/**
 * Does anything in use need the browser extension? DeepSeek does not, unless its tab was asked for
 * explicitly (transport "browser"): it goes over HTTP with the saved login, and without a login the
 * answer is "sign in", not "open a browser".
 */
export function needsBrowser(cfg) {
  const sites = cfg.preferredSites.filter((s) => cfg.sites[s]?.enabled !== false);
  return sites.some((s) => !(s === "deepseek" && cfg.sites.deepseek?.transport !== "browser"));
}

const PROBE_TTL_MS = 20_000;
/** Trouble with the link to the browser, not with the site: wait for it and try the same site again. */
const TRANSIENT = /worker restarted|disconnected mid-request|lost contact|not connected|failed: busy|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Picks the site for each request and keeps a task on ONE conversation per site.
 *
 *  - Sticky: a site that already holds this task's chat is tried first, so the model and the
 *    conversation only change when something forces it (usage limit, login wall, a reply the
 *    chat cannot continue).
 *  - Follow-ups: when `followUp` is given and the site already has the earlier turns, only the
 *    short follow-up is sent into the same chat; otherwise the full prompt goes into a new chat.
 *  - Before sending, the site's tab is probed (no side effects) so a site that is out of quota,
 *    signed out or blocked is skipped at once instead of after a wasted turn.
 *  - When a site reports a hard usage limit it is benched until the reset it states.
 */
export class Router {
  /**
   * `sessionKey`: which DeepSeek chat this router's turns belong to (an advisor thread, a build).
   */
  constructor({ cfg, bridge, limits = new Limits(), log = () => {}, http = null, sessionKey = null }) {
    this.key = sessionKey || Math.random().toString(36).slice(2);
    this.http = http; // DeepSeek without a browser tab (created on first use when a login is saved)
    this.cfg = cfg;
    this.bridge = bridge;
    this.limits = limits;
    this.log = log;
    this.sessions = new Map(); // site -> { chars, turns, at }
    this.probes = new Map(); // site -> { at }
  }

  /** Forget the open chats (a new task). */
  resetSessions() {
    this.sessions.clear();
    (this.http || (hasAuth() ? sharedDeepSeek(this.log) : null))?.reset(this.key);
  }

  /** `thinking` / `search`: DeepSeek's DeepThink or web search for this one message, whatever the config says. */
  async ask({ phase, prompt, followUp = null, freshChat, meta = {}, onProgress, thinking = false, search = false }) {
    const cfg = this.cfg;
    const listed = sitesForPhase(cfg, phase);
    if (!listed.length) throw new Error(`no site is enabled for the "${phase}" phase (check sites.<name>.enabled and phases.${phase}.sites)`);
    // Sites already holding this task's conversation first (most recent first); the configured
    // order decides among the rest.
    const sites = [...listed].sort((a, b) => (this.sessions.get(b)?.at || 0) - (this.sessions.get(a)?.at || 0));
    const errors = [];
    for (const site of sites) {
      const conf = cfg.sites[site];
      const gate = this.limits.check(site, conf.limit);
      if (!gate.ok) {
        errors.push(`${site}: ${gate.reason}`);
        this.log(`  skip ${site}: ${gate.reason}`);
        continue;
      }
      const eff = { ...resolveSite(cfg, site, phase), ...(thinking ? { reasoning: "high" } : {}), ...(search ? { search: "on" } : {}) };
      const viaHttp = this.usesHttp(site);
      if (viaHttp === "no-login") {
        errors.push(`${site}: no DeepSeek login saved; the user must run once: c2f kur`);
        this.log(`  skip ${site}: no login saved (c2f kur)`);
        continue;
      }
      if (!viaHttp && NEEDS_FOREGROUND.has(site) && !eff.focusTab) {
        const why = `${site} draws nothing while its tab is in the background; allow it to come forward with: c2f config set sites.${site}.focusTab true`;
        errors.push(`${site}: ${why}`);
        this.log(`  skip ${site}: needs its tab in front (background-only mode)`);
        continue;
      }
      const pre = viaHttp ? null : await this.preflight(site, conf);
      if (pre) {
        errors.push(`${site}: ${pre}`);
        this.log(`  skip ${site}: ${pre}`);
        this.sessions.delete(site);
        continue;
      }
      const maxChars = cfg.sessionMaxChars ?? 150_000;
      const session = this.sessions.get(site);
      // sessionMaxChars is for chats driven in a browser tab (a long page slows down). DeepSeek's own chat
      // holds far more, and a file-by-file review would cross it after a few pastes: over HTTP the chat goes on.
      const useFollowUp = followUp != null && Boolean(session) && (viaHttp === true || session.chars < maxChars);
      try {
        this.limits.record(site);
        // Asked to continue (freshChat false) and DeepSeek still holds this folder's chat from before
        // (an earlier run, a restarted server): go on in it instead of opening a new one.
        const resume = !useFollowUp && freshChat === false && viaHttp === true && this.httpHas();
        let sentPrompt = useFollowUp || resume ? followUp ?? prompt : prompt;
        let continued = useFollowUp || resume;
        let res;
        try {
          res = await this.send(site, sentPrompt, { freshChat: continued ? false : (freshChat ?? true), continuing: continued }, eff, { meta, onProgress });
        } catch (err) {
          // The tab no longer holds the earlier turns: resend everything into a new chat.
          if (!(continued && /context_lost/i.test(err.message))) throw err;
          this.log(`  ${site}: the earlier turns are gone from the chat; resending the full context in a new one`);
          sentPrompt = prompt;
          continued = false;
          res = await this.send(site, sentPrompt, { freshChat: true, continuing: false }, eff, { meta, onProgress });
        }
        const prev = continued ? this.sessions.get(site) : null;
        this.sessions.set(site, {
          chars: (prev ? prev.chars : 0) + String(sentPrompt).length + String(res.reply).length,
          turns: (prev ? prev.turns : 0) + 1,
          at: Date.now(),
        });
        this.report(site, res.settings);
        return { ...res, site, continued };
      } catch (err) {
        errors.push(`${site}: ${err.message}`);
        // c2f's own burst guard: nothing was sent and DeepSeek said nothing; no bench, the chat stays.
        if (err.burst) continue;
        // A limit leaves the chat as it was (DeepSeek keeps it): the next turn goes on in it. Any other
        // failure may have left it in an unknown state, so the next turn starts over.
        if (!/hit a usage limit/i.test(err.message)) this.sessions.delete(site);
        if (/hit a usage limit/i.test(err.message)) {
          // A used-up quota with no reset time named: an hour, not the short bench for "too frequent".
          const quota = /quota used up/i.test(err.message);
          const until = this.limits.trip(site, {
            until: parseResetTime(err.message, this.limits.now()),
            minutes: quota ? Math.max(60, conf.limit.cooldownMinutes) : conf.limit.cooldownMinutes,
            reason: err.message.replace(/^.*?usage limit(?: \(quota used up\))?:?\s*/i, "") + (quota ? " [quota]" : ""),
          });
          const at = new Date(until).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
          errors[errors.length - 1] += ` (benched until ${at})`;
          this.log(`  ${site} is at its usage limit; benched until ${at}`);
          continue;
        }
        // Without the extension no site can answer (and send() already waited for it to come
        // back); anything else (timeout, login wall, settings that strict mode refused) is
        // specific to this site, so try the next one.
        if (/did not come back|not connected/i.test(err.message)) break;
      }
    }
    throw new Error(`no web chat model answered.\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  /**
   * One question to one site. A dropped browser link (the extension's worker restarting, Chrome
   * briefly gone) is waited out and the same site asked again, instead of giving the site up
   * and losing the conversation with it.
   */
  async send(site, prompt, flags, eff, ctx) {
    const retries = this.cfg.transportRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(site, prompt, flags, eff, ctx);
      } catch (err) {
        if (!TRANSIENT.test(err.message) || attempt >= retries) throw err;
        const waitMs = this.cfg.reconnectWaitMs ?? 180_000;
        this.log(`  ${site}: ${err.message.split("\n")[0].slice(0, 110)}; waiting for the browser link, then asking ${site} again (${attempt + 1}/${retries})`);
        if (/failed: busy/i.test(err.message)) await sleep(this.cfg.busyWaitMs ?? 15_000);
        else if (this.usesHttp(site) === true) await sleep(3000);
        else if (!(await this.bridge.waitForClient(waitMs))) throw new Error(`the browser extension did not come back within ${Math.round(waitMs / 1000)}s (${err.message})`);
        this.probes.delete(site);
      }
    }
  }

  /**
   * Does this site go over HTTP instead of through a browser tab? Only DeepSeek, and always, unless
   * sites.deepseek.transport says "browser": true with a saved login, "no-login" without one (the tab is
   * never a silent fallback: it would be pulled onto the user's screen).
   */
  usesHttp(site) {
    if (site !== "deepseek" || this.cfg.sites?.deepseek?.transport === "browser") return false;
    return this.http || hasAuth() ? true : "no-login";
  }

  httpHas() {
    const http = this.http || (hasAuth() ? sharedDeepSeek(this.log) : null);
    return Boolean(http?.has(this.key));
  }

  sendHttp(site, prompt, { continuing }, eff) {
    this.log(`  → ${site} (direct, no browser tab): ${continuing ? "follow-up in the same chat" : "new chat"}`);
    this.http ||= sharedDeepSeek(this.log);
    // DeepSeek only has DeepThink on/off and search on/off. Fast by default: a coding turn rarely
    // needs the web, and thinking first makes every turn slower.
    const thinking = !["", "default", "off", "none", "false"].includes(String(eff.reasoning ?? "default").toLowerCase());
    const search = ["on", "true"].includes(String(eff.search ?? "default").toLowerCase());
    return this.http.chat({ prompt, continuing, thinking, search, timeoutMs: eff.timeoutMs, key: this.key });
  }

  sendOnce(site, prompt, { freshChat, continuing }, eff, { meta, onProgress }) {
    if (this.usesHttp(site) === true) return this.sendHttp(site, prompt, { continuing }, eff);
    this.log(`  → ${site}: ${continuing ? "follow-up in the same chat" : freshChat ? "new chat" : "current chat"}${eff.model && eff.model !== "default" ? ` · ${eff.model}` : ""}`);
    return this.bridge.chat({
      site,
      prompt,
      freshChat,
      continuing,
      timeoutMs: eff.timeoutMs,
      focusTab: eff.focusTab,
      quietMs: this.cfg.quietMs,
      onProgress,
      meta,
      settings: { model: eff.model, reasoning: eff.reasoning, search: eff.search },
      strictSettings: this.cfg.strictSettings,
    });
  }

  /**
   * A reason to skip the site right now, or null. Costs one quick round trip to the extension
   * (cached briefly) and sends nothing. An unknown answer (no tab, probe failed) never blocks.
   */
  async preflight(site, conf) {
    if (this.cfg.preflight === false || typeof this.bridge.probe !== "function") return null;
    const seen = this.probes.get(site);
    if (seen && Date.now() - seen.at < PROBE_TTL_MS) return null;
    let r;
    try {
      r = await this.bridge.probe({ site });
    } catch {
      return null;
    }
    const s = r?.state;
    if (!r?.tab || !s) return null;
    if (s.needsLogin || s.loggedOutUI) return "not signed in (sign in to that tab)";
    if (s.challenge) return "showing a bot check (clear it in the browser)";
    if (s.composerDisabled) {
      if (s.hardLimit) {
        const until = this.limits.trip(site, {
          until: parseResetTime(s.hardLimit, this.limits.now()),
          minutes: conf.limit.cooldownMinutes,
          reason: s.hardLimit,
        });
        return `at its usage limit (${String(s.hardLimit).slice(0, 80)}), benched until ${new Date(until).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}`;
      }
      return "composer is disabled right now";
    }
    this.probes.set(site, { at: Date.now() });
    return null;
  }

  report(site, settings) {
    if (!settings) return;
    const parts = Object.entries(settings.applied || {}).map(([k, v]) => `${k}=${v}`);
    if (parts.length) this.log(`  ${site}: ${parts.join(", ")}`);
    for (const w of settings.warnings || []) this.log(`  ! ${site}: ${w}`);
  }
}
