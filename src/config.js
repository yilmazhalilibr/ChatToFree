import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SITE_NAMES = ["chatgpt", "claude", "gemini", "deepseek"];
/** Phases of a build; each can use its own sites and reasoning level. */
export const PHASES = ["design", "critique", "plan", "step", "verify"];
export const REASONING = ["default", "off", "on", "low", "medium", "high", "xhigh", "max"];
export const TOGGLE = ["default", "on", "off"];

/** What one chat site is asked to do. "default" means: leave the site's own choice alone. */
export const SITE_DEFAULTS = {
  enabled: true,
  model: "default",
  reasoning: "default",
  search: "default",
  // Request budget this tool may spend on the site (0 = unlimited) and how long to stay away
  // after the site itself reports a usage limit.
  limit: { perHour: 0, perDay: 0, cooldownMinutes: 60 },
  timeoutMs: null,
  focusTab: null,
  // DeepSeek only: "http" = direct requests with the saved login (no tab), "browser" = drive its tab,
  // null = http when a login is saved (c2f auth deepseek), else browser.
  transport: null,
};

/**
 * Sites that draw nothing while their tab is in the background (measured: DeepSeek shows an empty
 * conversation, with timers running and no frames). They are only used when the user allows the
 * tab to come forward (sites.<name>.focusTab), so nothing is ever pulled onto the screen unasked.
 */
export const NEEDS_FOREGROUND = new Set(["deepseek"]);

export const DEFAULTS = {
  // Off: the web model is only TALKED to (c2f_advise, c2f sohbet), a few short messages per task.
  // On: it is also driven like a machine: as OpenCode's model (src/api.js), c2f_build, c2f_chat, c2f yap.
  // That traffic (a message every few seconds, tool definitions, long pastes) got a DeepSeek account
  // suspended on 2026-11-18. Turn it on only for an account you can afford to lose.
  automation: false,
  port: 8787,
  preferredSites: [...SITE_NAMES],
  workspace: "./out",
  freshChatPerRequest: true,
  // One reply may take a long time (a big model thinking or researching). This is only the
  // hard cap for a single reply, not how long we wait when nothing is happening.
  requestTimeoutMs: 1_800_000,
  maxRoundsPerStep: 14,
  design: true,
  // A second chat turn that reviews the design. Off by default: it costs a full model turn.
  critique: false,
  // Keep one chat per site for a whole task and send short follow-ups into it; start a fresh
  // chat after this many characters so a long task never overflows the model.
  sessionMaxChars: 150_000,
  // The browser link dropped mid-task (extension worker restart, Chrome restart): wait this long for
  // it to come back, and ask the same site again up to this many times, before giving the site up.
  reconnectWaitMs: 180_000,
  transportRetries: 3,
  // After the steps: how many times to reopen steps whose planned files are still missing.
  gapRounds: 2,
  // A reply whose text has not changed for this long is finished even if a stop-like control is still
  // on screen (silent thinking with no text yet is not affected).
  quietMs: 60_000,
  // Advisor (c2f_advise): how long one message may be. DeepSeek takes about 40,000 characters (measured: 60k
  // accepted, 90k refused); 30,000 leaves room and holds one file or class for review.
  advisorMaxChars: 30_000,
  // c2f kur makes the ctf agent OpenCode's default, so every new session works with the advisor without
  // typing /ctf_ask. false: OpenCode keeps its own default (pick ctf or type /ctf_ask when wanted).
  ctfDefault: true,
  // Look at a site's tab before sending (signed out, bot check, limit) and skip it at once.
  preflight: true,
  chatMeta: {},
  focusTab: false,
  // When a requested model / reasoning level cannot be applied: false = warn and carry on,
  // true = fail the request so nothing runs with a setting nobody asked for.
  strictSettings: false,
  // DeepSeek: no count of its own (its own quota decides); what is guarded is the pace (src/deepseek-http.js:
  // 15 s between messages, 2 min between new chats) and repeats. When DeepSeek says its limit is reached,
  // c2f stays away for cooldownMinutes, or until the time DeepSeek names.
  sites: Object.fromEntries(SITE_NAMES.map((s) => [s, s === "deepseek" ? { ...structuredClone(SITE_DEFAULTS), limit: { perHour: 0, perDay: 0, cooldownMinutes: 10, burstMax: 10, burstMinutes: 10 } } : structuredClone(SITE_DEFAULTS)])),
  // phases: { design: { sites: ["claude"], reasoning: "high" }, step: { reasoning: "low" } }
  phases: {},
  local: {
    enabled: true,
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "auto",
    maxDigestChars: 12_000,
  },
};

/** User-level defaults live next to the bridge token so any directory shares them. */
export function globalConfigPath() {
  const base = process.env.C2F_CONFIG_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "ChatToFree");
  return path.join(base, "config.json");
}

export function localConfigPath(cwd = process.cwd()) {
  return path.join(cwd, "c2f.config.json");
}

export function readConfigFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

export function writeConfigFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep merge for plain objects; arrays and scalars replace. */
export function merge(base, over) {
  if (!isPlain(over)) return over === undefined ? base : over;
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) ? merge(out[k], v) : v;
  }
  return out;
}

/** Every problem with a (merged) config, as readable lines. Empty = valid. */
export function validate(cfg) {
  const bad = [];
  const num = (v, name, min = 0) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) bad.push(`${name} must be a number >= ${min} (got ${JSON.stringify(v)})`);
  };
  for (const [site, s] of Object.entries(cfg.sites || {})) {
    const at = `sites.${site}`;
    if (typeof s.enabled !== "boolean") bad.push(`${at}.enabled must be true or false`);
    if (typeof s.model !== "string" || !s.model.trim()) bad.push(`${at}.model must be a non-empty string ("default" leaves the site's choice)`);
    if (!REASONING.includes(s.reasoning)) bad.push(`${at}.reasoning must be one of ${REASONING.join(", ")} (got ${JSON.stringify(s.reasoning)})`);
    if (!TOGGLE.includes(s.search)) bad.push(`${at}.search must be one of ${TOGGLE.join(", ")} (got ${JSON.stringify(s.search)})`);
    num(s.limit?.perHour, `${at}.limit.perHour`);
    num(s.limit?.perDay, `${at}.limit.perDay`);
    num(s.limit?.cooldownMinutes, `${at}.limit.cooldownMinutes`, 1);
    if (s.timeoutMs !== null) num(s.timeoutMs, `${at}.timeoutMs`, 1000);
    if (s.focusTab !== null && typeof s.focusTab !== "boolean") bad.push(`${at}.focusTab must be true, false or null`);
  }
  for (const [phase, p] of Object.entries(cfg.phases || {})) {
    if (!PHASES.includes(phase)) bad.push(`phases.${phase} is not a phase (${PHASES.join(", ")})`);
    if (p.reasoning !== undefined && !REASONING.includes(p.reasoning)) bad.push(`phases.${phase}.reasoning must be one of ${REASONING.join(", ")}`);
    if (p.sites !== undefined && (!Array.isArray(p.sites) || p.sites.some((x) => typeof x !== "string"))) bad.push(`phases.${phase}.sites must be a list of site names`);
  }
  if (!Array.isArray(cfg.preferredSites) || !cfg.preferredSites.length) bad.push("preferredSites must be a non-empty list");
  return bad;
}

export function loadConfig(cwd = process.cwd(), overrides = {}) {
  const fromGlobal = readConfigFile(globalConfigPath());
  const fromFile = readConfigFile(localConfigPath(cwd));
  const flat = withoutUndefined(overrides);
  const cfg = merge(merge(merge(DEFAULTS, fromGlobal), fromFile), flat);
  // A site missing from the file keeps its defaults (custom sites get them too).
  for (const site of Object.keys(cfg.sites)) cfg.sites[site] = merge(SITE_DEFAULTS, cfg.sites[site]);
  cfg.port = Number(cfg.port) || DEFAULTS.port;
  // The workspace follows the directory you run from ("./out"), which is what a CLI on PATH
  // must do: a build started inside another project writes into THAT project, not into this
  // repo. Use --workspace or c2f.config.json for a fixed location.
  cfg.workspace = path.resolve(cwd, cfg.workspace);
  cfg.cwd = cwd;
  const problems = validate(cfg);
  if (problems.length) throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  return cfg;
}

function withoutUndefined(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

/** Sites a phase may use, in order, with disabled sites removed. */
export function sitesForPhase(cfg, phase) {
  const wanted = cfg.phases?.[phase]?.sites?.length ? cfg.phases[phase].sites : cfg.preferredSites;
  return wanted.filter((s) => cfg.sites[s]?.enabled !== false);
}

/** What one request to one site should apply and wait for: site settings, then phase overrides. */
export function resolveSite(cfg, site, phase) {
  const s = cfg.sites[site] || SITE_DEFAULTS;
  const p = cfg.phases?.[phase] || {};
  return {
    model: s.model,
    reasoning: p.reasoning !== undefined ? p.reasoning : s.reasoning,
    search: s.search,
    timeoutMs: s.timeoutMs ?? cfg.requestTimeoutMs,
    focusTab: s.focusTab ?? cfg.focusTab,
  };
}

// --- `c2f config set` -------------------------------------------------------------------

const BOOL_KEYS = /(^|\.)(enabled|focusTab|design|critique|preflight|freshChatPerRequest|strictSettings|automation|ctfDefault)$/;
const NUM_KEYS = /(^|\.)(perHour|perDay|cooldownMinutes|burstMax|burstMinutes|timeoutMs|requestTimeoutMs|sessionMaxChars|reconnectWaitMs|transportRetries|gapRounds|quietMs|advisorMaxChars|maxRoundsPerStep|port)$/;
const LIST_KEYS = /(^preferredSites$|^phases\.[^.]+\.sites$)/;

/** Turn a command-line string into the type its key expects. "default"/"null" reset to null where allowed. */
export function coerce(key, raw) {
  if (LIST_KEYS.test(key)) return String(raw).split(",").map((x) => x.trim()).filter(Boolean);
  if (BOOL_KEYS.test(key)) {
    if (/^(null|default)$/i.test(raw) && /focusTab$/.test(key)) return null;
    if (/^(true|1|on|yes)$/i.test(raw)) return true;
    if (/^(false|0|off|no)$/i.test(raw)) return false;
    throw new Error(`${key} expects true or false`);
  }
  if (NUM_KEYS.test(key)) {
    if (/^(null|default)$/i.test(raw) && /timeoutMs$/.test(key)) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${key} expects a number`);
    return n;
  }
  if (/transport$/.test(key)) {
    if (/^(null|default)$/i.test(raw)) return null;
    if (!/^(http|browser)$/i.test(raw)) throw new Error(`${key} expects http or browser`);
    return String(raw).toLowerCase();
  }
  return String(raw);
}

export function setPath(obj, key, value) {
  const parts = key.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts.at(-1)] = value;
  return obj;
}

export function unsetPath(obj, key) {
  const parts = key.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(cur[part])) return obj;
    cur = cur[part];
  }
  delete cur[parts.at(-1)];
  return obj;
}

/**
 * The config keys one "use <site>" request changes, as [key, value] pairs. `opts` uses the
 * names of the command-line flags (model, reasoning, search, perHour, perDay, cooldown,
 * timeout, enable, disable), so the CLI and the MCP tool share one mapping.
 */
export function sitePairs(site, opts) {
  const pairs = [];
  const add = (key, raw) => {
    if (raw !== undefined && raw !== null && raw !== true && raw !== "") pairs.push([`sites.${site}.${key}`, coerce(`sites.${site}.${key}`, String(raw))]);
  };
  add("model", opts.model);
  add("reasoning", opts.reasoning);
  add("search", opts.search);
  add("limit.perHour", opts.perHour);
  add("limit.perDay", opts.perDay);
  add("limit.cooldownMinutes", opts.cooldown);
  add("timeoutMs", opts.timeout);
  if (opts.enable) pairs.push([`sites.${site}.enabled`, true]);
  if (opts.disable) pairs.push([`sites.${site}.enabled`, false]);
  return pairs;
}
