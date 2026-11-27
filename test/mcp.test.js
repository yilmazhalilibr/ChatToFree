/**
 * The MCP server speaks the protocol correctly and its settings tools behave like the CLI.
 * Hermetic: own config dir, own port, no browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.resolve(HERE, "..", "src", "mcp.js");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function start({ port, config = {}, login = false, apiPort = "off" }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-mcp-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port, ...config }));
  if (login) fs.writeFileSync(path.join(home, "deepseek-auth.json"), JSON.stringify({ token: "t", cookie: "", wasmUrl: "https://fe-static.deepseek.com/x.wasm" }));
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, C2F_CONFIG_HOME: home, C2F_API_PORT: String(apiPort), C2F_DEEPSEEK_URL: "http://127.0.0.1:1" }, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const stray = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stray.push(line);
      return;
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let seq = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 20_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  return { child, rpc, call, home, stray, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`), stop: () => child.kill() };
}

test("MCP server: handshake, tool list, settings tools, errors", { timeout: 60_000 }, async (t) => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  const port = busy.address().port; // occupied on purpose: a bridge cannot start here
  const s = await start({ port, config: { automation: true } }); // every tool, as an opted-in user has them
  try {
    await t.test("initialize answers with a supported protocol and the tools capability", async () => {
      const r = (await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })).result;
      assert.equal(r.protocolVersion, "2025-06-18");
      assert.ok(r.capabilities.tools);
      assert.equal(r.serverInfo.name, "c2f");
      const old = (await s.rpc("initialize", { protocolVersion: "1999-01-01" })).result;
      assert.equal(old.protocolVersion, "2025-11-25", "an unknown version gets the newest we speak");
      s.notify("notifications/initialized"); // a notification must not be answered
      assert.deepEqual((await s.rpc("ping")).result, {});
    });

    await t.test("every tool has a description and an object schema", async () => {
      const { tools } = (await s.rpc("tools/list")).result;
      assert.deepEqual(tools.map((x) => x.name).sort(), ["advise", "build", "chat", "config", "job", "models", "status", "usage", "use"]);
      for (const tool of tools) {
        assert.ok(tool.description.length > 20, tool.name);
        assert.equal(tool.inputSchema.type, "object", tool.name);
      }
      const build = tools.find((x) => x.name === "build");
      assert.deepEqual(build.inputSchema.required, ["request"]);
      assert.deepEqual(tools.find((x) => x.name === "advise").inputSchema.required, ["message"]);
    });

    await t.test("use saves for every session and config shows it; a bad value is refused and saves nothing", async () => {
      const ok = await s.call("use", { site: "claude", model: "Haiku 5.5", reasoning: "low", perHour: 7 });
      assert.notEqual(ok.isError, true, JSON.stringify(ok));
      const cfg = (await s.call("config")).content[0].text;
      assert.match(cfg, /claude\s+enabled=true model=Haiku 5\.5 reasoning=low .* perHour=7/);
      const bad = await s.call("use", { site: "claude", reasoning: "ultra" });
      assert.equal(bad.isError, true);
      const saved = JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8"));
      assert.equal(saved.sites.claude.reasoning, "low", "the refused value was not written");
      assert.equal(saved.port, port, "unrelated settings survive");
      const none = await s.call("use", { site: "gemini" });
      assert.equal(none.isError, true, "a request that changes nothing says so");
    });

    await t.test("usage lists every site and can clear one", async () => {
      const text = (await s.call("usage")).content[0].text;
      for (const site of ["chatgpt", "claude", "gemini", "deepseek"]) assert.match(text, new RegExp(site));
      assert.match((await s.call("usage", { reset: "claude" })).content[0].text, /cleared/);
    });

    await t.test("status answers at once when the browser cannot be reached; a tool that needs it explains the busy port", async () => {
      const began = Date.now();
      const r = await s.call("status");
      assert.notEqual(r.isError, true, "status is a report, not something that fails");
      assert.match(r.content[0].text, /chatgpt\s+not available: port \d+ is in use by another c2f process/);
      assert.ok(Date.now() - began < 5000, "it must not wait for a browser");
      const m = await s.call("models");
      assert.equal(m.isError, true);
      assert.match(m.content[0].text, /in use by another c2f process/);
    });

    await t.test("unknown job, unknown tool, unknown method and broken JSON are answered, not fatal", async () => {
      assert.equal((await s.call("job", { id: "job99" })).isError, true);
      assert.equal((await s.rpc("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
      assert.equal((await s.rpc("resources/list")).error.code, -32601);
      s.child.stdin.write("{not json\n");
      assert.deepEqual((await s.rpc("ping")).result, {}, "the server is still alive");
    });

    assert.deepEqual(s.stray, [], "nothing but protocol messages may reach stdout");
  } finally {
    s.stop();
    busy.close();
  }
});

test("with a saved DeepSeek login: status is instant without any browser, and the model endpoint is served", { timeout: 60_000 }, async () => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  const free = net.createServer();
  await new Promise((r) => free.listen(0, "127.0.0.1", r));
  const apiPort = free.address().port;
  await new Promise((r) => free.close(r));
  // The bridge port is taken on purpose: nothing here may need it.
  const s = await start({ port: busy.address().port, config: { preferredSites: ["deepseek"], automation: true }, login: true, apiPort });
  try {
    await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const began = Date.now();
    const r = await s.call("status");
    assert.equal(r.content[0].text, "deepseek  direct: ready", "one line, about the only site in use");
    assert.ok(Date.now() - began < 3000);

    let health = null;
    for (let i = 0; i < 40 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${apiPort}/health`).then((x) => x.json()).catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(health, { status: "ok", service: "c2f" }, "OpenCode can pick DeepSeek as a model while this server runs");
    const noKey = await fetch(`http://127.0.0.1:${apiPort}/v1/models`);
    assert.equal(noKey.status, 401);
    const key = fs.readFileSync(path.join(s.home, "api-key"), "utf8").trim();
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
  } finally {
    s.stop();
    busy.close();
  }
});

test("by default the web model can only be talked to: no machine-style tools, no model endpoint", { timeout: 60_000 }, async () => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  const free = net.createServer();
  await new Promise((r) => free.listen(0, "127.0.0.1", r));
  const apiPort = free.address().port;
  await new Promise((r) => free.close(r));
  const s = await start({ port: busy.address().port, config: { preferredSites: ["deepseek"] }, login: true, apiPort });
  try {
    await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const { tools } = (await s.rpc("tools/list")).result;
    assert.deepEqual(tools.map((x) => x.name).sort(), ["advise", "status"]);
    assert.match(tools.find((x) => x.name === "advise").description, /Write naturally from the actual situation[\s\S]*first person/);

    for (const name of ["build", "chat"]) {
      const r = await s.call(name, { request: "x", prompt: "x" });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /is turned off.*Use `advise` instead.*c2f config set automation true/s, `${name} must say why and what to use`);
    }
    const tooLong = await s.call("advise", { message: "x".repeat(30_001) });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0].text, /the limit is 30000\. Split it: one file or class per message/);

    await new Promise((r) => setTimeout(r, 700));
    const up = await fetch(`http://127.0.0.1:${apiPort}/health`).then(() => true, () => false);
    assert.equal(up, false, "the endpoint that lets an agent drive DeepSeek as its model is not served");
  } finally {
    s.stop();
    busy.close();
  }
});
