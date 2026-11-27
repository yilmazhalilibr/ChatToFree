/**
 * Launch the persistent profile once and dump the REAL composer/send/stop markup for a
 * site. Selectors are then written from evidence, not guesses.
 *
 * Usage: node src/live-dom.js chatgpt|claude|gemini|deepseek [...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { defaultProfileDir, stopBrowser } from "./browser.js";

const URLS = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  gemini: "https://gemini.google.com/app",
  deepseek: "https://chat.deepseek.com/",
};
const DEBUG_PORT = 9333;
const wanted = process.argv.slice(2).filter((a) => URLS[a]);
for (const s of wanted.length ? wanted : ["chatgpt"]) {
  // noop, keeps the default explicit
}

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));
const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const profileDir = defaultProfileDir();

stopBrowser(profileDir);
await new Promise((r) => setTimeout(r, 2000));
const child = spawn(
  EDGE,
  [
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,950",
    `--remote-debugging-port=${DEBUG_PORT}`,
  ],
  { stdio: "ignore" },
);

let info = null;
for (let i = 0; i < 240 && !info; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    if (res.ok) info = await res.json();
  } catch {
    /* not up */
  }
  if (!info) await new Promise((r) => setTimeout(r, 250));
}
if (!info) {
  console.error("browser never answered on the debug port");
  process.exit(1);
}

const ws = new WebSocket(info.webSocketDebuggerUrl);
let seq = 0;
const waits = new Map();
ws.on("message", (m) => {
  const d = JSON.parse(String(m));
  if (d.id && waits.has(d.id)) {
    waits.get(d.id)(d);
    waits.delete(d.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const id = ++seq;
    waits.set(id, res);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
await new Promise((r) => ws.once("open", r));

const PROBE = `(() => {
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01;
  };
  const d = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    cls: typeof el.className === "string" ? el.className.slice(0, 70) : null,
    testid: el.getAttribute("data-testid"),
    aria: el.getAttribute("aria-label"),
    title: el.getAttribute("title"),
    type: el.getAttribute("type"),
    disabled: el.disabled ?? null,
    ariaDisabled: el.getAttribute("aria-disabled"),
    text: (el.textContent || "").trim().slice(0, 24),
  });
  const composer = [...document.querySelectorAll("textarea, [contenteditable=true], [role=textbox]")].filter(vis);
  const buttons = [...document.querySelectorAll("button, [role=button]")].filter(vis);
  return {
    url: location.href,
    title: document.title,
    composer: composer.map(d),
    composerParents: composer.slice(0, 2).map(c => {
      const out = [];
      for (let n = c; n && n !== document.body && out.length < 5; n = n.parentElement) out.push(d(n));
      return out;
    }),
    buttons: buttons.map(d).slice(0, 28),
    forms: [...document.querySelectorAll("form")].map(f => ({ id: f.id || null, cls: String(f.className).slice(0, 40), buttons: f.querySelectorAll("button").length })),
    assistant: [...document.querySelectorAll("[data-message-author-role=assistant], .font-claude-message, model-response, .ds-markdown")].length,
  };
})()`;

const results = {};
for (const site of wanted.length ? wanted : ["chatgpt"]) {
  const created = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = (await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true })).result;
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: URLS[site] }, sessionId);
  let data = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const ev = await send("Runtime.evaluate", { returnByValue: true, expression: PROBE }, sessionId);
    data = ev.result?.result?.value;
    if (data && data.composer.length) break;
  }
  results[site] = data;
  console.log(`\n===== ${site} =====`);
  console.log(JSON.stringify({ url: data?.url, title: data?.title, composer: data?.composer }, null, 1));
  console.log("BUTTONS:");
  for (const b of data?.buttons || []) {
    console.log(`  ${b.tag} testid=${b.testid} aria=${b.aria} type=${b.type} disabled=${b.disabled} ariaDisabled=${b.ariaDisabled} text=${JSON.stringify(b.text)} cls=${(b.cls || "").slice(0, 40)}`);
  }
  console.log("FORMS:", JSON.stringify(data?.forms));
  await send("Target.closeTarget", { targetId: created.result.targetId });
}
fs.writeFileSync("tmp-live-dom.json", JSON.stringify(results, null, 1));
console.log(`\nbrowser left open (pid ${child.pid}) for the next step`);
process.exit(0);
