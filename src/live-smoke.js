/**
 * Live smoke: drive the four big chat sites through the real extension and require an
 * answer from each. Sends a nonce so a stale reply cannot pass, and reports the exact
 * selector that failed so the adapter can be fixed from evidence.
 *
 * Usage: node src/live-smoke.js [--site chatgpt] [--profile <dir>] [--keep]
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { ensureToken, tokenPath } from "./token.js";
import { openInChrome, extensionDir, SITES } from "./browser.js";

const argv = process.argv.slice(2);
const only = argv.includes("--site") ? [argv[argv.indexOf("--site") + 1]] : null;
const NEEDS_FOCUS = new Set(["deepseek"]);
const forceFocus = argv.includes("--focus-tab");

const cfg = loadConfig(process.cwd());
const token = ensureToken();
const bridge = new Bridge({ port: cfg.port, requestTimeoutMs: 240_000, token, log: (m) => console.log(`[bridge] ${m}`) });

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

await bridge.start();
console.log(dim(`bridge ws://127.0.0.1:${cfg.port}`));

let info = await bridge.waitForClient(2000);
if (!info) {
  // Chrome ignores --load-extension, so the extension is loaded once by hand in the
  // user's own profile. Open the pages for sign-in and wait for it to connect.
  console.log(yellow("extension not connected."));
  console.log("  1. Chrome → chrome://extensions → Developer mode → Load unpacked → pick:");
  console.log(`       ${extensionDir()}`);
  console.log("  2. Sign in to the four sites in that same Chrome.");
  console.log(dim(`(bridge token is bundled in extension/bridge-token.json; fallback: ${tokenPath()})`));
  openInChrome(["chrome://extensions", ...SITES.map(([, url]) => url)]);
  console.log(yellow("Waiting up to 10 minutes for the extension…"));
  info = await bridge.waitForClient(600_000);
}
if (!info) {
  console.error(red("extension never connected. Load extension/ in chrome://extensions and re-run."));
  await bridge.stop();
  process.exit(1);
}
console.log(green(`extension connected (v${info.version})`));

const results = [];
const sites = SITES.filter(([site]) => !only || only.includes(site));
for (const [site, url] of sites) {
  const nonce = `C2F-${site.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  process.stdout.write(`\n${site.padEnd(9)} ${dim(nonce)} … `);
  const started = Date.now();
  try {
    const res = await bridge.chat({
      site,
      prompt: `Reply with exactly this token and nothing else: ${nonce}`,
      freshChat: true,
      focusTab: forceFocus || NEEDS_FOCUS.has(site),
      timeoutMs: 180_000,
    });
    const secs = Math.round((Date.now() - started) / 1000);
    // A pass must prove the ASSISTANT node was read: a wrong selector that matches our own
    // user bubble would also contain the nonce, so the reply must not echo the prompt.
    const echoedPrompt = /reply with exactly this token/i.test(res.reply);
    const tooLong = res.reply.trim().length > nonce.length + 60;
    const gotNonce = res.reply.includes(nonce) && !echoedPrompt && !tooLong;
    if (gotNonce) {
      console.log(green(`ok (${secs}s, ${res.reply.length} chars)`));
      results.push({ site, ok: true, secs, nonce });
    } else {
      console.log(red(`answered but did not echo the token (${secs}s)`));
      results.push({ site, ok: false, secs, nonce, reply: res.reply.slice(0, 300) });
    }
  } catch (err) {
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(red(`failed (${secs}s)`));
    console.log(`          ${err.message.split("\n").join("\n          ")}`);
    results.push({ site, ok: false, secs, error: err.message });
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} sites answered`);
fs.writeFileSync(path.join(process.cwd(), "live-smoke.json"), JSON.stringify(results, null, 2));
console.log(dim("details in live-smoke.json"));
await bridge.stop();
// Leave the browser running: it holds the signed-in sessions the next run reuses.
console.log(dim("your Chrome was left untouched"));
process.exit(passed === results.length ? 0 : 1);
