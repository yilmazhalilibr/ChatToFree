import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The recorder runs in a page, so load the two scripts the way a content script would.
globalThis.document = { body: {} };
const dir = path.dirname(fileURLToPath(import.meta.url));
for (const file of ["custom-sites.js"]) {
  const code = fs.readFileSync(path.join(dir, "..", "extension", file), "utf8");
  new Function(code)();
}

const describe = globalThis.C2F_describeElement;
const buildSite = globalThis.C2F_buildSite;
const merge = globalThis.C2F_mergeCustomSites;

// Minimal fake DOM nodes: describe() only reads tagName, id, attributes, children, parent.
function fakeNode(tagName, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: attrs.id || "",
    parentElement: null,
    children,
    getAttribute: (n) => (n in attrs ? String(attrs[n]) : null),
  };
  for (const c of children) c.parentElement = node;
  return node;
}

test("a stable hook wins over a structural path", () => {
  const input = fakeNode("textarea", { "data-testid": "composer" });
  assert.equal(describe(input), 'textarea[data-testid="composer"]');
});

test("a generated id is ignored in favour of a hook", () => {
  const input = fakeNode("div", { id: "react-select-7-input", role: "textbox" });
  assert.equal(describe(input), 'div[role="textbox"]');
});

test("a readable id is used as-is", () => {
  assert.equal(describe(fakeNode("textarea", { id: "chat-input" })), "#chat-input");
});

test("no hooks falls back to a structural path", () => {
  const a = fakeNode("span");
  const root = fakeNode("div", {}, [a]);
  assert.equal(describe(a), "span");
});

test("buildSite rejects an incomplete recording", () => {
  assert.throws(() => buildSite({ key: "x", host: "x.com" }), /composer/i);
  assert.throws(() => buildSite({ key: "x", host: "x.com", composer: "#c" }), /reply/i);
});

test("buildSite produces an adapter the engine can drive", () => {
  const site = buildSite({
    key: "My Site!",
    label: "Mine",
    host: "chat.example.com",
    composer: "#c",
    send: "button.go",
    assistant: ".msg",
  });
  assert.equal(site.key, "my-site-");
  assert.deepEqual(site.hosts, ["chat.example.com"]);
  assert.deepEqual(site.composer, ["#c"]);
  assert.deepEqual(site.assistant, [".msg"]);
  assert.equal(site.custom, true);
});

test("a recording never shadows a built-in adapter", () => {
  const builtins = { chatgpt: { hosts: ["chatgpt.com"] }, generic: { hosts: ["127.0.0.1"] } };
  const merged = merge(builtins, [
    { key: "chatgpt", hosts: ["chatgpt.com"], composer: ["#evil"] },
    { key: "mysite", hosts: ["chat.example.com"], composer: ["#c"], assistant: [".m"] },
  ]);
  assert.deepEqual(merged.chatgpt.composer, undefined, "built-in must stay untouched");
  assert.deepEqual(merged.mysite.composer, ["#c"]);
  assert.equal(merged.mysite.custom, true);
});
