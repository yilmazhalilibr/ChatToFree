/**
 * Measure and drive a site's controls from the terminal.
 *
 * Usage:
 *   node src/probe.js chatgpt                       # snapshot of the page controls
 *   node src/probe.js chatgpt '[{"op":"snapshot","scope":"layer"}]'
 *   node src/probe.js chatgpt '<steps>' --any       # use the most recent tab, not the root page
 *
 * Steps: {op:"snapshot",scope:"page|layer"} {op:"click",name:"regex",testid,selector,how:"click|pointer",scope}
 *        {op:"escape"} {op:"text",scope} {op:"wait",ms}
 * Never sends a message.
 */
import { Bridge } from "./bridge.js";
import { ensureToken } from "./token.js";
import { loadConfig } from "./config.js";

const args = process.argv.slice(2);
const site = args[0] || "chatgpt";
const raw = args.find((a, i) => i > 0 && !a.startsWith("--"));
const steps = raw ? JSON.parse(raw) : [{ op: "snapshot", scope: "page" }];
const cfg = loadConfig(process.cwd());
const bridge = new Bridge({ port: cfg.port, token: ensureToken(), log: () => {} });
await bridge.start();
if (!(await bridge.waitForClient(40_000))) {
  console.error("extension is not connected");
  await bridge.stop();
  process.exit(1);
}
try {
  const res = await bridge.ui({ site, steps, target: args.includes("--any") ? "any" : "new" });
  console.log(JSON.stringify(res.steps, null, args.includes("--compact") ? 0 : 1));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
await bridge.stop();
