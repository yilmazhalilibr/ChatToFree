/**
 * Proves that a site state the user must act on actually reaches them with the right
 * wording and without a 45s wait. Runs the real extension in Edge against the mock
 * server, whose /challenge page renders a Cloudflare-style interstitial.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { killTree } from "./edge-harness.js";
import { Bridge } from "../src/bridge.js";
import http from "node:http";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..", "extension");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

const CHALLENGE_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Just a moment...</title></head><body><h1>Bir dakika lütfen...</h1>
<p>Checking your browser before accessing the site.</p></body></html>`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.waits = new Map();
    this.ws.on("message", (m) => {
      const d = JSON.parse(String(m));
      if (d.id && this.waits.has(d.id)) {
        this.waits.get(d.id)(d);
        this.waits.delete(d.id);
      }
    });
  }
  ready() {
    return new Promise((r) => this.ws.once("open", r));
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.waits.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

test("a bot-check page is reported to the user, not swallowed as 'no tab'", { timeout: 180_000 }, async (t) => {
  if (!EDGE) {
    t.skip("Microsoft Edge not installed");
    return;
  }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CHALLENGE_PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const pagePort = server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-block-"));
  const token = "e2e-blocked-0123456789";
  const bridge = new Bridge({ port: await freePort(), requestTimeoutMs: 90_000, token });
  let cdp;
  let child;
  try {
    await bridge.start();
    child = spawn(
      EDGE,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const pf = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 200 && !fs.existsSync(pf); i++) await new Promise((r) => setTimeout(r, 100));
    const [port, wsp] = fs.readFileSync(pf, "utf8").split("\n");
    cdp = new Cdp(`ws://127.0.0.1:${port}${wsp}`);
    await cdp.ready();

    let worker = null;
    for (let i = 0; i < 60 && !worker; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { targetInfos } = await cdp.send("Target.getTargets");
      for (const target of targetInfos.filter((x) => x.type === "service_worker")) {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        const name = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: "chrome.runtime.getManifest().name" }, sessionId);
        if (name.result?.value === "ChatToFree Bridge") {
          worker = sessionId;
          break;
        }
      }
    }
    assert.ok(worker, "extension did not load");
    await cdp.send(
      "Runtime.evaluate",
      { awaitPromise: true, returnByValue: true, expression: `(async () => { await chrome.storage.local.set({ port: ${bridge.port}, token: "${token}" }); try { ws.close(); } catch {} ws = null; ensureConnected(); return 1; })()` },
      worker,
    );
    assert.ok(await bridge.waitForClient(20_000), "extension never connected");

    const started = Date.now();
    await assert.rejects(
      () =>
        bridge.chat({
          site: "generic",
          prompt: "hello",
          freshChat: false,
          timeoutMs: 120_000,
          meta: { startUrl: `http://127.0.0.1:${pagePort}/` },
        }),
      (err) => {
        // The user-facing wording must name the bot check and what to do about it.
        assert.match(err.message, /bot\/captcha check/i);
        assert.match(err.message, /Open generic in your own Chrome window/i);
        assert.doesNotMatch(err.message, /Could not open a generic tab/i);
        return true;
      },
    );
    // And it must not sit through the full 45s readiness window.
    assert.ok(Date.now() - started < 40_000, `took ${Date.now() - started}ms to report the block`);
  } finally {
    await bridge.stop();
    server.close();
    cdp?.close();
    killTree(child);
    await new Promise((r) => setTimeout(r, 600));
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
});
