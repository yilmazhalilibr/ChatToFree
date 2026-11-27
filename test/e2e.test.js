/**
 * End-to-end: real Edge + the real unpacked extension + the real bridge +
 * the real agent loop, talking to a local mock chat page that renders markdown
 * the way ChatGPT/Claude do. Proves the whole path without any account.
 *
 * Google-branded Chrome 157 ignores --load-extension, so this uses Edge.
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
import { LocalModel } from "../src/local.js";
import { Workspace } from "../src/workspace.js";
import { Agent } from "../src/agent.js";
import { Router } from "../src/router.js";
import { Limits } from "../src/limits.js";
import { SITE_DEFAULTS } from "../src/config.js";
import { startMockChat } from "./mock-chat.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const EXT = path.join(ROOT, "extension");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

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
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
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

async function launchEdge(profile) {
  const child = spawn(
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
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(portFile)) throw new Error("Edge never opened its DevTools port");
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").split("\n");
  const cdp = new Cdp(`ws://127.0.0.1:${port}${wsPath}`);
  await cdp.ready();
  return { child, cdp };
}

/** Find OUR service worker by manifest name, never by filename. */
async function ourWorker(cdp) {
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((x) => x.type === "service_worker")) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const ev = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: "chrome.runtime.getManifest().name" }, sessionId);
      if (ev.result?.value === "ChatToFree Bridge") return { sessionId, targetId: t.targetId };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("ChatToFree Bridge service worker never appeared (extension did not load)");
}

test("end to end: extension → bridge → agent writes a working game", { timeout: 240_000 }, async (t) => {
  if (!EDGE) {
    t.skip("Microsoft Edge not installed");
    return;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-prof-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-out-"));
  const mock = await startMockChat(0);
  const token = "e2e-token-0123456789";
  const bridge = new Bridge({ port: await freePort(), requestTimeoutMs: 90_000, token });
  let edge;
  try {
    await bridge.start();
    edge = await launchEdge(profile);
    const worker = await ourWorker(edge.cdp);

    // Point the extension at this test's bridge port and reconnect.
    const set = await edge.cdp.send(
      "Runtime.evaluate",
      { awaitPromise: true, returnByValue: true, expression: `(async () => { await chrome.storage.local.set({ port: ${bridge.port}, token: "${token}" }); try { ws.close(); } catch {} ws = null; ensureConnected(); return 'ok'; })()` },
      worker.sessionId,
    );
    assert.equal(set.result.value, "ok");

    const info = await bridge.waitForClient(20_000);
    assert.ok(info, "extension never connected to the bridge");
    assert.ok(info.sites.includes("generic"), "extension did not report its adapters");

    // Fail loudly here if the mock page script is broken, instead of a vague no_reply later.
    const served = await fetch(`http://127.0.0.1:${mock.port}/app.js`).then((r) => r.text());
    assert.doesNotThrow(() => new Function(served), "mock page script does not parse");
    assert.match(await fetch(`http://127.0.0.1:${mock.port}/`).then((r) => r.text()), /src="\/app\.js"/);

    const cfg = {
      preferredSites: ["generic"],
      workspace: workDir,
      freshChatPerRequest: true,
      requestTimeoutMs: 90_000,
      maxRoundsPerStep: 4,
      design: true,
      chatMeta: { startUrl: `http://127.0.0.1:${mock.port}/` },
      strictSettings: false,
      sites: { generic: structuredClone(SITE_DEFAULTS) },
      phases: {},
      local: { enabled: false, baseUrl: "http://127.0.0.1:1/v1", model: "auto", maxDigestChars: 4000 },
    };
    // Budgets live in a file; keep this run's out of the developer's real usage file.
    const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(workDir, "usage.json") }), log: () => {} });
    const agent = new Agent({ cfg, bridge, router, local: new LocalModel(cfg.local), workspace: new Workspace(workDir), log: () => {} });
    const res = await agent.build("Basit bir HTML snake oyunu yap");

    // The web model (here: the mock's scripted replies) wrote the file, via the extension.
    const out = path.join(workDir, "index.html");
    assert.ok(fs.existsSync(out), "agent never wrote index.html");
    const html = fs.readFileSync(out, "utf8");
    // Screen-reader-only text and the toolbar are not part of the answer.
    for (const turn of res.turns) {
      assert.doesNotMatch(turn.preview, /Claude responded|minutes ago/, `reader returned hidden/toolbar text: ${turn.preview.slice(0, 80)}`);
    }
    assert.ok(res.turns.every((turn) => turn.chars > 20), "a reply was cut off right after its first heading mark");
    assert.match(html, /<canvas/i);
    assert.match(html, /ArrowUp|keydown/);
    assert.ok(fs.existsSync(path.join(workDir, ".c2f", "design.md")), "design round is missing");

    // Exactly one turn per phase: design, plan, one step round, one verify round (the review of
    // the design is off by default). A failed step RUN would burn retry rounds, so the count
    // also proves the RUN succeeded.
    assert.equal(res.turns.length, 4, `expected exactly 4 turns (no retries), got ${res.turns.length}: ${res.turns.map((t) => t.label).join(", ")}`);
    assert.deepEqual(
      res.turns.map((t) => t.label),
      ["design", "plan", "step 1 round 1", "verify 1"],
    );
    // One conversation for the whole task: only the first turn opens a chat, every later one is a
    // short follow-up into it (the model keeps its memory, and no time goes on new chats).
    assert.deepEqual(res.turns.map((t) => t.continued), [false, true, true, true], "later turns must continue the same chat");
    assert.ok(res.turns.every((t) => t.timings && t.timings.total > 0), "every turn reports where its time went");
    assert.ok(res.turns.every((turn) => turn.site === "generic" && turn.chars > 20));

    // The file had to come from a heading. Assert the DOM really holds an <h3>: if the mock
    // left "### FILE" inside a <p>, the hashes would survive untouched and this test would
    // prove nothing about replyText restoring them.
    const { targetInfos } = await edge.cdp.send("Target.getTargets");
    const mockTab = targetInfos.find((x) => x.type === "page" && x.url.includes(String(mock.port)));
    assert.ok(mockTab, "mock chat tab not found");
    const { sessionId } = await edge.cdp.send("Target.attachToTarget", { targetId: mockTab.targetId, flatten: true });
    const headings = await edge.cdp.send("Runtime.evaluate", {
      returnByValue: true,
      // Only the assistant's own markup counts: our prompt (user turn) legitimately contains
      // literal "### FILE" instructions.
      expression: `JSON.stringify({h3:[...document.querySelectorAll('[data-message-author-role=assistant] h3')].map(h=>h.textContent), strayHashes:[...document.querySelectorAll('[data-message-author-role=assistant]')].some(a=>/^#{2,4}\\s/m.test(a.innerText)), cookieClicks: window.__cookieClicks || 0, consentButtons: document.querySelectorAll('#consent button').length})`,
    }, sessionId);
    const parsed = JSON.parse(headings.result.value);
    assert.ok(parsed.h3.includes("FILE index.html"), `expected an <h3>FILE index.html</h3>, got ${JSON.stringify(parsed.h3)}`);
    assert.equal(parsed.strayHashes, false, "mock leaked raw markdown hashes into the DOM; headings are not being tested");
    assert.equal(parsed.cookieClicks, 0, "the extension clicked a consent-banner button on the user's behalf");
    assert.equal(parsed.consentButtons, 2, "fixture lost its consent banner; the guard is untested");

    assert.match(
      res.turns.map((t) => t.preview).join("\n"),
      /^### FILE index\.html$/m,
      "heading never survived the browser round trip; the section format is dead on real sites",
    );

    // Regression: when a send silently fails, the tab still holds the PREVIOUS assistant
    // reply. Returning that would replay stale ops, so it must error instead.
    // (timeoutMs must stay above background.js's 20s floor or the bridge timeout fires first.)
    let silentErr = "";
    await assert.rejects(
      () => bridge.chat({ site: "generic", prompt: "C2F_SILENT", freshChat: false, timeoutMs: 40_000, meta: { startUrl: `http://127.0.0.1:${mock.port}/` } }),
      (err) => {
        silentErr = err.message;
        return true;
      },
    );
    assert.match(silentErr, /no_reply|no_send_button/);
    assert.doesNotMatch(silentErr, /self-contained|index\.html/, "stale reply leaked through a failed send");
  } finally {
    await bridge.stop();
    mock.server.close();
    try {
      edge?.cdp.close();
    } catch {}
    killTree(edge?.child);
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
