/**
 * DeepSeek without a browser tab: the same three requests chat.deepseek.com makes, sent straight
 * from Node with the login the user's own browser already holds (`c2f auth deepseek` copies it once).
 * No tab means nothing to render, focus or wait for: a turn costs only the model's own time.
 *
 *   1. POST /api/v0/chat_session/create            -> a chat id
 *   2. POST /api/v0/chat/create_pow_challenge      -> a proof-of-work puzzle, solved here with the
 *                                                     site's own WASM and sent as X-DS-PoW-Response
 *   3. POST /api/v0/chat/completion                -> the reply as a server-sent-event stream
 *
 * The protocol was worked out from FreeDeepseekAPI (Apache-2.0, https://github.com/Blue-B/FreeDeepseekAPI,
 * commit 0fa66fdcf70de0e6183179fb650bd009bdae20d7: server.js and lib/pow.js). Nothing is copied
 * verbatim except the shape of the WASM call in solvePow(); see NOTICE. It is DeepSeek's private web
 * API: it can change without notice, and using it may go against DeepSeek's terms.
 *
 * One chat at a time per login: DeepSeek is reported to ban a login for days when two chats send at
 * once. Calls in this process go through one queue, and a lock file keeps other c2f processes (a
 * terminal build next to OpenCode's MCP server) from sending at the same moment.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseResetTime } from "./limits.js";
import { loadConfig } from "./config.js";

// C2F_DEEPSEEK_URL points the client at a stand-in server (tests); never set in normal use.
const BASE = process.env.C2F_DEEPSEEK_URL || "https://chat.deepseek.com";
// Two kinds of "limit": "too frequent" passes in a minute or two (a short back-off, the same turn again);
// a used-up quota (daily limit, or a reset more than 15 minutes away) does not, and every retry would be
// another request on an account that is already out: no retry, the site is benched until the reset.
const QUOTA = /quota|daily|per\s*day|today|tomorrow|今日|明天|used\s+up|exceeded|reached\s+(?:the|your|its)?\s*(?:daily\s+|usage\s+|message\s+)?limit|limit\s+(?:has\s+been\s+)?reached|上限|额度|用完|次数已达/i;
export function isQuota(text, now = Date.now()) {
  const t = String(text || "");
  // Rate wording ("too frequent", "rate limit", "too many requests") is the short kind, unless it also
  // speaks of a quota or a day, or names a reset far away.
  if (/too\s+frequent|try\s+again\s+later|rate[\s_-]*limit|too\s+many\s+requests|频繁/i.test(t) && !/quota|daily|per\s*day|today|tomorrow|上限|额度|今日|明天/i.test(t)) return (parseResetTime(t, now) ?? 0) > now + 15 * 60_000;
  return QUOTA.test(t) || (parseResetTime(t, now) ?? 0) > now + 15 * 60_000;
}

// Advisor conversations: kept on disk so they survive restarts. Other chats (the API endpoint, builds) are not.
const KEPT = /^advisor:/;

const RATE_LIMIT = /(?<![a-z])rate[\s_-]*limit|too\s+many\s+requests|too\s+frequent|слишком\s+част|частые\s+(?:сообщения|запросы)|频繁|请求过多|请求次数过多/i;
const wasmModules = new Map(); // wasm url -> Promise<WebAssembly.Module>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

export function authPath() {
  const base = process.env.C2F_CONFIG_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "ChatToFree");
  return path.join(base, "deepseek-auth.json");
}

/** The one DeepSeekHttp of this process, so every router shares one queue. */
let shared = null;
export function sharedDeepSeek(log) {
  if (shared) return shared;
  // The burst guard's numbers are the user's to tune: c2f config set sites.deepseek.limit.burstMax 10
  let limit = {};
  try {
    limit = loadConfig(process.cwd()).sites.deepseek.limit;
  } catch {
    /* defaults */
  }
  const tuned = {};
  if (Number.isFinite(limit.burstMax)) tuned.burstMax = limit.burstMax;
  if (Number.isFinite(limit.burstMinutes)) tuned.burstWindowMs = limit.burstMinutes * 60_000;
  // When the site moves its proof-of-work module, c2f's own sign-in profile reads the page again in a
  // headless browser (no window; the site turns plain requests away) and the new address is saved.
  const findWasm = async () => (await import("./login.js")).findWasmInBrowser();
  return (shared = new DeepSeekHttp({ log, keepAuth: (a) => saveAuth(a), findWasm, ...tuned }));
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

/** Can the site's proof-of-work module still be fetched and compiled? A static file on DeepSeek's CDN: no account request. */
export async function checkWasm(url) {
  if (!url || !isDeepSeekHttps(url)) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    await WebAssembly.compile(await res.arrayBuffer());
    return true;
  } catch (err) {
    return err instanceof WebAssembly.CompileError ? false : "unknown";
  }
}

/**
 * The proof-of-work module's address (sha3_wasm_bg.<hash>.wasm) is named inside the site's own scripts.
 * Look for it there: Node is not held to the browser's cross-origin rules, so the scripts can be read.
 */
export async function discoverWasmUrl(scriptUrls, fetchImpl = globalThis.fetch) {
  for (const url of scriptUrls.filter(isDeepSeekHttps).slice(0, 40)) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const found = (await res.text()).slice(0, 4_000_000).match(/[A-Za-z0-9_\-./:]*sha3_wasm_bg\.[A-Za-z0-9]+\.wasm/);
      if (!found) continue;
      const ref = found[0];
      if (/^https?:/i.test(ref) || ref.startsWith("/")) {
        const abs = new URL(ref, url).href;
        if (isDeepSeekHttps(abs)) return abs;
        continue; // a script naming someone else's module is not trusted
      }
      // A relative name ("static/sha3_wasm_bg.x.wasm") hangs off the bundler's public path, which is
      // some parent folder of this script: take the first one where the file really exists.
      const dirs = [];
      const u = new URL(url);
      const parts = u.pathname.split("/").slice(0, -1);
      for (let n = parts.length; n >= 1; n--) dirs.push(`${u.origin}${parts.slice(0, n).join("/")}/`);
      for (const dir of dirs) {
        const candidate = new URL(ref, dir).href;
        try {
          if ((await fetchImpl(candidate, { method: "HEAD", signal: AbortSignal.timeout(10_000) })).ok) return candidate;
        } catch {
          /* next folder */
        }
      }
    } catch {
      /* next script */
    }
  }
  return "";
}

export function hasAuth(file = authPath()) {
  try {
    return Boolean(JSON.parse(fs.readFileSync(file, "utf8")).token);
  } catch {
    return false;
  }
}

/**
 * Which computer (and Windows user) a login was made on. Every computer signs in on its own: a login file
 * copied from elsewhere is refused, so friends each use their own DeepSeek account and one session is
 * never driven from two places.
 */
export function machineId() {
  return crypto.createHash("sha256").update(`${os.hostname()}|${os.userInfo().username}`.toLowerCase()).digest("hex").slice(0, 16);
}

export const OTHER_MACHINE = "this DeepSeek login was saved on another computer. Every computer signs in on its own; the user must run: c2f giris";

export function loadAuth(file = authPath()) {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no DeepSeek login saved yet. The user must run once: c2f kur`);
  }
  if (!auth.token) throw new Error(`${file} has no token. The user must run: c2f giris`);
  if (auth.machine && auth.machine !== machineId()) throw new Error(OTHER_MACHINE);
  if (!auth.machine) saveAuth(auth, file); // a login from before this check: it was made here, mark it so
  return auth;
}

export function saveAuth(auth, file = authPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The login is as good as a password: only this user may read it.
  fs.writeFileSync(file, JSON.stringify({ ...auth, machine: machineId() }, null, 2), { mode: 0o600 });
  return file;
}

/** Only https addresses on deepseek.com may supply the module that runs inside this process. */
export function isDeepSeekHttps(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)deepseek\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Solve DeepSeek's proof-of-work with its own WASM module (compiled once, a fresh instance per solve). */
export async function solvePow(challenge, wasmUrl) {
  if (!wasmUrl) throw new Error("the saved login is incomplete. The user must run: c2f giris");
  if (!isDeepSeekHttps(wasmUrl)) throw new Error(`refusing to run a proof-of-work module from ${wasmUrl}: it must be an https address on deepseek.com`);
  if (!wasmModules.has(wasmUrl)) {
    const p = (async () => {
      const res = await fetch(wasmUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`could not fetch the proof-of-work module (HTTP ${res.status})`);
      return WebAssembly.compile(await res.arrayBuffer());
    })();
    wasmModules.set(wasmUrl, p);
    p.catch(() => wasmModules.delete(wasmUrl));
  }
  const instance = await WebAssembly.instantiate(await wasmModules.get(wasmUrl), { wbg: {} });
  const x = instance.exports;
  const enc = new TextEncoder();
  const challengeBytes = enc.encode(challenge.challenge);
  const prefixBytes = enc.encode(`${challenge.salt}_${challenge.expire_at}_`);
  const cp = x.__wbindgen_export_0(challengeBytes.length, 1) >>> 0;
  const pp = x.__wbindgen_export_0(prefixBytes.length, 1) >>> 0;
  new Uint8Array(x.memory.buffer, cp, challengeBytes.length).set(challengeBytes);
  new Uint8Array(x.memory.buffer, pp, prefixBytes.length).set(prefixBytes);
  const sp = x.__wbindgen_add_to_stack_pointer(-16);
  x.wasm_solve(sp, cp, challengeBytes.length, pp, prefixBytes.length, challenge.difficulty);
  const view = new DataView(x.memory.buffer);
  const code = view.getInt32(sp, true);
  const answer = view.getFloat64(sp + 8, true);
  x.__wbindgen_add_to_stack_pointer(16);
  if (code === 0 || !Number.isFinite(answer) || answer <= 0) throw new Error("the proof-of-work could not be solved");
  return Math.floor(answer);
}

/**
 * Read DeepSeek's event stream. The reply arrives as fragments (type RESPONSE for the answer, THINK
 * for DeepThink's reasoning) that are first announced whole and then grown by patches whose `p`
 * (path) persists across events that omit it.
 */
export async function readStream(body, onText = () => {}) {
  const fragments = [];
  let path = null;
  let messageId = null;
  let finish = null;
  let error = null;
  let hint = null;
  let buffer = "";
  const decoder = new TextDecoder();
  const add = (v) => {
    for (const f of Array.isArray(v) ? v : [v]) if (f && typeof f === "object") fragments.push({ ...f });
  };
  const text = (type) => fragments.filter((f) => f.type === type && typeof f.content === "string").map((f) => f.content).join("");
  const handle = (d) => {
    if (d.response_message_id !== undefined && !messageId) messageId = d.response_message_id;
    if (d.type === "error") error = { content: d.content || "", finish: d.finish_reason || null };
    // A hint event, or a limit-like finish reason: DeepSeek refusing instead of answering (send() only treats
    // it as a limit when no answer text came with it).
    else if (d.type === "hint" || /rate_?limit|quota|limit/i.test(String(d.finish_reason || ""))) hint = d.content || d.finish_reason || "limit";
    if (d.finish_reason) finish = d.finish_reason;
    if (d.p !== undefined) path = d.p;
    const v = d.v;
    if (v && typeof v === "object" && !Array.isArray(v) && v.response) {
      if (v.response.message_id !== undefined) messageId = v.response.message_id;
      if (Array.isArray(v.response.fragments)) {
        fragments.length = 0;
        add(v.response.fragments);
      }
      if (v.response.finish_reason !== undefined) finish = v.response.finish_reason;
    }
    if (path === "response/fragments" && v !== undefined) add(v);
    else if (path === "response" && Array.isArray(v)) {
      for (const op of v) if (op?.p === "fragments" && op.o === "APPEND" && op.v !== undefined) add(op.v);
    } else if (path === "response/fragments/-1/content" && typeof v === "string" && fragments.length) {
      const last = fragments[fragments.length - 1];
      last.content = `${last.content || ""}${v}`;
    } else if (path === "response/finish_reason" && v !== undefined) finish = v;
    else if (path === "response/status" && v !== undefined) finish = v === "FINISHED" ? finish || "FINISHED" : v;
    onText(text("RESPONSE"));
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        handle(JSON.parse(line.slice(6)));
      } catch {
        /* a keep-alive or a partial line */
      }
    }
  }
  return { reply: text("RESPONSE"), thinking: text("THINK"), messageId, finish, error, hint };
}

export class DeepSeekHttp {
  /**
   * @param auth      `{ token, cookie, hif_dliq, hif_leim, wasmUrl }`; or a function returning it (read at each turn)
   * @param fetchImpl injectable for tests
   * @param solve     injectable for tests
   */
  constructor({ auth = () => loadAuth(), baseUrl = BASE, fetchImpl = globalThis.fetch, solve = solvePow, log = () => {}, lockFile = path.join(path.dirname(authPath()), "deepseek.lock"), paceMs = 15_000, newChatGapMs = 120_000, burstMax = 10, burstWindowMs = 600_000, burstMaxWaitMs = 240_000, backoffMs = [30_000, 60_000, 120_000], keepAuth = null, findWasm = null } = {}) {
    this.keepAuth = keepAuth;
    this.findWasm = findWasm;
    this.lockFile = lockFile;
    // DeepSeek answers "Messages too frequent" to a login that sends too fast, and suspends an account
    // that keeps doing it (measured 2026-11-18: ~25 messages and 14 new chats in 11 minutes, then the
    // session was closed and the account suspended). So: at least paceMs between two messages, across
    // all c2f processes, and when it still says "too frequent", a wait and the same turn again.
    // Opening chat after chat (each message in a new one) is the other half of that pattern: at least
    // newChatGapMs between two new chats. Both waits queue the message; nothing is refused.
    // And the burst itself: at most burstMax messages in burstWindowMs. A message over that waits for the
    // window (up to burstMaxWaitMs); a longer wait is handed back as "consult again after HH:MM" (0 = off).
    this.paceMs = paceMs;
    this.newChatGapMs = newChatGapMs;
    this.burstMax = burstMax;
    this.burstWindowMs = burstWindowMs;
    this.burstMaxWaitMs = burstMaxWaitMs;
    this.backoffMs = backoffMs;
    const dir = path.dirname(lockFile);
    this.lastFile = path.join(dir, "deepseek.last");
    this.lastChatFile = path.join(dir, "deepseek.lastchat");
    this.sentFile = path.join(dir, "deepseek.sent"); // send times in the burst window, shared by every process
    this.chatsFile = path.join(dir, "deepseek-chats.json"); // advisor conversations, kept across restarts
    this.sentLog = path.join(dir, "sent.log"); // one line per message: time, chat, size, outcome; never the text
    this.refusalsLog = path.join(dir, "refusals.log"); // DeepSeek's own words whenever it refuses
    this.auth = auth;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.solve = solve;
    this.log = log;
    // key (what the chat is for: an advisor thread, an API conversation) -> { id, parent }. DeepSeek names
    // its chats itself, as on the website; c2f never touches the title. Advisor conversations ("advisor:"
    // keys) are also kept in chatsFile, so a restarted OpenCode or c2f goes on in the same DeepSeek chat.
    this.sessions = new Map();
    this.tail = Promise.resolve(); // ONE chat at a time on a login
  }

  headers(auth) {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "x-client-platform": "web",
      "x-client-version": "2.0.2",
      "x-app-version": "2.0.2",
      "x-client-locale": "en",
      "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
      Authorization: `Bearer ${auth.token}`,
      "x-hif-dliq": auth.hif_dliq || "",
      "x-hif-leim": auth.hif_leim || "",
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      Cookie: auth.cookie || "",
      "Content-Type": "application/json",
    };
  }

  drop(key) {
    this.sessions.delete(key);
    if (KEPT.test(key)) this.storeChat(key, null);
  }

  /** Is there an open chat for this key (so a continuing turn can go into it)? Also one kept from before a restart. */
  has(key) {
    if (this.sessions.has(key)) return true;
    const kept = KEPT.test(key) && this.keptChats()[key];
    if (kept?.id) this.sessions.set(key, { id: kept.id, parent: kept.parent ?? null });
    return Boolean(kept?.id);
  }

  keptChats() {
    try {
      return JSON.parse(fs.readFileSync(this.chatsFile, "utf8"));
    } catch {
      return {};
    }
  }

  /** Keep (or with null forget) an advisor conversation's chat. Called while the cross-process lock is held. */
  storeChat(key, session) {
    try {
      const all = this.keptChats();
      const month = Date.now() - 30 * 24 * 3_600_000;
      for (const [k, v] of Object.entries(all)) if (!(v.at > month)) delete all[k];
      if (session) all[key] = { id: session.id, parent: session.parent ?? null, at: Date.now() };
      else delete all[key];
      fs.mkdirSync(path.dirname(this.chatsFile), { recursive: true });
      const tmp = `${this.chatsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, this.chatsFile);
    } catch {
      /* without it a restart opens a new chat, as before */
    }
  }

  /** Append one line to a local log file (best effort). */
  note(file, line) {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* logging never breaks a turn */
    }
  }

  /** Forget a key's open chat (a new task), or all of them. The next turn opens a new DeepSeek chat. */
  reset(key) {
    if (key === undefined) this.sessions.clear();
    else this.drop(key);
  }

  /** Take the cross-process lock; resolves to a release function. Stale locks (dead pid, too old) are taken over. */
  async acquire(holdMs) {
    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, "wx");
        // The holder says how long it may legitimately hold the lock; a waiter never judges by ITS OWN timeout.
        const mine = JSON.stringify({ pid: process.pid, at: Date.now(), until: Date.now() + holdMs });
        fs.writeSync(fd, mine);
        fs.closeSync(fd);
        // Release only what is still ours: a lock taken over after its deadline belongs to someone else.
        return () => {
          try {
            if (fs.readFileSync(this.lockFile, "utf8") === mine) fs.unlinkSync(this.lockFile);
          } catch {
            /* already gone */
          }
        };
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        let stale = false;
        try {
          const held = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
          stale = !alive(held.pid) || Date.now() > (held.until ?? held.at);
        } catch {
          // unreadable: being written right now, or left half-written long ago
          try {
            stale = Date.now() - fs.statSync(this.lockFile).mtimeMs > 30_000;
          } catch {
            stale = false;
          }
        }
        if (stale) {
          try {
            fs.unlinkSync(this.lockFile);
          } catch {
            /* someone else took it over */
          }
          continue;
        }
        await sleep(200);
      }
    }
  }

  /**
   * One turn. `continuing` sends into the chat opened by the previous turn; without one (or when that
   * chat is gone) a new chat is opened, and a continuing turn then fails with context_lost so the
   * caller can resend the whole context.
   */
  chat({ prompt, continuing = false, thinking = false, search = false, timeoutMs = 1_800_000, key = "default", onText = null }) {
    const run = async () => {
      const release = await this.acquire(timeoutMs + 60_000);
      try {
        return await this.turn({ prompt, continuing, thinking, search, timeoutMs, key, onText });
      } finally {
        release();
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }

  async turn({ prompt, continuing, thinking, search, timeoutMs, key, onText }) {
    const began = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);
    const auth = typeof this.auth === "function" ? this.auth() : this.auth;
    const headers = this.headers(auth);
    if (continuing && !this.has(key)) throw new Error("context_lost: the DeepSeek chat of the earlier turns is not open any more");
    if (!continuing) this.drop(key);
    const post = (url, body, extra = {}) => this.fetch(`${this.baseUrl}${url}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body), signal });

    if (!this.sessions.has(key)) {
      await this.wait(this.lastChatFile, this.newChatGapMs);
      const res = await post("/api/v0/chat_session/create", {});
      const data = await this.json(res, "opening a chat");
      const id = data?.data?.biz_data?.chat_session?.id || data?.data?.biz_data?.id;
      if (!id) throw this.failure(res.status, JSON.stringify(data), "opening a chat");
      this.sessions.set(key, { id, parent: null });
    }
    const session = this.sessions.get(key);
    const opened = session.parent === null;
    const record = (outcome, n) => this.note(this.sentLog, `chat=${String(session.id).slice(0, 8)} ${opened ? "new" : "cont"} chars=${String(prompt).length} attempts=${n + 1}${thinking ? " deep" : ""} ${outcome}`);
    let out;
    for (let n = 0; ; n++) {
      try {
        await this.pace();
        out = await this.send({ post, auth, session, prompt, thinking, search, continuing, key, onText });
        record("ok", n);
        break;
      } catch (err) {
        if (!err.rateLimited || n >= this.backoffMs.length) {
          record(err.quota ? "quota" : err.rateLimited ? "rate-limited" : err.burst ? "held-by-burst-guard" : "error", n);
          throw err;
        }
        const wait = Math.max(err.retryAfterMs || 0, this.backoffMs[n]);
        this.log(`  deepseek: messages too frequent; waiting ${Math.round(wait / 1000)}s, then this turn again (${n + 1}/${this.backoffMs.length})`);
        await sleep(wait);
      }
    }
    // A failed or empty answer keeps the chat: the next turn goes on from the last good answer in the same
    // chat (DeepSeek branches from parent_message_id). Forgetting it here used to open a new chat that
    // held only the next message, losing the whole conversation.
    if (out.error) throw new Error(`deepseek failed: ${out.error.content || out.error.finish || "model error"}`);
    if (!out.reply.trim()) throw new Error("deepseek failed: no_reply (the stream ended without an answer)");
    if (out.messageId) session.parent = out.messageId;
    if (KEPT.test(key)) this.storeChat(key, session);
    const ms = Date.now() - began;
    return { reply: out.reply, thinking: out.thinking, ms, timings: { total: ms }, finish: out.finish };
  }

  /**
   * Is the saved login still accepted? One small read-only request (who am I), no chat, no message.
   * "ok" | "expired" (DeepSeek refused it: only signing in again helps) | "missing" | "unknown" (could not ask).
   */
  async loginState() {
    let auth;
    try {
      auth = typeof this.auth === "function" ? this.auth() : this.auth;
    } catch (err) {
      return err.message === OTHER_MACHINE ? "other-machine" : "missing";
    }
    try {
      const res = await this.fetch(`${this.baseUrl}/api/v0/users/current`, { headers: this.headers(auth), signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      if (res.status === 401 || res.status === 403 || /"code":\s*40003|invalid.?token|authorization failed/i.test(text)) return "expired";
      return res.ok ? "ok" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /** At least paceMs between two messages, and no more than burstMax in a window, across processes (the lock is held). */
  async pace() {
    await this.wait(this.lastFile, this.paceMs);
    if (!this.burstMax) return;
    let times = [];
    try {
      times = JSON.parse(fs.readFileSync(this.sentFile, "utf8"));
    } catch {
      /* none yet */
    }
    times = times.filter((t) => t > Date.now() - this.burstWindowMs).sort((a, b) => a - b);
    if (times.length >= this.burstMax) {
      const next = times[times.length - this.burstMax] + this.burstWindowMs;
      const ms = next - Date.now();
      const what = `${this.burstMax} messages in ${Math.round(this.burstWindowMs / 60_000)} minutes`;
      if (ms > this.burstMaxWaitMs) throw Object.assign(new Error(`deepseek hit a usage limit: c2f paces itself: ${what}, the next one can go at ${hhmm(next)}`), { burst: true });
      if (ms > 0) {
        this.log(`  deepseek: waiting ${Math.round(ms / 1000)}s (${what}: messages are spread out)`);
        await sleep(ms);
      }
    }
    times.push(Date.now());
    try {
      fs.writeFileSync(this.sentFile, JSON.stringify(times.filter((t) => t > Date.now() - this.burstWindowMs)));
    } catch {
      /* best effort */
    }
  }

  /** At least `gapMs` since the time stored in `file` (shared by every c2f process), then store now. */
  async wait(file, gapMs) {
    let last = 0;
    try {
      last = Number(fs.readFileSync(file, "utf8")) || 0;
    } catch {
      /* first time */
    }
    const ms = last + gapMs - Date.now();
    if (ms > 0) {
      this.log(`  deepseek: waiting ${Math.round(ms / 1000)}s (${file === this.lastChatFile ? "new chats are spaced out" : "messages are spaced out"})`);
      await sleep(ms);
    }
    try {
      fs.writeFileSync(file, String(Date.now()));
    } catch {
      /* pacing is best effort */
    }
  }

  /** One attempt at the message itself: puzzle, request, stream. Rate limits are marked and keep the chat. */
  async send({ post, auth, session, prompt, thinking, search, continuing, key, onText }) {
    // Known "too frequent" wording: rateLimited, the turn is tried again after a short wait. A used-up quota:
    // marked as such (the router benches the site until the reset), not tried again. Wording c2f does not
    // know: not tried again either (a short bench, DeepSeek's text shown as it is); an unknown quota message
    // must not get retries.
    const limited = (err, retryAfter) => {
      const said = err.message.replace(/^deepseek hit a usage limit:\s*/, "");
      this.note(this.refusalsLog, `${isQuota(err.message) ? "quota" : RATE_LIMIT.test(said) ? "rate" : "unknown"} ${said.replace(/\s+/g, " ").slice(0, 400)}`);
      if (isQuota(err.message)) {
        err.message = err.message.replace("hit a usage limit:", "hit a usage limit (quota used up):");
        return Object.assign(err, { quota: true });
      }
      if (!RATE_LIMIT.test(said)) return err;
      return Object.assign(err, { rateLimited: true, retryAfterMs: Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0 });
    };
    const asError = (res, text, what = "sending the message") => {
      const err = this.failure(res.status, text, what, res.headers);
      return /hit a usage limit/.test(err.message) ? limited(err, res.headers?.get?.("retry-after")) : null;
    };
    const pow = await this.powHeader(post, auth);
    const res = await post(
      "/api/v0/chat/completion",
      { chat_session_id: session.id, parent_message_id: session.parent, model_type: "default", prompt, ref_file_ids: [], thinking_enabled: Boolean(thinking), search_enabled: Boolean(search), action: null, preempt: false },
      { "X-DS-PoW-Response": pow },
    );
    if (!res.ok) {
      const text = await res.text();
      throw asError(res, text) || this.lostOr(continuing, key, this.failure(res.status, text, "sending the message", res.headers));
    }
    if (!/event-stream/i.test(res.headers.get("content-type") || "")) {
      // A JSON body on HTTP 200 is DeepSeek refusing (rate limit, bad session), not a reply.
      const text = await res.text();
      const rate = asError(res, text);
      if (rate) throw rate;
      this.drop(key);
      throw this.lostOr(continuing, key, this.failure(res.status, text, "sending the message"));
    }
    const out = await readStream(res.body, onText || undefined);
    if ((out.hint && !out.reply.trim()) || (out.error && RATE_LIMIT.test(`${out.error.content} ${out.error.finish}`))) {
      throw limited(new Error(`deepseek hit a usage limit: ${out.hint || out.error.content || "rate limited"}`));
    }
    return out;
  }

  /**
   * A continuing turn that DeepSeek refuses probably points at a chat that is gone (deleted, expired):
   * drop it and say so, so the caller resends the whole context into a new chat. Limits and login
   * problems keep their own message.
   */
  lostOr(continuing, key, err) {
    this.drop(key);
    if (continuing && /deepseek failed:/.test(err.message)) return new Error(`context_lost: DeepSeek no longer has that chat (${err.message})`);
    return err;
  }

  async powHeader(post, auth) {
    const target = "/api/v0/chat/completion";
    const res = await post("/api/v0/chat/create_pow_challenge", { target_path: target });
    const data = await this.json(res, "asking for a proof-of-work puzzle");
    const challenge = data?.data?.biz_data?.challenge;
    if (!challenge) throw this.failure(res.status, JSON.stringify(data), "asking for a proof-of-work puzzle");
    let answer;
    try {
      answer = await this.solve(challenge, auth.wasmUrl);
    } catch (err) {
      // DeepSeek moved or replaced the module (a new site build): find it again, once.
      if (!this.findWasm || (!/proof-of-work module|could not be solved|incomplete/i.test(err.message) && !/CompileError|LinkError|RuntimeError/.test(err.name))) throw err;
      const found = await this.findWasm();
      if (!found || found === auth.wasmUrl) throw err;
      this.log(`  deepseek: the proof-of-work module moved; using ${found}`);
      auth.wasmUrl = found;
      this.keepAuth?.(auth);
      answer = await this.solve(challenge, found);
    }
    return Buffer.from(JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt, answer, signature: challenge.signature, target_path: target })).toString("base64");
  }

  async json(res, what) {
    const text = await res.text();
    if (!res.ok) throw this.failure(res.status, text, what, res.headers);
    try {
      return JSON.parse(text);
    } catch {
      throw this.failure(res.status, text, what, res.headers);
    }
  }

  /** An Error whose message the router already understands (usage limit / sign-in / generic). */
  failure(status, body, what, headers = null) {
    const detail = String(body || "").replace(/\s+/g, " ").trim().slice(0, 240);
    // DeepSeek sits behind a bot check whose pass (aws-waf-token) expires: a challenge answer or an HTML page
    // instead of JSON means the saved login went stale, not that DeepSeek is down.
    if (Number(status) === 202 || headers?.get?.("x-amzn-waf-action") || /^<!doctype html|<html/i.test(detail)) {
      return new Error(`deepseek needs login: its bot check wants a fresh browser pass while ${what}. Retrying will not help: the user must sign in again by running: c2f giris`);
    }
    if (Number(status) === 429 || RATE_LIMIT.test(detail)) return new Error(`deepseek hit a usage limit: ${detail || "rate limited"}`);
    if (Number(status) === 401 || Number(status) === 403 || /"code":\s*40003|authorization failed|invalid token/i.test(detail)) {
      return new Error(`deepseek needs login: the saved login was refused while ${what}. Retrying will not help: the user must sign in again by running: c2f giris`);
    }
    return new Error(`deepseek failed: HTTP ${status} while ${what}${detail ? ` (${detail})` : ""}`);
  }
}
