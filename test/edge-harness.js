/** Launch headless Edge with the unpacked extension and connect it to a Bridge. */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT = path.resolve(HERE, "..", "extension");
export const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

/**
 * End a browser started by a test together with every process it spawned. child.kill() only ends
 * the parent on Windows, which left browser processes (and their windows) behind.
 */
export function killTree(child) {
  if (!child?.pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

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
    return new Promise((r) => this.ws.once("open", r));
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.waits.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** Starts Edge, waits for the extension's worker, points it at `bridge` and waits for hello. */
export async function startEdge({ bridge, token }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c2f-edge-"));
  const child = spawn(
    EDGE,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const pf = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !fs.existsSync(pf); i++) await new Promise((r) => setTimeout(r, 100));
  const [port, wsp] = fs.readFileSync(pf, "utf8").split("\n");
  const cdp = new Cdp(`ws://127.0.0.1:${port}${wsp.trim()}`);
  await cdp.ready();
  let worker = null;
  for (let i = 0; i < 60 && !worker; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const target of targetInfos.filter((x) => x.type === "service_worker")) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const name = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: "chrome.runtime.getManifest().name" }, sessionId);
      if (name.result?.value === "ChatToFree Bridge") {
        worker = sessionId;
        break;
      }
    }
  }
  if (!worker) throw new Error("extension did not load");
  await cdp.send(
    "Runtime.evaluate",
    { awaitPromise: true, returnByValue: true, expression: `(async () => { await chrome.storage.local.set({ port: ${bridge.port}, token: "${token}" }); try { ws.close(); } catch {} ws = null; ensureConnected(); return 1; })()` },
    worker,
  );
  if (!(await bridge.waitForClient(20_000))) throw new Error("extension never connected to the bridge");
  return {
    cdp,
    worker,
    child,
    /** Stop the extension's service worker, as Chrome does when it likes. It wakes on its own. */
    async stopWorker() {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const page = targetInfos.find((x) => x.type === "page");
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const versions = await new Promise((resolve) => {
        const t = setTimeout(() => resolve([]), 4000);
        const h = (m) => {
          const d = JSON.parse(String(m));
          if (d.method !== "ServiceWorker.workerVersionUpdated" || d.sessionId !== sessionId) return;
          const mine = d.params.versions.filter((v) => /chrome-extension:/.test(v.scriptURL) && v.runningStatus === "running");
          if (!mine.length) return;
          clearTimeout(t);
          cdp.ws.off("message", h);
          resolve(mine);
        };
        cdp.ws.on("message", h);
        cdp.send("ServiceWorker.enable", {}, sessionId).catch(() => {});
      });
      for (const v of versions) await cdp.send("ServiceWorker.stopWorker", { versionId: v.versionId }, sessionId).catch(() => {});
      return versions.length;
    },
    async close() {
      cdp.close();
      killTree(child);
      await new Promise((r) => setTimeout(r, 600));
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };
}
