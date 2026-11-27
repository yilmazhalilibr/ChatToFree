import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { Advisor } from "../src/advisor.js";

/** A Router stand-in: remembers what it was asked, says whether the chat was continued. */
function fakeRouter() {
  const calls = [];
  let open = false;
  return {
    calls,
    resets: 0,
    resetSessions() {
      open = false;
      this.resets++;
    },
    async ask(args) {
      calls.push(args);
      const continued = open;
      open = true;
      return { site: "deepseek", reply: `advice ${calls.length}`, continued, ms: 1000 };
    },
  };
}
const FIRST = "Tek sayfalık bir sayaç yapmak istiyorum. Klasör şu an boş. Düz HTML ve biraz JavaScript ile yapmayı düşünüyorum, sence yeterli mi?";
const LATER = "Butonu ekledim, tıklayınca sayı artıyor. Sayfayı yenileyince sıfırlanıyor; localStorage kullanmalı mıyım?";

test("the worker's own words reach the advisor unchanged, from the first message on: no set greeting or framing", async () => {
  const router = fakeRouter();
  const advisor = new Advisor({ getRouter: () => router });
  await advisor.consult({ message: FIRST });
  assert.equal(router.calls[0].prompt, FIRST, "the first message is exactly the worker's text");
  assert.doesNotMatch(router.calls[0].prompt, /\[PLAN\]|\[REVIEW\]|You are|###|```/, "no machine scaffolding: the user reads this conversation");

  const second = await advisor.consult({ message: LATER });
  assert.equal(router.calls[1].followUp, LATER, "a later message goes into the same conversation exactly as written");
  assert.equal(second.continued, true);
});

test("a go-between's report is refused: the worker speaks as the one whose work it is", async () => {
  const router = fakeRouter();
  const advisor = new Advisor({ getRouter: () => router });
  for (const reported of [
    "Kullanıcı tek dosyalık bir index.html istiyor: ortada Merhaba yazısı. Yaklaşımın ne olur?",
    "The user wants a counter page. How would you approach it?",
    "Kullanıcının isteği üzerine sayfayı yazdım, hata var mı?",
    "Benden istenen sayfayı yazdım, bakar mısın?",
  ]) {
    await assert.rejects(advisor.consult({ message: reported }), /write it as your own work, in the first person.*sence nasıl yapabilirim/s, reported);
  }
  assert.equal(router.calls.length, 0, "nothing was sent");
  for (const own of [FIRST, LATER, "Şu dosyayı şöyle yazdım: tek buton, tıklayınca sayı artıyor. Sence buradaki hatalar neler?", "Giriş formunda kullanıcı adı alanını boş bırakınca hata alıyorum. The user table is empty too. Sence neden?"]) {
    await advisor.consult({ message: own });
  }
  assert.equal(router.calls.length, 4, "first-person messages go through, also when they talk about the users of the program");
});

test("a message that is a paste, not a message, is refused with what to do instead", async () => {
  const router = fakeRouter();
  assert.equal(new Advisor({ getRouter: () => router }).maxChars, 30_000, "room for one file or class (DeepSeek takes about 40,000)");
  const advisor = new Advisor({ getRouter: () => router, maxChars: 4000 });
  await assert.rejects(advisor.consult({ message: "x".repeat(4001) }), /4001 characters; the limit is 4000\. Split it: one file or class per message/);
  await assert.rejects(advisor.consult({ message: "   " }), /message is required/);
  assert.equal(router.calls.length, 0, "nothing was sent");
});

test("one conversation per thread: the same OpenCode session keeps its chat across requests, a new session gets a new one", async () => {
  const { Threads } = await import("../src/advisor.js");
  const routers = [];
  let n = 0;
  const threads = new Threads({ newId: () => `t${++n}`, makeRouter: () => (routers.push(fakeRouter()), routers.at(-1)) });

  // OpenCode session 1, first /ctf_ask: no thread yet.
  const a = threads.get(undefined);
  await a.advisor.consult({ message: "Bir sayaç sayfası yapmak istiyorum, sence nasıl başlayayım?" });
  await threads.get(a.id).advisor.consult({ message: "Sayfayı yazdım, sence eksik var mı?" });
  // Same OpenCode session, second /ctf_ask: the agent passes the thread it saw in the earlier answer.
  const again = threads.get(a.id);
  assert.equal(again.id, a.id);
  const third = await again.advisor.consult({ message: "Şimdi bir sıfırlama butonu eklemek istiyorum, nereye koyayım?" });
  assert.equal(third.continued, true, "the same DeepSeek chat goes on");
  assert.equal(routers.length, 1, "one conversation for the whole session");
  assert.equal(routers[0].resets, 0);

  // A new OpenCode session has no thread: a new conversation.
  const b = threads.get(undefined);
  assert.notEqual(b.id, a.id);
  assert.equal((await b.advisor.consult({ message: "Başka bir iş: bir not defteri yapmak istiyorum." })).continued, false);
  assert.equal(routers.length, 2);

  // A thread this server does not know (it restarted) is said to be lost, and a new one starts.
  const lost = threads.get("gone");
  assert.equal(lost.lost, true);
  assert.equal(routers.length, 3);
});

test("with the OpenCode session, the session decides: the model forgetting its thread does not open a new chat", async () => {
  const { Threads } = await import("../src/advisor.js");
  let made = 0;
  let n = 0;
  const threads = new Threads({ newId: () => `t${++n}`, makeRouter: () => (made++, fakeRouter()) });
  const first = threads.get(undefined, "ses_A");
  assert.equal(threads.get(undefined, "ses_A").id, first.id, "thread forgotten: same conversation");
  assert.equal(threads.get("t999", "ses_A").id, first.id, "a wrong thread: still the session's conversation");
  assert.notEqual(threads.get(first.id, "ses_B").id, first.id, "another OpenCode session never joins it, even with its thread");
  assert.equal(made, 2);
});

test("the same message again soon after is not sent twice, also while the first is still on its way", async () => {
  const router = fakeRouter();
  const advisor = new Advisor({ getRouter: () => router });
  const msg = "notes.json adını değiştirmeyi düşünüyorum, sence gerek var mı?";
  const [a, b] = await Promise.all([advisor.consult({ message: msg }), advisor.consult({ message: msg })]);
  await advisor.consult({ message: msg });
  assert.equal(router.calls.length, 1, "one message reached DeepSeek");
  assert.equal(a, b);
  await advisor.consult({ message: "Peki README eklemeli miyim?" });
  await advisor.consult({ message: msg });
  assert.equal(router.calls.length, 3, "only an immediate repeat is skipped; asking it again later in the talk is sent");
});

test("the session plugin's note reaches c2f on OpenCode 1.x and 2.x", async () => {
  const { noteSession } = await import("../src/advisor.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-oc-"));
  const prev = process.env.C2F_CONFIG_HOME;
  process.env.C2F_CONFIG_HOME = dir;
  try {
    const plugin = (await import(`../.opencode/plugins/c2f-session.js?${Date.now()}`)).default;
    // 2.x: the hook sees the inner c2f_advise call; what it changes in the input is not passed on.
    let hook;
    await plugin.setup({ tool: { hook: async (name, cb) => (hook = cb) } });
    hook({ tool: "c2f_advise", sessionID: "ses_2x", input: { message: "Sence notes.json uygun mu?" } });
    assert.equal(noteSession(dir, "Sence notes.json uygun mu?"), "ses_2x");
    assert.equal(noteSession(dir, "başka bir mesaj"), "", "only the very message it was noted for");
    // 1.x: in the call itself as well.
    const output = { args: { message: "README eklemeli miyim?" } };
    await (await plugin.server())["tool.execute.before"]({ tool: "c2f_advise", sessionID: "ses_1x", callID: "c" }, output);
    assert.equal(output.args.opencode_session, "ses_1x");
    assert.equal(noteSession(dir, "README eklemeli miyim?"), "ses_1x");
    assert.equal(noteSession(dir, "Sence notes.json uygun mu?"), "ses_2x", "earlier notes are kept");
  } finally {
    if (prev === undefined) delete process.env.C2F_CONFIG_HOME;
    else process.env.C2F_CONFIG_HOME = prev;
  }
});

test("pasted code is not checked for third-person phrasing; the words around it still are", async () => {
  const router = fakeRouter();
  const advisor = new Advisor({ getRouter: () => router });
  const code = "```js\n// Kullanıcı silmek istiyorsa önce onay sorulur\nfunction remove(id) {}\n```";
  await advisor.consult({ message: `storage.js dosyasını gönderiyorum, sence bunda neyi değiştirirdin?\n${code}` });
  assert.equal(router.calls.length, 1);
  await assert.rejects(advisor.consult({ message: `Kullanıcı silme özelliği istiyor.\n${code}` }), /first person/);
});

test("secrets never go to the web chat; placeholders and ordinary code pass", async () => {
  const router = fakeRouter();
  const advisor = new Advisor({ getRouter: () => router });
  for (const leak of [
    'config.py:\n```python\nOPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwx1234"\n```\nSence bu yapı iyi mi?',
    ".env dosyam:\n```\nDATABASE_PASSWORD=Gizli.Parola-2026!\n```",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...",
    'Bağlanırken şunu kullanıyorum: password: "hunter2hunter2"',
    "Token bu: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ]) await assert.rejects(advisor.consult({ message: leak }), /nothing was sent: the message seems to contain .*placeholder/, leak);
  assert.equal(router.calls.length, 0);
  for (const fine of [
    'OPENAI_KEY = os.environ["OPENAI_KEY"] kullanıyorum, sence uygun mu?',
    '```python\npassword = input("Parola: ")\napi_key = "<API_KEY>"\n```\nBu doğru mu?',
    ".env.example dosyasına API_KEY=<API_KEY> yazdım, sence yeterli mi?",
  ]) await advisor.consult({ message: fine });
  assert.equal(router.calls.length, 3);
});

test("deep is passed on as DeepThink for that message", async () => {
  const router = fakeRouter();
  const advisor = new Advisor({ getRouter: () => router });
  await advisor.consult({ message: "Bu algoritmayı yazar mısın?", deep: true });
  await advisor.consult({ message: "Teşekkürler, şimdi test ediyorum." });
  assert.deepEqual(router.calls.map((c) => c.thinking), [true, false]);
});

test("after a restart the same OpenCode session goes on in its DeepSeek chat", async () => {
  const { Threads } = await import("../src/advisor.js");
  const sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-ot-")), "oc-threads.json");
  const kept = new Set();
  let n = 0;
  const make = () => new Threads({ sessionsFile, newId: () => `t${++n}`, hasChat: (id) => kept.has(id), makeRouter: () => fakeRouter() });
  const before = make().get(undefined, "ses_A");
  await before.advisor.consult({ message: "plan?" });
  kept.add(before.id); // DeepSeekHttp kept its chat on disk
  const after = make().get(undefined, "ses_A"); // a new c2f process
  assert.equal(after.id, before.id);
  await after.advisor.consult({ message: "devam?" });
  assert.equal(after.router.calls[0].freshChat, false, "it continues the kept chat instead of opening one");
  assert.notEqual(make().get(undefined, "ses_B").id, before.id, "another session still gets its own");
  kept.clear();
  assert.notEqual(make().get(undefined, "ses_A").id, before.id, "a chat DeepSeek no longer has: a new one");
});

test(".c2fignore: listed files never reach the web chat, and 'off' turns the advisor off in that project", async () => {
  const { projectGuard } = await import("../src/advisor.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-ign-"));
  fs.mkdirSync(path.join(dir, "secrets", "deep"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "secrets", "deep", "notes.txt"), "the customer list lives on the old server in room 4\n");
  fs.writeFileSync(path.join(dir, "src", "billing.py"), "def charge_customer(card_number, amount_in_cents):\n    pass\n");
  fs.writeFileSync(path.join(dir, "src", "public.py"), "def public_helper_function_that_is_fine(x):\n");
  fs.writeFileSync(path.join(dir, ".c2fignore"), "# not for the web\nsecrets/\n*billing*.py\n");
  const router = fakeRouter();
  const advisor = new Advisor({ getRouter: () => router, project: dir });
  await assert.rejects(advisor.consult({ message: "Bunu yazdım:\n```python\ndef charge_customer(card_number, amount_in_cents):\n```\nsence?" }), /holds lines of src\/billing\.py, which \.c2fignore keeps out/);
  await assert.rejects(advisor.consult({ message: "Not: the customer list lives on the old server in room 4" }), /secrets\/deep\/notes\.txt/);
  await advisor.consult({ message: "```python\ndef public_helper_function_that_is_fine(x):\n```\nBu nasıl?" });
  await advisor.consult({ message: "Ödeme modülünü yazdım; kart numarasını hiç saklamıyorum. Sence nasıl test edeyim?" });
  assert.equal(router.calls.length, 2, "only what .c2fignore allows went out");
  fs.writeFileSync(path.join(dir, ".c2fignore"), "off\n");
  await assert.rejects(advisor.consult({ message: "Yeni bir soru?" }), /turned off in this project/);
  assert.equal(projectGuard(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-none-")), "anything"), "", "no .c2fignore: nothing to check");
});

test("search is passed on for that message", async () => {
  const router = fakeRouter();
  await new Advisor({ getRouter: () => router }).consult({ message: "React 21'de bu API değişti mi?", search: true });
  assert.equal(router.calls[0].search, true);
});

test(".c2fignore holds in a big project: a file after thousands of others, exact paths, heavy folders, and it fails closed when it cannot check everything", async () => {
  const { projectGuard } = await import("../src/advisor.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-ign-big-"));
  const line = "def charge_customer(card_number, amount_in_cents):";
  fs.mkdirSync(path.join(dir, "aaa_data"));
  for (let i = 0; i < 6000; i++) fs.writeFileSync(path.join(dir, "aaa_data", `f${i}.txt`), "x");
  fs.mkdirSync(path.join(dir, "zzz", "pay"), { recursive: true });
  fs.writeFileSync(path.join(dir, "zzz", "pay", "billing.py"), `${line}\n`);
  fs.writeFileSync(path.join(dir, ".c2fignore"), "*billing*.py\n");
  assert.match(projectGuard(dir, line), /holds lines of zzz\/pay\/billing\.py/, "found after 6000 other files");

  fs.mkdirSync(path.join(dir, ".venv"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, ".venv", "token.txt"), "the deploy token for staging is kept in this file\n");
  fs.writeFileSync(path.join(dir, "config", "prod.json"), '{ "db": "postgres://prod-server-name.internal:5432/main" }\n');
  fs.writeFileSync(path.join(dir, ".c2fignore"), "config/prod.json\n.venv/\n");
  assert.match(projectGuard(dir, 'baktım: { "db": "postgres://prod-server-name.internal:5432/main" }'), /config\/prod\.json/, "an exact path, no walk needed");
  assert.match(projectGuard(dir, "the deploy token for staging is kept in this file"), /\.venv\/token\.txt/, "a heavy folder named directly is still covered");

  fs.writeFileSync(path.join(dir, ".c2fignore"), "*.secret\n");
  assert.match(projectGuard(dir, "anything", { maxEntries: 100 }), /could not check every file \.c2fignore protects/, "over the cap nothing goes");
});
