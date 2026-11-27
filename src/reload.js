/**
 * Reload the unpacked extension from the CLI. No clicking in chrome://extensions.
 *
 * The extension exposes a {type:"reload"} message that calls chrome.runtime.reload(); it
 * re-reads every file from disk, so a code change takes effect immediately. The service
 * worker is asleep most of the time, so this waits for it to wake (its alarm fires within
 * ~30s) instead of failing straight away.
 *
 * Usage: node src/reload.js [--wait 120] [--expect 0.2.8]
 */
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { ensureToken } from "./token.js";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const waitMs = Number(flag("wait", 120)) * 1000;
const expect = flag("expect", null);

const cfg = loadConfig(process.cwd());
const token = ensureToken();
const bridge = new Bridge({ port: cfg.port, token, log: () => {} });

await bridge.start();
console.log(`bridge on ${cfg.port}, waiting for the extension (up to ${waitMs / 1000}s)…`);

let info = await bridge.waitForClient(waitMs);
if (!info) {
  console.error("extension never connected. Open chrome://extensions once and click Reload by hand.");
  await bridge.stop();
  process.exit(1);
}
console.log(`connected: v${info.version} — sending reload`);
bridge.send({ type: "reload" });

// The worker restarts and sends a fresh hello carrying the new manifest version.
const before = info.version;
const deadline = Date.now() + 60_000;
let next = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 400));
  const current = bridge.clientInfo;
  if (current && current.version !== before) {
    next = current;
    break;
  }
  if (!next && current) next = current;
}
if (next) console.log(`extension back: v${next.version}${next.version === before ? " (unchanged — is the manifest version bumped?)" : ""}`);

if (expect && next && next.version !== expect) {
  console.error(`expected v${expect}, got v${next.version}`);
  await bridge.stop();
  process.exit(1);
}
await bridge.stop();
