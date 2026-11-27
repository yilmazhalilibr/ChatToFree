/**
 * Sign-in detection on the real extension, against pages that reproduce what the live sites
 * actually render. Guards two failure modes: reporting a signed-in tab as logged out (blocks
 * the user), and reporting a logged-out tab as ready (silent failure at send time).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocket } from "ws";
import { killTree } from "./edge-harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..", "extension");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Mock</title></head><body>${body}</body></html>`;

const CASES = {
  // Measured: ChatGPT and Gemini both show a composer while logged out.
  "/logged-out": page(`
    <header><button aria-label="Oturum aç">Oturum aç</button></header>
    <textarea id="prompt-textarea"></textarea>`),
  // The Turkish "Oturum aç" label: \b never matches after "aç", so this must still be caught.
  "/logged-out-tr": page(`
    <nav><a href="/login">Giriş yap</a></nav>
    <textarea id="prompt-textarea"></textarea>`),
  // Signed in, but a chat message links to "Sign in to GitHub". Must stay ready.
  "/signed-in-message-link": page(`
    <button aria-label="New chat">New chat</button>
    <div data-message-author-role="assistant"><p>To push, <a href="https://github.com/login">Sign in to GitHub</a>.</p></div>
    <textarea id="prompt-textarea"></textarea>`),
  "/signed-in": page(`<textarea id="prompt-textarea"></textarea>`),
  // DeepSeek's actual challenge title, which the old text regex missed.
  // The real ChatGPT files/images banner (user screenshot). Text chat still works.
  "/limited-tr": page(`<textarea id="prompt-textarea"></textarea><div>Kullanım 05:23 itibarıyla itibarıyla yenilenene kadar dosyalar, görseller ve veri analizi kullanılamaz. Yalnızca metinle sohbete devam et veya daha fazla erişim için planını yükselt.</div>`),
  // A signed-in chat whose reply merely talks about limits, plus the normal "Upgrade plan" entry.
  "/reply-mentions-limit": page(`<nav><a>Upgrade your plan</a></nav><article data-message-author-role="assistant"><div>Kullanım yenilenene kadar bekleyin: the API usage limit resets daily, so try again later or upgrade your plan.</div></article><textarea id="prompt-textarea"></textarea>`),
  // A hard limit: the site itself disables the composer.
  "/hard-limit": page(`<textarea id="prompt-textarea" disabled></textarea>`),
  "/challenge-tr": page(`<h1>İnsan olduğunuzu doğrulayalım</h1><p>Devam etmeden önce güvenlik denetimini tamamlayın.</p>`),
};

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

test("sign-in and challenge detection match what the live sites render", { timeout: 180_000 }, async (t) => {
  if (!EDGE) {
    t.skip("Microsoft Edge not installed");
    return;
  }
  const server = http.createServer((req, res) => {
    const body = CASES[req.url.split("?")[0]];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body || "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const pagePort = server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-login-"));
  let cdp;
  let child;
  try {
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
    cdp = new Cdp(`ws://127.0.0.1:${port}${wsp.trim()}`);
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

    const out = await cdp.send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const cases = ${JSON.stringify(Object.keys(CASES))};
          const results = {};
          for (const path of cases) {
            const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:${pagePort}' + path, active: false });
            let ping = null;
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 400));
              try { ping = await chrome.tabs.sendMessage(tab.id, { type: 'c2f.ping', site: 'generic' }); } catch { ping = null; }
              if (ping) break;
            }
            await chrome.tabs.remove(tab.id);
            results[path] = ping;
          }
          return JSON.stringify(results);
        })()`,
      },
      worker,
    );
    const results = JSON.parse(out.result.value);

    const pick = (r) => ({ ready: r.ready, needsLogin: r.needsLogin, challenge: r.challenge, loggedOutUI: r.loggedOutUI });

    assert.deepEqual(pick(results["/logged-out"]), { ready: false, needsLogin: true, challenge: false, loggedOutUI: true });
    assert.equal(results["/logged-out-tr"].needsLogin, true, "Turkish 'Giriş yap' must be detected");
    assert.equal(results["/signed-in"].ready, true, "a clean composer must be ready");
    assert.equal(
      results["/signed-in-message-link"].needsLogin,
      false,
      "a chat message linking to a login page must not lock the tab",
    );
    assert.equal(results["/signed-in-message-link"].ready, true);
    assert.equal(results["/challenge-tr"].challenge, true, "DeepSeek's Turkish challenge title must be detected");
    assert.equal(results["/limited-tr"].ready, true, "a files/images-only limit must not disable text chat");
    assert.ok(results["/limited-tr"].limited, "the banner is still reported as information");
    assert.equal(results["/reply-mentions-limit"].ready, true, "a reply about limits must not block the site");
    assert.equal(results["/reply-mentions-limit"].limited, null, "a reply or sidebar entry is not a notice");
    assert.equal(results["/hard-limit"].ready, false, "a disabled composer is a hard stop");
    assert.equal(results["/hard-limit"].composerDisabled, true);
    assert.equal(results["/signed-in"].limited, null, "a normal page has no notice");

    // inspect must report the same verdict: live-status reads those fields, and before this
    // it fell through to "a composer exists" and called signed-out tabs ready.
    const viaInspect = await cdp.send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:${pagePort}/logged-out', active: false });
          let info = null;
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 400));
            try { info = await chrome.tabs.sendMessage(tab.id, { type: 'c2f.inspect', site: 'generic' }); } catch { info = null; }
            if (info && info.composerTag !== undefined) break;
          }
          await chrome.tabs.remove(tab.id);
          return JSON.stringify(info);
        })()`,
      },
      worker,
    );
    const inspected = JSON.parse(viaInspect.result.value);
    assert.equal(inspected.ready, false, "inspect must not call a signed-out tab ready");
    assert.equal(inspected.needsLogin, true, "inspect must report the sign-in wall");
  } finally {
    server.close();
    cdp?.close();
    killTree(child);
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
});
