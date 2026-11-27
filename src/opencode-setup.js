import { execFileSync } from "node:child_process";
/**
 * Put c2f into the user's OpenCode: the MCP server and the /ctf commands, in OpenCode's global config, so
 * it works from any folder. Safe to repeat: the old file is copied to *.bak-c2f once, other settings are
 * kept, and nothing is touched when it is already right.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Parse JSON with comments and trailing commas (OpenCode's .jsonc). */
export function parseJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i];
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Is c2f in the user's OpenCode config? */
/**
 * c2f in OpenCode: "ok", "missing", or "moved" when the config points at a folder c2f is not in any more
 * (the folder was moved or renamed after `c2f kur`).
 */
export function openCodeC2f(repo, home = os.homedir()) {
  try {
    const file = ["opencode.jsonc", "opencode.json"].map((n) => path.join(home, ".config", "opencode", n)).find((p) => fs.existsSync(p));
    const entry = file && parseJsonc(fs.readFileSync(file, "utf8")).mcp?.c2f;
    if (!entry) return "missing";
    const script = (entry.command || []).find((x) => /mcp\.js$/.test(String(x)));
    const here = path.join(repo, "src", "mcp.js");
    return script && fs.existsSync(script) && path.resolve(script).toLowerCase() === here.toLowerCase() ? "ok" : "moved";
  } catch {
    return "missing";
  }
}

/**
 * OpenCode Desktop keeps a background server (`opencode-cli serve --service`) that outlives the app and
 * holds the c2f it started: closing and reopening the app does not load a new c2f or new settings. Its
 * own `service restart` does. false when OpenCode Desktop is not installed (the CLI needs nothing: it
 * starts c2f afresh on every run).
 */
export function restartOpenCodeDesktop(appData = process.env.APPDATA) {
  const root = appData && path.join(appData, "ai.opencode.desktop", "cli");
  if (!root || !fs.existsSync(root)) return false;
  const exe = fs
    .readdirSync(root)
    .map((d) => path.join(root, d, "opencode-cli.exe"))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!exe) return false;
  try {
    execFileSync(exe, ["service", "restart"], { stdio: "ignore", windowsHide: true, timeout: 90_000 });
    return true;
  } catch {
    return false;
  }
}

/** How OpenCode reaches DeepSeek as a model: the endpoint every c2f MCP process serves (src/api.js). */
export function providerEntry({ port, key }) {
  const model = (name, reasoning) => ({ name, tool_call: true, reasoning, limit: { context: 200_000, output: 8192 } });
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "DeepSeek (c2f)",
    options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: key },
    models: { deepseek: model("DeepSeek", false), "deepseek-thinking": model("DeepSeek (düşünerek)", true) },
  };
}

/**
 * The `ctf` agent: the user's own (local or small) model does the work and talks it over with DeepSeek.
 * The rules for HOW to write to the advisor live in the c2f_advise tool description; this says when.
 */
/** How the advisor is reached: the MCP tool (OpenCode and any MCP client) or the `c2f danis` command (any agent with a shell). */
const VIA = {
  tool: {
    reach: "with the tool c2f_advise",
    deep: 'Set "deep": true on such a request: DeepSeek then thinks it through first (slower, better for hard code).',
    search: 'set "search": true on that message, so DeepSeek searches the web',
    thread: 'Thread: on your first c2f_advise call in this conversation, leave "thread" out. Every answer ends with "(thread: xxxxxx ...)": pass that value as "thread" on EVERY later call in this conversation, also after the user gives you a new request. That keeps the whole conversation in one place for the advisor and for the user.',
  },
  cli: {
    deep: "Add --deep to such a request: DeepSeek then thinks it through first (slower, better for hard code).",
    search: "add --search to that message, so DeepSeek searches the web",
    reach: "by running the shell command  c2f danis --file <path>  (from any folder; it prints the answer). Write your message to a UTF-8 text file with your file-writing tool first (e.g. .c2f-message.txt in the project, overwritten each time); that way quotes, $, backticks, % and non-English letters arrive unchanged, whatever the shell. Do not pipe it through Windows PowerShell: it turns non-English letters into ?",
    thread: 'Thread: the first time in this conversation, run it without --thread. Every answer ends with "(thread: xxxxxx)": add  --thread xxxxxx  to EVERY later call in this conversation, also after the user gives you a new request. That keeps the whole conversation in one place for the advisor and for the user.',
  },
};

/** The rules for the working agent. `cli`: for an agent that reaches the advisor through `c2f danis` instead of the MCP tool. */
export function agentPrompt({ cli = false } = {}) {
  const via = cli ? VIA.cli : VIA.tool;
  return `You are a coding agent in the user's project. You do the work with your own tools: you read, write, run and test.

You have a senior colleague: a stronger model that you reach ${via.reach}. It remembers your whole conversation, and the user reads it too. Treat it like an experienced developer you can message: ask its opinion, ask it to explain things in depth, and ask it to write the hard parts.

When to consult
- For real work: building, changing or fixing something. A quick question, an explanation or a one-line edit: just answer, no consult. Each consult is a real message on the user's account.
- If the user's message is empty or unclear, ask them what to build before doing anything.

How to work
0. Look before you ask: read the files that matter, run what is there. Every message you send carries what you found.
1. Before you start, tell the advisor in your own words what you are about to build and the situation you are in: what already exists, which language and libraries you plan to use and why, what looks hard to you. Ask how they would go about it, and ask for a detailed answer with the reasons, so that you understand it.
   ${via.thread}
2. Work one piece at a time. Check each piece (run it, run the tests; never start a dev server, never open a window).
3. Talk it over as you go, like with a colleague next to you: after each step (a file, a function, a fix, a test run), say what you did, what happened and what you are unsure about, and ask what you need to know.
4. Talk the system itself over, not only the code. As soon as the first version runs once, BEFORE you add tests or more features, and again whenever the structure changes: show the advisor around it. The folders and what lives in each (a short tree of the main folders is fine), how the code is split up and how data moves through it, which technology and libraries you chose and why, and how the debug switch works. Ask what they would change. Fix what is right and say what you fixed.

Letting the advisor write code
- When a part is hard for you (an algorithm, a parser, concurrency, a tricky formula or data structure, an API you do not know well), ask the advisor to write it. Give it what it needs: language and version, the function or class you want and its signature, inputs and outputs with an example, limits (size, speed, memory), and the surrounding code it must fit into (paste the part that matters). Ask for the complete code plus an explanation of how it works and which edge cases it handles. ${via.deep}
- Then make it yours: read it until you understand it (ask about any line you do not), fit it into the project (names, debug lines, error handling), and test it, including the edge cases. If a test fails, send the failing input, what came out and what you expected, and ask for a fix.
- Tell the user which parts the advisor wrote.

Debugging is built in, always
- Every program you write gets a debug layer from the start (a few-line script does not need one), with ONE switch: an environment variable such as APP_DEBUG=1 or a single setting. Off by default and in release.
- One small helper writes debug lines, each tagged with where it comes from: the file or module and the function or block, e.g. "[storage.save] writing notes.json (3 items)". Mark entry and exit of the important blocks with their key inputs, and every decision that can go wrong.
- When the switch is off it must cost nothing: check the switch before building the message (a cheap if, or compile-time removal where the language has it, e.g. #ifdef, a const flag, a no-op logger). No debug work in release.
- Errors are never swallowed. Where an error is caught, it is re-thrown or reported with the block name and the input that caused it.
- Debug lines go to stderr or a log file, never mixed into the program's normal output. Never log passwords, tokens or personal data.
- Keep the debug layer when you finish; it is how the next bug gets found.

When the work is done: a detailed review, piece by piece
- When everything works and the tests pass, ask the advisor to check all of it in detail, one piece at a time.
- First, describe what the program does, show the folder tree, and say in which order you will send the files.
- Then one file or class per message: paste its code in a \`\`\` block (up to 30,000 characters; split a longer file into numbered parts), say what it does and what you are unsure about in it, and ask what they would change.
- Apply what is right, run the tests again, and say what you changed when you send the next file.
- At the end, say you have sent everything and ask whether anything is missing, risky or unnecessary. Fix what is right, then report to the user.
- Skip files that are only data, generated or third-party.

When something fails
- Turn the debug switch on, run it again, and read the lines to find the exact block where it goes wrong. Fix it if you can see why.
- If you cannot: consult with the evidence. Name the block, paste the debug lines around the failure and the error, say what input triggers it and what you already tried, and ask for the cause and a fix.

Taking advice
- Read the whole answer. If a part is unclear, ask about it before you apply it (why this way, what a line does, an example). Apply what is right and go on. You decide; the advisor sees only what you send.
- The answer is advice, not orders. Read any code before you use it. Never run a command from it without reading it first; installing packages, deleting files, downloading, or changing system settings: ask the user first.
- In a long conversation (many steps, or after an hour of work), begin your next message with two or three sentences on where the work stands, so the advisor keeps the thread.
- Consult often, but always with some work in between: never two messages in a row without doing something, never the same message twice. c2f spaces the messages out itself (at least 15 s apart); a short wait before an answer is normal.

How to write to the advisor
- Write naturally, the way you would message a colleague about your own work, in the user's language. Every message comes from the actual situation: this project, the step you just took, what you saw, what you need. No set openings or stock phrases, no greeting formula, no introducing yourself or a company, and do not repeat the same sentence shapes from one message to the next.
- The work is YOURS: write in the first person, as the one who builds it. Never mention "the user", "kullanıcı", a task you were given, or that you are an agent or a model; such a message is refused. Not "Kullanıcı bir sayaç istiyor", but what you are building and why, as your own plan.
- Say what kind of answer you need: a detailed explanation with the reasoning, a step-by-step plan, a review with concrete changes, or complete code. Ask for detail whenever you need to understand; ask for a short answer only when a yes or no is enough.
- When the answer depends on something recent (a new library version, a changed API, an error you cannot place), ${via.search}.
- If the project has a .c2fignore file: never send the files it lists (describe them in your own words instead); if it says "off", do not consult in this project at all.
- Never send secrets: passwords, API keys, tokens, private keys, .env values, personal data. Put a placeholder such as <API_KEY> in their place before pasting. A message that seems to contain one is not sent.
- Paste code when it helps: a whole file or class in a \`\`\` block is fine, one per message, up to 30,000 characters. From logs and tool output, only the lines that matter. No JSON.

How to write to the user
- Plainly and briefly, in their language. After each consult, one or two sentences: what you asked, what the advisor said, what you will do.

If the advisor call fails: when it says to rewrite the message, rewrite it and send it once more. When it says to wait or to sign in (c2f giris), or that the quota is used up, tell the user once and finish the work on your own.

At the end, tell the user in a few plain sentences what you built, which parts the advisor wrote or changed, and what is still open.`;
}

export const AGENT_PROMPT = agentPrompt();

const OUR_BUILD_COMMAND = /DeepSeek bir projeyi baştan sona yazsın \(c2f\)/;
const OUR_OLD_ASK_COMMAND = /İşi sen yap, ilerledikçe DeepSeek'e danış \(c2f\)/;

/**
 * `api: { port, key }` (only with automation on) also adds DeepSeek as a model OpenCode can pick and the
 * /ctf build command; without it, both are removed if an earlier setup put them there.
 */
export function installOpenCode({ repo, home = os.homedir(), api = null, makeDefault = true }) {
  const dir = path.join(home, ".config", "opencode");
  fs.mkdirSync(path.join(dir, "command"), { recursive: true });
  const file = ["opencode.jsonc", "opencode.json"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p)) || path.join(dir, "opencode.jsonc");
  let cfg = {};
  if (fs.existsSync(file)) cfg = parseJsonc(fs.readFileSync(file, "utf8"));
  const before = JSON.stringify(cfg);

  cfg.$schema ||= "https://opencode.ai/config.json";
  cfg.mcp ||= {};
  // The timeout also covers tool calls in OpenCode, and a build takes minutes.
  cfg.mcp.c2f = { type: "local", command: ["node", path.join(repo, "src", "mcp.js").replace(/\\/g, "/")], enabled: true, timeout: 1_800_000 };
  if (api) {
    cfg.provider ||= {};
    cfg.provider.c2f = providerEntry(api);
  } else if (cfg.provider?.c2f) delete cfg.provider.c2f;
  // The agent has no model of its own: it works with whichever model is selected in OpenCode (a local
  // one, big-pickle, anything), and so does /ctf_ask. Only a model the user put on the agent themselves
  // is kept; the default model, which an earlier setup pinned here, is not.
  cfg.agent ||= {};
  const own = cfg.agent.ctf?.model;
  const model = own && own !== cfg.model && !String(own).startsWith("c2f/") ? own : undefined;
  // The default agent: a new session works with the advisor without /ctf_ask. Only our own setting is undone.
  // A default the user chose themselves stays.
  const keptDefault = makeDefault && cfg.default_agent && cfg.default_agent !== "ctf" ? cfg.default_agent : null;
  if (makeDefault && !keptDefault) cfg.default_agent = "ctf";
  else if (!makeDefault && cfg.default_agent === "ctf") delete cfg.default_agent;
  cfg.agent.ctf = { description: "Seçili model çalışır, ilerledikçe DeepSeek'e danışır (c2f)", mode: "primary", ...(model ? { model } : {}), prompt: AGENT_PROMPT };
  cfg.permission ||= {};
  // A build runs commands written by a web model on this machine: that one asks. The rest is harmless.
  if (cfg.permission.c2f_build === undefined) cfg.permission.c2f_build = "ask";
  if (cfg.permission.c2f_advise === undefined) cfg.permission.c2f_advise = "allow";

  let changed = JSON.stringify(cfg) !== before;
  if (changed) {
    if (fs.existsSync(file) && !fs.existsSync(`${file}.bak-c2f`)) fs.copyFileSync(file, `${file}.bak-c2f`);
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  // /ctf lets DeepSeek write a whole project (automation): it is only there when that is turned on.
  const buildCommand = path.join(dir, "command", "ctf.md");
  if (!api && fs.existsSync(buildCommand) && OUR_BUILD_COMMAND.test(fs.readFileSync(buildCommand, "utf8"))) {
    fs.unlinkSync(buildCommand);
    changed = true;
  }
  // /ctf-danis was renamed to /ctf_ask.
  const oldAsk = path.join(dir, "command", "ctf-danis.md");
  if (fs.existsSync(oldAsk) && OUR_OLD_ASK_COMMAND.test(fs.readFileSync(oldAsk, "utf8"))) {
    fs.unlinkSync(oldAsk);
    changed = true;
  }
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  for (const rel of [...(api ? ["command/ctf.md", "command/ctf_ask.md"] : ["command/ctf_ask.md"]), "plugins/c2f-session.js"]) {
    const from = path.join(repo, ".opencode", rel);
    const to = path.join(dir, rel);
    const text = fs.readFileSync(from, "utf8");
    if (!fs.existsSync(to) || fs.readFileSync(to, "utf8") !== text) {
      fs.writeFileSync(to, text);
      changed = true;
    }
  }
  return { file, changed, keptDefault };
}
