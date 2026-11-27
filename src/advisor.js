import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
/**
 * Advisor: the model that does the work (a local or small model inside OpenCode) talks things over
 * with the big web model, the way a developer talks to a senior colleague: "I did this part like
 * this, here is what happened, what do you think?" One conversation per task, which the web model
 * remembers.
 *
 * Why it is shaped like a conversation between people:
 *  - The user reads that conversation in their own DeepSeek account. It has to be understandable.
 *  - Driving the web chat like an API (a message every few seconds, tool definitions, huge pastes) got
 *    the user's account suspended (2026-11-18). A few short messages per task do not look like that,
 *    because they are not that.
 *
 * So the messages are the worker's own words, passed on unchanged. What is enforced here is only what
 * can be: they are short, there are few of them, and they are written by the person doing the work
 * ("I want to build...", "I wrote this file like this..."), not by a go-between reporting on someone
 * else ("the user wants...").
 */

/**
 * A go-between's voice: reporting what somebody else asked for ("Kullanıcı ... istiyor", "the user
 * wants", "benden istenen"). Talking ABOUT users of the program ("kullanıcı adı alanı") is fine.
 */
const THIRD_PERSON = /(?<!\p{L})kullanıcı(?:nın)?\s+(?:(?![.!?](?:\s|$)).){0,80}?(?<!\p{L})(?:ist(?:iyor|edi|er|eği|ediği|emiş)|talep|rica)|(?<!\p{L})benden\s+isten|\bthe user (?:wants|asked|requested|needs|would like)\b/iu;

// Secrets that must never reach a web chat (it keeps the conversation, the user's account holds it).
// Checked on the whole message, pasted code included. A placeholder (<API_KEY>, "changeme") passes.
const SECRETS = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an API key (sk-...)", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a JWT / session token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["a password or secret value", /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|parola|şifre)["']?\s*[:=]\s*["'](?!<|\$\{|changeme|example|your[_-]|xxx|\*{3})[^"'\s]{8,}["']/i],
  ["a secret in an env file", /^\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*(?!<|\$\{|changeme|example|your[_-]|xxx)[^\s#()[\]{}"']{12,}\s*$/m],
];

/** A .gitignore-style pattern as a test on a project-relative path ("a/b.txt"). */
function patternTest(pattern) {
  let p = pattern.replace(/^\//, "");
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const body = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  const re = new RegExp(`${p.includes("/") ? "^" : "(^|/)"}${body}${dirOnly ? "/" : "$"}`, "i");
  return (rel) => re.test(rel);
}

// Folders a wildcard rule does not look into (dependencies, builds, caches). A rule that names one of them
// directly ("vendor/secret.txt", ".venv/") still covers it.
const HEAVY = new Set(["node_modules", ".git", ".venv", "venv", "env", "dist", "build", "out", "target", "vendor", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".gradle", "bin", "obj"]);
const guardCache = new Map(); // project dir -> { at, stamp, files, incomplete }

/** The files a project's .c2fignore protects: named ones resolved directly, wildcard ones found by a walk. */
function protectedFiles(dir, rules, maxEntries) {
  const files = new Set();
  let seen = 0;
  let incomplete = false;
  const walk = (rel, onFile, skipHeavy) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > maxEntries) {
        incomplete = true;
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git" || (skipHeavy && HEAVY.has(e.name))) continue;
        walk(r, onFile, skipHeavy);
        if (incomplete) return;
      } else onFile(r);
    }
  };
  const globs = [];
  for (const rule of rules) {
    if (!/[*?[]/.test(rule)) {
      const rel = rule.replace(/^\/+|\/+$/g, "");
      const full = path.join(dir, rel);
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        /* a name that is not there (yet): a wildcard walk still finds it deeper down */
      }
      if (st?.isFile()) files.add(rel);
      else if (st?.isDirectory()) walk(rel, (r) => files.add(r), false);
      // A path that names an existing file or folder is settled; a bare name ("secrets") may also stand deeper.
      if (st && rule.includes("/")) continue;
    }
    globs.push(patternTest(rule));
  }
  if (globs.length && !incomplete) {
    walk("", (r) => {
      const parts = r.split("/");
      if (globs.some((t) => t(r) || parts.some((_, i) => i < parts.length - 1 && t(`${parts.slice(0, i + 1).join("/")}/`)))) files.add(r);
    }, true);
  }
  return { files: [...files], incomplete };
}

/**
 * A project's .c2fignore: "off" on a line turns the advisor off in that project; every other line is a
 * file pattern (like .gitignore) whose contents must never reach the web chat. Returns why a message may
 * not go, or "". Enforced on content: a message holding a line of such a file (30+ characters) is refused.
 * When not every file could be checked, nothing goes (the guard fails closed).
 */
export function projectGuard(dir, text, { maxEntries = 20_000 } = {}) {
  if (!dir) return "";
  const ignoreFile = path.join(dir, ".c2fignore");
  let rules;
  let stamp;
  try {
    rules = fs.readFileSync(ignoreFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    stamp = fs.statSync(ignoreFile).mtimeMs;
  } catch {
    return "";
  }
  if (rules.some((l) => /^off$/i.test(l))) return "the advisor is turned off in this project (.c2fignore says off). Do the work without consulting, and do not mention it again.";
  let found = guardCache.get(dir);
  if (!found || found.stamp !== stamp || Date.now() - found.at > 60_000 || found.maxEntries !== maxEntries) {
    found = { ...protectedFiles(dir, rules, maxEntries), stamp, at: Date.now(), maxEntries };
    guardCache.set(dir, found);
  }
  if (found.incomplete) {
    return `nothing was sent: this project has more than ${maxEntries} files and folders, so c2f could not check every file .c2fignore protects. Ask the user to write exact paths in .c2fignore (e.g. config/prod.json or secrets/) instead of wildcards, or to add "off".`;
  }
  for (const rel of found.files) {
    try {
      const full = path.join(dir, rel);
      if (fs.statSync(full).size > 512 * 1024) continue;
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 30);
      if (lines.some((l) => text.includes(l))) return `nothing was sent: the message holds lines of ${rel}, which .c2fignore keeps out of the web chat. Describe what you need in your own words, without its content.`;
    } catch {
      /* gone or unreadable: nothing to compare */
    }
  }
  return "";
}

export class Advisor {
  /** `getRouter()` returns the (long-lived) Router so its chat session persists between consults. */
  // No cap per conversation: one conversation is a whole OpenCode session, and a per-conversation cap
  // would lock every later request in it. The account is protected by the per-site hourly and daily
  // budgets and the pause between two messages, which count every consult.
  /** `resume`: the router already knows this conversation's DeepSeek chat (saved by `c2f danis`): continue it. */
  /** `project`: the project folder, for its .c2fignore. */
  constructor({ getRouter, maxChars = 30_000, repeatWindowMs = 10 * 60_000, resume = false, project = null }) {
    this.project = project;
    this.getRouter = getRouter;
    this.started = resume; // a conversation from before a restart has its chat already
    this.maxChars = maxChars;
    this.repeatWindowMs = repeatWindowMs;
    this.last = null; // { text, at, answer }: the previous message of this conversation and its answer
  }

  async consult({ message, deep = false, search = false }) {
    const text = String(message || "").trim();
    if (!text) throw new Error("message is required: tell the advisor in your own words what you did and what you want to know");
    if (text.length > this.maxChars) {
      throw new Error(`that message is ${text.length} characters; the limit is ${this.maxChars}. Split it: one file or class per message (say "parça 1/2", "parça 2/2" for a long one), and only the lines of logs or tool output that matter. Send the next part after the answer.`);
    }
    // Pasted code is not the message's voice: a comment like "// kullanıcı silmek istiyorsa" must not refuse a review.
    if (THIRD_PERSON.test(text.replace(/```[\s\S]*?(?:```|$)/g, ""))) {
      throw new Error(`write it as your own work, in the first person, not as a report about someone else. Not "Kullanıcı bir sayaç sayfası istiyor" but "Bir sayaç sayfası yapmak istiyorum, sence nasıl yapabilirim?"; not "the user asked for X" but "Şu dosyayı şöyle yazdım, sence buradaki hatalar neler?". Rewrite the message and send it again.`);
    }
    const secret = SECRETS.find(([, re]) => re.test(text));
    if (secret) {
      throw new Error(`nothing was sent: the message seems to contain ${secret[0]}. Secrets must not go to the web chat. Replace the value with a placeholder such as <API_KEY> or "***" (keep the name, so the code still reads right) and send it again.`);
    }
    const blocked = projectGuard(this.project, text);
    if (blocked) throw new Error(blocked);
    // The same message again, soon after (models repeat a call; seen 3x in a row in OpenCode 2.3.0): the
    // earlier answer, nothing sent. Each repeat would be a real message on the user's account.
    if (this.last && this.last.text === text && Date.now() - this.last.at < this.repeatWindowMs) return this.last.answer;
    const answer = this.ask(text, deep, search);
    this.last = { text, at: Date.now(), answer };
    answer.catch(() => {
      if (this.last?.answer === answer) this.last = null; // a failed send may be retried
    });
    return answer;
  }

  /** One message; DeepSeek's quota or rate limit comes back as one plain instruction instead of a stack of errors. */
  async ask(text, deep = false, search = false) {
    try {
      const res = await this.getRouter().ask({
      thinking: deep,
      search,
      phase: "chat",
      // The worker's own words open the conversation and continue it; c2f adds nothing (no set greeting).
      prompt: text,
      followUp: text,
      // Only the very first message opens a chat. Later ones go on in this conversation's chat even when
      // the router has lost track of it (after a limit, a restart): DeepSeekHttp still knows it.
      freshChat: !this.started,
      });
      this.started = true;
      return res;
    } catch (err) {
      const m = String(err?.message || err);
      if (!/usage limit|cooling down|budget of/i.test(m)) throw err;
      const until = /until (\d{1,2}:\d{2})|free again at (\d{1,2}:\d{2})|benched until (\d{1,2}:\d{2})/i.exec(m);
      const when = until ? until[1] || until[2] || until[3] : null;
      const paced = /c2f paces itself: ([^,]+), the next one can go at (\d{1,2}:\d{2})/.exec(m);
      if (paced) {
        throw new Error(`c2f is spreading your messages out (${paced[1]} already). Nothing was sent; nothing is broken. Go on with the work yourself and consult again after ${paced[2]}, with what you did meanwhile.`);
      }
      const said = /usage limit(?: \(quota used up\))?:?\s*([^\n(]*)/i.exec(m)?.[1]?.replace(/\s*\[quota\]/, "").trim();
      const quoted = said ? ` (DeepSeek said: "${said.slice(0, 160)}")` : "";
      if (/quota used up|\[quota\]/i.test(m)) {
        throw new Error(
          `DeepSeek's quota is used up${quoted}. No message is sent to DeepSeek ${when ? `before ${when}` : "for about an hour"}; nothing is broken. Tell the user once, in their language (e.g. "DeepSeek kotası doldu${when ? `, ${when}'de açılır` : ""}"), and finish the work on your own. Do not call the advisor again ${when ? `before ${when}` : "in this task"}.`,
        );
      }
      throw new Error(
        `DeepSeek asked to slow down${quoted}. Nothing is sent to it ${when ? `before ${when}` : "for a few minutes"}; nothing is broken and the quota is not used up. Go on with the work yourself and consult again ${when ? `after ${when}` : "in a few minutes"}, with what you did meanwhile. Mention it to the user in one sentence only if they are waiting on the advice.`,
      );
    }
  }
}

/**
 * Advisor conversations. One thread is one advisor conversation (one DeepSeek chat).
 * - With the OpenCode session (added to each call by the c2f-session plugin), the session decides: one
 *   OpenCode session, one DeepSeek chat, whatever the model passes or forgets.
 * - Without it (plugin missing, another client), the thread id shown at the end of every answer and sent
 *   back by the agent decides. Models forget it after a pause (seen with big-pickle), hence the plugin.
 * Kept in memory: after c2f restarts, the next call starts a new chat.
 * ponytail: in-memory only; persist session -> chat id/parent to disk if restarts turn out to matter.
 */
export class Threads {
  /**
   * `makeRouter(id)` builds the Router for a conversation; `hasChat(id)`: does DeepSeek still hold that
   * conversation's chat (kept on disk by DeepSeekHttp)? `sessionsFile` keeps OpenCode session -> thread
   * across restarts. `newId()` is injectable for tests.
   */
  constructor({ makeRouter, hasChat = () => false, sessionsFile = null, project = null, max = 50, newId = () => crypto.randomBytes(4).toString("hex") }) {
    this.project = project;
    this.makeRouter = makeRouter;
    this.hasChat = hasChat;
    this.sessionsFile = sessionsFile;
    this.max = max;
    this.newId = newId;
    this.open = new Map();
    this.bySession = new Map(); // OpenCode session id -> thread id
  }

  keptSessions() {
    try {
      return this.sessionsFile ? JSON.parse(fs.readFileSync(this.sessionsFile, "utf8")) : {};
    } catch {
      return {};
    }
  }

  keepSession(session, id) {
    if (!this.sessionsFile) return;
    try {
      const all = this.keptSessions();
      const month = Date.now() - 30 * 24 * 3_600_000;
      for (const [k, v] of Object.entries(all)) if (!(v.at > month)) delete all[k];
      all[session] = { thread: id, at: Date.now() };
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      const tmp = `${this.sessionsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, this.sessionsFile);
    } catch {
      /* without it a restart opens a new chat for this session */
    }
  }

  open_(id, resume) {
    const router = this.makeRouter(id);
    const t = { router, advisor: new Advisor({ getRouter: () => router, resume, project: this.project }) };
    this.open.set(id, t);
    return t;
  }

  /** The conversation for this OpenCode `session`, else for thread `id`, else a new one. Also after a restart. */
  get(id, session = "") {
    const s = String(session || "").trim();
    const known = s && (this.bySession.get(s) || this.keptSessions()[s]?.thread);
    const wanted = known || (s ? "" : String(id || "").trim());
    if (wanted && this.open.has(wanted)) return { id: wanted, ...this.open.get(wanted), lost: false };
    // A conversation from before a restart whose DeepSeek chat is still kept: go on in it.
    if (wanted && this.hasChat(wanted)) {
      if (s) this.bySession.set(s, wanted);
      return { id: wanted, ...this.open_(wanted, true), lost: false };
    }
    const fresh = this.newId();
    const t = this.open_(fresh, false);
    if (s) {
      this.bySession.set(s, fresh);
      this.keepSession(s, fresh);
    }
    if (this.open.size > this.max) {
      const oldest = this.open.keys().next().value;
      this.open.delete(oldest);
      for (const [k, v] of this.bySession) if (v === oldest) this.bySession.delete(k);
    }
    return { id: fresh, ...t, lost: Boolean(wanted) };
  }
}

/**
 * The OpenCode session a message came from, as noted by the c2f-session plugin in `dir`/oc-sessions.json
 * (OpenCode 2.x, where the plugin cannot add it to the call itself). "" when there is no fresh note.
 */
export function noteSession(dir, message) {
  try {
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "oc-sessions.json"), "utf8"));
    const hit = seen[crypto.createHash("sha1").update(String(message)).digest("hex")];
    return hit && Date.now() - hit.at < 120_000 ? String(hit.session) : "";
  } catch {
    return "";
  }
}
