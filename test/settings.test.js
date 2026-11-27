import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  validate,
  merge,
  DEFAULTS,
  SITE_DEFAULTS,
  sitesForPhase,
  resolveSite,
  coerce,
  setPath,
  unsetPath,
} from "../src/config.js";
import { Limits, parseResetTime } from "../src/limits.js";
import { Router, phaseOf } from "../src/router.js";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `c2f-${name}-`));
}

/** loadConfig with an isolated user-level config dir, so a developer's own settings never leak in. */
function load(files = {}, overrides = {}) {
  const home = tmp("home");
  const cwd = tmp("cwd");
  process.env.C2F_CONFIG_HOME = home;
  if (files.global) fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(files.global));
  if (files.local) fs.writeFileSync(path.join(cwd, "c2f.config.json"), JSON.stringify(files.local));
  return loadConfig(cwd, overrides);
}

test("settings merge defaults < user file < project file < command line, per site and per field", () => {
  const cfg = load(
    {
      global: { sites: { claude: { model: "Haiku 5.5", reasoning: "low", limit: { perHour: 20 } } } },
      local: { sites: { claude: { reasoning: "high" } } },
    },
    { sites: { claude: { model: "Sonnet 5.5" } } },
  );
  assert.equal(cfg.sites.claude.model, "Sonnet 5.5", "command line wins");
  assert.equal(cfg.sites.claude.reasoning, "high", "project file beats the user file");
  assert.equal(cfg.sites.claude.limit.perHour, 20, "a nested field survives when only a sibling is set");
  assert.equal(cfg.sites.claude.limit.cooldownMinutes, 60, "untouched nested defaults stay");
  assert.equal(cfg.sites.gemini.model, "default", "other sites keep their defaults");
});

test("an invalid reasoning level or negative limit is refused with the key named", () => {
  assert.throws(() => load({ local: { sites: { claude: { reasoning: "ultra" } } } }), /sites\.claude\.reasoning/);
  assert.throws(() => load({ local: { sites: { gemini: { limit: { perHour: -1 } } } } }), /limit\.perHour/);
  assert.throws(() => load({ local: { phases: { review: { reasoning: "high" } } } }), /phases\.review is not a phase/);
  assert.throws(() => load({ local: { sites: { chatgpt: { search: "maybe" } } } }), /sites\.chatgpt\.search/);
});

test("a site can be removed from a phase by disabling it, and a phase can pick its own sites and reasoning", () => {
  const cfg = load({
    local: {
      sites: { chatgpt: { enabled: false }, claude: { reasoning: "medium" } },
      phases: { design: { sites: ["claude", "gemini"], reasoning: "high" }, step: { reasoning: "low" } },
    },
  });
  assert.deepEqual(sitesForPhase(cfg, "design"), ["claude", "gemini"]);
  assert.deepEqual(sitesForPhase(cfg, "plan"), ["claude", "gemini", "deepseek"], "disabled chatgpt is skipped");
  assert.equal(resolveSite(cfg, "claude", "design").reasoning, "high", "phase beats the site");
  assert.equal(resolveSite(cfg, "claude", "verify").reasoning, "medium", "no phase override falls back to the site");
  assert.equal(resolveSite(cfg, "gemini", "step").reasoning, "low");
});

test("config set/unset coerce types and never reach into a missing parent", () => {
  assert.equal(coerce("sites.claude.limit.perHour", "20"), 20);
  assert.equal(coerce("sites.claude.enabled", "off"), false);
  assert.deepEqual(coerce("preferredSites", "claude, gemini"), ["claude", "gemini"]);
  assert.deepEqual(coerce("phases.design.sites", "claude"), ["claude"]);
  assert.equal(coerce("sites.claude.timeoutMs", "null"), null);
  assert.throws(() => coerce("sites.claude.limit.perHour", "many"), /number/);
  const o = {};
  setPath(o, "sites.claude.model", "Haiku 5.5");
  assert.equal(o.sites.claude.model, "Haiku 5.5");
  unsetPath(o, "sites.claude.model");
  assert.equal(o.sites.claude.model, undefined);
  assert.doesNotThrow(() => unsetPath({}, "a.b.c"));
});

test("defaults are valid, and merging never mutates the shared defaults", () => {
  assert.deepEqual(validate(merge(DEFAULTS, {})), []);
  const cfg = load({ local: { sites: { claude: { model: "x" } } } });
  assert.equal(cfg.sites.claude.model, "x");
  assert.equal(DEFAULTS.sites.claude.model, "default");
  assert.equal(SITE_DEFAULTS.limit.perHour, 0);
});

test("a reset time is read from the site's own wording", () => {
  const noon = new Date("2026-11-17T12:00:00").getTime();
  const at = (ms) => new Date(ms);
  assert.equal(at(parseResetTime("Kullanım 05:23 itibarıyla yenilenene kadar", noon)).getHours(), 5);
  assert.equal(at(parseResetTime("Kullanım 05:23 itibarıyla", noon)).getDate(), 18, "a clock time already passed means tomorrow");
  assert.equal(at(parseResetTime("resets at 18:30", noon)).getHours(), 18);
  assert.equal(at(parseResetTime("resets at 18:30", noon)).getDate(), 17, "a later time today stays today");
  assert.equal(parseResetTime("try again in 3 hours", noon), noon + 3 * 3_600_000);
  assert.equal(parseResetTime("45 dakika sonra tekrar dene", noon), noon + 45 * 60_000);
  assert.equal(parseResetTime("no time in here", noon), null);
  assert.equal(parseResetTime("version 1.2345", noon), null, "a decimal is not a clock");
});

test("per-hour and per-day budgets block at the limit and free up as old requests age out", () => {
  let now = 1_000_000_000_000;
  const limits = new Limits({ file: path.join(tmp("usage"), "usage.json"), now: () => now });
  const limit = { perHour: 2, perDay: 3 };
  assert.equal(limits.check("claude", limit).ok, true);
  limits.record("claude");
  now += 60_000;
  limits.record("claude");
  const blocked = limits.check("claude", limit);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /2\/hour/);
  assert.equal(blocked.retryAt, 1_000_000_000_000 + 3_600_000, "free again when the oldest request leaves the hour");
  now += 3_600_000 + 1;
  assert.equal(limits.check("claude", limit).ok, true, "the hour rolled over");
  limits.record("claude");
  now += 1000;
  assert.match(limits.check("claude", limit).reason, /3\/day/, "the day budget still counts them");
  assert.equal(limits.check("gemini", limit).ok, true, "another site is unaffected");
  assert.equal(limits.check("claude", { perHour: 0, perDay: 0 }).ok, true, "0 means unlimited");
});

test("a site's own usage-limit report benches it until its reset, or for the cooldown when unknown", () => {
  let now = new Date("2026-11-17T12:00:00").getTime();
  const limits = new Limits({ file: path.join(tmp("usage"), "usage.json"), now: () => now });
  const until = limits.trip("chatgpt", { until: parseResetTime("05:23", now), minutes: 60, reason: "files paused" });
  assert.equal(new Date(until).getHours(), 5);
  const gate = limits.check("chatgpt", {});
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /cooling down/);
  limits.trip("claude", { until: null, minutes: 30 });
  assert.equal(limits.check("claude", {}).retryAt, now + 30 * 60_000);
  limits.trip("gemini", { until: now - 1000, minutes: 10 });
  assert.equal(limits.check("gemini", {}).retryAt, now + 10 * 60_000, "a reset in the past is noise");
  limits.trip("deepseek", { until: now + 10 * 24 * 3_600_000, minutes: 10 });
  assert.equal(limits.check("deepseek", {}).retryAt, now + 10 * 60_000, "a reset days away is noise");
  now += 18 * 3_600_000; // 12:00 -> 06:00 next day, past the 05:23 reset
  assert.equal(limits.check("chatgpt", {}).ok, true, "cooldown over");
  limits.clear("chatgpt");
  assert.equal(limits.load().chatgpt, undefined);
});

test("phases are read from request labels", () => {
  assert.equal(phaseOf("design"), "design");
  assert.equal(phaseOf("critique"), "critique");
  assert.equal(phaseOf("plan-retry"), "plan");
  assert.equal(phaseOf("step 2 round 1"), "step");
  assert.equal(phaseOf("verify 3"), "verify");
  assert.equal(phaseOf(undefined), "step");
});

function fakeBridge(script) {
  const calls = [];
  return {
    calls,
    async chat(args) {
      calls.push(args);
      const next = script[args.site];
      if (!next) throw new Error(`${args.site}: no script`);
      if (next instanceof Error) throw next;
      return { reply: `from ${args.site}`, ms: 5, settings: next.settings || null };
    },
  };
}

test("the router sends each site its own model and reasoning, honouring phase overrides", async () => {
  const cfg = load({
    local: {
      preferredSites: ["claude", "gemini"],
      sites: { claude: { model: "Haiku 5.5", reasoning: "low" }, gemini: { reasoning: "medium" } },
      phases: { design: { reasoning: "high" } },
    },
  });
  const bridge = fakeBridge({ claude: {}, gemini: {} });
  const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }) });
  const res = await router.ask({ phase: "design", prompt: "p", freshChat: true });
  assert.equal(res.site, "claude");
  assert.deepEqual(bridge.calls[0].settings, { model: "Haiku 5.5", reasoning: "high", search: "default" });
  await router.ask({ phase: "step", prompt: "p", freshChat: true });
  assert.equal(bridge.calls[1].settings.reasoning, "low");
  assert.equal(bridge.calls[1].strictSettings, false);
});

test("a site at its usage limit is benched and the next site answers; the bench survives the next request", async () => {
  const cfg = load({ local: { preferredSites: ["chatgpt", "claude"] } });
  const bridge = fakeBridge({
    chatgpt: new Error("chatgpt hit a usage limit: Kullanım 05:23 itibarıyla yenilenene kadar"),
    claude: {},
  });
  const logs = [];
  const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }), log: (m) => logs.push(m) });
  const first = await router.ask({ phase: "step", prompt: "p", freshChat: true });
  assert.equal(first.site, "claude");
  assert.ok(logs.some((l) => /chatgpt is at its usage limit; benched until 05:23/.test(l)), logs.join("\n"));
  bridge.calls.length = 0;
  const second = await router.ask({ phase: "step", prompt: "p", freshChat: true });
  assert.equal(second.site, "claude");
  assert.deepEqual(bridge.calls.map((c) => c.site), ["claude"], "chatgpt was not even tried again");
});

test("a request budget stops a site, and when nothing can answer the error says why for each site", async () => {
  const cfg = load({
    local: {
      preferredSites: ["claude", "gemini"],
      sites: { claude: { limit: { perHour: 1 } }, gemini: { enabled: false } },
    },
  });
  const bridge = fakeBridge({ claude: {}, gemini: {} });
  const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }) });
  await router.ask({ phase: "step", prompt: "p", freshChat: true });
  await assert.rejects(router.ask({ phase: "step", prompt: "p", freshChat: true }), (err) => {
    assert.match(err.message, /claude: budget of 1\/hour used up/);
    assert.doesNotMatch(err.message, /gemini/, "a disabled site is not even listed");
    return true;
  });
  assert.equal(bridge.calls.length, 1, "the over-budget site was never contacted");
});

test("with no enabled site for a phase the router says so instead of hanging", async () => {
  const cfg = load({ local: { sites: { chatgpt: { enabled: false }, claude: { enabled: false }, gemini: { enabled: false }, deepseek: { enabled: false } } } });
  const router = new Router({ cfg, bridge: fakeBridge({}), limits: new Limits({ file: path.join(tmp("u"), "u.json") }) });
  await assert.rejects(router.ask({ phase: "plan", prompt: "p" }), /no site is enabled for the "plan" phase/);
});

test("a missing extension stops the loop at once instead of trying every site", async () => {
  const cfg = load({ local: { preferredSites: ["claude", "gemini", "deepseek"], reconnectWaitMs: 50 } });
  const inner = fakeBridge({ claude: new Error("ChatToFree browser extension is not connected."), gemini: {}, deepseek: {} });
  const bridge = { calls: inner.calls, chat: inner.chat, waitForClient: async () => null };
  const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }) });
  await assert.rejects(router.ask({ phase: "step", prompt: "p" }), /did not come back/);
  assert.equal(bridge.calls.length, 1);
});

/** A bridge whose chat answers come from a list per site, and whose browser link can be waited for. */
function flakyBridge(outcomes, { comesBack = true } = {}) {
  const calls = [];
  let waited = 0;
  return {
    calls,
    get waited() {
      return waited;
    },
    async waitForClient() {
      waited++;
      return comesBack ? {} : null;
    },
    async chat(args) {
      calls.push(args);
      const next = outcomes[args.site].shift();
      if (next instanceof Error) throw next;
      return { reply: `from ${args.site}`, ms: 5 };
    },
  };
}

test("a dropped browser link is waited out and the same site is asked again, instead of giving the site up", async () => {
  const cfg = load({ local: { preferredSites: ["claude", "gemini"] } });
  const bridge = flakyBridge({ claude: [new Error("the extension worker restarted mid-request; retry"), {}], gemini: [{}] });
  const logs = [];
  const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }), log: (m) => logs.push(m) });
  const res = await router.ask({ phase: "step", prompt: "p", freshChat: true });
  assert.equal(res.site, "claude", "the conversation stays with the same site");
  assert.deepEqual(bridge.calls.map((c) => c.site), ["claude", "claude"]);
  assert.equal(bridge.waited, 1);
  assert.ok(logs.some((l) => /waiting for the browser link/.test(l)), logs.join("\n"));
});

test("when the browser never comes back the request fails once, naming that, without trying every site", async () => {
  const cfg = load({ local: { preferredSites: ["claude", "gemini"], reconnectWaitMs: 50 } });
  const bridge = flakyBridge({ claude: [new Error("extension disconnected mid-request")], gemini: [{}] }, { comesBack: false });
  const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }) });
  await assert.rejects(router.ask({ phase: "step", prompt: "p", freshChat: true }), /did not come back/);
  assert.deepEqual(bridge.calls.map((c) => c.site), ["claude"], "gemini cannot answer without the browser either");
});

test("a site's own failure is not mistaken for a dropped link: the next site answers at once", async () => {
  const cfg = load({ local: { preferredSites: ["claude", "gemini"] } });
  const bridge = flakyBridge({ claude: [new Error("claude failed: needs_login")], gemini: [{}] });
  const router = new Router({ cfg, bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }) });
  const res = await router.ask({ phase: "step", prompt: "p", freshChat: true });
  assert.equal(res.site, "gemini");
  assert.equal(bridge.waited, 0);
});

test("DeepSeek through its browser tab (asked for explicitly) is skipped unless the user lets the tab come forward", async () => {
  const bridge = fakeBridge({ deepseek: {}, claude: {} });
  const background = new Router({ cfg: load({ local: { preferredSites: ["deepseek", "claude"], sites: { deepseek: { transport: "browser" } } } }), bridge, limits: new Limits({ file: path.join(tmp("u"), "u.json") }) });
  assert.equal((await background.ask({ phase: "step", prompt: "p", freshChat: true })).site, "claude");
  assert.deepEqual(bridge.calls.map((c) => c.site), ["claude"], "nothing was sent to deepseek, so nothing was brought forward");

  const allowed = new Router({ cfg: load({ local: { preferredSites: ["deepseek", "claude"], sites: { deepseek: { transport: "browser", focusTab: true } } } }), bridge, limits: new Limits({ file: path.join(tmp("u"), "u2.json") }) });
  const res = await allowed.ask({ phase: "step", prompt: "p", freshChat: true });
  assert.equal(res.site, "deepseek");
  assert.equal(bridge.calls.at(-1).focusTab, true, "the extension is told it may bring the tab forward");

  await assert.rejects(
    new Router({ cfg: load({ local: { preferredSites: ["deepseek"], sites: { deepseek: { transport: "browser" } } } }), bridge, limits: new Limits({ file: path.join(tmp("u"), "u3.json") }) }).ask({ phase: "step", prompt: "p", freshChat: true }),
    /deepseek draws nothing while its tab is in the background.*focusTab true/s,
  );
});
