/**
 * Waiting behaviour of the real extension in headless Edge: never wait on something that is not
 * going to happen, always wait for what is (a big model thinking), and notice quota problems at
 * once. Pages reproduce what the live sites do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Bridge } from "../src/bridge.js";
import { Router } from "../src/router.js";
import { Limits } from "../src/limits.js";
import { SITE_DEFAULTS } from "../src/config.js";
import { EDGE, freePort, startEdge } from "./edge-harness.js";

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Chat</title></head><body>${body}</body></html>`;

/** A chat page: composer + send form; `onSubmit` is the page-side script run when a prompt is sent. */
const chat = (extra, onSubmit) =>
  page(`${extra}
<form id="f"><textarea id="prompt-textarea"></textarea><button type="submit" data-testid="send-button">Send</button></form>
<script>
  const say = (t) => { const a = document.createElement("article"); a.setAttribute("data-message-author-role", "assistant"); a.textContent = t; document.body.append(a); };
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); const prompt = document.getElementById("prompt-textarea").value; document.getElementById("prompt-textarea").value = ""; ${onSubmit} });
</script>`);

const PAGES = {
  // A control labelled "stop" that is on screen from the start and never goes away (dictation).
  "/stale-stop": chat(`<button aria-label="Dikteyi durdur" style="display:block">mic</button>`, `setTimeout(() => say("quick answer"), 300);`),
  // A big model that thinks for 5 s (stop control visible, no text) and then answers.
  "/thinking": chat(``, `const s = document.createElement("button"); s.setAttribute("data-testid", "stop-button"); s.textContent = "Stop"; document.body.append(s);
    setTimeout(() => { s.remove(); say("deep answer"); }, 5000);`),
  // A "stop" control that appears with the send and never leaves, next to a short finished reply.
  "/stuck-stop": chat(``, `const s = document.createElement("button"); s.setAttribute("data-testid", "stop-button"); s.textContent = "Stop"; document.body.append(s); setTimeout(() => say("ok"), 300);`),
  // The quota runs out after the send: a toast, no reply.
  "/toast-limit": chat(``, `setTimeout(() => { const t = document.createElement("div"); t.setAttribute("role", "alert"); t.textContent = "You've reached your usage limit. Try again in 2 hours."; document.body.append(t); }, 200);`),
  // The chat has no earlier turns; it echoes what it receives.
  "/echo": chat(``, `setTimeout(() => say("got: " + prompt), 200);`),
  // Like Gemini/DeepSeek: the answer is only drawn while the page says it is visible.
  "/needs-visible": chat(``, `const draw = () => (document.visibilityState === "visible" && !document.hidden ? say("rendered while in the background") : setTimeout(draw, 200)); setTimeout(draw, 200);`),
  // Composer disabled by the site, with its notice.
  "/disabled": page(`<div role="alert">You've reached your usage limit. Try again in 3 hours.</div><textarea id="prompt-textarea" disabled></textarea>`),
};

test("waiting: nothing is waited on needlessly, long thinking is waited out, quota problems are caught at once", { timeout: 300_000 }, async (t) => {
  if (!EDGE) {
    t.skip("Microsoft Edge not installed");
    return;
  }
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url.split("?")[0]];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body || "nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = "e2e-speed-0123456789";
  const bridge = new Bridge({ port: await freePort(), requestTimeoutMs: 120_000, token });
  let edge;
  try {
    await bridge.start();
    edge = await startEdge({ bridge, token });
    // One tab per site is reused, so each case starts from a closed tab.
    const closeTabs = () =>
      edge.cdp.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => { for (const t of await chrome.tabs.query({ url: "${origin}/*" })) await chrome.tabs.remove(t.id); return 1; })()` }, edge.worker);
    const ask = async (route, extra = {}) => {
      await closeTabs();
      const began = Date.now();
      const res = await bridge.chat({ site: "generic", prompt: "hello", freshChat: false, timeoutMs: 120_000, meta: { startUrl: `${origin}${route}` }, ...extra });
      return { ...res, took: Date.now() - began };
    };

    await t.test("a stop control that was already there before sending is ignored, so the reply is not held for minutes", async () => {
      const res = await ask("/stale-stop");
      assert.match(res.reply, /quick answer/);
      assert.ok(res.took < 8000, `a finished reply took ${res.took} ms: the stale stop control was waited on`);
      assert.ok(res.timings && res.timings.total > 0, "the turn reports its timings");
    });

    await t.test("a model that thinks silently with its stop control showing is waited for, and the answer is taken as soon as it ends", async () => {
      const res = await ask("/thinking");
      assert.match(res.reply, /deep answer/);
      assert.ok(res.took >= 4500, `returned after ${res.took} ms: gave up before the model finished`);
      assert.ok(res.took < 11_000, `took ${res.took} ms: waited well past the end of the reply`);
    });

    await t.test("a stop-like control that never leaves does not hold a finished reply for minutes", async () => {
      const res = await ask("/stuck-stop", { quietMs: 2500 });
      assert.match(res.reply, /ok/);
      assert.ok(res.took < 9000, `a one-word reply took ${res.took} ms: the stuck stop control was waited on`);
    });

    await t.test("a quota notice instead of a reply is reported within seconds, not after the start budget", async () => {
      const began = Date.now();
      await assert.rejects(ask("/toast-limit"), (err) => {
        assert.match(err.message, /hit a usage limit/);
        assert.match(err.message, /2 hours/);
        return true;
      });
      assert.ok(Date.now() - began < 9000, `took ${Date.now() - began} ms to notice the limit`);
    });

    await t.test("a site that only draws while 'visible' still answers from a background tab, and no window is raised or opened", async () => {
      const snapshot = () =>
        edge.cdp
          .send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => JSON.stringify((await chrome.windows.getAll()).map((w) => ({ id: w.id, focused: w.focused, state: w.state }))))()` }, edge.worker)
          .then((r) => JSON.parse(r.result.value));
      const before = await snapshot();
      const res = await ask("/needs-visible");
      assert.match(res.reply, /rendered while in the background/);
      const after = await snapshot();
      assert.equal(after.length, before.length, "no window may be opened");
      assert.deepEqual(after.map((w) => [w.id, w.focused, w.state]), before.map((w) => [w.id, w.focused, w.state]), "no window may be focused, raised or restored");
    });

    await t.test("a follow-up into a chat that lost its earlier turns is refused, so the full context can be resent", async () => {
      await assert.rejects(ask("/echo", { continuing: true }), /context_lost/);
    });

    await t.test("the router resends everything when the chat it meant to continue is gone", async () => {
      const cfg = { preferredSites: ["generic"], strictSettings: false, preflight: true, requestTimeoutMs: 120_000, focusTab: false, sites: { generic: structuredClone(SITE_DEFAULTS) }, phases: {} };
      const logs = [];
      const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-spd-")), "u.json") }), log: (m) => logs.push(m) });
      router.sessions.set("generic", { chars: 10, turns: 1, at: Date.now() }); // pretend an earlier turn was sent here
      await closeTabs();
      const res = await router.ask({ phase: "step", prompt: "FULL CONTEXT", followUp: "SHORT", freshChat: false, meta: { startUrl: `${origin}/echo` } });
      assert.match(res.reply, /got: FULL CONTEXT/, "the full prompt must arrive after the follow-up is refused");
      assert.equal(res.continued, false);
      assert.ok(logs.some((l) => /earlier turns are gone/.test(l)), logs.join("\n"));
    });

    await t.test("a site out of quota is probed and skipped before anything is sent to it", async () => {
      await ask("/disabled").catch(() => {}); // leaves the tab open, as in real use
      const probe = await bridge.probe({ site: "generic" });
      assert.equal(probe.tab, true);
      assert.equal(probe.state.composerDisabled, true);
      assert.match(probe.state.hardLimit, /usage limit/);
      const cfg = { preferredSites: ["generic"], strictSettings: false, preflight: true, requestTimeoutMs: 120_000, focusTab: false, sites: { generic: structuredClone(SITE_DEFAULTS) }, phases: {} };
      const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-spd-")), "u.json") });
      const logs = [];
      const router = new Router({ cfg, bridge, limits, log: (m) => logs.push(m) });
      const began = Date.now();
      await assert.rejects(router.ask({ phase: "step", prompt: "hello", freshChat: false }), /generic: at its usage limit/);
      assert.ok(Date.now() - began < 3000, `the skip took ${Date.now() - began} ms`);
      const gate = limits.check("generic", {});
      assert.equal(gate.ok, false, "the site is benched");
      assert.ok(Math.abs(gate.retryAt - Date.now() - 3 * 3_600_000) < 60_000, "for the 3 hours the site stated");
    });

    await t.test("a probe with no tab open is not an obstacle", async () => {
      await closeTabs();
      const probe = await bridge.probe({ site: "generic" });
      assert.equal(probe.tab, false);
    });
    await t.test("a reply that finishes while the extension's worker is down is still delivered, not lost", async () => {
      // Chrome restarts the worker at will; the chat keeps running in its tab. Stop the worker
      // while the model is still thinking and expect the answer anyway.
      const answer = ask("/thinking");
      await new Promise((r) => setTimeout(r, 1500));
      const helloBefore = bridge.clientInfo.at;
      assert.ok(await edge.stopWorker(), "the extension worker was found and stopped");
      const res = await answer;
      assert.match(res.reply, /deep answer/);
      assert.notEqual(bridge.clientInfo?.at, helloBefore, "the worker really restarted and said hello again");
    });
  } finally {
    await bridge.stop();
    server.close();
    await edge?.close();
  }
});
