import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

const TEXT_LIMIT = 120_000;
const RUN_OUTPUT_LIMIT = 24_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".c2f", "dist", "build", ".next", "__pycache__"]);

/** Everything the agent may touch lives under one real directory. */
export class Workspace {
  constructor(root) {
    const abs = path.resolve(root);
    fs.mkdirSync(abs, { recursive: true });
    this.root = fs.realpathSync(abs);
  }

  /** Resolve a model-supplied path; throws if it escapes the workspace. */
  resolve(rel, { mustExist = false } = {}) {
    if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
    if (path.isAbsolute(rel)) throw new Error(`absolute paths are not allowed: ${rel}`);
    const abs = path.resolve(this.root, rel);
    // Resolve symlinks of the nearest existing ancestor so a link cannot escape.
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const relToRoot = path.relative(this.root, real);
    const inside = relToRoot === "" || (!relToRoot.startsWith("..") && !path.isAbsolute(relToRoot));
    if (!inside) throw new Error(`path escapes workspace: ${rel}`);
    if (mustExist && !fs.existsSync(abs)) throw new Error(`no such file: ${rel}`);
    return abs;
  }

  write(rel, content) {
    if (typeof content !== "string") throw new Error("content must be a string");
    const abs = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return `wrote ${rel} (${content.length} chars)`;
  }

  append(rel, content) {
    const abs = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, content);
    return `appended ${content.length} chars to ${rel}`;
  }

  read(rel) {
    const abs = this.resolve(rel, { mustExist: true });
    const text = fs.readFileSync(abs, "utf8");
    if (text.length <= TEXT_LIMIT) return { text, truncated: false };
    return { text: text.slice(0, TEXT_LIMIT), truncated: true };
  }

  del(rel) {
    const abs = this.resolve(rel, { mustExist: true });
    fs.rmSync(abs, { recursive: true, force: true });
    return `deleted ${rel}`;
  }

  /** Compact tree with line counts; the model's map of the project. */
  tree(dir = ".", { maxEntries = 300 } = {}) {
    const base = this.resolve(dir);
    const lines = [];
    let count = 0;
    const walk = (absDir, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (count >= maxEntries) {
          lines.push(`${prefix}... (truncated)`);
          return;
        }
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".DS_Store")) continue;
        const abs = path.join(absDir, e.name);
        const rel = path.relative(this.root, abs).split(path.sep).join("/");
        if (e.isDirectory()) {
          lines.push(`${prefix}${e.name}/`);
          walk(abs, prefix + "  ");
        } else {
          let n = 0;
          try {
            n = fs.readFileSync(abs, "utf8").split("\n").length;
          } catch {
            n = -1;
          }
          lines.push(`${prefix}${e.name}${n >= 0 ? ` (${n}L)` : ""}`);
          count++;
        }
      }
    };
    walk(base, "");
    return lines.join("\n") || "(empty)";
  }

  listFiles(dir = ".", { limit = 3000 } = {}) {
    const base = this.resolve(dir);
    const out = [];
    const walk = (absDir) => {
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= limit) return;
        if (SKIP_DIRS.has(e.name)) continue;
        const abs = path.join(absDir, e.name);
        if (e.isDirectory()) walk(abs);
        else out.push(path.relative(this.root, abs).split(path.sep).join("/"));
      }
    };
    walk(base);
    return out;
  }

  /** Runs a shell command inside the workspace. Never a detached daemon. */
  run(cmd, { timeoutMs = 120_000 } = {}) {
    if (typeof cmd !== "string" || !cmd.trim()) throw new Error("cmd is required");
    // The user keeps working while a build runs: nothing may open on their screen.
    if (opensWindow(cmd)) {
      return Promise.resolve({
        code: 0,
        out: "skipped: this command would open a window on the user's screen, which is not allowed while building. Check the result headless (a node script, a test runner, curl against a local server); the user opens the finished result themselves.",
        ms: 0,
      });
    }
    return new Promise((resolve) => {
      const started = Date.now();
      exec(
        cmd,
        {
          cwd: this.root,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          shell: true,
          // Tools that would open a browser or wait for a key stay quiet (Vite/CRA read BROWSER, test runners read CI).
          env: { ...process.env, BROWSER: "none", CI: "1" },
        },
        (err, stdout, stderr) => {
          let out = `${stdout || ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
          if (out.length > RUN_OUTPUT_LIMIT) out = `${out.slice(0, RUN_OUTPUT_LIMIT)}\n... (truncated)`;
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, out: out || "(no output)", ms: Date.now() - started });
        },
      );
    });
  }
}

/**
 * True when a shell command would put a window on the user's screen: start / explorer / open /
 * xdg-open / Invoke-Item, a browser or editor binary, or a dev server told to --open itself.
 * Only the command word of each pipeline segment counts, so `echo start` or `npm start` pass.
 */
const GUI_COMMANDS = "start|explorer|invoke-item|ii|start-process|open|xdg-open|rundll32|msedge|chrome|firefox|brave|notepad|code|wslview";
const GUI_AT_COMMAND = new RegExp(
  `(^|[;&|(]\\s*|\\bcmd(\\.exe)?\\s+/[ck]\\s+"?|\\bpowershell(\\.exe)?\\s+(-\\w+\\s+)*(-command\\s+)?["']?)(${GUI_COMMANDS})(\\.exe)?(?=\\s|$|["'])`,
  "i",
);
export function opensWindow(cmd) {
  const c = String(cmd).trim();
  return GUI_AT_COMMAND.test(c) || /(^|\s)--open(=|\s|$)/.test(c);
}
