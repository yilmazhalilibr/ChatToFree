/**
 * The extension's model / reasoning driver, run for real in headless Edge against a mock picker
 * that reproduces the traps measured on the live sites (see test/mock-picker.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocket } from "ws";
import { killTree } from "./edge-harness.js";
import { pickerPage } from "./mock-picker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..", "extension");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

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

test("model, reasoning and toggles are set through the page's own menus", { timeout: 240_000 }, async (t) => {
  if (!EDGE) {
    t.skip("Microsoft Edge not installed");
    return;
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pickerPage({ mode: url.searchParams.get("mode") || "click", lang: url.searchParams.get("lang") || "tr", stale: url.searchParams.get("stale") === "1" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const pagePort = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-settings-"));
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

    const inWorker = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression }, worker);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "worker eval failed");
      return JSON.parse(r.result.value);
    };

    /** Open the mock in a tab, run settings ops in order through the content script, report page state. */
    const runSeq = async (query, site, calls) =>
      inWorker(`(async () => {
        const win = (await chrome.windows.getAll({ windowTypes: ["normal"] }))[0];
        const tab = await chrome.tabs.create({ url: "http://127.0.0.1:${pagePort}/?${query}", active: true, windowId: win?.id });
        const replies = [];
        for (const call of ${JSON.stringify(calls)}) {
          let reply = null;
          for (let i = 0; i < 40 && !reply; i++) {
            await new Promise((r) => setTimeout(r, 300));
            try { reply = await chrome.tabs.sendMessage(tab.id, { type: "c2f.settings", site: ${JSON.stringify(site)}, op: call.op, settings: call.settings || {} }); } catch { reply = null; }
          }
          replies.push(reply);
        }
        const [{ result: page }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN",
          func: () => ({
            model: window.__state.model,
            effort: window.__state.effort,
            opened: window.__state.opened,
            upgradeClicks: window.__state.upgradeClicks,
            upsellOpen: Boolean(document.getElementById("upsell")),
            popupOpen: Boolean(document.querySelector(".popup")),
            expanded: document.getElementById("trigger").getAttribute("aria-expanded"),
            thinking: document.getElementById("think").getAttribute("aria-pressed"),
            label: document.getElementById("trigger").textContent,
          }),
        });
        await chrome.tabs.remove(tab.id);
        return JSON.stringify({ replies, page });
      })()`);
    const run = async (query, site, op, settings) => {
      const { replies, page } = await runSeq(query, site, [{ op, settings }]);
      return { reply: replies[0], page };
    };

    for (const mode of ["click", "pointerdown"]) {
      await t.test(`reads every model, the locked ones, the submenu and the levels (menu opens on ${mode})`, async () => {
        const { reply, page } = await run(`mode=${mode}&lang=tr`, "claude", "read");
        assert.ok(reply?.ok, JSON.stringify(reply));
        const r = reply.result;
        assert.equal(r.model.current, "Sonnet 5.5");
        const by = Object.fromEntries(r.model.options.map((o) => [o.title, o]));
        assert.deepEqual(Object.keys(by).sort(), ["Haiku 5.5", "Opus 3", "Opus 5.5", "Pro Mode", "Sonnet 4.6", "Sonnet 5", "Sonnet 5.5"]);
        assert.equal(by["Opus 5.5"].locked, true, "an upgrade row is locked, not selectable");
        assert.equal(by["Sonnet 4.6"].more, true, "rows from the 'more models' submenu are included");
        assert.equal(by["Sonnet 5.5"].selected, true);
        assert.deepEqual(r.reasoning.options.map((o) => o.level), ["low", "medium", "high", "xhigh"], "Turkish level names map to canonical levels");
        assert.equal(r.reasoning.current, "medium");
        assert.equal(page.popupOpen, false, "reading must leave no menu open under the user");
        assert.equal(page.model, "Sonnet 5.5", "reading changes nothing");
        assert.equal(page.effort, 1);
      });

      await t.test(`sets model and reasoning, verified from the page (menu opens on ${mode})`, async () => {
        const { reply, page } = await run(`mode=${mode}&lang=tr`, "claude", "apply", { model: "haiku", reasoning: "high" });
        assert.deepEqual(reply.result.warnings, [], JSON.stringify(reply.result));
        assert.deepEqual(reply.result.applied, { model: "Haiku 5.5", reasoning: "high" });
        assert.equal(page.model, "Haiku 5.5");
        assert.equal(page.effort, 2, "Yüksek");
        assert.equal(page.popupOpen, false);
      });
    }

    await t.test("a submenu left open by an earlier attempt is not mistaken for the main menu", async () => {
      // Open a submenu and abandon it (what an interrupted run leaves behind), then read and set.
      const { replies, page } = await runSeq("mode=click&lang=tr&stale=1", "claude", [
        { op: "read" },
        { op: "read" },
        { op: "apply", settings: { model: "Haiku 5.5", reasoning: "high" } },
      ]);
      for (const reply of [replies[0], replies[1]]) {
        assert.ok(reply.result.reasoning.supported, "the effort menu must still be found");
        assert.deepEqual(reply.result.reasoning.options.map((o) => o.level), ["low", "medium", "high", "xhigh"]);
        assert.equal(reply.result.model.current, "Sonnet 5.5");
      }
      assert.deepEqual(replies[2].result.applied, { model: "Haiku 5.5", reasoning: "high" }, JSON.stringify(replies[2].result));
      assert.equal(page.model, "Haiku 5.5");
      assert.equal(page.effort, 2);
    });

    await t.test("English labels work the same way", async () => {
      const { reply, page } = await run("mode=click&lang=en", "claude", "apply", { reasoning: "low" });
      assert.deepEqual(reply.result.applied, { reasoning: "low" });
      assert.equal(page.effort, 0);
    });

    await t.test("a model inside the 'more models' submenu is found", async () => {
      const { reply, page } = await run("mode=pointerdown&lang=tr", "claude", "apply", { model: "Sonnet 4.6" });
      assert.deepEqual(reply.result.applied, { model: "Sonnet 4.6" }, JSON.stringify(reply.result));
      assert.equal(page.model, "Sonnet 4.6");
    });

    await t.test("a locked model is refused with the reason, and nothing changes", async () => {
      const { reply, page } = await run("mode=click&lang=tr", "claude", "apply", { model: "Opus 5.5" });
      assert.deepEqual(reply.result.applied, {});
      assert.match(reply.result.warnings.join(" "), /locked on this account/);
      assert.equal(page.model, "Sonnet 5.5");
      assert.equal(page.popupOpen, false);
    });

    await t.test("a paid mode that only opens an upsell is reported as not applied, the prompt is dismissed, and Upgrade is never pressed", async () => {
      for (const lang of ["tr", "en"]) {
        const { reply, page } = await run(`mode=click&lang=${lang}`, "claude", "apply", { model: "Pro Mode" });
        assert.deepEqual(reply.result.applied, {}, "the click did not change the model, so it must not be claimed");
        assert.match(reply.result.warnings.join(" | "), /selected but the site still shows "Sonnet 5\.5"/);
        assert.match(reply.result.warnings.join(" | "), /upgrade prompt .* dismissed/);
        assert.equal(page.upsellOpen, false, "the prompt is closed");
        assert.equal(page.upgradeClicks, 0, "the Upgrade button must never be pressed");
        assert.equal(page.model, "Sonnet 5.5");
        assert.equal(page.popupOpen, false);
      }
    });

    await t.test("the same verified request is not replayed through the menus", async () => {
      const { replies, page } = await runSeq("mode=click&lang=tr", "claude", [
        { op: "apply", settings: { model: "Haiku 5.5", reasoning: "high" } },
        { op: "apply", settings: { model: "Haiku 5.5", reasoning: "high" } },
      ]);
      assert.deepEqual(replies[0].result.applied, { model: "Haiku 5.5", reasoning: "high" });
      assert.equal(replies[1].result.cached, true);
      assert.deepEqual(replies[1].result.applied, { model: "Haiku 5.5", reasoning: "high" });
      const afterFirst = page.opened;
      assert.ok(afterFirst >= 1 && afterFirst <= 4, `menus opened ${afterFirst} times for two identical requests`);
    });

    await t.test("an unknown model lists what is available instead of guessing", async () => {
      const { reply, page } = await run("mode=click&lang=tr", "claude", "apply", { model: "gpt-9" });
      assert.match(reply.result.warnings.join(" "), /not offered; available: .*Sonnet 5\.5.*Haiku 5\.5/);
      assert.equal(page.model, "Sonnet 5.5");
    });

    await t.test("a level the site lacks falls back to the nearest LOWER one, never higher", async () => {
      const { reply, page } = await run("mode=click&lang=tr", "claude", "apply", { reasoning: "max" });
      assert.deepEqual(reply.result.applied, { reasoning: "xhigh" });
      assert.match(reply.result.warnings.join(" "), /"max" not offered; using "xhigh"/);
      assert.equal(page.effort, 3);
    });

    await t.test("'off' on a site that always reasons is reported, not faked", async () => {
      const { reply, page } = await run("mode=click&lang=tr", "claude", "apply", { reasoning: "off" });
      assert.deepEqual(reply.result.applied, {});
      assert.match(reply.result.warnings.join(" "), /"off" is not offered/);
      assert.equal(page.effort, 1);
    });

    await t.test("asking for what is already selected presses nothing and still reports it", async () => {
      const { reply, page } = await run("mode=click&lang=tr", "claude", "apply", { model: "Sonnet 5.5", reasoning: "medium" });
      assert.deepEqual(reply.result.applied, { model: "Sonnet 5.5", reasoning: "medium" });
      assert.equal(page.effort, 1);
      assert.equal(page.popupOpen, false);
    });

    await t.test("an on/off reasoning pill is switched, verified, and a model request is ignored with a reason", async () => {
      const on = await run("mode=click&lang=tr", "chatgpt", "apply", { model: "GPT-5", reasoning: "high" });
      assert.equal(on.page.thinking, "true");
      assert.equal(on.reply.result.applied.reasoning, "on");
      assert.match(on.reply.result.warnings.join(" "), /no model picker/);
      assert.match(on.reply.result.warnings.join(" "), /only has on\/off/);
      const off = await run("mode=click&lang=tr", "chatgpt", "apply", { reasoning: "off" });
      assert.equal(off.page.thinking, "false");
      assert.deepEqual(off.reply.result.applied, { reasoning: "off" });
    });

    await t.test("reading a toggle-only site reports on/off and no models", async () => {
      const { reply } = await run("mode=click&lang=tr", "chatgpt", "read");
      assert.equal(reply.result.model.supported, false);
      assert.equal(reply.result.reasoning.kind, "toggle");
      assert.equal(reply.result.reasoning.current, "off");
    });
  } finally {
    cdp?.close();
    killTree(child);
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
});
