/**
 * DeepSeek as a model for coding agents: an OpenAI-compatible endpoint (POST /v1/chat/completions) in
 * front of the DeepSeek web chat. OpenCode (or any OpenAI-compatible client) picks it as its model and
 * talks to DeepSeek directly, with tools.
 *
 * It uses the same client as the rest of c2f (src/deepseek-http.js), so the one-chat-at-a-time queue,
 * the cross-process lock, the pacing and the "too frequent" back-off all apply: this endpoint and the
 * c2f tools can never send on the login at the same moment.
 *
 * Two things the web chat does not have are done here:
 *  - Tools. The model is told to write <tool_call>{json}</tool_call> blocks; they are parsed out of its
 *    reply and returned as OpenAI tool_calls. Tool results go back as <tool_result> blocks.
 *  - Conversations. An agent resends the whole history on every request. A request that extends a
 *    conversation already sent goes into the SAME DeepSeek chat, and only the new messages are sent;
 *    anything else opens a new chat with the full transcript.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { authPath, sharedDeepSeek } from "./deepseek-http.js";
import { parseJsonLoose } from "./protocol.js";
import { Limits } from "./limits.js";
import { loadConfig } from "./config.js";

export const API_PORT = 8788;
/** What OpenCode is told it can pick. Other ids still work: "think" turns DeepThink on, "search" web search. */
export const API_MODELS = ["deepseek", "deepseek-thinking"];
/**
 * DeepSeek's web chat refuses a long message ("Content is too long"). Measured 2026-11-18: 60,000
 * characters accepted, 90,000 refused. OpenCode's first message (system prompt + tools) is about 29,000.
 * A prompt above the cap is shortened, and when DeepSeek still refuses it is halved once.
 */
const MAX_PROMPT_CHARS = Number(process.env.C2F_MAX_PROMPT_CHARS) || 60_000;
const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_CONVERSATIONS = 100;

export function apiKeyPath() {
  return path.join(path.dirname(authPath()), "api-key");
}

/** The key clients must send. Without one, any web page open in a browser could spend the DeepSeek login. */
export function ensureApiKey(file = apiKeyPath()) {
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    if (key) return key;
  } catch {
    /* first run */
  }
  const key = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key);
  return key;
}

export function modelFlags(id) {
  const m = String(id || "").toLowerCase();
  return { thinking: /think|reason/.test(m), search: /search/.test(m) && !/nosearch/.test(m) };
}

// --- turning an OpenAI request into text for the chat ---------------------------------------------

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text || "" : p?.type ? `[${p.type} omitted]` : "")).join("\n")
      : content == null
        ? ""
        : String(content);

const clipMiddle = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.floor(max * 0.35))}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-Math.floor(max * 0.65))}`);

/** The tools the model may use. c2f's own tools are left out: through them DeepSeek would only consult itself. */
const functionsOf = (tools) => (Array.isArray(tools) ? tools : []).map((t) => t?.function || (t?.name ? t : null)).filter((f) => f?.name && !/^c2f_/.test(f.name));

export function toolsBlock(tools, { compact = false } = {}) {
  const fns = functionsOf(tools);
  if (!fns.length) return "";
  // compact: when space is short, the names and parameter shapes matter more than the prose.
  const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "description" && k !== "$schema").map(([k, x]) => [k, strip(x)])) : v);
  const list = fns.map((f) => `## ${f.name}\n${String(f.description || "").replace(/\s+/g, " ").trim().slice(0, compact ? 160 : 600)}\nparameters: ${JSON.stringify(compact ? strip(f.parameters || {}) : f.parameters || { type: "object", properties: {} })}`).join("\n\n");
  return `# Tools
You are connected to a program that runs tools on the user's computer. To use a tool, write a block exactly like this (several blocks in one reply are fine):

<tool_call>
{"name": "TOOL_NAME", "arguments": {"param": "value"}}
</tool_call>

Rules:
- Inside the block: ONE JSON object and nothing else. Escape newlines inside strings as \\n and quotes as \\".
- After your tool_call blocks, STOP. Never write a tool's result yourself: it arrives in the next message inside <tool_result>.
- To act on files or run commands you MUST use a tool; describing the action does nothing.
- When the task is done, or you only need to talk to the user, answer in plain text without any tool_call block.
- Use only these tools:

${list}`;
}

const REMINDER = "(To act, reply with <tool_call> blocks; when the task is done, reply in plain text.)";

function renderMessage(m, toolNames) {
  if (m.role === "tool") {
    return `<tool_result name="${toolNames.get(m.tool_call_id) || m.name || "tool"}">\n${clipMiddle(textOf(m.content), MAX_TOOL_RESULT_CHARS)}\n</tool_result>`;
  }
  if (m.role === "assistant") {
    const calls = (m.tool_calls || []).map((c) => `<tool_call>\n${JSON.stringify({ name: c.function?.name, arguments: parseJsonLoose(c.function?.arguments || "{}") ?? {} })}\n</tool_call>`);
    return [textOf(m.content).trim(), ...calls].filter(Boolean).join("\n");
  }
  return textOf(m.content);
}

/** tool_call_id -> tool name, from the assistant messages that made the calls. */
function toolNameIndex(messages) {
  const names = new Map();
  for (const m of messages) for (const c of m.tool_calls || []) if (c?.id) names.set(c.id, c.function?.name || "tool");
  return names;
}

/** The first message of a chat: instructions, tools, and the whole conversation so far. */
export function renderFull(messages, tools, max = MAX_PROMPT_CHARS) {
  const names = toolNameIndex(messages);
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n\n").trim();
  const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const block = toolsBlock(tools, { compact: max < MAX_PROMPT_CHARS });
  const head = [system, block].filter(Boolean).join("\n\n");
  let body;
  if (rest.length === 1 && rest[0].role === "user") body = `# Request\n${renderMessage(rest[0], names)}`;
  else body = `# Conversation so far\n${rest.map((m) => `[${m.role}]\n${renderMessage(m, names)}`).join("\n\n")}\n\nContinue from here.`;
  const tail = block ? `\n\n${REMINDER}` : "";
  // Too long: the instructions and the latest messages matter most.
  const room = Math.max(4_000, max - head.length - tail.length - 4);
  return `${head ? `${head}\n\n` : ""}${body.length > room ? `[... earlier conversation omitted ...]\n${body.slice(-room)}` : body}${tail}`;
}

/** A later message into an open chat: only what is new. */
export function renderTail(newMessages, allMessages, tools, { toolsChanged = false, max = MAX_PROMPT_CHARS } = {}) {
  const names = toolNameIndex(allMessages);
  const parts = newMessages.map((m) => (m.role === "user" || m.role === "tool" ? renderMessage(m, names) : `[${m.role}]\n${renderMessage(m, names)}`));
  if (toolsChanged) parts.unshift(functionsOf(tools).length ? `The available tools changed.\n\n${toolsBlock(tools)}` : "No tools are available for this reply: answer in plain text, without tool_call blocks.");
  const block = functionsOf(tools).length ? `\n\n${REMINDER}` : "";
  return clipMiddle(parts.join("\n\n"), max - block.length) + block;
}

// --- reading the reply ------------------------------------------------------------------------

/** How much of a growing reply can be shown already: everything before a tool_call block, or before a tail that may become one. */
export function safeLength(text) {
  const at = text.search(/<tool_call>|[<＜]\s*[|｜]|[<＜]\s*(?:function_calls|tool_calls|invoke\s)/i);
  if (at !== -1) return at;
  const tag = "<tool_call>";
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) if (text.toLowerCase().endsWith(tag.slice(0, k))) return text.length - k;
  return text.length;
}

function asCall(obj) {
  if (!obj || typeof obj !== "object") return null;
  const o = obj.tool_call || obj.function_call || obj.function || obj;
  const name = o.name || o.tool || o.tool_name;
  if (typeof name !== "string" || !name) return null;
  let args = o.arguments ?? o.args ?? o.parameters ?? o.input ?? {};
  if (typeof args === "string") args = parseJsonLoose(args) ?? { input: args };
  return { name, arguments: args && typeof args === "object" ? args : {} };
}

/**
 * DeepSeek's own tool-call markup, which it sometimes writes instead of the format it was asked for.
 * A complete real reply is kept in test/fixtures/dsml-reply.txt:
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="bash">
 *   <｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜ parameter>
 *   <｜｜DSML｜｜ parameter name="timeout" string="false">5000</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 * Values are raw text when string="true", JSON otherwise. Other spellings seen in the wild are accepted
 * too: one bar, no DSML prefix (<function_calls><invoke name=..>), full-width brackets, curly quotes,
 * missing closing tags. Returns null when the reply has none of it.
 */
const DSML_PREFIX = String.raw`<\s*(\/)?\s*(?:\|+\s*DSML\s*\|+\s*)?(?:DSML)?(?:[\w.-]+:)?`;
function parseDsml(text, tools) {
  // Same length as the original, so positions carry over.
  const norm = text.replace(/｜/g, "|").replace(/＜/g, "<").replace(/＞/g, ">").replace(/[“”＂]/g, '"').replace(/[‘’＇]/g, "'");
  const start = norm.search(new RegExp(String.raw`<\s*\|+\s*DSML|${DSML_PREFIX}(?:(?:tool|function)[\s_-]*calls\s*>|invoke\s+name\s*=)`, "i"));
  if (start === -1) return null;
  const region = norm.slice(start).replace(new RegExp(`${DSML_PREFIX}(invoke|parameter)\\b`, "gi"), (_, close, name) => `<${close ? "/" : ""}DSML:${name.toLowerCase()}`);
  const schemas = new Map(functionsOf(tools).map((f) => [f.name, f.parameters?.properties || {}]));
  const calls = [];
  for (const inv of region.matchAll(/<DSML:invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)(?=<\/DSML:invoke|<DSML:invoke\s|$)/g)) {
    const args = {};
    for (const p of inv[2].matchAll(/<DSML:parameter\s+name\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)(<\/DSML:parameter\s*>|(?=<DSML:parameter\s)|$)/g)) {
      const raw = p[4] ? p[3] : p[3].trimEnd(); // without its closing tag, the trailing blank lines are not part of the value
      const asString = /string\s*=\s*["']true/i.test(p[2]) || (!/string\s*=\s*["']false/i.test(p[2]) && schemas.get(inv[1])?.[p[1]]?.type === "string");
      const json = asString ? null : parseJsonLoose(raw.trim());
      args[p[1]] = asString || (json === null && raw.trim() !== "null") ? raw : json;
    }
    calls.push({ name: inv[1], arguments: args });
  }
  return { content: text.slice(0, start).trim(), calls, raw: text.slice(start, start + 300) };
}

/**
 * Split a reply into what is said and what is to be done. Returns { content, calls, bad }: `bad` lists
 * tool_call blocks that could not be read (so the caller can ask for them again instead of losing them).
 */
export function parseReply(text, tools = []) {
  const known = new Set(functionsOf(tools).map((f) => f.name));
  const calls = [];
  const bad = [];
  const take = (raw) => {
    const parsed = parseJsonLoose(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    const list = Array.isArray(parsed) ? parsed : parsed?.tool_calls ? parsed.tool_calls : [parsed];
    const got = list.map(asCall).filter(Boolean);
    if (got.length) calls.push(...got);
    else bad.push(String(raw).trim().slice(0, 300));
  };
  // Closed blocks, then one left open at the very end (the model stopped right after the JSON).
  let content = String(text || "").replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (_, raw) => (take(raw), ""));
  content = content.replace(/<tool_call>\s*([\s\S]+)$/i, (_, raw) => (take(raw), ""));
  // None of the asked-for blocks: maybe the model used its own markup. (Checked second, so a file that
  // merely contains such markup inside a proper tool_call is not mistaken for one.)
  if (!calls.length && !bad.length) {
    const dsml = parseDsml(String(text || ""), tools);
    if (dsml) return { content: dsml.content, calls: dsml.calls, bad: dsml.calls.length ? [] : [dsml.raw] };
  }
  // No tags at all, but the whole reply is a call for a tool that exists: models sometimes drop the tags.
  if (!calls.length && !bad.length && known.size) {
    const bare = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    if (/^[[{]/.test(bare)) {
      const parsed = parseJsonLoose(bare);
      const got = (Array.isArray(parsed) ? parsed : parsed?.tool_calls ? parsed.tool_calls : [parsed]).map(asCall).filter((c) => c && known.has(c.name));
      if (got.length) {
        calls.push(...got);
        content = "";
      }
    }
  }
  return { content: content.trim(), calls, bad };
}

// --- conversations: which DeepSeek chat a request belongs to ---------------------------------------

const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

/**
 * What identifies a conversation across requests. Only what the client cannot change afterwards counts:
 * the user's own messages. Assistant turns and tool results are matched by position (clients rewrite
 * them: re-serialised arguments, cleared old tool output), and the system prompt is left out (it carries
 * the date, the file tree and other things that move).
 */
export function signature(messages) {
  return messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => (m.role === "user" ? `U${hash(textOf(m.content))}` : m.role === "assistant" ? "A" : `T${m.tool_call_id || ""}`));
}

export class Conversations {
  constructor(max = MAX_CONVERSATIONS) {
    this.list = [];
    this.max = max;
  }
  /** The stored conversation this request continues (the longest one it extends), or null. */
  match(sig) {
    let best = null;
    for (const c of this.list) {
      if (c.sig.length >= sig.length || !c.sig.every((x, i) => x === sig[i])) continue;
      if (!best || c.sig.length > best.sig.length || (c.sig.length === best.sig.length && c.at > best.at)) best = c;
    }
    return best;
  }
  save(conv) {
    conv.at = Date.now();
    if (!this.list.includes(conv)) this.list.push(conv);
    if (this.list.length > this.max) this.list.sort((a, b) => a.at - b.at).splice(0, this.list.length - this.max);
  }
  drop(conv) {
    this.list = this.list.filter((c) => c !== conv);
  }
}

// --- the endpoint -------------------------------------------------------------------------------

const tooLongErr = (err) => /too long/i.test(String(err?.message));

const isTitleRequest = (messages, tools) => !functionsOf(tools).length && /title generator|generate a (brief |short |concise )?title/i.test(messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join(" "));

export class Api {
  /**
   * `budget()` returns DeepSeek's { perHour, perDay, cooldownMinutes }. Every message sent from here is
   * counted in the same file as the advisor's, so the hourly and daily budget hold for this path too
   * (it used to bypass them: 35 messages in a morning showed up as 3).
   */
  constructor({ client = sharedDeepSeek(), key = ensureApiKey(), log = () => {}, timeoutMs = 1_800_000, limits = new Limits(), budget = () => loadConfig(process.cwd()).sites.deepseek.limit } = {}) {
    this.limits = limits;
    this.budget = budget;
    this.client = client;
    this.key = key;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.convs = new Conversations();
    this.seq = 0;
  }

  /** One completion: returns { content, reasoning, calls, usage }. `onText` gets the answer text as it grows. */
  async complete(body, { onText } = {}) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = body.tools || [];
    if (!messages.some((m) => m.role === "user")) throw Object.assign(new Error("messages must contain a user message"), { status: 400 });
    // Naming a session costs nothing here; it must not open a chat or spend a message on the login.
    if (isTitleRequest(messages, tools)) {
      const first = textOf(messages.find((m) => m.role === "user").content).replace(/\s+/g, " ").trim();
      return { content: first.split(" ").slice(0, 6).join(" ").slice(0, 50) || "New session", reasoning: "", calls: [], usage: { in: 0, out: 0 } };
    }
    const flags = modelFlags(body.model);
    const sig = signature(messages);
    const toolsHash = hash(functionsOf(tools).map((f) => f.name).sort().join(","));
    const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer");
    let conv = this.convs.match(sig);
    const ask = (prompt, continuing, cb) => {
      const gate = this.limits.check("deepseek", this.budget());
      if (!gate.ok) throw new Error(`deepseek hit a usage limit: ${gate.reason}`);
      this.limits.record("deepseek");
      return this.client.chat({ prompt, continuing, key: conv.key, thinking: flags.thinking, search: flags.search, timeoutMs: this.timeoutMs, onText: cb });
    };

    let prompt;
    let res;
    if (conv) {
      prompt = renderTail(rest.slice(conv.sig.length), messages, tools, { toolsChanged: conv.toolsHash !== toolsHash });
      try {
        res = await ask(prompt, true, onText);
      } catch (err) {
        if (!/context_lost/i.test(err.message) && !tooLongErr(err)) throw err;
        this.log(`api: the chat of ${conv.key} cannot be continued (${String(err.message).slice(0, 60)}); resending the conversation into a new one`);
        this.convs.drop(conv);
        conv = null;
      }
    }
    const open = (max) => {
      conv = { key: `api-${process.pid}-${++this.seq}`, sig: [] };
      prompt = renderFull(messages, tools, max);
      this.log(`api: new chat ${conv.key}, ${prompt.length} characters`);
      return ask(prompt, false, onText);
    };
    if (!conv) {
      try {
        res = await open(MAX_PROMPT_CHARS);
      } catch (err) {
        if (!tooLongErr(err)) throw err;
        this.log("api: DeepSeek said the message is too long; sending a shorter one");
        res = await open(Math.floor(MAX_PROMPT_CHARS / 2));
      }
    }
    let parsed = parseReply(res.reply, tools);
    // A tool call that cannot be read would be lost and the agent would stop: ask for it once more.
    if (parsed.bad.length && !parsed.calls.length) {
      this.log(`api: unreadable tool_call from the model; asking for it again`);
      const again = await ask(`Your <tool_call> block could not be read as JSON:\n${parsed.bad[0]}\n\nSend it again: valid JSON only inside <tool_call>...</tool_call>, newlines inside strings written as \\n.`, true, null);
      const second = parseReply(again.reply, tools);
      if (second.calls.length) parsed = { content: parsed.content, calls: second.calls, bad: [] };
      else parsed = { content: [parsed.content, second.content].filter(Boolean).join("\n\n") || res.reply, calls: [], bad: [] };
      res = { ...again, reply: res.reply + again.reply, thinking: res.thinking };
    }
    this.log(`api: ${conv.key} turn ${Math.ceil((sig.length + 1) / 2)}: sent ${prompt.length} characters, ${parsed.calls.length ? `tool calls ${parsed.calls.map((c) => c.name).join(", ")}` : "plain answer"}`);
    conv.sig = [...sig, "A"];
    conv.toolsHash = toolsHash;
    this.convs.save(conv);
    return { content: parsed.content, reasoning: res.thinking || "", calls: parsed.calls, usage: { in: Math.ceil(prompt.length / 4), out: Math.ceil(String(res.reply).length / 4) } };
  }

  /** node:http request handler. */
  async handle(req, res) {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/health") return send(200, { status: "ok", service: "c2f" });
    if ((req.headers.authorization || "") !== `Bearer ${this.key}`) return send(401, { error: { message: "missing or wrong API key (see c2f kur)", type: "authentication_error" } });
    if (req.method === "GET" && url.pathname === "/v1/models") return send(200, { object: "list", data: API_MODELS.map((id) => ({ id, object: "model", owned_by: "c2f" })) });
    if (!(req.method === "POST" && url.pathname === "/v1/chat/completions")) return send(404, { error: { message: "not found", type: "not_found" } });

    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 30 * 1024 * 1024) throw new Error("request body too large");
        chunks.push(c);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (err) {
      return send(400, { error: { message: `bad request: ${err.message}`, type: "invalid_request_error" } });
    }
    const id = `chatcmpl-${crypto.randomBytes(8).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || API_MODELS[0];
    const failure = (err) => {
      let m = String(err?.message || err);
      const status = err?.status || (/usage limit|too frequent/i.test(m) ? 429 : /needs login|no DeepSeek login|has no token|login is incomplete/i.test(m) ? 401 : 502);
      // What the person at the screen has to do, in their words; the agent shows this text as it is.
      if (status === 401) m = `DeepSeek girişi yok ya da eskimiş. Bir terminalde şunu çalıştır:  c2f giris   (${m.split(".")[0]})`;
      if (status === 429) m = `DeepSeek çok sık mesaj gönderildiğini söylüyor. Birkaç dakika bekleyip tekrar dene.   (${m.slice(0, 120)})`;
      return { status, body: { error: { message: m, type: status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "upstream_error" } } };
    };
    const toolCalls = (calls) => calls.map((c, index) => ({ index, id: `call_${crypto.randomBytes(6).toString("hex")}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
    const usageOf = (u) => ({ prompt_tokens: u.in, completion_tokens: u.out, total_tokens: u.in + u.out });

    if (!body.stream) {
      try {
        const out = await this.complete(body);
        const calls = toolCalls(out.calls).map(({ index, ...c }) => c);
        return send(200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: out.content || (calls.length ? null : ""), ...(out.reasoning ? { reasoning_content: out.reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
          usage: usageOf(out.usage),
        });
      } catch (err) {
        const f = failure(err);
        return send(f.status, f.body);
      }
    }

    // Streaming. The answer's text is passed on as it grows, but only up to where a tool_call block could
    // begin: what follows is held back and delivered as tool_calls once the reply is complete.
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    // A quiet line while DeepSeek thinks or a rate limit is waited out: comment lines keep the connection open.
    const beat = setInterval(() => res.write(": waiting\n\n"), 15_000);
    let shown = "";
    chunk({ role: "assistant", content: "" });
    try {
      const out = await this.complete(body, {
        onText: (text) => {
          const safe = text.slice(0, safeLength(text));
          if (safe.length > shown.length && safe.startsWith(shown)) {
            chunk({ content: safe.slice(shown.length) });
            shown = safe;
          }
        },
      });
      if (out.reasoning) chunk({ reasoning_content: out.reasoning });
      // What was not shown yet: all of it when nothing was streamed, else text that came after a block.
      const seen = shown.trim();
      if (!seen) {
        if (out.content) chunk({ content: out.content });
      } else if (out.content.startsWith(seen) && out.content.length > seen.length) chunk({ content: out.content.slice(seen.length) });
      const calls = toolCalls(out.calls);
      if (calls.length) chunk({ tool_calls: calls });
      chunk({}, calls.length ? "tool_calls" : "stop", { usage: usageOf(out.usage) });
    } catch (err) {
      res.write(`data: ${JSON.stringify(failure(err).body)}\n\n`);
    } finally {
      clearInterval(beat);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

/**
 * Start the endpoint on 127.0.0.1. Resolves to the server, or null when the port is taken (another c2f
 * process already serves it, which is fine: they share the same login queue).
 */
export function startApi({ port = API_PORT, log = () => {}, api = new Api({ log }) } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      api.handle(req, res).catch((err) => {
        log(`api: ${err.message}`);
        try {
          res.end();
        } catch {
          /* gone */
        }
      });
    });
    server.requestTimeout = 0; // a turn may take many minutes
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
