import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DeepSeekHttp, saveAuth, loadAuth, hasAuth, readStream, machineId, OTHER_MACHINE } from "../src/deepseek-http.js";
import { Router } from "../src/router.js";
import { Limits } from "../src/limits.js";
import { loadConfig } from "../src/config.js";

const AUTH = { token: "tok-123", cookie: "ds_session_id=abc", hif_dliq: "d", hif_leim: "l", wasmUrl: "https://example.invalid/x.wasm" };
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

/** A stand-in for chat.deepseek.com: the three endpoints, recording what it was sent. */
async function mockDeepSeek({ stream = null, completionStatus = 200, completionType = "text/event-stream", titleCode = 0, goneAfter = null, limitFirst = 0, limitText = "Messages too frequent. Try again later." } = {}) {
  const seen = { titles: [], sessions: 0, completions: [], inFlight: 0, maxInFlight: 0, headers: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", async () => {
      seen.headers.push(req.headers);
      const json = (obj, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/api/v0/chat_session/create") {
        seen.sessions++;
        return json({ code: 0, data: { biz_data: { chat_session: { id: `sess-${seen.sessions}` } } } });
      }
      if (req.url === "/api/v0/users/current") {
        return req.headers.authorization === "Bearer tok-123" ? json({ code: 0, data: { biz_data: { id: "u1" } } }) : json({ code: 40003, msg: "Authorization Failed (invalid token)", data: null });
      }
      if (req.url === "/api/v0/chat_session/update_title") {
        seen.titles.push(JSON.parse(body));
        return json({ code: 0, data: { biz_code: titleCode, biz_msg: titleCode ? "empty chat session" : "", biz_data: null } });
      }
      if (req.url === "/api/v0/chat/create_pow_challenge") {
        return json({ code: 0, data: { biz_data: { challenge: { algorithm: "DeepSeekHashV1", challenge: "ch", salt: "s", signature: "sig", difficulty: 1, expire_at: 1 } } } });
      }
      if (req.url === "/api/v0/chat/completion") {
        const parsed = JSON.parse(body);
        if (goneAfter && parsed.parent_message_id !== null) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end('{"msg":"chat session not found"}');
        }
        seen.completions.push({ ...parsed, pow: JSON.parse(Buffer.from(req.headers["x-ds-pow-response"] || "", "base64").toString() || "null") });
        seen.inFlight++;
        seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
        await new Promise((r) => setTimeout(r, 60));
        seen.inFlight--;
        const n = seen.completions.length;
        res.writeHead(completionStatus, { "content-type": completionType });
        const events = n <= limitFirst ? [{ type: "hint", content: limitText, finish_reason: "rate_limit_reached" }] : stream ? stream(n) : [
          { v: { response: { message_id: n, fragments: [{ type: "THINK", content: "hm" }] } } },
          { p: "response/fragments", v: [{ type: "RESPONSE", content: "Hel" }] },
          { p: "response/fragments/-1/content", v: "lo" },
          { v: ` #${n}` }, // the path persists across events that omit it
          { p: "response/status", v: "FINISHED" },
        ];
        return res.end(typeof events === "string" ? events : sse(events));
      }
      json({ error: "nope" }, 404);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-lock-"));
const client = (url, extra = {}) => new DeepSeekHttp({ auth: AUTH, baseUrl: url, solve: async () => 4242, lockFile: path.join(lockDir, "deepseek.lock"), paceMs: 0, newChatGapMs: 0, burstMax: 0, backoffMs: [20, 20], ...extra });

test("one turn: opens a chat, solves the proof of work, sends the login, and reads the streamed answer", async () => {
  const ds = await mockDeepSeek();
  try {
    const res = await client(ds.url).chat({ prompt: "say hi", thinking: true, search: false });
    assert.equal(res.reply, "Hello #1", "fragments grow by patches, and a path-less event extends the last one");
    assert.equal(res.thinking, "hm", "DeepThink text is kept apart from the answer");
    const sent = ds.seen.completions[0];
    assert.equal(sent.chat_session_id, "sess-1");
    assert.equal(sent.parent_message_id, null);
    assert.equal(sent.prompt, "say hi");
    assert.equal(sent.thinking_enabled, true);
    assert.equal(sent.search_enabled, false);
    assert.deepEqual({ answer: sent.pow.answer, target: sent.pow.target_path, salt: sent.pow.salt }, { answer: 4242, target: "/api/v0/chat/completion", salt: "s" }, "the solved puzzle travels with the message");
    assert.equal(ds.seen.headers[0].authorization, "Bearer tok-123");
    assert.equal(ds.seen.headers[0].cookie, "ds_session_id=abc");
  } finally {
    await ds.close();
  }
});

test("a continuing turn goes into the same chat after the previous answer; a fresh turn opens a new one", async () => {
  const ds = await mockDeepSeek();
  try {
    const c = client(ds.url);
    await c.chat({ prompt: "one" });
    await c.chat({ prompt: "two", continuing: true });
    assert.equal(ds.seen.sessions, 1, "no second chat was opened");
    assert.deepEqual([ds.seen.completions[1].chat_session_id, ds.seen.completions[1].parent_message_id], ["sess-1", 1], "it continues after the previous answer");
    await c.chat({ prompt: "three" });
    assert.equal(ds.seen.sessions, 2, "continuing:false starts a new chat");
    await c.chat({ prompt: "x" });
    c.reset("default");
    await assert.rejects(c.chat({ prompt: "y", continuing: true }), /context_lost/, "a chat that is not open any more is reported so the caller resends everything");
  } finally {
    await ds.close();
  }
});

test("two requests at once are sent one after the other: a login must never carry two chats", async () => {
  const ds = await mockDeepSeek();
  try {
    const c = client(ds.url);
    await Promise.all([c.chat({ prompt: "a" }), c.chat({ prompt: "b" }), c.chat({ prompt: "c" })]);
    assert.equal(ds.seen.completions.length, 3);
    assert.equal(ds.seen.maxInFlight, 1);
  } finally {
    await ds.close();
  }
});

test("two clients (two processes) never send at the same moment, and a dead process's lock is taken over", async () => {
  const ds = await mockDeepSeek();
  try {
    await Promise.all([client(ds.url).chat({ prompt: "a" }), client(ds.url).chat({ prompt: "b" })]);
    assert.equal(ds.seen.maxInFlight, 1, "the lock file serialises separate clients");
    fs.writeFileSync(path.join(lockDir, "deepseek.lock"), JSON.stringify({ pid: 2_000_000_000, at: Date.now() }));
    const res = await client(ds.url).chat({ prompt: "after a crash" });
    assert.match(res.reply, /Hello/);
  } finally {
    await ds.close();
  }
});

test("each caller keeps its own chat: a second task does not close the first one's conversation", async () => {
  const ds = await mockDeepSeek();
  try {
    const c = client(ds.url);
    await c.chat({ prompt: "advisor plan", key: "advisor" });
    await c.chat({ prompt: "other task", key: "build" });
    await c.chat({ prompt: "advisor review", key: "advisor", continuing: true });
    assert.deepEqual(ds.seen.completions.map((x) => x.chat_session_id), ["sess-1", "sess-2", "sess-1"]);
  } finally {
    await ds.close();
  }
});

test("a rate limit, a refused login and an empty answer are named so the router can act", async () => {
  const limited = await mockDeepSeek({ stream: () => [{ type: "hint", content: "Too many requests", finish_reason: "rate_limit_reached" }] });
  try {
    const c = client(limited.url);
    await assert.rejects(c.chat({ prompt: "x" }), /deepseek hit a usage limit: Too many requests/);
    assert.equal(c.sessions.size, 1, "a rate limit does not throw the chat away");
  } finally {
    await limited.close();
  }
  const denied = await mockDeepSeek({ completionStatus: 401, completionType: "application/json", stream: () => '{"msg":"unauthorized"}' });
  try {
    await assert.rejects(client(denied.url).chat({ prompt: "x" }), /deepseek needs login.*c2f giris/);
  } finally {
    await denied.close();
  }
  const empty = await mockDeepSeek({ stream: () => [{ p: "response/status", v: "FINISHED" }] });
  try {
    await assert.rejects(client(empty.url).chat({ prompt: "x" }), /no_reply/);
  } finally {
    await empty.close();
  }
});

test("an empty answer keeps the chat: the next turn continues it from the last good answer", async () => {
  const ds = await mockDeepSeek({ stream: (n) => (n === 2 ? [{ v: { response: { message_id: 2, fragments: [] } } }, { p: "response/status", v: "FINISHED" }] : [{ v: { response: { message_id: n, fragments: [{ type: "RESPONSE", content: `answer ${n}` }] } } }]) });
  try {
    const c = client(ds.url);
    await c.chat({ prompt: "one", key: "k" });
    await assert.rejects(c.chat({ prompt: "two", key: "k", continuing: true }), /no_reply/);
    const third = await c.chat({ prompt: "three", key: "k", continuing: true });
    assert.equal(third.reply, "answer 3");
    assert.equal(ds.seen.sessions, 1, "no new chat");
    assert.deepEqual(ds.seen.completions.map((x) => x.parent_message_id), [null, 1, 1], "the third turn hangs off the last good answer");
  } finally {
    await ds.close();
  }
});

test("the stream reader copes with a line split across chunks", async () => {
  const text = sse([{ v: { response: { message_id: 9, fragments: [{ type: "RESPONSE", content: "ab" }] } } }, { p: "response/fragments/-1/content", v: "cd" }]);
  const out = await readStream((async function* () {
    for (let i = 0; i < text.length; i += 7) yield Buffer.from(text.slice(i, i + 7));
  })());
  assert.equal(out.reply, "abcd");
  assert.equal(out.messageId, 9);
});

test("the saved login is read back, and a missing one says how to create it", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-auth-")), "deepseek-auth.json");
  assert.equal(hasAuth(file), false);
  assert.throws(() => loadAuth(file), /c2f kur/);
  saveAuth(AUTH, file);
  assert.equal(hasAuth(file), true);
  assert.equal(loadAuth(file).token, "tok-123");
});

test("the router sends DeepSeek over HTTP when a login is saved, continues the same chat, and skips the browser entirely", async () => {
  const calls = [];
  const fake = {
    async chat(args) {
      calls.push(args);
      return { reply: `deepseek ${calls.length}`, ms: 10, timings: { total: 10 } };
    },
    reset() {},
  };
  const bridge = { chat: async () => assert.fail("the browser must not be used"), probe: async () => assert.fail("no probe either") };
  const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
  const router = new Router({ cfg, bridge, http: fake, limits: new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-u-")), "u.json") }) });
  const first = await router.ask({ phase: "step", prompt: "full", followUp: "short", freshChat: true });
  const second = await router.ask({ phase: "step", prompt: "full", followUp: "short", freshChat: true });
  assert.equal(first.site, "deepseek");
  assert.deepEqual(calls.map((c) => [c.prompt, c.continuing]), [["full", false], ["short", true]], "later turns are short follow-ups into the same chat");
  assert.equal(second.continued, true);
  assert.equal(calls[0].thinking, false, "fast by default: no DeepThink unless asked");
  assert.equal(calls[0].search, false);
});

test("transport browser keeps DeepSeek on its tab even with a login saved; transport http without one says what to do", async () => {
  const bridge = { calls: [], async chat(a) { this.calls.push(a); return { reply: "tab", ms: 1 }; }, async probe() { return { ok: true }; } };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-u-"));
  const browserCfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], sites: { deepseek: { transport: "browser", focusTab: true } }, local: { enabled: false } });
  const viaTab = new Router({ cfg: browserCfg, bridge, http: { chat: async () => assert.fail("not over http"), reset() {} }, limits: new Limits({ file: path.join(home, "u.json") }) });
  assert.equal((await viaTab.ask({ phase: "step", prompt: "p", freshChat: true })).reply, "tab");

  const saved = process.env.C2F_CONFIG_HOME;
  process.env.C2F_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-nohome-"));
  try {
    const httpCfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], sites: { deepseek: { transport: "http" } }, local: { enabled: false } });
    await assert.rejects(new Router({ cfg: httpCfg, bridge, limits: new Limits({ file: path.join(home, "u2.json") }) }).ask({ phase: "step", prompt: "p", freshChat: true }), /no DeepSeek login saved; the user must run once: c2f kur/);
  } finally {
    if (saved === undefined) delete process.env.C2F_CONFIG_HOME;
    else process.env.C2F_CONFIG_HOME = saved;
  }
});

test("saving a login asks DeepSeek one read-only question and never opens a chat on the account", async () => {
  const { finishLogin } = await import("../src/login.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-fin-"));
  const asked = [];
  const answer = (body) => async (url, opts = {}) => {
    asked.push(`${opts.method || "GET"} ${new URL(url).pathname}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const raw = { token: "tok", cookie: "ds_session_id=x", wasmUrl: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.abc.wasm", cookieNames: ["ds_session_id"] };
  const done = await finishLogin(raw, { file: path.join(dir, "auth.json"), fetchImpl: answer({ code: 0, data: { biz_data: { id: "u1" } } }) });
  assert.deepEqual(asked, ["GET /api/v0/users/current"], "one request, and it creates nothing");
  assert.equal(JSON.parse(fs.readFileSync(done.file, "utf8")).token, "tok");
  await assert.rejects(finishLogin(raw, { file: path.join(dir, "auth2.json"), fetchImpl: answer({ code: 40003, msg: "INVALID_TOKEN" }) }), /not_signed_in/);
});

test("the in-page login reader finds the token, the bot-check values and the proof-of-work module", async () => {
  const vm = await import("node:vm");
  const store = (obj) => ({ get length() { return Object.keys(obj).length; }, key: (i) => Object.keys(obj)[i], getItem: (k) => obj[k] ?? null });
  const sandbox = {
    localStorage: store({ userToken: JSON.stringify({ value: "tok-xyz", __version: "0" }), hif_dliq: JSON.stringify({ value: "dliq" }), other: "1" }),
    sessionStorage: store({ "x-hif-leim": "leim-plain" }),
    document: { cookie: "ds_session_id=abc; smidV2=zzz" },
    performance: { getEntriesByType: () => [{ name: "https://x/a.js" }, { name: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.abc.wasm" }] },
    location: { href: "https://chat.deepseek.com/a/chat/s/1" },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(new URL("../extension/deepseek-login.js", import.meta.url), "utf8"), sandbox);
  const got = JSON.parse(JSON.stringify(sandbox.C2F_collectDeepSeekLogin()));
  assert.deepEqual(got, { scripts: [], token: "tok-xyz", hif_dliq: "dliq", hif_leim: "leim-plain", cookie: "ds_session_id=abc; smidV2=zzz", wasmUrl: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.abc.wasm", href: "https://chat.deepseek.com/a/chat/s/1" });
});

test("the proof-of-work module is found by name inside the site's scripts, and relative paths are resolved", async () => {
  const { discoverWasmUrl } = await import("../src/deepseek-http.js");
  const pages = {
    "https://fe-static.deepseek.com/chat/static/a.js": "var x=1;",
    "https://fe-static.deepseek.com/chat/static/b.js": 'const u="/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";',
    "https://evil.example/c.js": 'sha3_wasm_bg.zzz.wasm',
  };
  const asked = [];
  const fakeFetch = async (url) => {
    asked.push(url);
    return { ok: url in pages, text: async () => pages[url] };
  };
  assert.equal(await discoverWasmUrl(Object.keys(pages), fakeFetch), "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm");
  assert.ok(!asked.includes("https://evil.example/c.js"), "only deepseek.com scripts are read");
  assert.equal(await discoverWasmUrl([], fakeFetch), "");

  // A name relative to the bundler's public path: the folder where the file really exists wins.
  const real = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.abc.wasm";
  const relFetch = async (url, opts = {}) => (opts.method === "HEAD" ? { ok: url === real } : { ok: true, text: async () => 'load("static/sha3_wasm_bg.abc.wasm")' });
  assert.equal(await discoverWasmUrl(["https://fe-static.deepseek.com/chat/static/js/main.js"], relFetch), real);
});

test("a bot-check answer or an HTML page means the saved login went stale, and says how to fix it", async () => {
  const waf = await mockDeepSeek({ completionStatus: 202, completionType: "text/html", stream: () => "" });
  try {
    await assert.rejects(client(waf.url).chat({ prompt: "x" }), /deepseek needs login: its bot check wants a fresh browser pass.*c2f giris/);
  } finally {
    await waf.close();
  }
  const html = await mockDeepSeek({ completionType: "text/html", stream: () => "<!DOCTYPE html><html><body>Verify you are human</body></html>" });
  try {
    await assert.rejects(client(html.url).chat({ prompt: "x" }), /needs login.*c2f giris/);
  } finally {
    await html.close();
  }
});

test("a proof-of-work module is only ever taken from an https address on deepseek.com", async () => {
  const { solvePow, discoverWasmUrl, isDeepSeekHttps } = await import("../src/deepseek-http.js");
  assert.equal(isDeepSeekHttps("https://fe-static.deepseek.com/a.wasm"), true);
  for (const bad of ["http://fe-static.deepseek.com/a.wasm", "https://deepseek.com.evil.example/a.wasm", "https://evil.example/deepseek.com/a.wasm", "file:///c:/x.wasm", "nonsense"]) {
    assert.equal(isDeepSeekHttps(bad), false, bad);
  }
  await assert.rejects(solvePow({}, "https://evil.example/sha3_wasm_bg.x.wasm"), /refusing to run a proof-of-work module/);
  const pages = { "https://fe-static.deepseek.com/chat/static/b.js": 'load("https://evil.example/sha3_wasm_bg.zzz.wasm")' };
  const fetchImpl = async (url) => ({ ok: url in pages, text: async () => pages[url] });
  assert.equal(await discoverWasmUrl(Object.keys(pages), fetchImpl), "", "a script that names someone else's module is not trusted");
  assert.equal(await discoverWasmUrl(["https://evil.example/a.js"], async () => assert.fail("must not even be fetched")), "");
});

test("a live holder with a long deadline is never robbed by a waiter with a short timeout", async () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-lock2-")), "deepseek.lock");
  const slow = new DeepSeekHttp({ auth: AUTH, lockFile: lock });
  const quick = new DeepSeekHttp({ auth: AUTH, lockFile: lock });
  const release = await slow.acquire(10 * 60_000); // a long DeepThink turn
  let got = false;
  const waiting = quick.acquire(1_000).then((r) => {
    got = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 1500)); // well past the waiter's own 1 s
  assert.equal(got, false, "the waiter's timeout says nothing about how long the holder may keep it");
  release();
  (await waiting)();
});

test("DeepSeek never needs the browser unless its tab was asked for; without a login the answer is to sign in", async () => {
  const { needsBrowser } = await import("../src/router.js");
  const saved = process.env.C2F_CONFIG_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-nb-"));
  process.env.C2F_CONFIG_HOME = home;
  try {
    const only = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
    assert.equal(needsBrowser(only), false, "no saved login: it needs a login, not a browser");
    const bridge = { chat: async () => assert.fail("the tab is never a silent fallback"), probe: async () => assert.fail("no probe either"), waitForClient: async () => assert.fail("no waiting for a browser") };
    await assert.rejects(
      new Router({ cfg: only, bridge, limits: new Limits({ file: path.join(home, "u.json") }) }).ask({ phase: "chat", prompt: "p", freshChat: true }),
      /no DeepSeek login saved; the user must run once: c2f kur/,
    );
    saveAuth(AUTH, path.join(home, "deepseek-auth.json"));
    assert.equal(needsBrowser(only), false);
    const mixed = loadConfig(os.tmpdir(), { preferredSites: ["deepseek", "claude"], local: { enabled: false } });
    assert.equal(needsBrowser(mixed), true, "Claude still needs the browser");
    const tab = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], sites: { deepseek: { transport: "browser" } }, local: { enabled: false } });
    assert.equal(needsBrowser(tab), true);
  } finally {
    if (saved === undefined) delete process.env.C2F_CONFIG_HOME;
    else process.env.C2F_CONFIG_HOME = saved;
  }
});

test("c2f never names a chat (DeepSeek titles its own, as on the website); later turns continue it until it is reset", async () => {
  const ds = await mockDeepSeek();
  const key = "D:/proje/deneme · chat";
  try {
    const c = client(ds.url);
    await c.chat({ prompt: "one", key });
    await c.chat({ prompt: "two", key, continuing: true });
    await c.chat({ prompt: "three", key, continuing: true });
    assert.deepEqual(ds.seen.titles, [], "the title is DeepSeek's business");
    assert.deepEqual([ds.seen.completions[2].chat_session_id, ds.seen.completions[2].parent_message_id], ["sess-1", 2], "it goes on in the same DeepSeek chat, after the last answer");
    assert.equal(ds.seen.sessions, 1, "no new chat was opened");

    c.reset(key);
    assert.equal(c.has(key), false);
    await c.chat({ prompt: "fresh", key });
    assert.equal(ds.seen.sessions, 2, "after a reset the next turn opens a new chat");
  } finally {
    await ds.close();
  }
});

test("the text of a reply is handed over as it grows, for callers that stream it on", async () => {
  const ds = await mockDeepSeek();
  try {
    const seen = [];
    const res = await client(ds.url).chat({ prompt: "x", onText: (t) => seen.push(t) });
    assert.equal(seen.at(-1), res.reply);
    assert.ok(seen.includes("Hel"), `partial text was passed on: ${JSON.stringify(seen)}`);
  } finally {
    await ds.close();
  }
});

test("a lock taken over after its deadline is not removed by the process that lost it", async () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-lock3-")), "deepseek.lock");
  const a = new DeepSeekHttp({ auth: AUTH, lockFile: lock });
  const b = new DeepSeekHttp({ auth: AUTH, lockFile: lock });
  const releaseA = await a.acquire(-1); // already past its own deadline
  const releaseB = await b.acquire(60_000); // takes it over
  releaseA();
  assert.ok(fs.existsSync(lock), "b still holds the lock");
  releaseB();
  assert.equal(fs.existsSync(lock), false);
});

test("a continuing turn into a vanished chat says context_lost", async () => {
  const gone = await mockDeepSeek({ goneAfter: true });
  try {
    const c = client(gone.url);
    await c.chat({ prompt: "one", key: "k" });
    await assert.rejects(c.chat({ prompt: "two", key: "k", continuing: true }), /context_lost: DeepSeek no longer has that chat/);
    assert.equal(c.has("k"), false, "the dead chat is forgotten");
  } finally {
    await gone.close();
  }
});

test("over HTTP a long conversation stays in one DeepSeek chat: the browser tab's size cap does not split it", async () => {
  const calls = [];
  const held = new Set();
  const fake = { has: (k) => held.has(k), reset() {}, async chat(args) { calls.push(args); held.add(args.key); return { reply: "y".repeat(5000), ms: 1 }; } };
  const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false }, sessionMaxChars: 10_000 });
  const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-u-")), "u.json") });
  const router = new Router({ cfg, bridge: null, http: fake, limits, sessionKey: "review" });
  for (let i = 0; i < 4; i++) await router.ask({ phase: "chat", prompt: `opening + part ${i}`, followUp: "x".repeat(8000), freshChat: true });
  assert.deepEqual(calls.map((c) => c.continuing), [false, true, true, true], "past sessionMaxChars the same chat goes on");
});

test("the router continues its DeepSeek chat when asked not to start fresh", async () => {
  const calls = [];
  const held = new Set(["D:/p · chat"]);
  const fake = { has: (k) => held.has(k), reset() {}, async chat(args) { calls.push(args); held.add(args.key); return { reply: "ok", ms: 1 }; } };
  const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
  const limits = () => new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-u-")), "u.json") });
  const resumed = new Router({ cfg, bridge: null, http: fake, limits: limits(), sessionKey: "D:/p · chat" });
  await resumed.ask({ phase: "chat", prompt: "next question", freshChat: false });
  assert.deepEqual([calls[0].continuing, calls[0].key, "title" in calls[0]], [true, "D:/p · chat", false], "no title is ever passed on");
  const fresh = new Router({ cfg, bridge: null, http: fake, limits: limits(), sessionKey: "D:/p · chat" });
  await fresh.ask({ phase: "chat", prompt: "new task", freshChat: true });
  assert.equal(calls[1].continuing, false, "freshChat starts a new web chat for the folder");
});

test("'Messages too frequent' is waited out and the same turn tried again in the same chat; only a persistent limit is reported", async () => {
  const brief = await mockDeepSeek({ limitFirst: 2 });
  try {
    const c = client(brief.url);
    const res = await c.chat({ prompt: "x", key: "k" });
    assert.match(res.reply, /Hello/, "the turn went through after two refusals");
    assert.equal(brief.seen.completions.length, 3);
    assert.equal(brief.seen.sessions, 1, "one chat the whole time");
    assert.equal(new Set(brief.seen.completions.map((x) => x.chat_session_id)).size, 1);
    assert.equal(c.has("k"), true, "a rate limit does not throw the chat away");
  } finally {
    await brief.close();
  }
  const stuck = await mockDeepSeek({ limitFirst: 99 });
  try {
    await assert.rejects(client(stuck.url).chat({ prompt: "x", key: "k" }), /deepseek hit a usage limit: Messages too frequent/);
    assert.equal(stuck.seen.completions.length, 3, "first try plus the two waits it allows, then it stops");
  } finally {
    await stuck.close();
  }
});

test("messages on one login are spaced out, across clients", async () => {
  const ds = await mockDeepSeek();
  try {
    const gap = 400;
    const a = client(ds.url, { paceMs: gap });
    const b = client(ds.url, { paceMs: gap });
    const stamps = [];
    await a.chat({ prompt: "1", key: "a" });
    stamps.push(Date.now());
    await b.chat({ prompt: "2", key: "b" });
    stamps.push(Date.now());
    assert.ok(stamps[1] - stamps[0] >= gap - 80, `two messages ${stamps[1] - stamps[0]} ms apart: too close`);
  } finally {
    await ds.close();
  }
});

test("DeepSeek's defaults: no count of our own (its quota decides), a person's pace, a short bench, automation off", () => {
  const cfg = loadConfig(os.tmpdir(), { local: { enabled: false } });
  assert.deepEqual(cfg.sites.deepseek.limit, { perHour: 0, perDay: 0, cooldownMinutes: 10, burstMax: 10, burstMinutes: 10 });
  assert.equal(new DeepSeekHttp({ auth: AUTH }).newChatGapMs, 120_000);
  assert.equal(cfg.sites.claude.limit.cooldownMinutes, 60);
  assert.equal(cfg.automation, false);
  assert.equal(new DeepSeekHttp({ auth: AUTH }).paceMs, 15_000);
});

test("sign-in without the extension: the login is read from a browser window, HttpOnly cookie included", async (t) => {
  const { EDGE } = await import("./edge-harness.js");
  if (!EDGE) return t.skip("Microsoft Edge not installed");
  const { captureLogin, readLogin, finishLogin } = await import("../src/login.js");
  const { spawn } = await import("node:child_process");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "set-cookie": ["ds_session_id=secret-http-only; HttpOnly; Path=/", "visible=1; Path=/"] });
    res.end(`<!doctype html><title>x</title><script>localStorage.setItem("userToken", JSON.stringify({ value: "tok-cdp", __version: "0" }));</script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-login-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    // Nothing signed in yet: reading the profile finds no login.
    await assert.rejects(readLogin({ url: `${url}?empty`, hostRe: /^nowhere$/, exe: EDGE, profileDir: profile, timeoutMs: 3000, pollMs: 300 }), /timeout/);
    // The whole flow. The "sign-in window" here is a stand-in process: the person's part cannot run in a test.
    const order = [];
    const raw = await captureLogin({
      url,
      hostRe: /^127\.0\.0\.1$/,
      exe: EDGE,
      profileDir: profile,
      readTimeoutMs: 30_000,
      pollMs: 400,
      onWaiting: () => order.push("waiting"),
      launch: (exe, dir, u) => {
        order.push(`window ${u === url ? "at the sign-in page" : u}`);
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], { stdio: "ignore" });
        child.once("exit", () => order.push("window closed"));
        return child;
      },
    });
    assert.deepEqual(order, ["window at the sign-in page", "waiting", "window closed"], "the login is only read after the window is closed");
    assert.equal(raw.token, "tok-cdp");
    assert.match(raw.cookie, /ds_session_id=secret-http-only/, "a cookie the page cannot read is still captured");
    const file = path.join(profile, "deepseek-auth.json");
    const done = await finishLogin(raw, { file, check: false });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, "tok-cdp");
    assert.ok(done.cookies.includes("ds_session_id"));
  } finally {
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* a browser process may still hold a file */
    }
  }
});

test("the login is checked with one read-only request: accepted, refused, missing, or could not ask", async () => {
  const ds = await mockDeepSeek();
  try {
    assert.equal(await client(ds.url).loginState(), "ok");
    assert.equal(await client(ds.url, { auth: { ...AUTH, token: "revoked" } }).loginState(), "expired");
    assert.equal(await client(ds.url, { auth: () => { throw new Error("no file"); } }).loginState(), "missing");
    assert.equal(ds.seen.sessions, 0, "no chat was opened");
    assert.equal(ds.seen.completions.length, 0, "no message was sent");
  } finally {
    await ds.close();
  }
  assert.equal(await client("http://127.0.0.1:1").loginState(), "unknown", "an unreachable DeepSeek is not reported as an expired login");
});

test("a login works only on the computer it was made on: a copied one asks for c2f giris, an older one is adopted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-mach-"));
  const file = path.join(dir, "deepseek-auth.json");
  saveAuth({ token: "tok", cookie: "c" }, file);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).machine, machineId());
  assert.equal(loadAuth(file).token, "tok");

  fs.writeFileSync(file, JSON.stringify({ token: "tok", cookie: "c", machine: "0123456789abcdef" }));
  assert.throws(() => loadAuth(file), (err) => err.message === OTHER_MACHINE && /c2f giris/.test(err.message));
  assert.equal(await new DeepSeekHttp({ auth: () => loadAuth(file) }).loginState(), "other-machine", "c2f durum / kur say so before any request");

  fs.writeFileSync(file, JSON.stringify({ token: "old", cookie: "c" }));
  assert.equal(loadAuth(file).token, "old", "a login saved before this check was made here");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).machine, machineId(), "and is marked as this computer's");
});

test("c2f danis: any agent with a shell keeps one DeepSeek chat per thread across separate processes", async () => {
  const { promisify } = await import("node:util");
  const execFile = promisify((await import("node:child_process")).execFile);
  const ds = await mockDeepSeek();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-danis-"));
  try {
    saveAuth({ token: "tok-123", cookie: "c", wasmUrl: "https://fe-static.deepseek.com/x.wasm" }, path.join(home, "deepseek-auth.json"));
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ preferredSites: ["deepseek"] }));
    // Each call is its own process, as when an agent runs the command. The stand-in does not check the puzzle.
    const wrapper = path.join(home, "run.mjs");
    const cli = new URL("../src/cli.js", import.meta.url).href;
    fs.writeFileSync(wrapper, `const { DeepSeekHttp } = await import(${JSON.stringify(new URL("../src/deepseek-http.js", import.meta.url).href)});
DeepSeekHttp.prototype.powHeader = async () => "e30=";
DeepSeekHttp.prototype.wait = async () => {};
DeepSeekHttp.prototype.pace = async () => {};
process.argv = [process.argv[0], "c2f", ...JSON.parse(process.env.ARGS)];
await import(${JSON.stringify(cli)});`);
    // Not execFileSync: the stand-in runs in this process and must keep answering.
    const ask = async (...args) => (await execFile(process.execPath, [wrapper], { encoding: "utf8", env: { ...process.env, ARGS: JSON.stringify(["danis", ...args]), C2F_CONFIG_HOME: home, C2F_DEEPSEEK_URL: ds.url, NO_COLOR: "1" } })).stdout;
    const thread = (out) => /\(thread: ([0-9a-f]{8})\)\s*$/.exec(out)?.[1];

    const first = await ask("Bir not defteri yapmak istiyorum, sence nasıl başlayayım?");
    const id = thread(first);
    assert.ok(id, first);
    const second = await ask("Notları JSON dosyasında tutuyorum, sence uygun mu?", "--thread", id);
    assert.equal(thread(second), id);
    assert.equal(ds.seen.sessions, 1, "the second process went on in the same chat");
    assert.deepEqual(ds.seen.completions.map((x) => [x.chat_session_id, x.parent_message_id]), [["sess-1", null], ["sess-1", 1]], "after the last answer");
    assert.equal(ds.seen.completions[0].prompt, "Bir not defteri yapmak istiyorum, sence nasıl başlayayım?", "only the agent's own words, no set greeting");

    await ask("Notları JSON dosyasında tutuyorum, sence uygun mu?", "--thread", id);
    assert.equal(ds.seen.completions.length, 2, "the same message again at once is not sent");

    // A real message, given on stdin: quotes, $, backticks and % arrive unchanged.
    const tricky = 'Şunu yazdım: echo "$HOME" ve `ls %PATH%`; sence doğru mu?';
    const child = (await import("node:child_process")).spawn(process.execPath, [wrapper], { env: { ...process.env, ARGS: JSON.stringify(["danis", "--thread", id]), C2F_CONFIG_HOME: home, C2F_DEEPSEEK_URL: ds.url } });
    let piped = "";
    child.stdout.on("data", (d) => (piped += d));
    child.stdin.end(tricky);
    await new Promise((r) => child.on("close", r));
    assert.equal(thread(piped), id, piped);
    assert.equal(ds.seen.completions.at(-1).prompt, tricky);

    // From a file the agent wrote: no shell in between at all (a UTF-8 BOM is dropped).
    const msgFile = path.join(home, "mesaj.txt");
    fs.writeFileSync(msgFile, "\uFEFF" + tricky.replace("doğru mu", "şimdi doğru mu"));
    assert.equal(thread(await ask("--file", msgFile, "--thread", id)), id);
    assert.equal(ds.seen.completions.at(-1).prompt, tricky.replace("doğru mu", "şimdi doğru mu"));

    const lost = await ask("Başka bir soru?", "--thread", "abcdef");
    assert.match(lost, /not known on this computer/);
    assert.equal(ds.seen.sessions, 2, "an unknown thread starts a new chat");
  } finally {
    await ds.close();
  }
});

test("new chats are spaced out (a message in a new chat every time is the pattern that got an account suspended); turns in an open chat are not held", async () => {
  const ds = await mockDeepSeek();
  try {
    const gap = 400;
    const c = client(ds.url, { newChatGapMs: gap, lockFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-gap-")), "deepseek.lock") });
    const t0 = Date.now();
    await c.chat({ prompt: "a", key: "one" });
    await c.chat({ prompt: "b", key: "one", continuing: true });
    const sameChat = Date.now() - t0;
    await c.chat({ prompt: "c", key: "two" });
    const total = Date.now() - t0;
    assert.ok(sameChat < gap, `a turn in the open chat waited (${sameChat} ms)`);
    assert.ok(total >= gap - 50, `the second new chat came ${total} ms after the first: too soon`);
    assert.equal(ds.seen.sessions, 2, "it waits, it does not refuse");
  } finally {
    await ds.close();
  }
});

test("which limit is which: 'too frequent' passes soon, a used-up quota does not", async () => {
  const { isQuota } = await import("../src/deepseek-http.js");
  for (const t of ["Messages too frequent. Try again later.", "rate_limit_reached", "消息发送过于频繁，请稍后再试", "Messages too frequent, try again in 2 minutes"]) assert.equal(isQuota(t), false, t);
  for (const t of ["You have reached the daily limit. Please try again tomorrow.", "Your quota has been used up", "Rate limit exceeded for today", "今日对话次数已达上限", "Too many requests, resets in 3 hours"]) assert.equal(isQuota(t), true, t);
});

test("'too frequent': a short back-off in the same chat, then 'slow down, go on and consult again later', not 'quota used up'", async () => {
  const { Advisor } = await import("../src/advisor.js");
  const ds = await mockDeepSeek({ limitFirst: 99 });
  try {
    const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
    const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-q-")), "usage.json") });
    const advisor = new Advisor({ getRouter: () => new Router({ cfg, bridge: null, http: client(ds.url), limits, sessionKey: "f" }) });
    await assert.rejects(advisor.consult({ message: "Sence bu yapı doğru mu?" }), (err) => {
      assert.match(err.message, /^DeepSeek asked to slow down \(DeepSeek said: "Messages too frequent/);
      assert.match(err.message, /the quota is not used up\. Go on with the work yourself and consult again after \d{1,2}:\d{2}/);
      assert.doesNotMatch(err.message, /kotası doldu|Do not call/);
      return true;
    });
    assert.equal(ds.seen.completions.length, 3, "the first try and the two short retries (backoffMs: [20, 20])");
  } finally {
    await ds.close();
  }
});

test("a refusal in wording c2f does not know: not retried, a short rest, DeepSeek's own words passed on", async () => {
  const { Advisor } = await import("../src/advisor.js");
  const stream = () => [{ type: "hint", content: "Hesabınız için hizmet şu an kullanılamıyor.", finish_reason: "stop" }];
  const ds = await mockDeepSeek({ stream });
  try {
    const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
    const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-q-")), "usage.json") });
    const advisor = new Advisor({ getRouter: () => new Router({ cfg, bridge: null, http: client(ds.url), limits, sessionKey: "u" }) });
    await assert.rejects(advisor.consult({ message: "Sence bu yapı doğru mu?" }), /DeepSeek said: "Hesabınız için hizmet şu an kullanılamıyor\."/);
    assert.equal(ds.seen.completions.length, 1, "an unknown refusal is not retried");
    assert.match(fs.readFileSync(path.join(lockDir, "refusals.log"), "utf8"), /unknown Hesabınız için hizmet şu an kullanılamıyor\./, "its wording is kept, so c2f can learn it");
    assert.match(limits.check("deepseek").reason, /cooling down until/);
  } finally {
    await ds.close();
  }
});

test("an informational hint that comes with an answer is not a limit", async () => {
  const stream = (n) => [{ type: "hint", content: "Bilgi: model güncellendi." }, { v: { response: { message_id: n, fragments: [{ type: "RESPONSE", content: "Cevap burada." }] } } }];
  const ds = await mockDeepSeek({ stream });
  try {
    assert.equal((await client(ds.url).chat({ prompt: "x", key: "i" })).reply, "Cevap burada.");
  } finally {
    await ds.close();
  }
});

test("a used-up quota: no retry at all, the site rests until the reset DeepSeek names, and the user hears 'kota doldu, HH:MM'de açılır'", async () => {
  const { Advisor } = await import("../src/advisor.js");
  const ds = await mockDeepSeek({ limitFirst: 99, limitText: "You have reached today's message limit. Resets in 5 hours." });
  try {
    const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
    const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-q-")), "usage.json") });
    const advisor = new Advisor({ getRouter: () => new Router({ cfg, bridge: null, http: client(ds.url), limits, sessionKey: "q" }) });
    const opens = new Date(Date.now() + 5 * 3_600_000).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    await assert.rejects(advisor.consult({ message: "Sence bu yapı doğru mu?" }), (err) => {
      assert.match(err.message, /^DeepSeek's quota is used up \(DeepSeek said: "You have reached today's message limit/);
      assert.ok(err.message.includes(`DeepSeek kotası doldu, ${opens}'de açılır`), err.message);
      assert.match(err.message, /nothing is broken\. Tell the user once/);
      return true;
    });
    assert.equal(ds.seen.completions.length, 1, "no retry: each one would be another request on an exhausted account");
    await assert.rejects(advisor.consult({ message: "Peki şimdi?" }), /quota is used up.*before \d{1,2}:\d{2}/s);
    assert.equal(ds.seen.completions.length, 1, "nothing goes out while it rests");
    assert.match(limits.check("deepseek").reason, new RegExp(`cooling down until ${opens}`), "c2f durum shows when it opens");
  } finally {
    await ds.close();
  }
});


test("a burst is spread out: over burstMax messages in the window the next one waits, and a long wait is handed back with the time", async () => {
  const ds = await mockDeepSeek();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-burst-"));
    const c = client(ds.url, { lockFile: path.join(dir, "deepseek.lock"), burstMax: 2, burstWindowMs: 400, burstMaxWaitMs: 1000 });
    const t0 = Date.now();
    for (const p of ["a", "b", "c"]) await c.chat({ prompt: p, key: "advisor:b", continuing: p !== "a" });
    assert.ok(Date.now() - t0 >= 350, `the third message went out ${Date.now() - t0} ms after the first: the window was not waited for`);
    assert.equal(ds.seen.completions.length, 3, "it waits, nothing is refused");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-burst-"));
    const strict = client(ds.url, { lockFile: path.join(other, "deepseek.lock"), burstMax: 2, burstWindowMs: 60_000, burstMaxWaitMs: 0 });
    await strict.chat({ prompt: "d", key: "advisor:s" });
    await strict.chat({ prompt: "e", key: "advisor:s", continuing: true });
    await assert.rejects(strict.chat({ prompt: "f", key: "advisor:s", continuing: true }), /c2f paces itself: 2 messages in 1 minutes, the next one can go at \d{1,2}:\d{2}/);
    assert.match(fs.readFileSync(path.join(dir, "sent.log"), "utf8"), /chat=sess-\d+ new chars=1 attempts=1 ok/, "the send log has time, chat, size and outcome");
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "sent.log"), "utf8"), /prompt|"d"/, "never the text");
  } finally {
    await ds.close();
  }
});

test("an advisor conversation survives a restart: a new process goes on in the same DeepSeek chat; other chats are not kept", async () => {
  const ds = await mockDeepSeek();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-keep-"));
    const lockFile = path.join(dir, "deepseek.lock");
    await client(ds.url, { lockFile }).chat({ prompt: "plan", key: "advisor:k1" });
    await client(ds.url, { lockFile }).chat({ prompt: "api", key: "api-1-1" });
    const after = client(ds.url, { lockFile }); // as if OpenCode had restarted
    assert.equal(after.has("advisor:k1"), true);
    assert.equal(after.has("api-1-1"), false, "only advisor conversations are kept");
    await after.chat({ prompt: "devam", key: "advisor:k1", continuing: true });
    assert.deepEqual(ds.seen.completions.map((x) => [x.chat_session_id, x.parent_message_id]).at(-1), ["sess-1", 1], "same chat, after the last answer");
    after.drop("advisor:k1");
    assert.equal(client(ds.url, { lockFile }).has("advisor:k1"), false, "a dropped chat is forgotten on disk too");
  } finally {
    await ds.close();
  }
});

test("deep: that one message goes with DeepThink, whatever the config says", async () => {
  const calls = [];
  const fake = { has: () => false, reset() {}, async chat(args) { calls.push(args); return { reply: "ok", ms: 1 }; } };
  const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
  const router = new Router({ cfg, bridge: null, http: fake, limits: new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-d-")), "u.json") }), sessionKey: "d" });
  await router.ask({ phase: "chat", prompt: "x" });
  await router.ask({ phase: "chat", prompt: "y", thinking: true });
  assert.deepEqual(calls.map((c) => c.thinking), [false, true]);
  await router.ask({ phase: "chat", prompt: "z", search: true });
  assert.deepEqual(calls.map((c) => c.search), [false, false, true], "search, likewise, for that one message");
});

test("a limit in the middle does not split the conversation: the next consult goes on in the same chat", async () => {
  const { Advisor } = await import("../src/advisor.js");
  const limitedTurns = new Set([2, 3, 4]); // the second consult: the first try and both short retries
  const stream = (n) => (limitedTurns.has(n) ? [{ type: "hint", content: "Messages too frequent. Try again later.", finish_reason: "rate_limit_reached" }] : [{ v: { response: { message_id: n, fragments: [{ type: "RESPONSE", content: `answer ${n}` }] } } }]);
  const ds = await mockDeepSeek({ stream });
  try {
    const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
    const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-sp-")), "usage.json") });
    const lockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-sp-")), "deepseek.lock");
    const router = new Router({ cfg, bridge: null, http: client(ds.url, { lockFile }), limits, sessionKey: "advisor:sp" });
    const advisor = new Advisor({ getRouter: () => router });
    await advisor.consult({ message: "Bir oyun yapıyorum, sence nasıl başlayayım?" });
    await assert.rejects(advisor.consult({ message: "İlk dosyayı yazdım, sence doğru mu?" }), /asked to slow down/);
    limits.clear("deepseek"); // the bench is over
    const after = await advisor.consult({ message: "Bekledim; dosyayı düzelttim, şimdi nasıl?" });
    assert.equal(after.reply, "answer 5");
    assert.equal(ds.seen.sessions, 1, "still one DeepSeek chat");
    assert.deepEqual(ds.seen.completions.at(-1).chat_session_id, "sess-1");
    assert.equal(ds.seen.completions.at(-1).parent_message_id, 1, "after the last answer it got");
    assert.equal(client(ds.url, { lockFile }).has("advisor:sp"), true, "and the kept chat was not forgotten");
  } finally {
    await ds.close();
  }
});

test("c2f's own burst guard does not bench DeepSeek and does not split the conversation", async () => {
  const { Advisor } = await import("../src/advisor.js");
  const ds = await mockDeepSeek();
  try {
    const cfg = loadConfig(os.tmpdir(), { preferredSites: ["deepseek"], local: { enabled: false } });
    const limits = new Limits({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-bg-")), "usage.json") });
    const lockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-bg-")), "deepseek.lock");
    const router = new Router({ cfg, bridge: null, http: client(ds.url, { lockFile, burstMax: 1, burstWindowMs: 300, burstMaxWaitMs: 0 }), limits, sessionKey: "advisor:bg" });
    const advisor = new Advisor({ getRouter: () => router });
    await advisor.consult({ message: "plan?" });
    await assert.rejects(advisor.consult({ message: "ikinci?" }), /c2f is spreading your messages out \(1 messages in 0 minutes already\)\. Nothing was sent/);
    assert.equal(limits.check("deepseek").ok, true, "no bench written for DeepSeek");
    await new Promise((r) => setTimeout(r, 350));
    await advisor.consult({ message: "ikinci, şimdi?" });
    assert.equal(ds.seen.sessions, 1);
    assert.equal(ds.seen.completions.length, 2, "the held message was never sent");
  } finally {
    await ds.close();
  }
});

test("when DeepSeek moves its proof-of-work module, c2f finds the new one and keeps it", async () => {
  const NEW = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.n3w.wasm";
  const ds = await mockDeepSeek();
  try {
    const kept = [];
    const tried = [];
    let looked = 0;
    const solve = async (challenge, url) => {
      tried.push(url);
      if (url !== NEW) throw new Error("could not fetch the proof-of-work module (HTTP 404)");
      return 4242;
    };
    const c = client(ds.url, { solve, findWasm: async () => (looked++, NEW), keepAuth: (a) => kept.push(a.wasmUrl), auth: () => ({ ...AUTH, wasmUrl: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.old.wasm" }) });
    const res = await c.chat({ prompt: "x", key: "w" });
    assert.match(res.reply, /Hello/);
    assert.deepEqual(tried.map((u) => u.split("_bg.")[1]), ["old.wasm", "n3w.wasm"]);
    assert.equal(looked, 1);
    assert.deepEqual(kept, [NEW], "the new address is written back to the saved login");
  } finally {
    await ds.close();
  }
});
