#!/usr/bin/env node
/**
 * ChatToFree as an MCP server (stdio), so an agent such as OpenCode can use the web chat
 * models (ChatGPT, Claude, Gemini, DeepSeek) through the user's own signed-in browser, while
 * a free model does the orchestration.
 *
 * One process owns the bridge: tools share a single connection to the extension, and the
 * port is released after a quiet period so a terminal `c2f` is not locked out.
 *
 * stdout carries the protocol only; everything else goes to stderr.
 */
import readline from "node:readline";
import { Bridge } from "./bridge.js";
import { Router, needsBrowser } from "./router.js";
import { Threads, noteSession } from "./advisor.js";
import { hasAuth, authPath, sharedDeepSeek } from "./deepseek-http.js";
import { startApi, API_PORT } from "./api.js";
import fs from "node:fs";
import path from "node:path";
import { Limits } from "./limits.js";
import { Agent } from "./agent.js";
import { LocalModel } from "./local.js";
import { Workspace } from "./workspace.js";
import { ensureToken } from "./token.js";
import { readSiteStates } from "./site-status.js";
import { assertValid } from "./cmd-settings.js";
import {
  SITE_NAMES,
  REASONING,
  loadConfig,
  globalConfigPath,
  readConfigFile,
  writeConfigFile,
  setPath,
  sitePairs,
} from "./config.js";

const SERVER = { name: "c2f", version: "1.0.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const IDLE_STOP_MS = 90_000;
const MAX_TEXT = 12_000;

const log = (m) => process.stderr.write(`[c2f-mcp] ${m}\n`);
const clip = (s, n = MAX_TEXT) => (String(s).length > n ? `${String(s).slice(0, n)}\n… (${String(s).length - n} more characters)` : String(s));

// --- the bridge, shared and released when idle ------------------------------------------------

let bridge = null;
let idleTimer = null;
const jobs = new Map();
let jobSeq = 0;

function running() {
  return [...jobs.values()].find((j) => j.status === "running") || null;
}

// Advisor conversations, one per thread id (see Threads in advisor.js). cfg and bridge are set per call.
const threads = new Threads({
  makeRouter: (id) => new Router({ cfg: loadConfig(process.cwd()), bridge: null, log: () => {}, sessionKey: `advisor:${id}` }),
  hasChat: (id) => sharedDeepSeek(() => {}).has(`advisor:${id}`),
  sessionsFile: path.join(path.dirname(authPath()), "oc-threads.json"),
  project: process.cwd(),
});
// One tag per MCP `initialize`: a new OpenCode connection gets its own DeepSeek chats. Every DeepSeek chat
// key carries it, so two sessions in the same folder never share a web chat. initialize events are logged
// (pid, time, client) in mcp-sessions.log next to the config, to see how OpenCode opens sessions.
let sessionTag = Math.random().toString(36).slice(2, 6);

/** The bridge, or null when every site in use goes over HTTP (then another c2f holding the port, or no Chrome, does not matter). */
async function getBridgeIfNeeded(cfg) {
  return needsBrowser(cfg) ? getBridge(cfg) : null;
}

async function getBridge(cfg, waitMs = 40_000) {
  clearTimeout(idleTimer);
  if (!bridge) {
    const b = new Bridge({ port: cfg.port, requestTimeoutMs: cfg.requestTimeoutMs, log: () => {}, token: ensureToken() });
    try {
      await b.start();
    } catch (err) {
      if (String(err.code) === "EADDRINUSE") {
        throw new Error(`port ${cfg.port} is in use by another c2f process (a terminal "c2f build/serve" or another agent). Close it, or change "port" in the c2f config and in the extension options.`);
      }
      throw err;
    }
    bridge = b;
  }
  if (!bridge.connected) {
    const info = await bridge.waitForClient(waitMs);
    if (!info) {
      await releaseBridge();
      throw new Error("the ChatToFree browser extension did not connect. Open Chrome with the extension enabled (chrome://extensions → ChatToFree Bridge → Reload) and retry; `node src/cli.js doctor` diagnoses it.");
    }
  }
  return bridge;
}

async function releaseBridge() {
  const b = bridge;
  bridge = null;
  if (b) await b.stop().catch(() => {});
}

function scheduleIdleStop() {
  clearTimeout(idleTimer);
  if (running()) return;
  idleTimer = setTimeout(() => {
    if (!running()) releaseBridge();
  }, IDLE_STOP_MS);
}

// --- tools ------------------------------------------------------------------------------------

const siteEnum = { type: "string", enum: SITE_NAMES };
const reasoningEnum = { type: "string", enum: REASONING };

const TOOLS = [
  {
    name: "status",
    description: "Which web chat models can answer right now (ready, waiting out a rate limit, needs login). Read-only, sends no message, returns at once. Optional: the other tools report the same problems themselves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const cfg = loadConfig(process.cwd());
      const inUse = cfg.preferredSites.filter((s) => cfg.sites[s]?.enabled !== false);
      const limits = new Limits();
      const waiting = (site) => {
        const gate = limits.check(site, cfg.sites[site].limit);
        return gate.ok ? "" : ` (waiting: ${gate.reason})`;
      };
      const lines = [];
      // DeepSeek with a saved login goes straight over HTTP: no browser, nothing to wait for.
      const direct = inUse.includes("deepseek") && cfg.sites.deepseek?.transport !== "browser" && hasAuth();
      if (direct) {
        const login = await sharedDeepSeek(log).loginState();
        lines.push(login === "expired" ? "deepseek  NOT ready: its login expired. Only the user can fix it, by running: c2f giris" : `deepseek  direct: ready${waiting("deepseek")}`);
      }
      const viaBrowser = inUse.filter((s) => !(s === "deepseek" && direct));
      if (viaBrowser.length) {
        try {
          const b = await getBridge(cfg, 8000);
          for (const r of await readSiteStates(b, viaBrowser)) lines.push(`${r.site.padEnd(9)} ${r.verdict}${waiting(r.site)}`);
        } catch (err) {
          const why = String(err.message).split(/\.\s/)[0];
          for (const s of viaBrowser) lines.push(`${s.padEnd(9)} not available: ${why}${s === "deepseek" ? " (or save a login once: c2f kur)" : ""}`);
        }
      }
      return lines.join("\n") || "no site is enabled (c2f config)";
    },
  },
  {
    name: "models",
    description:
      "List what each site offers right now: selectable models (locked ones marked), reasoning levels, search toggle, and which are selected. Opens and closes menus, sends no message.",
    inputSchema: { type: "object", properties: { site: siteEnum }, additionalProperties: false },
    run: async ({ site }) => {
      const cfg = loadConfig(process.cwd());
      const b = await getBridge(cfg);
      const out = [];
      for (const s of site ? [site] : SITE_NAMES) {
        try {
          const r = (await b.settings({ site: s, op: "read" })).result;
          const model = r.model.supported ? r.model.options.map((o) => `${o.title}${o.selected ? " [selected]" : ""}${o.locked ? " [locked]" : ""}`).join(", ") : "no model picker";
          const reasoning = r.reasoning.supported
            ? `${r.reasoning.options.map((o) => o.level || o.title).join(" | ")} (current: ${r.reasoning.current})${r.reasoning.kind === "toggle" ? " on/off only" : ""}`
            : "not available";
          out.push(`${s}\n  model: ${model}\n  reasoning: ${reasoning}${r.search?.supported ? `\n  search: ${r.search.current}` : ""}`);
        } catch (err) {
          out.push(`${s}: ${err.message.split("\n")[0]}`);
        }
      }
      return out.join("\n");
    },
  },
  {
    name: "use",
    description:
      "Change one site's settings, saved for every session: model name, reasoning level, search, request budget per hour/day, cooldown minutes, enabled. Settings are applied to the site automatically before the next request.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteEnum,
        model: { type: "string", description: 'Model name as shown by `models`, e.g. "Haiku 5.5". "default" leaves the site\'s own choice.' },
        reasoning: reasoningEnum,
        search: { type: "string", enum: ["default", "on", "off"] },
        perHour: { type: "number", description: "Max requests per hour this tool may spend on the site (0 = unlimited)" },
        perDay: { type: "number", description: "Max requests per day (0 = unlimited)" },
        cooldown: { type: "number", description: "Minutes to stay away after the site reports its own usage limit" },
        enabled: { type: "boolean" },
      },
      required: ["site"],
      additionalProperties: false,
    },
    run: async (a) => {
      const pairs = sitePairs(a.site, { ...a, enable: a.enabled === true, disable: a.enabled === false });
      if (!pairs.length) throw new Error("nothing to change: pass model, reasoning, search, perHour, perDay, cooldown or enabled");
      const file = globalConfigPath();
      const obj = readConfigFile(file);
      for (const [k, v] of pairs) setPath(obj, k, v);
      assertValid(obj, `use ${a.site}`);
      writeConfigFile(file, obj);
      return `saved to ${file}\n${pairs.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n")}`;
    },
  },
  {
    name: "config",
    description: "Show every setting: site order, per-site model / reasoning / search / limits, per-phase overrides.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const cfg = loadConfig(process.cwd());
      const rows = Object.entries(cfg.sites).map(
        ([s, v]) => `${s.padEnd(9)} enabled=${v.enabled} model=${v.model} reasoning=${v.reasoning} search=${v.search} perHour=${v.limit.perHour || "unlimited"} perDay=${v.limit.perDay || "unlimited"} cooldown=${v.limit.cooldownMinutes}m`,
      );
      const phases = Object.entries(cfg.phases).map(([p, v]) => `phase ${p}: ${JSON.stringify(v)}`);
      return [`directory: ${process.cwd()}`, `build output (default): ${cfg.workspace}`, `order: ${cfg.preferredSites.join(" -> ")}`, ...rows, ...phases].join("\n");
    },
  },
  {
    name: "usage",
    description: "Requests this tool has spent per site (last hour / day), and which sites are cooling down after a usage limit.",
    inputSchema: { type: "object", properties: { reset: { type: "string", description: "Site name to clear its budget and cooldown" } }, additionalProperties: false },
    run: async ({ reset }) => {
      const cfg = loadConfig(process.cwd());
      const limits = new Limits();
      if (reset) {
        limits.clear(reset);
        return `${reset}: budget and cooldown cleared`;
      }
      return limits
        .status(cfg)
        .map((r) => `${r.site.padEnd(9)} ${r.enabled ? "on " : "OFF"} hour ${r.lastHour}${r.perHour ? `/${r.perHour}` : ""}  day ${r.lastDay}${r.perDay ? `/${r.perDay}` : ""}  ${r.available ? "available" : r.note}`)
        .join("\n");
    },
  },
  {
    name: "chat",
    description:
      "Ask ONE standalone question to the web chat model and get its reply. The model does NOT remember earlier `chat` calls: put everything it needs (code, errors, constraints) into the prompt, or pass fresh: false to continue the previous chat of this folder. Uses the user's real account, which is slowed down when messages come too often: use it for hard questions, not trivial ones. For a plan and reviews of one task use `advise` instead (it keeps one conversation).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        site: siteEnum,
        model: { type: "string", description: "Only with `site`: model name for this one request" },
        reasoning: reasoningEnum,
        fresh: { type: "boolean", description: "Start a new chat (default true). false continues this folder's previous chat (DeepSeek over HTTP only)" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    run: async (a) => {
      const sites = a.site ? { [a.site]: { ...(a.model ? { model: a.model } : {}), ...(a.reasoning ? { reasoning: a.reasoning } : {}) } } : a.reasoning ? Object.fromEntries(SITE_NAMES.map((s) => [s, { reasoning: a.reasoning }])) : undefined;
      const cfg = loadConfig(process.cwd(), { sites, preferredSites: a.site ? [a.site] : undefined });
      const b = await getBridgeIfNeeded(cfg);
      const lines = [];
      // Every call is a NEW web chat unless `fresh: false` asks to continue the folder's chat. (An MCP
      // server cannot tell OpenCode sessions apart, so continuing by default made a new session
      // inherit the previous one's DeepSeek chat.) DeepSeek over HTTP names the chat after the folder.
      const key = `${path.resolve(process.cwd())} · chat · ${sessionTag}`;
      const direct = !needsBrowser(cfg);
      const fresh = a.fresh ?? true;
      const router = new Router({ cfg, bridge: b, log: (m) => lines.push(m.trim()), sessionKey: direct ? key : null });
      const res = await router.ask({ phase: "chat", prompt: a.prompt, freshChat: fresh });
      // Only what went wrong on the way (a site skipped, a setting refused) is worth the caller's attention.
      const notes = lines.filter((l) => /^(skip|!)/.test(l));
      return `${res.reply}${notes.length ? `\n\n(${notes.join("; ")})` : ""}`;
    },
  },
  {
    name: "advise",
    description:
      "Your senior colleague: a stronger model (DeepSeek) on the user's own chat account, in one conversation per `thread` that it remembers and the user reads. Use it like an experienced developer you can message: before starting, after each step, when stuck, and for a file-by-file review at the end. Ask for detailed answers with reasons so you understand them, or ask it to write a hard part (an algorithm, a parser, tricky logic) with the language, signature, inputs and outputs, limits and the surrounding code; then fit it in and test it yourself. Write naturally from the actual situation, in the user's language and in the first person as the owner of the work: no set phrases or fixed openings, never 'the user wants' / 'Kullanıcı istiyor' (refused). Paste code in a code block (one file or class per message, at most 30,000 characters; split longer ones into numbered parts); from logs only the lines that matter; no JSON. Always do some work between two messages and never send the same message twice. If the answer says to wait or to sign in, tell the user once and carry on alone.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Your message about YOUR work, in your own words and the first person, saying what you need (an opinion, a detailed explanation, a review, or code). Never 'the user wants' / 'Kullanıcı istiyor'." },
        search: { type: "boolean", description: "true when the answer depends on something recent (a new library version, a changed API, an unfamiliar error): DeepSeek searches the web for this message." },
        deep: { type: "boolean", description: "true when you ask it to write or debug hard code (an algorithm, tricky logic): DeepSeek thinks longer first. Slower; leave it out otherwise." },
        thread: { type: "string", description: "Leave out on your FIRST call in this conversation. On every later call, pass the thread shown at the end of the previous c2f_advise answer, so the advisor keeps the context." },
      },
      required: ["message"],
      additionalProperties: false,
    },
    run: async (a) => {
      const cfg = loadConfig(process.cwd());
      const b = await getBridgeIfNeeded(cfg);
      // The OpenCode session, from the c2f-session plugin: in the call (OpenCode 1.x; not in the schema, the
      // model never sees it) or noted beside it (2.x). Without either, the thread id the model passes.
      const t = threads.get(a.thread, a.opencode_session || noteSession(path.dirname(authPath()), a.message));
      const note = t.lost ? "(That thread is not open any more, e.g. after a restart: this is a new conversation, so give the context again.)\n\n" : "";
      t.router.cfg = cfg;
      t.router.bridge = b; // the bridge is released when idle
      t.advisor.maxChars = cfg.advisorMaxChars;
      const res = await t.advisor.consult({ message: a.message, deep: a.deep === true, search: a.search === true });
      return `${note}${res.reply}\n\n(thread: ${t.id})`;
    },
  },
  {
    name: "build",
    description:
      "Have the web chat models BUILD a project: they design it, plan steps, write files and run commands in the workspace (default ./out under the current directory), then audit the result. Takes minutes (long thinking is normal) and uses real account quota. Returns when finished, or after `waitSeconds` with a job id and the current phase: then TELL THE USER in one or two sentences which phase it is in (design / plan / step N of M / audit) and what is done, and call `job` again with that id until it finishes. If it ends as failed, the finished steps are kept: call `build` again with the same request and `resume: true` to continue instead of starting over. The chat models' commands run on this machine inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "What to build, in plain language" },
        workspace: { type: "string", description: "Output directory, relative to the current directory (default ./out)" },
        site: siteEnum,
        reasoning: reasoningEnum,
        design: { type: "boolean", description: "Run the design + review round first (default: from config)" },
        resume: { type: "boolean", description: "Continue the unfinished build of this same request in this workspace (skips the steps already built)" },
        waitSeconds: { type: "number", description: "How long to wait before reporting progress and returning a job id (default 120)" },
      },
      required: ["request"],
      additionalProperties: false,
    },
    run: async (a) => {
      const busy = running();
      if (busy) throw new Error(`a build is already running (job ${busy.id}: "${busy.goal.slice(0, 60)}"). Follow it with \`job\`.`);
      const sites = a.reasoning ? Object.fromEntries((a.site ? [a.site] : SITE_NAMES).map((s) => [s, { reasoning: a.reasoning }])) : undefined;
      const cfg = loadConfig(process.cwd(), {
        workspace: a.workspace,
        design: a.design,
        sites,
        preferredSites: a.site ? [a.site] : undefined,
        // The agent calling us does the orchestration; the local model is not needed.
        local: { enabled: false },
      });
      const b = await getBridgeIfNeeded(cfg);
      const job = { id: `job${++jobSeq}`, goal: a.request, status: "running", lines: [], startedAt: Date.now(), workspace: cfg.workspace, progress: { phase: "starting", steps: [], done: [], turns: 0, last: "" } };
      jobs.set(job.id, job);
      const jobLog = (m) => job.lines.push(String(m).replace(/\x1b\[[0-9;]*m/g, ""));
      const agent = new Agent({ cfg, bridge: b, router: new Router({ cfg, bridge: b, log: jobLog, sessionKey: needsBrowser(cfg) ? null : `${path.resolve(cfg.workspace)} · build · ${sessionTag}` }), local: new LocalModel(cfg.local), workspace: new Workspace(cfg.workspace), log: jobLog, onEvent: (e) => trackProgress(job, e) });
      job.promise = agent
        .build(a.request, { approve: null, resume: Boolean(a.resume) })
        .then((res) => {
          job.result = res;
          job.status = res.incomplete?.length || res.verified === false ? "finished_with_problems" : "done";
        })
        .catch((err) => {
          job.status = "failed";
          job.error = err.message;
          // A rate limit does not clear by asking again: retries only spend the login and extend the wait.
          if (/usage limit|too frequent/i.test(err.message)) job.error += "\nDo NOT start this build again right now: DeepSeek is slowing this login down. Tell the user to wait a few minutes, then try once.";
        })
        .finally(() => {
          job.endedAt = Date.now();
          scheduleIdleStop();
        });
      const waitMs = Math.max(5, Number(a.waitSeconds) || 120) * 1000;
      await Promise.race([job.promise, new Promise((r) => setTimeout(r, waitMs))]);
      return describeJob(job);
    },
  },
  {
    name: "job",
    description: "Progress and result of a `build` that was still running when it returned. Pass the job id; `wait` seconds (default 120) blocks until it finishes or the time is up. After each answer, tell the user the phase in a sentence.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, wait: { type: "number" } }, required: ["id"], additionalProperties: false },
    run: async ({ id, wait }) => {
      const job = jobs.get(id);
      if (!job) throw new Error(`unknown job "${id}" (known: ${[...jobs.keys()].join(", ") || "none"})`);
      if (job.status === "running") await Promise.race([job.promise, new Promise((r) => setTimeout(r, Math.min(Number(wait) || 120, 600) * 1000))]);
      return describeJob(job);
    },
  },
];

/** Fold the agent's events into what a person wants to know: which phase, how far along. */
function trackProgress(job, e) {
  const p = job.progress;
  p.at = Date.now();
  if (e.type === "phase") p.phase = e.phase;
  if (e.type === "plan") {
    p.steps = e.steps;
    p.phase = "plan ready";
  }
  if (e.type === "step") {
    p.phase = "step";
    p.step = { index: e.index, total: e.total, title: e.title };
  }
  if (e.type === "step-done") p.done[e.index] = e.ok ? "ok" : "unfinished";
  if (e.type === "turn") {
    p.turns++;
    p.last = `${e.site}${e.continued ? " (same chat)" : ""} replied ${e.chars} chars${e.ms ? ` in ${Math.round(e.ms / 1000)}s` : ""} [${e.label}]`;
  }
}

function describePhase(job) {
  const p = job.progress;
  if (!p) return "";
  const built = p.done.filter((d) => d === "ok").length;
  const where = p.phase === "step" && p.step ? `step ${p.step.index + 1} of ${p.step.total}: ${p.step.title}` : p.phase;
  const out = [`phase: ${where}${p.steps.length ? ` (${built}/${p.steps.length} steps built)` : ""}`];
  if (p.last) out.push(`last model turn: ${p.last}`);
  if (p.at && job.status === "running") out.push(`last activity ${Math.round((Date.now() - p.at) / 1000)}s ago`);
  return out.join("\n");
}

function describeJob(job) {
  const secs = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  const head = `${job.id}: ${job.status} after ${secs}s, workspace ${job.workspace}`;
  const lines = [head, describePhase(job)].filter(Boolean);
  if (job.status === "running") lines.push("still running: tell the user the phase above in a sentence, then call `job` with this id again to follow it.");
  if (job.result) {
    lines.push(`${job.result.steps} steps, ${job.result.turns.length} model turns`);
    if (job.result.incomplete?.length) lines.push(`steps that did not finish: ${job.result.incomplete.join("; ")}`);
    if (job.result.verified === false) lines.push("the final audit gave no verdict (result not verified)");
  }
  if (job.error) lines.push(`error: ${job.error}`);
  if (job.status === "failed" && job.progress?.steps.length) lines.push(`kept: ${job.progress.done.filter((d) => d === "ok").length}/${job.progress.steps.length} steps are built in the workspace. Call \`build\` again with the same request and resume: true to continue.`);
  lines.push("--- log (last lines) ---", ...job.lines.slice(-25).map((l) => l.slice(0, 300)));
  return lines.join("\n");
}

// --- MCP over stdio ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

const publicTool = ({ name, description, inputSchema }) => ({ name, description, inputSchema });

// Talking to the web model is always on. Everything that drives it like a machine, and the settings
// tools that go with that, are offered only when the user turned `automation` on (see config.js).
const ALWAYS = new Set(["status", "advise"]);
const automationOn = () => {
  try {
    return loadConfig(process.cwd()).automation === true;
  } catch {
    return false;
  }
};

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      sessionTag = Math.random().toString(36).slice(2, 6);
      try {
        fs.appendFileSync(path.join(path.dirname(authPath()), "mcp-sessions.log"), `${new Date().toISOString()} pid ${process.pid} tag ${sessionTag} cwd ${process.cwd()} client ${JSON.stringify(params?.clientInfo || {})}\n`);
      } catch {
        /* diagnostics only */
      }
      const wanted = params?.protocolVersion;
      return send({
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions:
            "c2f gives you a senior colleague: a stronger model (DeepSeek) on the user's own chat account. Talk to it with `advise` in your own words, like to an experienced colleague: ask for detailed explanations, or for code for the hard parts. Talk often, with work in between; at the end send the code file by file for a review. The user reads the conversation. When a call says to wait or to sign in, tell the user and carry on alone.",
        },
      });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TOOLS.filter((t) => ALWAYS.has(t.name) || automationOn()).map(publicTool) } });
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ id, error: { code: -32602, message: `unknown tool "${params?.name}"` } });
      if (!ALWAYS.has(tool.name) && !automationOn()) {
        return send({ id, result: { isError: true, content: [{ type: "text", text: `${tool.name} is turned off. It drives the chat account like a machine, and that got an account suspended. Use \`advise\` instead. (Only the user can turn it on: c2f config set automation true)` }] } });
      }
      try {
        const text = await tool.run(params.arguments || {});
        return send({ id, result: { content: [{ type: "text", text: clip(text) }] } });
      } catch (err) {
        return send({ id, result: { isError: true, content: [{ type: "text", text: clip(err.message || String(err)) }] } });
      } finally {
        scheduleIdleStop();
      }
    }
    if (isRequest) return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err) {
    if (isRequest) send({ id, error: { code: -32603, message: err.message || String(err) } });
  }
}

/**
 * While this server runs, DeepSeek is also offered as a MODEL (OpenAI-compatible endpoint, src/api.js) so
 * OpenCode can pick it directly. One c2f process serves it; the others keep trying, so the endpoint stays
 * up as long as any of them is alive. Only with `automation` on (config.js); C2F_API_PORT=off (tests) turns it off.
 */
async function hostApi() {
  if (/^(off|0)$/i.test(process.env.C2F_API_PORT || "") || !automationOn()) return;
  const port = Number(process.env.C2F_API_PORT) || API_PORT;
  const server = await startApi({ port, log }).catch(() => null);
  if (server) log(`DeepSeek model endpoint on http://127.0.0.1:${port}/v1`);
  else setTimeout(hostApi, 5000).unref();
}
hostApi();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "parse error" } });
  }
  handle(msg).catch((err) => log(err.stack || err.message));
});
rl.on("close", async () => {
  await releaseBridge();
  process.exit(0);
});
process.on("SIGINT", () => rl.close());
log(`ready (cwd ${process.cwd()})`);
