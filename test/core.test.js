import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseReply, parsePlan, parseSections, OPS_HELP, repairJson, parseJsonLoose } from "../src/protocol.js";
import { Workspace } from "../src/workspace.js";
import { Agent } from "../src/agent.js";
import { LocalModel } from "../src/local.js";

test("parses a fenced ops block and strips it from prose", () => {
  const reply = 'Here you go.\n\n```json\n{"ops":[{"op":"write","path":"a.txt","content":"hi"}]}\n```';
  const { ops, text, errors } = parseReply(reply);
  assert.deepEqual(errors, []);
  assert.deepEqual(ops, [{ op: "write", path: "a.txt", content: "hi" }]);
  assert.equal(text, "Here you go.");
});

test("parses escaped file content that itself contains backticks", () => {
  const content = "```js\nconsole.log(1)\n```";
  const reply = "```json\n" + JSON.stringify({ ops: [{ op: "write", path: "x.js", content }] }) + "\n```";
  assert.equal(parseReply(reply).ops[0].content, content);
});

test("accepts aliases and rejects malformed ops", () => {
  const reply = JSON.stringify({
    ops: [
      { type: "create", file: "b.html", code: "<h1>x</h1>" },
      { op: "write", path: "no-content.html" },
      { op: "exec", command: "npm test" },
      { op: "finish", note: "shipped" },
      { op: "nonsense" },
    ],
  });
  const { ops } = parseReply("```json\n" + reply + "\n```");
  assert.deepEqual(ops, [
    { op: "write", path: "b.html", content: "<h1>x</h1>" },
    { op: "run", cmd: "npm test" },
    { op: "done", summary: "shipped" },
  ]);
});

test("finds a bare ops object with no fence", () => {
  const { ops } = parseReply('some prose {"ops":[{"op":"delete","path":"old.txt"}]} more prose');
  assert.deepEqual(ops, [{ op: "delete", path: "old.txt" }]);
});

test("dedupes identical ops across blocks", () => {
  const block = '{"ops":[{"op":"read","path":"a"}]}';
  const { ops } = parseReply(`${block}\n${block}`);
  assert.equal(ops.length, 1);
});

test("reports unparseable fenced blocks without throwing", () => {
  const { ops, errors } = parseReply("```json\n{not json at all\n```\nand no ops");
  assert.equal(ops.length, 0);
  assert.equal(errors.length, 1);
});

test("recovers a reply whose JSON strings contain raw newlines", () => {
  // Real models emit this constantly with multi-line file contents.
  const reply = '```json\n{"ops":[{"op":"write","path":"a.txt","content":"line1\nline2\n\ttabbed"}]}\n```';
  const { ops, errors } = parseReply(reply);
  assert.deepEqual(errors, []);
  assert.equal(ops[0].content, "line1\nline2\n\ttabbed");
});

test("repairJson leaves escaped sequences alone and fixes only raw control chars", () => {
  const broken = '{"a":"x\\ny\nz","b":"q\\"r"}';
  assert.deepEqual(repairJson(broken), '{"a":"x\\ny\\nz","b":"q\\"r"}');
});

test("parseJsonLoose returns null instead of throwing", () => {
  assert.equal(parseJsonLoose("{]" ), null);
  assert.deepEqual(parseJsonLoose('```json\n{"steps":[]}\n```'), { steps: [] });
});

test("OPS_HELP documents every op the executor implements", () => {
  for (const line of ["### FILE", "### APPEND", "### READ", "### LIST", "### DELETE", "### RUN", "### DONE"]) {
    assert.ok(OPS_HELP.includes(line), `OPS_HELP is missing ${line}`);
  }
});

test("section format writes files without JSON escaping", () => {
  const reply = [
    "Here is the game.",
    "",
    "### FILE index.html",
    "```html",
    '<!doctype html><script>const q = "a\\"b";</script>',
    "```",
    "",
    "### DONE playable",
  ].join("\n");
  const { ops, text } = parseReply(reply);
  assert.deepEqual(ops, [
    { op: "write", path: "index.html", content: '<!doctype html><script>const q = "a\\"b";</script>' },
    { op: "done", summary: "playable" },
  ]);
  assert.equal(text, "Here is the game.");
});

test("a longer fence keeps a file that contains triple backticks", () => {
  const reply = ["### FILE md.md", "````", "```js", "code", "```", "````", "### DONE ok"].join("\n");
  assert.equal(parseSections(reply)[0].content, "```js\ncode\n```");
});

test("RUN keeps command quoting exactly, only paths get unwrapped", () => {
  const reply = ['### RUN node -e "console.log(1)"', "### FILE `pkg/__init__.py`", "```", "x=1", "```"].join("\n");
  const ops = parseSections(reply);
  assert.equal(ops[0].cmd, 'node -e "console.log(1)"');
  assert.equal(ops[1].path, "pkg/__init__.py");
});

test("a backticked RUN drops only the backticks, not shell quotes or underscores", () => {
  const ops = parseSections('### RUN `node -e "require(\'fs\')"`\n### RUN `python -m my_pkg_test`');
  assert.equal(ops[0].cmd, 'node -e "require(\'fs\')"');
  assert.equal(ops[1].cmd, "python -m my_pkg_test");
});

test("a FILE with no fence does not swallow the next file", () => {
  const reply = [
    "### FILE a.js",
    "forgot the fence",
    "### FILE b.js",
    "```",
    "console.log(2)",
    "```",
    "### DONE ok",
  ].join("\n");
  const { ops, errors } = parseReply(reply);
  assert.equal(ops.find((o) => o.path === "a.js"), undefined, "a.js must not be written from b.js's body");
  assert.equal(ops.find((o) => o.path === "b.js").content, "console.log(2)");
  assert.match(errors.join(" "), /a\.js has no fenced block/);
});

test("an unterminated fence is reported instead of writing a truncated file", () => {
  const { ops, errors } = parseReply(["### FILE a.js", "```", "half a file"].join("\n"));
  assert.equal(ops.length, 0);
  assert.match(errors.join(" "), /never closed/);
});

test("LIST defaults to the workspace root and sections beat the JSON scan", () => {
  assert.deepEqual(parseSections("### LIST"), [{ op: "list", path: "." }]);
  // A package.json inside a FILE block must not be read as ops.
  const reply = ["### FILE package.json", "```json", '{"ops":[{"op":"delete","path":"x"}]}', "```", "### DONE ok"].join("\n");
  const { ops, errors } = parseReply(reply);
  assert.deepEqual(errors, []);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, "write");
});

test("parses a plan and drops entries without a title", () => {
  const plan = parsePlan('```json\n{"steps":[{"title":"a","acceptance":"b"},{"acceptance":"x"},{"step":"c"}]}\n```');
  assert.deepEqual(plan, [
    { title: "a", acceptance: "b", files: [], check: "" },
    { title: "c", acceptance: "", files: [], check: "" },
  ]);
});

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-"));
  return new Workspace(dir);
}

test("workspace writes, reads and trees files", () => {
  const ws = tmpWorkspace();
  ws.write("src/a.js", "line1\nline2");
  assert.equal(ws.read("src/a.js").text, "line1\nline2");
  ws.append("src/a.js", "\nline3");
  assert.match(ws.tree("."), /src\/\n {2}a\.js \(3L\)/);
  ws.del("src/a.js");
  assert.equal(ws.listFiles().length, 0);
});

test("workspace refuses traversal and absolute paths", () => {
  const ws = tmpWorkspace();
  assert.throws(() => ws.read("../../etc/passwd"), /escapes workspace|no such file/);
  assert.throws(() => ws.write("C:\\Windows\\evil.txt", "x"), /absolute/);
  assert.throws(() => ws.write("", "x"), /path is required/);
});

test("workspace refuses writes through a symlink that points outside", () => {
  const ws = tmpWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-out-"));
  try {
    fs.symlinkSync(outside, path.join(ws.root, "link"), "junction");
  } catch {
    return; // symlink needs privileges on Windows; the realpath guard is covered above
  }
  assert.throws(() => ws.write("link/escape.txt", "x"), /escapes workspace/);
});

test("workspace run captures exit codes", async () => {
  const ws = tmpWorkspace();
  const ok = await ws.run('node -e "console.log(42)"');
  assert.equal(ok.code, 0);
  assert.match(ok.out, /42/);
  const bad = await ws.run('node -e "process.exit(3)"');
  assert.equal(bad.code, 3);
});

test("a parse error blocks DONE and the step re-asks instead of finishing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-retry-"));
  const ws = new Workspace(dir);
  const prompts = [];
  const replies = [
    // Round 1: a.js lost its fence, but b.js and DONE arrived. Executing this would
    // finish the step with a.js missing.
    ["### FILE a.js", "### FILE b.js", "```", "console.log('b')", "```", "### DONE half done"].join("\n"),
    // Round 2: the corrected reply.
    ["### FILE a.js", "```", "console.log('a')", "```", "### FILE b.js", "```", "console.log('b')", "```", "### DONE both written"].join("\n"),
  ];
  const agent = new Agent({
    cfg: {
      preferredSites: ["x"],
      workspace: dir,
      freshChatPerRequest: false,
      requestTimeoutMs: 1000,
      maxRoundsPerStep: 3,
      design: false,
      chatMeta: {},
      local: { enabled: false, baseUrl: "http://127.0.0.1:1/v1", model: "auto", maxDigestChars: 1000 },
    },
    bridge: null,
    local: new LocalModel({ enabled: false, baseUrl: "http://127.0.0.1:1/v1" }),
    workspace: ws,
    log: () => {},
    ask: async (prompt) => {
      prompts.push(prompt);
      return { site: "x", reply: replies.shift() || "### DONE ok" };
    },
  });

  const res = await agent.runStep({ goal: "g", design: "", step: { title: "t", acceptance: "a" }, index: 0, total: 1 });

  assert.equal(prompts.length, 2, "the broken reply must not end the step");
  assert.equal(res.ok, true);
  assert.match(prompts[1], /could not be read/, "round 2 must tell the model what was lost");
  assert.equal(fs.readFileSync(path.join(dir, "a.js"), "utf8"), "console.log('a')");
  assert.equal(fs.readFileSync(path.join(dir, "b.js"), "utf8"), "console.log('b')");
});

test("declining the design approval writes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-gate-"));
  const ws = new Workspace(dir);
  const replies = [
    "Stack: one HTML file.", // design
    "No problems.", // critique
    '```json\n{"steps":[{"title":"Write index.html","acceptance":"it opens"}]}\n```', // plan
  ];
  const agent = new Agent({
    cfg: {
      preferredSites: ["x"],
      workspace: dir,
      freshChatPerRequest: true,
      requestTimeoutMs: 1000,
      maxRoundsPerStep: 2,
      design: true,
      chatMeta: {},
      local: { enabled: false, baseUrl: "http://127.0.0.1:1/v1", model: "auto", maxDigestChars: 1000 },
    },
    bridge: null,
    local: new LocalModel({ enabled: false, baseUrl: "http://127.0.0.1:1/v1" }),
    workspace: ws,
    log: () => {},
    ask: async () => ({ site: "x", reply: replies.shift() || "### DONE ok" }),
  });
  const res = await agent.build("make a thing", { approve: async () => false });
  assert.equal(res.stopped, "awaiting approval");
  assert.ok(fs.existsSync(path.join(dir, ".c2f", "design.md")), "design must be saved for review");
  assert.ok(fs.existsSync(path.join(dir, ".c2f", "plan.json")), "plan must be saved for review");
  assert.equal(fs.existsSync(path.join(dir, "index.html")), false, "nothing may be built before approval");
});

/** An Agent whose chat model answers from a script keyed by the request label. */
function scriptedAgent(script, { maxRounds = 3, dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-verify-")), onEvent } = {}) {
  const prompts = [];
  const logs = [];
  const agent = new Agent({
    cfg: {
      preferredSites: ["x"],
      workspace: dir,
      freshChatPerRequest: true,
      requestTimeoutMs: 1000,
      maxRoundsPerStep: maxRounds,
      design: false,
      chatMeta: {},
      local: { enabled: false, baseUrl: "http://127.0.0.1:1/v1", model: "auto", maxDigestChars: 1000 },
    },
    bridge: null,
    local: new LocalModel({ enabled: false, baseUrl: "http://127.0.0.1:1/v1" }),
    workspace: new Workspace(dir),
    log: (m) => logs.push(m),
    onEvent,
    ask: async (prompt, meta) => {
      prompts.push({ label: meta.label, prompt });
      const queue = script[meta.label.replace(/ round \d+/, "").replace(/ \d+$/, "").trim()] || script[meta.label];
      const reply = Array.isArray(queue) ? queue.shift() : queue;
      // A function entry is a model that cannot be reached.
      if (typeof reply === "function") return reply();
      return { site: "x", reply: reply ?? "### DONE ok" };
    },
  });
  return { agent, prompts, logs, dir };
}

const ONE_STEP = '```json\n{"steps":[{"title":"Write a.js","acceptance":"a.js exists"}]}\n```';
const WRITE_A = ["### FILE a.js", "```", "console.log('a')", "```", "### DONE written"].join("\n");

test("the audit only counts as clean when the model says so: an empty or garbled reply is inconclusive", async () => {
  const { agent, prompts, logs } = scriptedAgent({ plan: ONE_STEP, step: [WRITE_A], verify: ["###", "###", "looks fine I think"] });
  const res = await agent.build("g");
  assert.equal(res.verified, false, "no round produced a verdict");
  const asks = prompts.filter((p) => p.label.startsWith("verify"));
  assert.equal(asks.length, 3, "each unreadable audit is asked again");
  assert.match(asks[1].prompt, /### DONE/, "the retry tells the model exactly what a verdict looks like");
  assert.ok(logs.some((l) => /verify: inconclusive/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /verify: clean/.test(l)), "must never claim clean on garbage");
});

test("an explicit DONE ends the audit as verified; fixes followed by DONE are applied first", async () => {
  const clean = scriptedAgent({ plan: ONE_STEP, step: [WRITE_A], verify: ["### DONE nothing to fix"] });
  const a = await clean.agent.build("g");
  assert.equal(a.verified, true);
  assert.equal(clean.prompts.filter((p) => p.label.startsWith("verify")).length, 1);

  const fix = scriptedAgent({ plan: ONE_STEP, step: [WRITE_A], verify: [["### FILE b.js", "```", "console.log('b')", "```", "### DONE fixed"].join("\n")] });
  const b = await fix.agent.build("g");
  assert.equal(b.verified, true);
  assert.equal(fs.readFileSync(path.join(fix.dir, "b.js"), "utf8"), "console.log('b')", "the fix was written");
});

test("a step that ran out of rounds is reported as incomplete, not silently moved past", async () => {
  const { agent, logs } = scriptedAgent({ plan: ONE_STEP, step: ["nothing useful", "still nothing", "no ops here either"], verify: ["### DONE ok"] }, { maxRounds: 2 });
  const res = await agent.build("g");
  assert.deepEqual(res.incomplete, ["Write a.js"]);
  assert.ok(logs.some((l) => /did not finish/.test(l)), logs.join("\n"));
});

const THREE_STEPS = '```json\n{"steps":[{"title":"One"},{"title":"Two"},{"title":"Three"}]}\n```';
const write = (f) => [`### FILE ${f}`, "```", `console.log('${f}')`, "```", `### DONE wrote ${f}`].join("\n");

test("a build that loses every model keeps its finished steps and resumes from the next one", async () => {
  const events = [];
  const first = scriptedAgent(
    { plan: THREE_STEPS, step: [write("one.js"), () => { throw new Error("no web chat model answered.\n  - claude: extension disconnected mid-request"); }] },
    { onEvent: (e) => events.push(e) },
  );
  await assert.rejects(first.agent.build("make it"), (err) => /resume/.test(err.message) && /1\/3 steps/.test(err.message));
  assert.ok(events.some((e) => e.type === "step" && e.index === 1), "the phase was reported");
  assert.deepEqual(events.filter((e) => e.type === "step-done").map((e) => e.index), [0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, ".c2f", "state.json"), "utf8")).results.length, 1);

  // Same workspace, models are back. The plan and step one must not be asked for again.
  const second = scriptedAgent({ step: [write("two.js"), write("three.js")], verify: ["### DONE good"] }, { dir: first.dir });
  const res = await second.agent.build("make it", { resume: true });
  assert.equal(res.resumed, true);
  assert.deepEqual(second.prompts.map((p) => p.label), ["step 2 round 1", "step 3 round 1", "verify 1"], "nothing already built is rebuilt");
  assert.ok(fs.existsSync(path.join(first.dir, "one.js")) && fs.existsSync(path.join(first.dir, "three.js")));
  assert.equal(res.verified, true);
});

test("resume ignores the saved state of another request, and of a build that already finished", async () => {
  const a = scriptedAgent({ plan: ONE_STEP, step: [WRITE_A], verify: ["### DONE ok"] });
  await a.agent.build("first request");
  const other = scriptedAgent({ plan: ONE_STEP, step: [WRITE_A], verify: ["### DONE ok"] }, { dir: a.dir });
  const res = await other.agent.build("first request", { resume: true });
  assert.equal(res.resumed, false, "a finished build is not resumed");
  assert.ok(other.prompts.some((p) => p.label === "plan"), "so it plans again");
});

test("a reply the model got wrong is kept on disk so it can be inspected", async () => {
  const { agent, dir } = scriptedAgent({ plan: ONE_STEP, step: ["### FILE a.js\nno fence here", WRITE_A], verify: ["### DONE ok"] });
  await agent.build("g");
  assert.match(fs.readFileSync(path.join(dir, ".c2f", "failed", "step-1-round-1.txt"), "utf8"), /no fence here/);
});

test("commands that would open a window on the user's screen are skipped with an explanation, real ones still run", async () => {
  const ws = new Workspace(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-gui-")));
  for (const cmd of ["start index.html", "cmd /c start index.html", "explorer .", "npx vite --open", "echo hi && start x.html", "powershell -Command Start-Process index.html", "xdg-open index.html", "msedge index.html"]) {
    const res = await ws.run(cmd);
    assert.equal(res.code, 0, `${cmd}: a skipped command must not fail the step`);
    assert.match(res.out, /^skipped: .*not allowed while building/, `${cmd} must be skipped, not run`);
  }
  for (const cmd of ["echo start", "npm start --version", 'node -e "console.log(41+1)"']) {
    const res = await ws.run(cmd);
    assert.doesNotMatch(res.out, /^skipped:/, `${cmd} is an ordinary command`);
  }
  assert.match((await ws.run('node -e "console.log(41+1)"')).out, /42/);
});

test("commands run with BROWSER=none and CI=1 so dev tools neither open a browser nor wait for input", async () => {
  const ws = new Workspace(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-env-")));
  const res = await ws.run('node -e "console.log(process.env.BROWSER + \'/\' + process.env.CI)"');
  assert.match(res.out, /none\/1/);
});

const PLAN_WITH_FILES = '```json\n{"steps":[{"title":"Player","acceptance":"player exists","files":["src/Player.js"]},{"title":"Inventory","acceptance":"inventory exists","files":["src/Inventory.js"]}]}\n```';
const writeAt = (f) => [`### FILE ${f}`, "```", `export default 1`, "```", `### DONE wrote ${f}`].join("\n");
const CLAIM_ONLY = "### READ package.json\n### DONE step complete";

test("DONE without the promised files is refused; the model is told which file is missing and writes it", async () => {
  const { agent, prompts, logs, dir } = scriptedAgent({ plan: PLAN_WITH_FILES, step: [CLAIM_ONLY, writeAt("src/Player.js"), writeAt("src/Inventory.js")], verify: ["### DONE ok"] });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const res = await agent.build("g");
  assert.ok(logs.some((l) => /DONE refused: these planned files do not exist: src\/Player\.js/.test(l)), logs.join("\n"));
  const retry = prompts.find((p) => p.label === "step 1 round 2");
  assert.match(retry.prompt, /DONE, but these planned files do not exist: src\/Player\.js/, "the next round says exactly what is missing");
  assert.ok(fs.existsSync(path.join(dir, "src", "Player.js")) && fs.existsSync(path.join(dir, "src", "Inventory.js")));
  assert.deepEqual(res.incomplete, []);
  assert.match(prompts.find((p) => p.label.startsWith("verify")).prompt, /Player -> src\/Player\.js/, "the audit sees the plan");
});

test("a step that never delivers its files is reopened after the steps, and reported as incomplete when it still fails", async () => {
  // Step 1 keeps claiming DONE without writing; every round and the reopened round get the same claim.
  const { agent, prompts, logs } = scriptedAgent({ plan: PLAN_WITH_FILES, step: [CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, writeAt("src/Inventory.js"), CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY], verify: ["### DONE ok"] }, { maxRounds: 2 });
  const res = await agent.build("g");
  assert.ok(logs.some((l) => /gaps: 1 step\(s\) are not really built \(1\)/.test(l)), logs.join("\n"));
  assert.ok(prompts.some((p) => /reported finished, but these planned files do not exist/.test(p.prompt)), "the reopened step carries the reason");
  assert.equal(res.incomplete.length, 1);
  assert.match(res.incomplete[0], /Player \(missing: src\/Player\.js\)/);
});

test("a step's check must pass before DONE is accepted", async () => {
  const plan = '```json\n{"steps":[{"title":"Counter","files":["a.js"],"check":"node -e \\"process.exit(Number(require(\'fs\').readFileSync(\'a.js\',\'utf8\').includes(\'good\')?0:1))\\""}]}\n```';
  const bad = ["### FILE a.js", "```", "bad", "```", "### DONE written"].join("\n");
  const good = ["### FILE a.js", "```", "good", "```", "### DONE fixed"].join("\n");
  const { agent, prompts } = scriptedAgent({ plan, step: [bad, good], verify: ["### DONE ok"] });
  const res = await agent.build("g");
  assert.match(prompts.find((p) => p.label === "step 1 round 2").prompt, /the step's check failed/);
  assert.deepEqual(res.incomplete, []);
});

const BARE_PLAN = '```json\n{"steps":[{"title":"Player"},{"title":"Inventory"}]}\n```';

test("the Minecraft failure replayed: a step with no files and no check that only READs and says DONE is not complete", async () => {
  const readOnly = ["### READ package.json", "### LIST .", "### DONE step complete"].join("\n");
  const { agent, prompts, logs, dir } = scriptedAgent({ plan: [BARE_PLAN, BARE_PLAN], step: [readOnly, writeAt("src/Player.js"), writeAt("src/Inventory.js")], verify: ["### DONE ok"] });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const res = await agent.build("g");
  assert.ok(logs.some((l) => /DONE refused: nothing was written in this step/.test(l)), logs.join("\n"));
  assert.match(prompts.find((p) => p.label === "step 1 round 2").prompt, /nothing was written/);
  assert.ok(fs.existsSync(path.join(dir, "src", "Player.js")), "the step had to do real work before it counted");
  assert.deepEqual(res.incomplete, []);
});

test("a plan whose steps name neither files nor a check is sent back once for them", async () => {
  const { agent, prompts, logs } = scriptedAgent({ plan: [BARE_PLAN], "plan-retry": [PLAN_WITH_FILES], step: [writeAt("src/Player.js"), writeAt("src/Inventory.js")], verify: ["### DONE ok"] });
  await agent.build("g");
  const retry = prompts.find((p) => p.label === "plan-retry");
  assert.match(retry.prompt, /neither "files" nor "check": "Player", "Inventory"/);
  assert.ok(logs.some((l) => /2 step\(s\) name no files and no check/.test(l)));
  assert.match(prompts.find((p) => p.label === "step 1 round 1").prompt, /Files this step must create.*src\/Player\.js/s, "the corrected plan is the one built");
});

test("the audit is told which planned files are missing", async () => {
  const { agent, prompts } = scriptedAgent({ plan: PLAN_WITH_FILES, step: [CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY, CLAIM_ONLY], verify: ["### DONE ok"] }, { maxRounds: 1 });
  await agent.build("g");
  assert.match(prompts.find((p) => p.label.startsWith("verify")).prompt, /Player -> src\/Player\.js {2}\[NOT BUILT, missing: src\/Player\.js\]/);
});

test("READ, then running the old tests, then DONE builds nothing: a step with no files and no check is refused", async () => {
  const readRun = ["### READ package.json", "### RUN node -e 0", "### DONE step complete"].join("\n");
  const { agent, logs, dir } = scriptedAgent({ plan: [BARE_PLAN, BARE_PLAN], step: [readRun, writeAt("src/Player.js"), writeAt("src/Inventory.js")], verify: ["### DONE ok"] });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  await agent.build("g");
  assert.ok(logs.some((l) => /DONE refused: nothing was written in this step/.test(l)), logs.join("\n"));
  assert.ok(fs.existsSync(path.join(dir, "src", "Player.js")));
});
