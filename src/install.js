/**
 * Puts this folder (with c2f.cmd) on the user's PATH, so `c2f` works from any directory. No admin rights.
 * Run by `c2f kur`; `node src/install.js --remove` takes it off again.
 *
 * The user's PATH is read raw from the registry (no %VAR% expanded, Turkish letters intact) and written
 * back through an environment variable, never pasted into a PowerShell string: that once doubled every
 * backslash in it. Each run also repairs that (repeated backslashes, the same folder twice) and drops the
 * folder c2f was in before it was moved. The value before any change is saved next to c2f's other files.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Drive letter in capitals: started as `node d:\...` the folder would otherwise be spelled differently each time.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/^[a-z]:/, (d) => d.toUpperCase());
const home = () => process.env.C2F_CONFIG_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "ChatToFree");

const ps = (command, env = {}) =>
  execFileSync("powershell", ["-NoProfile", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
  });

/** A user environment variable exactly as stored ("" when there is none). */
export function readUserVar(name) {
  return ps(`$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); [Console]::Out.Write($k.GetValue($env:C2F_VAR_NAME, '', 'DoNotExpandEnvironmentNames'))`, { C2F_VAR_NAME: name });
}

/** Store a user environment variable (as an expandable string, like Windows does for PATH) and tell open programs. */
export function writeUserVar(name, value) {
  ps(
    `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue($env:C2F_VAR_NAME, $env:C2F_VAR_VALUE, 'ExpandString'); [Environment]::SetEnvironmentVariable('C2F_SETTING_CHANGED', '1', 'User'); [Environment]::SetEnvironmentVariable('C2F_SETTING_CHANGED', $null, 'User')`,
    { C2F_VAR_NAME: name, C2F_VAR_VALUE: value },
  );
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
// One backslash where there are several, except the two that start a network path (\\server\share).
const tidy = (entry) => entry.replace(/(?!^)\\{2,}/g, "\\").replace(/^\\{3,}/, "\\\\");

/** The PATH as it should be: tidied, each folder once, the old c2f folder gone, this one kept where it is or added at the end (or gone). */
export function fixPath(current, { repo: here, previous = "", remove = false }) {
  const out = [];
  for (const entry of current.split(";").map((p) => tidy(p.trim())).filter(Boolean)) {
    if (same(entry, here) && remove) continue;
    if (previous && same(entry, tidy(previous)) && !same(entry, here)) continue;
    if (!out.some((p) => same(p, entry))) out.push(entry);
  }
  if (!remove && !out.some((p) => same(p, here))) out.push(here);
  return out.join(";");
}

function main() {
  const remove = process.argv.includes("--remove");
  const marker = path.join(home(), "installed-at.txt");
  const previous = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  const current = readUserVar("Path");
  const next = fixPath(current, { repo, previous, remove });
  if (next !== current) {
    fs.mkdirSync(home(), { recursive: true });
    const backup = path.join(home(), `path-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
    fs.writeFileSync(backup, current);
    writeUserVar("Path", next);
    if (readUserVar("Path") !== next) throw new Error(`PATH could not be written; the old value is in ${backup}`);
    console.log(`PATH updated (the old value is in ${backup}). Open a new terminal.`);
  } else console.log("PATH already right");
  if (remove) fs.rmSync(marker, { force: true });
  else {
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(marker, repo);
  }
}

// Run as a script (c2f kur), not when imported (tests). Compared as paths: a URL comparison misses on a
// lower-case drive letter or a differently encoded Turkish name, and main() would silently not run.
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) main();
