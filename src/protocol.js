/**
 * The wire format between ChatToFree and the web chat model.
 *
 * Primary: line-oriented sections, because they need no escaping and survive markdown
 * rendering the way JSON does not —
 *   ### FILE index.html
 *   ```
 *   <html>...</html>
 *   ```
 *   ### RUN npm test
 *   ### DONE playable
 * Fallback: a fenced JSON block {"ops":[...]} or a bare ops object, for models that ignore
 * the format. Parsing is deliberately forgiving, because big chat models drift.
 */

/** Web models often emit raw newlines/tabs inside JSON strings. Escape them in place. */
export function repairJson(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of String(text)) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inStr = false;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      if (ch < " ") {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

const SECTION = /^#{2,4}\s*(FILE|APPEND|RUN|READ|LIST|DELETE|DONE)\s*:?\s*(.*)$/i;

/**
 * Line-oriented format, which is what big models are actually reliable at:
 *
 *   ### FILE src/app.js
 *   ```js
 *   console.log("no escaping needed")
 *   ```
 *   ### RUN npm test
 *   ### DONE works
 *
 * The closing fence must be at least as long as the opening one and made of the same
 * character, so a file whose contents contain ``` survives intact.
 */
export function parseSections(text, errors = []) {
  const lines = String(text ?? "").split(/\r?\n/);
  const ops = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION.exec(lines[i]);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    const arg = m[2].trim();
    // Only paths get unwrapped: markdown eats underscores in plain text
    // (pkg/__init__.py → pkg/init.py), so the model sends them as inline code.
    // Commands and summaries keep their quotes exactly as written.
    const path = arg.replace(/^[`'"]+|[`'"]+$/g, "");
    if (kind === "RUN" && arg) {
      // Commands are asked for in backticks too, so markdown cannot eat `_` or `*`.
      // Only a matching backtick pair is removed: shell quotes are part of the command.
      ops.push({ op: "run", cmd: arg.replace(/^`([\s\S]*)`$/, "$1") });
      continue;
    }
    if (kind === "LIST") {
      ops.push({ op: "list", path: path || "." });
      continue;
    }
    if ((kind === "READ" || kind === "DELETE") && path) {
      ops.push({ op: kind.toLowerCase(), path });
      continue;
    }
    if (kind === "DONE") {
      ops.push({ op: "done", summary: arg || "step complete" });
      continue;
    }
    if (!(kind === "FILE" || kind === "APPEND") || !path) {
      if ((kind === "FILE" || kind === "APPEND") && !path) errors.push(`${kind} without a path`);
      continue;
    }
    // Only look for the opening fence before the next instruction. Otherwise a FILE
    // that forgot its fence silently swallows the next file's body and overwrites it.
    let j = i + 1;
    let open = null;
    for (; j < lines.length && !SECTION.test(lines[j]); j++) {
      open = /^\s*(`{3,}|~{3,})/.exec(lines[j]);
      if (open) break;
    }
    if (!open) {
      errors.push(`${kind} ${path} has no fenced block`);
      continue;
    }
    const marker = open[1][0];
    const len = open[1].length;
    const close = new RegExp(`^\\s*\\${marker}{${len},}\\s*$`);
    const body = [];
    let k = j + 1;
    let closed = false;
    for (; k < lines.length; k++) {
      if (close.test(lines[k])) {
        closed = true;
        break;
      }
      body.push(lines[k]);
    }
    if (!closed) {
      errors.push(`${kind} ${path} was never closed (missing ${marker.repeat(len)})`);
      continue;
    }
    ops.push({ op: kind === "FILE" ? "write" : "append", path, content: body.join("\n") });
    i = k;
  }
  return ops;
}

/** JSON.parse with one repair retry; returns null instead of throwing. */
export function parseJsonLoose(text) {
  const src = String(text ?? "").trim().replace(/^json\s*/i, "");
  const attempts = [src];
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start >= 0 && end > start) attempts.push(src.slice(start, end + 1));
  for (const attempt of attempts) {
    for (const candidate of [attempt, repairJson(attempt)]) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/* Greedy: file contents may themselves contain ``` so the block ends at the last fence.
 * If a reply holds two fences, JSON.parse fails there and bareObjects() rescues the ops. */
const FENCE = /```[a-z0-9+#-]*[ \t]*\n([\s\S]*)```/gi;

export function extractBlocks(text) {
  const blocks = [];
  for (const m of String(text ?? "").matchAll(FENCE)) blocks.push(m[1]);
  return blocks;
}

/** Last-resort: find balanced top-level {...} objects containing "ops". */
export function bareObjects(text) {
  const src = String(text ?? "");
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = src.slice(i, j + 1);
          if (/"ops"\s*:/.test(candidate)) out.push(candidate);
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

function normalizeOp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const op = String(raw.op ?? raw.type ?? raw.tool ?? "").toLowerCase().trim();
  const one = {
    op,
    path: raw.path ?? raw.file ?? raw.filename ?? raw.file_path,
    content: raw.content ?? raw.text ?? raw.code ?? raw.body,
    cmd: raw.cmd ?? raw.command ?? raw.shell,
    pattern: raw.pattern ?? raw.query,
    summary: raw.summary ?? raw.note,
    timeoutMs: raw.timeoutMs ?? raw.timeout,
  };
  if (op === "write" || op === "create") {
    if (typeof one.path !== "string" || typeof one.content !== "string") return null;
    return { op: "write", path: one.path, content: one.content };
  }
  if (op === "append") {
    if (typeof one.path !== "string" || typeof one.content !== "string") return null;
    return { op: "append", path: one.path, content: one.content };
  }
  if (op === "read" || op === "list" || op === "delete" || op === "rm") {
    if (typeof one.path !== "string") return null;
    return { op: op === "rm" ? "delete" : op, path: one.path };
  }
  if (op === "run" || op === "exec" || op === "shell") {
    if (typeof one.cmd !== "string") return null;
    return { op: "run", cmd: one.cmd, ...(Number(one.timeoutMs) > 0 ? { timeoutMs: Number(one.timeoutMs) } : {}) };
  }
  if (op === "done" || op === "finish") {
    return { op: "done", summary: String(one.summary ?? "step complete") };
  }
  return null;
}

/**
 * @returns {{ops: object[], errors: string[], text: string}}
 *   text: reply with the parsed blocks removed, so it can be shown as prose.
 */
export function parseReply(reply) {
  const src = String(reply ?? "");
  const ops = [];
  const errors = [];
  const seen = new Set();
  const add = (op) => {
    const key = JSON.stringify(op);
    if (!seen.has(key)) {
      seen.add(key);
      ops.push(op);
    }
  };
  // Section format first: it survives markdown rendering and needs no JSON escaping.
  // When it yields ops, do not also run the JSON scan: the greedy fence would swallow
  // every FILE block, and a package.json containing "ops" could be misread as instructions.
  const sections = parseSections(src, errors);
  for (const op of sections) add(op);
  const candidates = sections.length ? [] : [...extractBlocks(src), ...bareObjects(src)];

  for (const raw of candidates) {
    const obj = parseJsonLoose(raw);
    if (!obj) {
      errors.push(`unparseable block: ${raw.trim().slice(0, 60)}…`);
      continue;
    }
    const list = Array.isArray(obj?.ops) ? obj.ops : Array.isArray(obj) ? obj : obj?.op ? [obj] : [];
    for (const item of list) {
      const norm = normalizeOp(item);
      if (norm) {
        const key = JSON.stringify(norm);
        if (!seen.has(key)) {
          seen.add(key);
          ops.push(norm);
        }
      }
    }
    if (obj && !Array.isArray(obj) && obj.done && typeof obj.done === "string" && !list.length) {
      ops.push({ op: "done", summary: obj.done });
    }
  }

  // Prose for the human: everything before the first instruction, or the reply minus fences.
  const firstSection = src.search(new RegExp(SECTION.source, "m"));
  let text = firstSection > 0 ? src.slice(0, firstSection) : "";
  if (!text) {
    text = src;
    for (const block of extractBlocks(src)) text = text.replace(block, "");
    text = text.replace(/```[a-z0-9]*\s*```/gi, "");
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return { ops, errors, text };
}

export const OPS_HELP = `Reply format (STRICT). Short prose first, then the instructions:

### FILE path/to/file.ext
\`\`\`
complete file contents
\`\`\`
### APPEND path/to/file.ext
\`\`\`
more contents
\`\`\`
### READ path/to/file.ext
### LIST .
### DELETE path/to/file.ext
### RUN npm test
### DONE one line on what this step now does

Rules:
- Each instruction is its own line starting with "### ". File contents go in a fenced block
  under it, never inside JSON, so quotes and newlines need no escaping.
- If a file's contents contain \`\`\`, wrap it in a longer fence (\`\`\`\`).
- Put the path in backticks (### FILE \`pkg/\_\_init\_\_.py\`): markdown can swallow underscores
  in plain text and turn a path into italic text.
- Do the same for commands: ### RUN \`npm test\`. Underscores and \`*\` are eaten otherwise.
- Paths are workspace-relative, never absolute. A FILE block always holds the COMPLETE file.
- Write the whole file in one FILE block; use APPEND only to add to an existing file.
- End with ### DONE once the step's acceptance criteria is met, after running it with ### RUN.
- Do not put "### " at the start of a line inside file contents.
- The user keeps working while this runs: never open anything on their screen. No start, open,
  explorer, no browser or editor, no --open on a dev server (such commands are skipped). Verify
  headless: a node script, a test runner, or curl against a local server.`;

/** What the program itself will check before it accepts "### DONE" for the step. */
export function stepContract(step) {
  const lines = [];
  if (step.files?.length) lines.push(`Files this step must create (DONE is refused while any is missing): ${step.files.join(", ")}`);
  if (step.check) lines.push(`Check that must pass before DONE: ${step.check}`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

export function stepPrompt({ goal, design, tree, digest, step, round, history, feedback }) {
  return `You are the lead engineer of a project built through ChatToFree. A small local model relays your instructions to a file system; you are the only one writing the code.

# Project goal
${goal}

${design ? `# Agreed design\n${design}\n` : ""}# Current file tree
${tree}

${digest ? `# File contents (local-model digest)\n${digest}\n` : ""}# Current step (${step.index + 1}/${step.total})
${step.title}
Acceptance: ${step.acceptance || "the step works end to end"}${stepContract(step)}

# Round ${round}
${history || "No actions taken in this step yet."}
${feedback ? `\n# Verifier feedback\n${feedback}\n` : ""}
${OPS_HELP}`;
}

export function designPrompt({ goal, tree }) {
  return `You are a principal engineer. A user wants this project built by an autonomous agent that writes files and runs commands.

# Request
${goal}

# Existing files
${tree}

Produce a concrete build design: stack and why, file layout, data model, the critical algorithms, security/edge cases, and a numbered roadmap where each step has observable acceptance criteria. Prefer the simplest stack that ships (no build tooling unless needed). Be specific about filenames and APIs. Keep it under 1200 words. Do not write the project files yet.`;
}

export function critiquePrompt({ goal, design }) {
  return `You are a strict reviewer. Another model proposed the design below for this request:
${goal}

# Proposed design
${design}

List only real problems (wrong stack choice for the constraints, missing edge cases, broken ordering, over-engineering, security holes) and the minimal fix for each. Then give a corrected design section only where you changed something. Under 700 words.`;
}

export function planPrompt({ goal, design, tree }) {
  return `You are the lead engineer. Turn this into an ordered build plan of 3-7 steps an autonomous agent can execute, where each step ends in something observable (a file that opens, a test that passes).

# Request
${goal}

${design ? `# Design\n${design}\n` : ""}# Existing files
${tree}

Rules for the plan:
- One module or feature per step, so every step is small. Together the steps must cover EVERYTHING the request asks for; nothing may be left to "later".
- "files" lists every file this step must create (workspace-relative). A step is only finished when they exist. Use [] for a step that writes nothing (a pure verification step).
- "check" is optional: a command that runs headless, finishes by itself and exits 0 on success (a test, a build, a node script). Never a dev server, never something that opens a window.

Answer with ONE fenced json block and nothing else:
{"steps":[{"title":"short imperative title","acceptance":"how to prove this step works","files":["src/path/File.js"],"check":"optional headless shell command that exits 0 when this step works"}]}`;
}

/** Plan parser: tolerant of prose around the fenced block. */
export function parsePlan(reply) {
  for (const raw of extractBlocks(reply)) {
    const obj = parseJsonLoose(raw);
    if (!obj) continue;
    const list = Array.isArray(obj?.steps) ? obj.steps : [];
    const steps = list
      .map((s) => ({
        title: String(s?.title ?? s?.step ?? "").trim(),
        acceptance: String(s?.acceptance ?? s?.accept ?? s?.done ?? "").trim(),
        files: (Array.isArray(s?.files) ? s.files : []).map((f) => String(f).trim().replace(/^\.\//, "")).filter(Boolean),
        check: String(s?.check ?? "").trim(),
      }))
      .filter((s) => s.title);
    if (steps.length) return steps;
  }
  return [];
}

/** The plan with what the program found: which steps' files are missing. `missing[i]` is a list. */
export function planOutline(steps = [], missing = []) {
  return steps
    .map((s, i) => `${i + 1}. ${s.title}${s.files?.length ? ` -> ${s.files.join(", ")}` : ""}${missing[i]?.length ? `  [NOT BUILT, missing: ${missing[i].join(", ")}]` : ""}`)
    .join("\n");
}

export function verifyPrompt({ goal, tree, digest, plan = "" }) {
  return `You are the QA engineer for this project. The build steps are finished.

# Request
${goal}

${plan ? `# Plan that was supposed to be built\n${plan}\nA step whose files are not in the file list below was NOT built, whatever anyone claimed. Write what is missing.\n\n` : ""}# Files
${tree}

${digest ? `# Contents (digest)\n${digest}\n` : ""}# Job
Find real defects: missing files, broken imports, dead links, features the request asked for that were never written, insecure defaults. Ignore style. Fix them with FILE/RUN sections, or reply with only a "### DONE" line if the project already meets the request.

${OPS_HELP}`;
}


// --- follow-ups ---------------------------------------------------------------------------------
// Sent INTO a chat that already holds the earlier turns (the model remembers the goal, the design
// and every file it wrote), so they carry only what is new. Each keeps the wording the full prompt
// uses for that phase, and repeats the reply format in one line because that is what drifts first.

const SAME_FORMAT = 'Reply in the same format as before: "### FILE `path`" + a fenced block per file, "### RUN `cmd`", and "### DONE <summary>" when the acceptance criteria are met.';

export function critiqueFollowUp() {
  return `Now act as a strict reviewer of the design you just wrote. List only real problems (wrong stack choice, missing edge cases, broken ordering, over-engineering, security holes) and the minimal fix for each, then a corrected design section only where you changed something. Under 700 words.`;
}

export function planFollowUp({ tree }) {
  return `Now turn this into an ordered build plan of 3-7 steps an autonomous agent can execute, each ending in something observable.

# Existing files
${tree}

Rules for the plan:
- One module or feature per step, so every step is small. Together the steps must cover EVERYTHING the request asks for; nothing may be left to "later".
- "files" lists every file this step must create (workspace-relative). A step is only finished when they exist. Use [] for a step that writes nothing (a pure verification step).
- "check" is optional: a command that runs headless, finishes by itself and exits 0 on success (a test, a build, a node script). Never a dev server, never something that opens a window.

Answer with ONE fenced json block and nothing else:
{"steps":[{"title":"short imperative title","acceptance":"how to prove this step works","files":["src/path/File.js"],"check":"optional headless shell command that exits 0 when this step works"}]}`;
}

export function planRetryFollowUp() {
  return "Your previous reply did not contain a parsable fenced json block. Reply with ONLY the json block this time.";
}

export function stepFollowUp({ step, tree, round, note, feedback }) {
  const head = `# Current step (${step.index + 1}/${step.total})\n${step.title}\nAcceptance: ${step.acceptance || "the step works end to end"}${stepContract(step)}`;
  if (round === 1) return `${head}\n\n# Current file tree\n${tree}\n\n${SAME_FORMAT}`;
  return `${head}\n\n# Round ${round}\n${note || "No actions taken in this step yet."}\n${feedback ? `\n# Verifier feedback\n${feedback}\n` : ""}\n${SAME_FORMAT}`;
}

export function verifyFollowUp({ tree, plan = "" }) {
  return `The build steps are finished. Now act as the QA engineer for this project.

${plan ? `# Plan that was supposed to be built\n${plan}\nA step whose files are not in the file list below was NOT built, whatever anyone claimed. Write what is missing.\n\n` : ""}# Files
${tree}

Find real defects: missing files, broken imports, dead links, features the request asked for that were never written, insecure defaults. Ignore style. Fix them with FILE/RUN sections, or reply with only a "### DONE" line if the project already meets the request.

${SAME_FORMAT}`;
}
