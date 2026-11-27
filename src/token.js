import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A per-machine shared secret between the CLI and the browser extension.
 *
 * Origin alone is not enough: any installed extension can present a
 * chrome-extension:// origin, and any local page could try 127.0.0.1. The token is
 * pasted into the extension once and stored there.
 */
export function tokenPath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "ChatToFree", "bridge-token");
}

export function ensureToken() {
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* create it below */
  }
  const token = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
