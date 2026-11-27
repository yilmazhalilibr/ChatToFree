/**
 * Hands the bridge port and token to the extension without touching its LevelDB.
 *
 * chrome.storage.local lives in a database Edge locks while running, so writing it from
 * outside either fails or corrupts the profile that holds the user's sign-ins. Instead the
 * token is written as a file inside the extension, which background.js fetches with
 * chrome.runtime.getURL at startup. The file is gitignored and not web_accessible, so no
 * page can read it.
 *
 * Usage: node src/link-extension.js [--port 8787]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureToken } from "./token.js";

export function extensionDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
}

export function linkExtension({ port = 8787, token = ensureToken() } = {}) {
  const target = path.join(extensionDir(), "bridge-token.json");
  fs.writeFileSync(target, JSON.stringify({ port, token }, null, 2));
  return { target, port, token };
}

if (process.argv[1] && process.argv[1].endsWith("link-extension.js")) {
  const argv = process.argv.slice(2);
  const portI = argv.indexOf("--port");
  const out = linkExtension({ ...(portI >= 0 ? { port: Number(argv[portI + 1]) } : {}) });
  console.log(`wrote ${out.target}`);
  console.log(`port  ${out.port}`);
  console.log(`token ${out.token}`);
  console.log(`\nReload the extension in edge://extensions (or restart the browser) to pick it up.`);
}
