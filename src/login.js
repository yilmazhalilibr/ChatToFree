/**
 * Sign-in without the extension, in a browser profile of c2f's OWN (never the user's), in two steps:
 *
 *  1. A NORMAL browser window, with no automation switch of any kind. The person signs in to
 *     chat.deepseek.com and closes the window. (Measured 2026-11-18: with --remote-debugging-port on
 *     the sign-in window, DeepSeek's captcha rejected correct answers. Bot checks see that switch.)
 *  2. After the window is closed, the same profile is opened headless with the debugging port, only to
 *     READ what the sign-in left: the token from page storage and the cookies, HttpOnly ones included.
 *
 * Nothing leaves this computer.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { saveAuth, discoverWasmUrl, DeepSeekHttp } from "./deepseek-http.js";

// Chrome first: it is what people sign in with, and Edge keeps background processes that outlive its window.
const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export function findBrowser() {
  return BROWSERS.find((p) => fs.existsSync(p)) || null;
}

export function loginProfileDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "ChatToFree", "login-profile");
}

const collectorSource = () => fs.readFileSync(new URL("../extension/deepseek-login.js", import.meta.url), "utf8");

/** A tiny DevTools client: send(method, params, sessionId) -> result. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.waits = new Map();
    this.ws.on("message", (m) => {
      const d = JSON.parse(String(m));
      if (d.id && this.waits.has(d.id)) {
        this.waits.get(d.id)(d);
        this.waits.delete(d.id);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
      this.waits.set(id, (d) => {
        clearTimeout(timer);
        if (d.error) reject(new Error(`${method}: ${d.error.message}`));
        else resolve(d.result);
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

const plainWindow = (exe, profileDir, url) => spawn(exe, [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-background-mode", "--new-window", url], { stdio: "ignore" });

/**
 * Step 1 then step 2. Resolves to { token, cookie, hif_dliq, hif_leim, wasmUrl, scripts }.
 * `onWaiting` is called once the window is up (so the caller can tell the person what to do).
 * `launch` is injectable for tests.
 */
export async function captureLogin({ url = "https://chat.deepseek.com/", hostRe, exe = findBrowser(), profileDir = loginProfileDir(), timeoutMs = 10 * 60_000, readTimeoutMs = 45_000, pollMs = 1500, onWaiting = () => {}, launch = plainWindow } = {}) {
  if (!exe) throw new Error("no_browser");
  fs.mkdirSync(profileDir, { recursive: true });
  const child = launch(exe, profileDir, url);
  onWaiting();
  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!closed) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    throw new Error("timeout");
  }
  await new Promise((r) => setTimeout(r, 800)); // let the browser finish writing its profile
  try {
    return await readLogin({ url, ...(hostRe ? { hostRe } : {}), exe, profileDir, timeoutMs: readTimeoutMs, pollMs });
  } catch (err) {
    throw new Error(err.message === "timeout" ? "not_signed_in" : err.message);
  }
}

/**
 * Step 2 on its own: open the profile with the debugging port and read the login it holds. Headless by
 * default; never used for the sign-in itself.
 */
export async function readLogin({
  url = "https://chat.deepseek.com/",
  hostRe = /(^|\.)deepseek\.com$/i,
  exe = findBrowser(),
  profileDir = loginProfileDir(),
  headless = true,
  timeoutMs = 45_000,
  pollMs = 1500,
} = {}) {
  if (!exe) throw new Error("no_browser");
  fs.mkdirSync(profileDir, { recursive: true });
  const portFile = path.join(profileDir, "DevToolsActivePort");
  try {
    fs.unlinkSync(portFile);
  } catch {
    /* none */
  }
  const child = spawn(exe, [`--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--window-size=1000,800", ...(headless ? ["--headless=new"] : []), url], { stdio: "ignore" });
  let cdp = null;
  try {
    // A busy machine can take well over ten seconds to bring a browser up (seen in the full test run).
    for (let i = 0; i < 600 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(portFile)) throw new Error("the browser did not start");
    const [port, wsPath] = fs.readFileSync(portFile, "utf8").split("\n");
    cdp = new Cdp(`ws://127.0.0.1:${port}${wsPath.trim()}`);
    await cdp.ready();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      let targets;
      try {
        ({ targetInfos: targets } = await cdp.send("Target.getTargets"));
      } catch {
        throw new Error("window_closed");
      }
      const page = targets.find((t) => t.type === "page" && (() => { try { return hostRe.test(new URL(t.url).hostname); } catch { return false; } })());
      if (!page) continue;
      let session;
      try {
        ({ sessionId: session } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
        const probe = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `${collectorSource()}\n;JSON.stringify(globalThis.C2F_collectDeepSeekLogin())` }, session);
        const found = JSON.parse(probe.result?.value || "{}");
        if (!found.token) continue;
        const { cookies } = await cdp.send("Network.getAllCookies", {}, session);
        const mine = cookies.filter((c) => hostRe.test(String(c.domain).replace(/^\./, "")));
        found.cookie = mine.map((c) => `${c.name}=${c.value}`).join("; ");
        found.cookieNames = mine.map((c) => c.name);
        return found;
      } catch {
        /* the page is still loading: look again */
      } finally {
        if (session) cdp.send("Target.detachFromTarget", { sessionId: session }).catch(() => {});
      }
    }
    throw new Error("timeout");
  } finally {
    try {
      await cdp?.send("Browser.close");
    } catch {
      /* already closing */
    }
    cdp?.close();
    await new Promise((r) => setTimeout(r, 400));
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

/**
 * Turn a capture into a saved login. With `check`, DeepSeek is asked once whether it accepts it: a
 * read-only "who am I". Signing in never opens a chat on the account (it used to: one empty chat and a
 * proof-of-work request per sign-in).
 */
/**
 * The proof-of-work module's current address, read from the site in c2f's own sign-in profile with a
 * headless browser (no window). The site refuses plain requests (bot check), a real browser passes. "" if
 * not found (signed out, no browser).
 */
export async function findWasmInBrowser() {
  try {
    const raw = await readLogin({});
    return raw.wasmUrl || (await discoverWasmUrl(raw.scripts || []));
  } catch {
    return "";
  }
}

export async function finishLogin(raw, { file, check = true, fetchImpl = globalThis.fetch } = {}) {
  let wasmUrl = raw.wasmUrl;
  if (!wasmUrl) wasmUrl = await discoverWasmUrl(raw.scripts || [], fetchImpl);
  const saved = saveAuth({ token: raw.token, cookie: raw.cookie, hif_dliq: raw.hif_dliq, hif_leim: raw.hif_leim, wasmUrl }, file);
  if (check) {
    if (!wasmUrl) throw new Error("no_wasm");
    if ((await new DeepSeekHttp({ auth: () => JSON.parse(fs.readFileSync(saved, "utf8")), fetchImpl }).loginState()) === "expired") throw new Error("not_signed_in");
  }
  return { file: saved, cookies: raw.cookieNames || [], wasmUrl };
}
