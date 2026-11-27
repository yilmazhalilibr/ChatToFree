import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Api as RealApi, startApi, parseReply, renderFull, safeLength, signature, Conversations, modelFlags } from "../src/api.js";
import { Limits } from "../src/limits.js";

const usageFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2f-api-")), "usage.json");
/** The endpoint with a private, unlimited budget unless a test sets one. */
class Api extends RealApi {
  constructor(opts) {
    super({ limits: new Limits({ file: usageFile() }), budget: () => ({ perHour: 0, perDay: 0, cooldownMinutes: 10 }), ...opts });
  }
}

const TOOLS = [
  { type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "write", description: "Write a file", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } } } } },
];
const call = (name, args) => `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;

/** A DeepSeek client stand-in: answers from a list, records what it was asked, feeds the text in pieces. */
function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    async chat(a) {
      calls.push(a);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      const reply = r ?? "ok";
      if (a.onText) {
        for (let i = 7; i < reply.length; i += 7) a.onText(reply.slice(0, i));
        a.onText(reply);
      }
      return { reply, thinking: "", ms: 1 };
    },
  };
}
const SYS = { role: "system", content: "You are a coding agent.\nWorking directory: D:/proje/deneme\nToday is Monday." };

test("a reply is split into what is said and the tool calls, however the model wrapped them", () => {
  const two = parseReply(`I will look first.\n${call("bash", { command: "ls" })}\n${call("write", { filePath: "a.txt", content: "line1\nline2" })}`, TOOLS);
  assert.equal(two.content, "I will look first.");
  assert.deepEqual(two.calls, [{ name: "bash", arguments: { command: "ls" } }, { name: "write", arguments: { filePath: "a.txt", content: "line1\nline2" } }]);

  const open = parseReply(`ok\n<tool_call>\n{"name":"bash","arguments":{"command":"dir"}}`, TOOLS);
  assert.deepEqual(open.calls, [{ name: "bash", arguments: { command: "dir" } }], "a block the model never closed still counts");

  const rawNewline = parseReply(`<tool_call>\n{"name":"write","arguments":{"filePath":"a.txt","content":"a\nb"}}\n</tool_call>`, TOOLS);
  assert.equal(rawNewline.calls[0].arguments.content, "a\nb", "a raw newline inside a JSON string is repaired, not lost");

  const bare = parseReply('```json\n{"name":"bash","arguments":{"command":"pwd"}}\n```', TOOLS);
  assert.deepEqual(bare.calls, [{ name: "bash", arguments: { command: "pwd" } }], "tags dropped, but it is a call for a tool that exists");

  const prose = parseReply('Here is the config: {"name":"my-app","arguments":1}', TOOLS);
  assert.equal(prose.calls.length, 0, "JSON inside an answer is not a tool call");

  const broken = parseReply("<tool_call>\n{name: bash, oops\n</tool_call>", TOOLS);
  assert.equal(broken.calls.length, 0);
  assert.equal(broken.bad.length, 1, "an unreadable block is reported, not silently dropped");

  assert.equal(parseReply("All done, the file is written.", TOOLS).content, "All done, the file is written.");
});

test("a real reply in DeepSeek's own markup (captured live) is read completely", () => {
  const reply = fs.readFileSync(new URL("./fixtures/dsml-reply.txt", import.meta.url), "utf8");
  const tools = [...TOOLS, { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } } }];
  const out = parseReply(reply, tools);
  assert.deepEqual(out.calls, [
    { name: "write", arguments: { filePath: "D:/proje/deneme/merhaba.txt", content: 'Merhaba\nDünya "tırnak"\n' } },
    { name: "bash", arguments: { command: "ls -l merhaba.txt", timeout: 5000 } },
  ]);
  assert.deepEqual([out.content, out.bad], ["", []]);
  assert.equal(safeLength(reply), reply.indexOf("<"), "nothing of it would be shown as text");
});

test("other spellings of that markup are read, and a proper tool_call that merely contains it is not confused", () => {
  const plain = parseReply('Bakıyorum.\n<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>', TOOLS);
  assert.deepEqual([plain.content, plain.calls], ["Bakıyorum.", [{ name: "bash", arguments: { command: "ls" } }]]);
  const sloppy = parseReply("＜｜DSML｜invoke name=‘write’＞\n＜｜DSML｜parameter name=“filePath” string=“true”＞a.txt＜/｜DSML｜parameter＞\n＜｜DSML｜parameter name=“content” string=“true”＞satır\n\n", TOOLS);
  assert.deepEqual(sloppy.calls, [{ name: "write", arguments: { filePath: "a.txt", content: "satır" } }], "full-width brackets, curly quotes, closing tags missing");
  const doc = parseReply(call("write", { filePath: "notes.md", content: 'Example:\n<invoke name="bash">\n<parameter name="command">rm -rf /</parameter>\n</invoke>' }), TOOLS);
  assert.equal(doc.calls.length, 1);
  assert.equal(doc.calls[0].name, "write", "markup inside a file being written is content, not a call");
  assert.equal(parseReply("In HTML you write <invoke> tags? No such thing.", TOOLS).calls.length, 0);
});

test("DeepSeek's own tool-call markup is read too: raw text for strings, JSON for the rest", () => {
  const D = "｜｜DSML｜｜";
  const reply = `Dosyayı yazıyorum.\n<${D} calls>\n<${D} invoke name="write">\n<${D} parameter name="filePath" string="true">D:/proje/deneme/merhaba.txt</${D} parameter>\n<${D} parameter name="content" string="true">Merhaba\nDünya "tırnak" x < y\n</${D} parameter>\n</${D} invoke>\n<${D} invoke name="bash">\n<${D} parameter name="command" string="true">ls -l</${D} parameter>\n<${D} parameter name="timeout" string="false">5000</${D} parameter>\n</${D} invoke>\n</${D} calls>`;
  const out = parseReply(reply, TOOLS);
  assert.equal(out.content, "Dosyayı yazıyorum.");
  assert.deepEqual(out.calls, [
    { name: "write", arguments: { filePath: "D:/proje/deneme/merhaba.txt", content: 'Merhaba\nDünya "tırnak" x < y\n' } },
    { name: "bash", arguments: { command: "ls -l", timeout: 5000 } },
  ]);
  // The single-bar spelling, no string attribute: the tool's schema says what is text.
  const single = parseReply('<|DSML|function_calls>\n<|DSML|invoke name="bash">\n<|DSML|parameter name="command">echo 1</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|function_calls>', TOOLS);
  assert.deepEqual(single.calls, [{ name: "bash", arguments: { command: "echo 1" } }]);
  const empty = parseReply(`<${D} calls>\n</${D} calls>`, TOOLS);
  assert.equal(empty.bad.length, 1, "markup without a readable call is reported");
  assert.equal(safeLength(`tamam <${D} calls>`), 6, "none of the markup is shown while streaming");
});

test("only text that cannot become a tool_call block is shown while the reply grows", () => {
  assert.equal(safeLength("hello"), 5);
  assert.equal(safeLength("hello <tool_call>{"), 6);
  assert.equal(safeLength("hello <tool_c"), 6, "a tail that may turn into the tag is held back");
  assert.equal(safeLength("a < b"), 5);
});

test("model ids pick DeepThink and search", () => {
  assert.deepEqual(modelFlags("deepseek"), { thinking: false, search: false });
  assert.deepEqual(modelFlags("deepseek-thinking"), { thinking: true, search: false });
  assert.deepEqual(modelFlags("deepseek-v4-flash-thinking-nosearch"), { thinking: true, search: false });
  assert.deepEqual(modelFlags("deepseek-search"), { thinking: false, search: true });
});

test("the first request opens a chat with instructions, tools and the request; a tool result goes into the SAME chat as a short message", async () => {
  const client = fakeClient([`Looking.\n${call("bash", { command: "ls" })}`, "There are two files."]);
  const api = new Api({ client, key: "k" });
  const first = await api.complete({ model: "deepseek", messages: [SYS, { role: "user", content: "list the files" }], tools: TOOLS });
  assert.deepEqual(first.calls, [{ name: "bash", arguments: { command: "ls" } }]);
  assert.equal(first.content, "Looking.");
  const sent = client.calls[0];
  assert.equal(sent.continuing, false);
  assert.match(sent.prompt, /You are a coding agent/);
  assert.match(sent.prompt, /## bash\nRun a shell command/);
  assert.match(sent.prompt, /# Request\nlist the files/);
  assert.equal("title" in sent, false, "DeepSeek names its own chats");
  assert.deepEqual([sent.thinking, sent.search], [false, false]);

  // The agent comes back with the whole history plus the tool's output; it re-serialised our call.
  const history = [
    { ...SYS, content: `${SYS.content}\nToday is Tuesday.` },
    { role: "user", content: "list the files" },
    { role: "assistant", content: "Looking.", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{ "command": "ls" }' } }] },
    { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" },
  ];
  const second = await api.complete({ model: "deepseek", messages: history, tools: TOOLS });
  assert.equal(second.content, "There are two files.");
  const follow = client.calls[1];
  assert.equal(follow.continuing, true);
  assert.equal(follow.key, sent.key, "same DeepSeek chat");
  assert.match(follow.prompt, /^<tool_result name="bash">\na\.txt\nb\.txt\n<\/tool_result>/);
  assert.doesNotMatch(follow.prompt, /You are a coding agent|## bash/, "nothing that was already sent is sent again");
});

test("another conversation gets another chat; a request that rewrites history starts over with the full transcript", async () => {
  const client = fakeClient(["one", "two", "three"]);
  const api = new Api({ client, key: "k" });
  await api.complete({ messages: [SYS, { role: "user", content: "first topic" }] });
  await api.complete({ messages: [SYS, { role: "user", content: "second topic" }] });
  assert.notEqual(client.calls[0].key, client.calls[1].key);
  assert.equal(client.calls[1].continuing, false);

  // The user edited their first message: the open chat no longer matches.
  await api.complete({ messages: [SYS, { role: "user", content: "first topic, edited" }, { role: "assistant", content: "one" }, { role: "user", content: "go on" }] });
  const third = client.calls[2];
  assert.equal(third.continuing, false);
  assert.match(third.prompt, /# Conversation so far\n\[user\]\nfirst topic, edited\n\n\[assistant\]\none\n\n\[user\]\ngo on/);
});

test("when DeepSeek no longer has the chat, the whole conversation is resent into a new one", async () => {
  const client = fakeClient(["first answer", new Error("context_lost: DeepSeek no longer has that chat"), "recovered"]);
  const api = new Api({ client, key: "k" });
  const msgs = [SYS, { role: "user", content: "hello" }];
  await api.complete({ messages: msgs });
  const out = await api.complete({ messages: [...msgs, { role: "assistant", content: "first answer" }, { role: "user", content: "and then?" }] });
  assert.equal(out.content, "recovered");
  assert.deepEqual(client.calls.map((c) => c.continuing), [false, true, false]);
  assert.match(client.calls[2].prompt, /first answer[\s\S]*and then\?/);
  assert.notEqual(client.calls[2].key, client.calls[0].key);
});

test("a tool call that cannot be read is asked for again once instead of ending the agent's turn", async () => {
  const client = fakeClient(["<tool_call>\n{name: bash, broken\n</tool_call>", call("bash", { command: "ls" })]);
  const api = new Api({ client, key: "k" });
  const out = await api.complete({ messages: [SYS, { role: "user", content: "list" }], tools: TOOLS });
  assert.deepEqual(out.calls, [{ name: "bash", arguments: { command: "ls" } }]);
  assert.match(client.calls[1].prompt, /could not be read as JSON/);
  assert.equal(client.calls[1].continuing, true);
});

test("naming a session is answered here: it never opens a chat or spends a message", async () => {
  const client = fakeClient([]);
  const api = new Api({ client, key: "k" });
  const out = await api.complete({ messages: [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, { role: "user", content: "make me a small snake game in one html file please" }] });
  assert.equal(out.content, "make me a small snake game");
  assert.equal(client.calls.length, 0);
});

test("a long transcript keeps the instructions and the newest messages", () => {
  const big = "x".repeat(120_000);
  const prompt = renderFull([SYS, { role: "user", content: "start" }, { role: "assistant", content: big }, { role: "user", content: "the newest question" }], TOOLS);
  assert.ok(prompt.length <= 61_000, `prompt is ${prompt.length} chars: above what DeepSeek accepts`);
  assert.match(prompt, /^You are a coding agent/);
  assert.match(prompt, /## bash/);
  assert.match(prompt, /the newest question/);
});

test("when DeepSeek says the message is too long, a shorter one is sent once, in a new chat", async () => {
  const tooLong = () => new Error("deepseek failed: Content is too long. Please shorten it and try again.");
  const client = fakeClient([tooLong(), "fits now"]);
  const api = new Api({ client, key: "k" });
  const out = await api.complete({ messages: [SYS, { role: "user", content: "a".repeat(50_000) }, { role: "assistant", content: "b".repeat(50_000) }, { role: "user", content: "the newest question" }], tools: TOOLS });
  assert.equal(out.content, "fits now");
  assert.ok(client.calls[1].prompt.length < client.calls[0].prompt.length / 1.8, `${client.calls[0].prompt.length} -> ${client.calls[1].prompt.length}`);
  assert.match(client.calls[1].prompt, /the newest question/);
  assert.match(client.calls[1].prompt, /## bash/, "the tools are still described");
  assert.equal(client.calls[1].continuing, false);

  // A follow-up that is too long (a huge tool result) loses its chat: the conversation starts over, clipped.
  const c2 = fakeClient(["first", tooLong(), "recovered"]);
  const api2 = new Api({ client: c2, key: "k" });
  await api2.complete({ messages: [SYS, { role: "user", content: "hi" }] });
  const again = await api2.complete({ messages: [SYS, { role: "user", content: "hi" }, { role: "assistant", content: "first" }, { role: "user", content: "next" }] });
  assert.equal(again.content, "recovered");
  assert.deepEqual(c2.calls.map((c) => c.continuing), [false, true, false]);

  await assert.rejects(new Api({ client: fakeClient([tooLong(), tooLong()]), key: "k" }).complete({ messages: [{ role: "user", content: "x" }] }), /too long/, "it does not shrink forever");
});

test("c2f's own tools are never offered to the model: DeepSeek would only be consulting itself", async () => {
  const client = fakeClient(["ok"]);
  const api = new Api({ client, key: "k" });
  const withOurs = [...TOOLS, { type: "function", function: { name: "c2f_advise", description: "Ask the web model", parameters: { type: "object", properties: {} } } }, { type: "function", function: { name: "c2f_build", description: "Build", parameters: { type: "object", properties: {} } } }];
  await api.complete({ messages: [SYS, { role: "user", content: "x" }], tools: withOurs });
  assert.match(client.calls[0].prompt, /## bash/);
  assert.doesNotMatch(client.calls[0].prompt, /c2f_advise|c2f_build/);
});

test("a conversation is recognised by the user's own messages and the order of turns", () => {
  const a = signature([SYS, { role: "user", content: "hi" }, { role: "assistant", content: "x" }, { role: "tool", tool_call_id: "c1", content: "out" }]);
  const b = signature([{ role: "system", content: "another system prompt" }, { role: "user", content: "hi" }, { role: "assistant", content: "rewritten" }, { role: "tool", tool_call_id: "c1", content: "[cleared]" }]);
  assert.deepEqual(a, b);
  const store = new Conversations(2);
  const conv = { sig: a.slice(0, 2), key: "k1" };
  store.save(conv);
  assert.equal(store.match(a), conv);
  assert.equal(store.match(a.slice(0, 2)), null, "the same request again is not a continuation");
  assert.equal(store.match(signature([{ role: "user", content: "other" }, { role: "assistant", content: "" }, { role: "user", content: "x" }])), null);
});

async function withServer(client, run) {
  const server = await startApi({ port: 0, api: new Api({ client, key: "secret" }) });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const post = (base, body, key = "secret") => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

test("over HTTP: the key is required, and an answer comes back in OpenAI's shape", async () => {
  await withServer(fakeClient([`Sure.\n${call("bash", { command: "ls" })}`, "plain answer"]), async (base) => {
    assert.equal((await post(base, { messages: [{ role: "user", content: "x" }] }, null)).status, 401);
    assert.equal((await post(base, { messages: [{ role: "user", content: "x" }] }, "wrong")).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer secret" } })).json();
    assert.deepEqual(models.data.map((m) => m.id), ["deepseek", "deepseek-thinking"]);

    const res = await (await post(base, { model: "deepseek", messages: [SYS, { role: "user", content: "list" }], tools: TOOLS })).json();
    const choice = res.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, "Sure.");
    assert.equal(choice.message.tool_calls[0].function.name, "bash");
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { command: "ls" });
    assert.match(choice.message.tool_calls[0].id, /^call_/);

    const plain = await (await post(base, { messages: [SYS, { role: "user", content: "hi" }] })).json();
    assert.deepEqual([plain.choices[0].finish_reason, plain.choices[0].message.content], ["stop", "plain answer"]);
  });
});

test("streaming: text arrives as it grows, a tool_call block never leaks into it, and the calls come as tool_calls", async () => {
  await withServer(fakeClient([`I will check the folder.\n${call("bash", { command: "ls" })}`]), async (base) => {
    const res = await post(base, { model: "deepseek", stream: true, messages: [SYS, { role: "user", content: "list" }], tools: TOOLS });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const raw = await res.text();
    assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
    const events = raw.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    const text = events.map((e) => e.choices[0].delta.content || "").join("");
    assert.equal(text.trim(), "I will check the folder.");
    assert.ok(events.filter((e) => e.choices[0].delta.content).length > 1, "the text came in more than one piece");
    const calls = events.flatMap((e) => e.choices[0].delta.tool_calls || []);
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].index, calls[0].function.name, JSON.parse(calls[0].function.arguments)], [0, "bash", { command: "ls" }]);
    assert.equal(events.at(-1).choices[0].finish_reason, "tool_calls");
    assert.ok(events.at(-1).usage.total_tokens > 0);
  });
});

test("DeepSeek's refusals reach the client as the right kind of error", async () => {
  await withServer(fakeClient([new Error("deepseek hit a usage limit: Messages too frequent"), new Error("deepseek needs login: run c2f giris"), new Error("deepseek failed: HTTP 500")]), async (base) => {
    const ask = () => post(base, { messages: [{ role: "user", content: `q${Math.random()}` }] });
    const limited = await ask();
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.type, "rate_limit_error");
    const login = await ask();
    assert.equal(login.status, 401);
    assert.match((await login.json()).error.message, /c2f giris/, "the person is told the one command that fixes it");
    assert.equal((await ask()).status, 502);
  });
  await withServer(fakeClient([new Error("deepseek hit a usage limit: Messages too frequent")]), async (base) => {
    const raw = await (await post(base, { stream: true, messages: [{ role: "user", content: "x" }] })).text();
    assert.match(raw, /"type":"rate_limit_error"/, "a streamed request reports the error inside the stream");
    assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
  });
});

test("messages sent through the endpoint count against DeepSeek's budget, and stop when it is used up", async () => {
  const client = fakeClient(["one", "two", "three"]);
  const limits = new Limits({ file: usageFile() });
  const api = new RealApi({ client, key: "k", limits, budget: () => ({ perHour: 2, perDay: 0, cooldownMinutes: 10 }) });
  await api.complete({ messages: [{ role: "user", content: "a" }] });
  await api.complete({ messages: [{ role: "user", content: "b" }] });
  await assert.rejects(api.complete({ messages: [{ role: "user", content: "c" }] }), /deepseek hit a usage limit: budget of 2\/hour used up/);
  assert.equal(client.calls.length, 2, "the third message never left");
  assert.equal(limits.load().deepseek.hits.length, 2, "both sends are on record, where the advisor's are");
});
