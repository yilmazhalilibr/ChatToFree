/**
 * Print the live DOM the extension sees for one site. Diagnostic: shows why a send failed.
 * Usage: node src/inspect.js chatgpt
 */
import { Bridge } from "./bridge.js";
import { ensureToken } from "./token.js";
import { loadConfig } from "./config.js";

const site = process.argv[2] || "chatgpt";
const cfg = loadConfig(process.cwd());
const bridge = new Bridge({ port: cfg.port, token: ensureToken(), log: () => {} });
await bridge.start();
const info = await bridge.waitForClient(15000);
if (!info) {
  console.error("extension is not connected");
  process.exit(1);
}
const flags = process.argv.slice(2);
const anyPath = flags.includes("--any-path");
const probeText = flags.find((f) => !f.startsWith("--") && f !== site) || "";
const res = await bridge.inspect({ site, timeoutMs: 40000, probeText, anyPath });
console.log(JSON.stringify(res.info ?? res, null, 1));
await bridge.stop();
