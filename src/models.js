/**
 * Show what each chat site offers right now: models, reasoning levels, toggles, and what is
 * selected. Opens menus and closes them again; sends nothing.
 *
 * Usage: node src/models.js [site ...] [--json]
 */
import { Bridge } from "./bridge.js";
import { ensureToken } from "./token.js";
import { loadConfig } from "./config.js";

const args = process.argv.slice(2);
const sites = args.filter((a) => !a.startsWith("--"));
const list = sites.length ? sites : ["chatgpt", "claude", "gemini", "deepseek"];
const cfg = loadConfig(process.cwd());
const bridge = new Bridge({ port: cfg.port, token: ensureToken(), log: () => {} });
await bridge.start();
if (!(await bridge.waitForClient(40_000))) {
  console.error("extension is not connected");
  await bridge.stop();
  process.exit(1);
}
const all = {};
for (const site of list) {
  try {
    const res = await bridge.settings({ site, op: "read" });
    all[site] = res.result;
  } catch (err) {
    all[site] = { error: err.message };
  }
}
await bridge.stop();
console.log(JSON.stringify(all, null, 1));
