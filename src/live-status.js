/**
 * Ask each site for its real state through the extension that runs in the USER'S browser.
 *
 * This is read-only: it opens nothing, closes nothing, and sends no prompt. It asks the
 * already-connected extension what each open tab looks like (ready / needs_login / blocked).
 *
 * Earlier versions launched their own Edge profile with a debug port. That measured an
 * unsigned profile with no sessions, so it reported "needs login" for sites that worked
 * perfectly in the user's Chrome — a trap. Never reintroduce a browser launch here.
 *
 * Usage: node src/live-status.js
 */
import { Bridge } from "./bridge.js";
import { ensureToken } from "./token.js";
import { loadConfig } from "./config.js";
import { readSiteStates } from "./site-status.js";

const cfg = loadConfig(process.cwd());
const sites = (process.argv.includes("--site") ? [process.argv[process.argv.indexOf("--site") + 1]] : null) || [
  "chatgpt",
  "claude",
  "gemini",
  "deepseek",
];

const bridge = new Bridge({ port: cfg.port, token: ensureToken(), log: () => {} });
await bridge.start();

const info = await bridge.waitForClient(40_000);
if (!info) {
  console.error("extension is not connected. Run: node src/reload.js");
  await bridge.stop();
  process.exit(1);
}
console.log(`extension v${info.version}, adapters: ${info.sites.join(", ")}\n`);

const rows = await readSiteStates(bridge, sites);
for (const r of rows) console.log(`${r.site.padEnd(9)} ${r.verdict}${r.url ? `  ${r.url.slice(0, 60)}` : ""}`);

await bridge.stop();
