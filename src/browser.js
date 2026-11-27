/**
 * Browser helpers. For real use, openInChrome() opens the four sites in the user's own
 * Chrome, where they are signed in; the extension is loaded there once by hand.
 * Automation cannot pass Cloudflare's challenge (its docs say test suites are detected),
 * so a human signs in and the extension drives those tabs.
 *
 * Usage: node src/browser.js
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export const SITES = [
  ["chatgpt", "https://chatgpt.com/"],
  ["claude", "https://claude.ai/"],
  ["gemini", "https://gemini.google.com/app"],
  ["deepseek", "https://chat.deepseek.com/"],
];

export function defaultProfileDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "ChatToFree", "browser-profile");
}

/**
 * Edge-only launcher used by the automated tests and CI: Edge honours --load-extension,
 * branded Chrome does not. Real use goes through openInChrome() instead.
 */
export function launchBrowser({ profileDir = defaultProfileDir(), open = true, candidates = null, debugPort = -1 } = {}) {
  const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
  const exe = (candidates || [...EDGE_CANDIDATES, ...CHROME_CANDIDATES]).find((p) => fs.existsSync(p));
  if (!exe) throw new Error("No Chrome or Edge found. Install one, or pass --browser <path>.");
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,950",
  ];
  // Only when asked: a fixed debug port conflicts with an already-running Edge on the
  // same profile, and the sign-in window must not be restarted under the user.
  if (debugPort >= 0 && Number.isInteger(debugPort)) args.push(`--remote-debugging-port=${debugPort}`);
  if (open) args.push(...SITES.map(([, url]) => url));

  // Launch through `cmd /c start` so the window is owned by Explorer, not by this process:
  // a directly spawned browser dies with its launcher, which would close the sign-in
  // window the moment this command exits.
  const child = spawn("cmd", ["/c", "start", "", exe, ...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { exe, profileDir, pid: null, child: null, sites: SITES };
}

export function extensionDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
}

/**
 * Opens URLs in the user's OWN Chrome (default profile, where they are already signed in).
 * No --user-data-dir and no flags: branded Chrome ignores --load-extension and refuses
 * remote debugging on the default profile, so the extension is loaded once by hand.
 * Launched through `cmd /c start` so the window is not tied to this process.
 */
export function openInChrome(urls = SITES.map(([, url]) => url)) {
  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Chrome not found. Open the sites in your browser and load extension/ there.");
  const child = spawn("cmd", ["/c", "start", "", exe, ...urls], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { exe };
}

if (process.argv[1] && process.argv[1].endsWith("browser.js")) {
  const { exe } = openInChrome(["chrome://extensions", ...SITES.map(([, url]) => url)]);
  console.log(`opened in your Chrome: ${exe}\n`);
  console.log("One-time setup in that Chrome:");
  console.log("  1. chrome://extensions → turn on Developer mode (top right)");
  console.log("  2. Load unpacked → select:");
  console.log(`       ${extensionDir()}`);
  console.log("  3. Sign in to the four sites that just opened as tabs.");
  console.log("\nThen run: node src/live-smoke.js");
}

/**
 * Ends only the browser processes that use this profile. NEVER kill by image name:
 * that closes every window on the machine, including the user's own.
 */
export function stopBrowser(profileDir = defaultProfileDir()) {
  let out = "";
  try {
    // wmic is deprecated and missing on some builds; CIM via PowerShell is always there.
    // Matching on CommandLine keeps this scoped to OUR profile — never kill by image name.
    out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$p = '${profileDir.replace(/'/g, "''")}'; Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$p*" } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  } catch {
    return { killed: 0, pids: [], reason: "process listing failed" };
  }
  const pids = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
  }
  return { killed: pids.length, pids };
}
