import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { installOpenCode, parseJsonc, openCodeC2f } from "../src/opencode-setup.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("comments and trailing commas in OpenCode's config are read, strings with // are left alone", () => {
  const got = parseJsonc('{\n // note\n "a": "http://x", /* c */ "b": [1, 2,],\n}\n');
  assert.deepEqual(got, { a: "http://x", b: [1, 2] });
});

test("OpenCode gets the c2f server, the ctf agent and /ctf_ask, working with whichever model is selected", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-oc-"));
  const dir = path.join(home, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const original = '{\n  // mine\n  "model": "llamacpp/qwen",\n  "agent": { "main": { "model": "llamacpp/qwen" } },\n  "mcp": { "other": { "type": "local", "command": ["x"] } },\n}\n';
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), original);

  const first = installOpenCode({ repo, home });
  assert.equal(first.changed, true);
  const cfg = parseJsonc(fs.readFileSync(first.file, "utf8"));
  assert.equal(cfg.model, "llamacpp/qwen", "existing settings stay");
  assert.deepEqual(cfg.agent.main, { model: "llamacpp/qwen" }, "other agents stay");
  assert.deepEqual(cfg.mcp.other, { type: "local", command: ["x"] }, "other servers stay");
  assert.match(cfg.mcp.c2f.command[1], /src\/mcp\.js$/);
  assert.equal(cfg.default_agent, "ctf", "new sessions work with the advisor without /ctf_ask");
  assert.equal(cfg.agent.ctf.model, undefined, "no model of its own: it follows the model selected in OpenCode");
  assert.equal(cfg.agent.ctf.mode, "primary");
  assert.match(cfg.agent.ctf.prompt, /c2f_advise/);
  assert.match(cfg.agent.ctf.prompt, /The work is YOURS: write in the first person/);
  assert.match(cfg.agent.ctf.prompt, /No set openings or stock phrases/, "no fixed templates");
  assert.match(cfg.agent.ctf.prompt, /Letting the advisor write code[\s\S]*complete code plus an explanation[\s\S]*make it yours/, "it may have the hard parts written, then owns them");
  assert.match(cfg.agent.ctf.prompt, /debug layer from the start .*with ONE switch/, "the agent builds a switchable debug layer");
  assert.match(cfg.agent.ctf.prompt, /folders and what lives in each/, "and talks the structure over");
  assert.match(cfg.agent.ctf.prompt, /detailed review, piece by piece[\s\S]*one file or class per message/, "and ends with a file-by-file review");
  assert.equal(cfg.permission.c2f_advise, "allow");
  assert.equal(cfg.provider?.c2f, undefined, "DeepSeek is not offered as a model to drive");
  assert.equal(fs.readFileSync(`${first.file}.bak-c2f`, "utf8"), original, "the old file is kept once");
  const ask = fs.readFileSync(path.join(dir, "command", "ctf_ask.md"), "utf8");
  assert.match(ask, /^---\ndescription: .*\nagent: ctf\n---/, "/ctf_ask runs as the ctf agent, with the selected model");
  assert.equal(ask.split("---").pop().trim(), "$ARGUMENTS", "the command passes on only what the user typed; the rules stay in the agent's hidden prompt");
  assert.match(fs.readFileSync(path.join(dir, "plugins", "c2f-session.js"), "utf8"), /opencode_session/, "the session plugin is installed");
  assert.equal(fs.existsSync(path.join(dir, "command", "ctf.md")), false, "no build command without automation");

  assert.equal(installOpenCode({ repo, home }).changed, false, "a second run changes nothing");

  // A model the user later put on the agent is theirs to keep; the default one an earlier setup pinned is dropped.
  cfg.agent.ctf.model = "ollama/small";
  fs.writeFileSync(first.file, JSON.stringify(cfg));
  installOpenCode({ repo, home });
  assert.equal(parseJsonc(fs.readFileSync(first.file, "utf8")).agent.ctf.model, "ollama/small");
  cfg.agent.ctf.model = "llamacpp/qwen";
  fs.writeFileSync(first.file, JSON.stringify(cfg));
  installOpenCode({ repo, home });
  assert.equal(parseJsonc(fs.readFileSync(first.file, "utf8")).agent.ctf.model, undefined);

  // The command's old name is cleaned up, but only when the file is ours.
  const oldName = path.join(dir, "command", "ctf-danis.md");
  fs.writeFileSync(oldName, "---\ndescription: İşi sen yap, ilerledikçe DeepSeek'e danış (c2f)\n---\nold");
  installOpenCode({ repo, home });
  assert.equal(fs.existsSync(oldName), false);
  fs.writeFileSync(oldName, "my own command");
  installOpenCode({ repo, home });
  assert.equal(fs.readFileSync(oldName, "utf8"), "my own command");
});

test("with automation the model entry and the build command are added, and taken away again without it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-oc3-"));
  const on = installOpenCode({ repo, home, api: { port: 8788, key: "abc123" } });
  let cfg = parseJsonc(fs.readFileSync(on.file, "utf8"));
  assert.deepEqual(cfg.provider.c2f.options, { baseURL: "http://127.0.0.1:8788/v1", apiKey: "abc123" });
  assert.deepEqual(Object.keys(cfg.provider.c2f.models), ["deepseek", "deepseek-thinking"]);
  const build = path.join(home, ".config", "opencode", "command", "ctf.md");
  assert.ok(fs.existsSync(build));
  assert.equal(cfg.agent.ctf.model, undefined, "no default model to inherit here");

  installOpenCode({ repo, home });
  cfg = parseJsonc(fs.readFileSync(on.file, "utf8"));
  assert.equal(cfg.provider.c2f, undefined);
  assert.equal(fs.existsSync(build), false);

  // A model that is DeepSeek itself is never put on the agent: it would be consulting itself.
  cfg.model = "c2f/deepseek";
  delete cfg.agent.ctf;
  fs.writeFileSync(on.file, JSON.stringify(cfg));
  installOpenCode({ repo, home });
  assert.equal(parseJsonc(fs.readFileSync(on.file, "utf8")).agent.ctf.model, undefined);
});

test("with no OpenCode config yet, one is created", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-oc2-"));
  const res = installOpenCode({ repo, home });
  assert.equal(parseJsonc(fs.readFileSync(res.file, "utf8")).mcp.c2f.type, "local");
});

test("c2f finds its own folder when the path has spaces and Turkish letters, and notices when it was moved", () => {
  // A copy in C:\\Users\\Kullanıcı\\Masaüstü\\Chat To Free. The folder used to be read from the module URL
  // without decoding it ("Kullan%C4%B1c%C4%B1", "Chat%20To%20Free"), so OpenCode got a path that does not exist.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-yol-"));
  const copy = path.join(root, "Çalışma Klasörü", "Chat To Free");
  for (const part of ["src", "node_modules", "package.json", ".opencode", "extension"]) fs.cpSync(path.join(repo, part), path.join(copy, part), { recursive: true });
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  installOpenCode({ repo: copy, home });
  const env = { ...process.env, USERPROFILE: home, HOME: home, C2F_CONFIG_HOME: path.join(root, "c2f"), NO_COLOR: "1" };
  const status = () => execFileSync(process.execPath, [path.join(copy, "src", "cli.js"), "durum"], { env, encoding: "utf8" });
  assert.match(status(), /OpenCode hazır/, "c2f recognises its own folder in OpenCode's config");

  const moved = path.join(root, "Taşındı", "Chat To Free");
  fs.renameSync(path.dirname(copy), path.dirname(moved));
  assert.equal(openCodeC2f(moved, home), "moved", "the config still points at the old folder");
  installOpenCode({ repo: moved, home });
  assert.equal(openCodeC2f(moved, home), "ok", "c2f kur points it at the new one");
  assert.equal(openCodeC2f(moved, path.join(root, "nobody")), "missing");
});

test("ctf as OpenCode's default agent can be turned off, and only our own default is undone", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-def-"));
  const dir = path.join(home, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const read = () => parseJsonc(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8"));
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), "{}");
  installOpenCode({ repo, home });
  assert.equal(read().default_agent, "ctf");
  installOpenCode({ repo, home, makeDefault: false });
  assert.equal(read().default_agent, undefined);
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), JSON.stringify({ default_agent: "plan" }));
  installOpenCode({ repo, home, makeDefault: false });
  assert.equal(read().default_agent, "plan", "the user's own default stays");
  assert.equal(installOpenCode({ repo, home }).keptDefault, "plan", "also when c2f would make ctf the default");
  assert.equal(read().default_agent, "plan");
});
