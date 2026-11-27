/**
 * A site that hits its own usage limit must say so in a way the router can act on, and the
 * router must stop sending it work. Real extension in headless Edge against pages that show
 * the two forms a hard limit takes: a disabled composer, and a toast after the send.
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

const PAGES = {
  // The site disables the composer itself and says why.
  "/disabled": page(`<div role="alert">You've reached your usage limit. Try again in 3 hours.</div><textarea id="prompt-textarea" disabled></textarea>`),
  // The send works, then a toast replaces the answer.
  "/toast": page(`<form id="f"><textarea id="prompt-textarea"></textarea><button type="submit" data-testid="send-button">Send</button></form><div id="t"></div>
    <script>document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); document.getElementById("prompt-textarea").value = "";
      document.getElementById("t").innerHTML = '<div role="status">Too many requests. Please try again in 2 hours.</div>'; });</script>`),
  // Disabled for a second (hydration / a reply still streaming), then fine: not a limit.
  "/blip": page(`<form id="f"><textarea id="prompt-textarea" disabled></textarea><button type="submit" data-testid="send-button">Send</button></form>
    <script>setTimeout(() => document.getElementById("prompt-textarea").disabled = false, 1000);
    document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); document.getElementById("prompt-textarea").value = "";
      const a = document.createElement("article"); a.setAttribute("data-message-author-role", "assistant"); a.textContent = "answer after the blip"; document.body.append(a); });</script>`),
  // Disabled and staying disabled, but the page says nothing about a limit.
  "/disabled-quiet": page(`<textarea id="prompt-textarea" disabled></textarea>`),
  // Looks like a limit in prose, but it is just a reply: must NOT trip the detector.
  "/talks-about-limits": page(`<article data-message-author-role="assistant">The API usage limit resets daily; you've reached the end of this chapter. Try again later.</article>
    <form id="f"><textarea id="prompt-textarea"></textarea><button type="submit">Send</button></form>
    <script>document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); document.getElementById("prompt-textarea").value = "";
      const a = document.createElement("article"); a.setAttribute("data-message-author-role", "assistant"); a.textContent = "fine, here is the answer"; document.body.append(a); });</script>`),
};

test("a hard usage limit is reported with its reset, and the router benches the site", { timeout: 240_000 }, async (t) => {
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
  const token = "e2e-limit-0123456789";
  const bridge = new Bridge({ port: await freePort(), requestTimeoutMs: 90_000, token });
  let edge;
  try {
    await bridge.start();
    edge = await startEdge({ bridge, token });
    // The extension keeps one tab per site and reuses it, so each case starts from a closed tab.
    const closeTabs = () =>
      edge.cdp.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => { for (const t of await chrome.tabs.query({ url: "${origin}/*" })) await chrome.tabs.remove(t.id); return 1; })()` }, edge.worker);
    const ask = async (route, extra = {}) => {
      await closeTabs();
      return bridge.chat({ site: "generic", prompt: "hello", freshChat: false, timeoutMs: 30_000, meta: { startUrl: `${origin}${route}` }, ...extra });
    };

    await t.test("a disabled composer is a limit, with the site's own wording", async () => {
      await assert.rejects(ask("/disabled"), (err) => {
        assert.match(err.message, /hit a usage limit/);
        assert.match(err.message, /Try again in 3 hours/);
        return true;
      });
    });

    await t.test("a composer disabled for a moment is not a usage limit", async () => {
      const res = await ask("/blip");
      assert.match(res.reply, /answer after the blip/);
    });

    await t.test("a composer that stays disabled with no notice is a retryable error and earns no cooldown", async () => {
      await assert.rejects(ask("/disabled-quiet"), (err) => {
        assert.match(err.message, /composer is disabled/);
        assert.doesNotMatch(err.message, /hit a usage limit/);
        return true;
      });
      const cfg = { preferredSites: ["generic"], strictSettings: false, requestTimeoutMs: 30_000, focusTab: false, sites: { generic: structuredClone(SITE_DEFAULTS) }, phases: {} };
      const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-lim-")), "usage.json") });
      await closeTabs();
      await assert.rejects(new Router({ cfg, bridge, limits }).ask({ phase: "step", prompt: "hello", freshChat: false, meta: { startUrl: `${origin}/disabled-quiet` } }), /composer is disabled/);
      assert.equal(limits.check("generic", {}).ok, true, "no cooldown for a silent disable");
    });

    await t.test("a limit toast after the send is a limit, not a vague 'no reply'", async () => {
      await assert.rejects(ask("/toast"), (err) => {
        assert.match(err.message, /hit a usage limit/);
        assert.match(err.message, /try again in 2 hours/i);
        assert.doesNotMatch(err.message, /no_reply|did not start a reply/);
        return true;
      });
    });

    await t.test("a reply that merely talks about limits is not mistaken for one", async () => {
      const res = await ask("/talks-about-limits");
      assert.match(res.reply, /fine, here is the answer/);
    });

    await t.test("the router benches the site for the time the site gave, and stops contacting it", async () => {
      const cfg = {
        preferredSites: ["generic"],
        strictSettings: false,
        requestTimeoutMs: 30_000,
        focusTab: false,
        sites: { generic: structuredClone(SITE_DEFAULTS) },
        phases: {},
      };
      let now = Date.now();
      const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-lim-")), "usage.json"), now: () => now });
      const logs = [];
      const router = new Router({ cfg, bridge, limits, log: (m) => logs.push(m) });
      await closeTabs();
      await assert.rejects(router.ask({ phase: "step", prompt: "hello", freshChat: false, meta: { startUrl: `${origin}/toast` } }), /no web chat model answered/);
      const gate = limits.check("generic", {});
      assert.equal(gate.ok, false);
      const waitMs = gate.retryAt - now;
      assert.ok(Math.abs(waitMs - 2 * 3_600_000) < 5_000, `benched for ${Math.round(waitMs / 60000)} min, the site said 2 hours`);
      assert.ok(logs.some((l) => /generic is at its usage limit/.test(l)));
      // Second request: skipped without touching the browser.
      const before = Date.now();
      await assert.rejects(router.ask({ phase: "step", prompt: "hello", freshChat: false, meta: { startUrl: `${origin}/toast` } }), /generic: cooling down/);
      assert.ok(Date.now() - before < 2000, "a benched site must be skipped instantly");
      now += 3 * 3_600_000;
      assert.equal(limits.check("generic", {}).ok, true, "free again after the stated time");
    });
  } finally {
    await bridge.stop();
    server.close();
    await edge?.close();
  }
});
