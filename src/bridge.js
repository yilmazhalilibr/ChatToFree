import { WebSocketServer } from "ws";

const LOGIN_HINTS = {
  chatgpt: "Open https://chatgpt.com in Chrome and sign in",
  claude: "Open https://claude.ai and sign in",
  gemini: "Open https://gemini.google.com and sign in",
  deepseek: "Open https://chat.deepseek.com and sign in",
};

/**
 * Localhost WebSocket server. The Chrome extension is the only intended client:
 * it owns the logged-in browser tabs, so no API keys or session cookies touch this process, with one
 * opt-in exception: `c2f auth deepseek` copies the DeepSeek login (collectAuth) so DeepSeek can be used
 * directly over HTTP (src/deepseek-http.js).
 */
export class Bridge {
  constructor({ port = 8787, requestTimeoutMs = 1_800_000, log = () => {}, token = null, reconnectGraceMs = 120_000, aliveTimeoutMs = 300_000 } = {}) {
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
    // A chat already typed into a tab keeps running there while the extension's worker restarts
    // or the browser hiccups; its result is re-delivered once the extension is back. So a chat
    // is only given up on after this long without any extension, or without a sign of life.
    this.reconnectGraceMs = reconnectGraceMs;
    this.aliveTimeoutMs = aliveTimeoutMs;
    this.log = log;
    this.token = token;
    this.wss = null;
    this.client = null;
    this.pending = new Map();
    this.seq = 0;
    this.queues = new Map();
    this.onClient = null;
  }

  async start() {
    if (this.wss) return this.port;
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
    await new Promise((resolve, reject) => {
      this.wss.once("listening", resolve);
      this.wss.once("error", reject);
    });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.watchdog = setInterval(() => this.checkAlive(), Math.min(15_000, Math.max(200, this.aliveTimeoutMs / 3)));
    this.watchdog.unref?.();
    return this.port;
  }

  onConnection(ws, req) {
    const origin = req.headers.origin || "";
    // Only a browser extension may connect. Any page on this machine could otherwise
    // read our prompts and answer with RUN commands.
    if (!origin.startsWith("chrome-extension://")) {
      this.log(`rejected bridge client with origin ${origin || "(none)"}`);
      ws.close(1008, "extensions only");
      return;
    }
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* socket already gone */
      }
    }, 20_000);

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(String(buf));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        if (this.token && msg.token !== this.token) {
          this.log("rejected bridge client with a wrong token");
          ws.close(1008, "bad token");
          return;
        }
        // An MV3 service worker is killed after ~30s idle and reconnects on wake, so the
        // newest authenticated socket must win. The token is what authenticates a client;
        // rejecting the newcomer would break the bridge on every worker restart.
        if (this.pending.size) {
          // A worker restart mid-request. A chat keeps running in its tab, and the tab hands
          // the result to whichever worker is alive, so chats stay pending. Short requests
          // (probe / settings / ui) were answered through the dead worker and cannot finish.
          this.log("worker restarted with requests in flight; chats are kept, short requests failed");
          this.failShort("the extension worker restarted mid-request; retry");
          for (const [, p] of this.pending) if (p.chat) p.lastAlive = Date.now();
        }
        if (this.client && this.client !== ws) {
          // Same extension instance racing itself (worker waking while a socket is still
          // closing). The work is still running in the content script and will post its
          // result on whichever socket is current.
          this.log("a newer authenticated client replaced the previous one (in-flight work kept)");
          try {
            this.client.close(1000, "replaced by a newer client");
          } catch {
            /* already gone */
          }
        }
        this.client = ws;
        this.clientInfo = { sites: Array.isArray(msg.sites) ? msg.sites : [], version: msg.version || "?", at: Date.now(), alive: Boolean(msg.alive) };
        this.log(`extension connected (v${this.clientInfo.version})`);
        this.send({ type: "welcome", port: this.port });
        if (this.onClient) this.onClient(this.clientInfo);
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "chat.alive") {
        const p = this.pending.get(msg.id);
        if (p) p.lastAlive = Date.now();
        return;
      }
      if (msg.type === "inspect.result" || msg.type === "ui.result" || msg.type === "settings.result" || msg.type === "probe.result" || msg.type === "auth.result") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if ((msg.type === "ui.result" || msg.type === "settings.result" || msg.type === "probe.result" || msg.type === "auth.result") && !msg.ok) p.reject(new Error(`${msg.site}: ${msg.error}${msg.detail ? ` (${msg.detail})` : ""}`));
        else p.resolve(msg);
        return;
      }
      if (msg.type === "chat.result" || msg.type === "chat.progress") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        p.lastAlive = Date.now();
        if (msg.type === "chat.progress") {
          if (p.onProgress) p.onProgress(msg);
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(this.explainError(msg)));
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      if (this.client !== ws) return; // replaced socket: the newer one owns the session
      this.client = null;
      this.clientInfo = null;
      // The extension reconnects within ~1s of a worker restart. Short requests are failed
      // after a few seconds; a chat is kept for the grace period, since it is still running in
      // its tab and its result is re-delivered on reconnect.
      // unref: these must never keep the process alive after the bridge is done.
      setTimeout(() => {
        if (!this.client) this.failShort("extension disconnected mid-request");
      }, 8000).unref();
      setTimeout(() => {
        if (!this.client && this.pending.size) this.failAll("extension disconnected mid-request");
      }, this.reconnectGraceMs).unref();
    });
    ws.on("error", () => {});
  }

  explainError(msg) {
    if (msg.error === "needs_login") {
      return `Not signed in to ${msg.site} in the tab the extension opened. ${LOGIN_HINTS[msg.site] || "Sign in in Chrome"} then re-run.`;
    }
    if (msg.error === "blocked") {
      return `${msg.site} is showing a bot/captcha check instead of the chat UI${msg.detail ? ` (${msg.detail})` : ""}. Open ${msg.site} in your own Chrome window, clear the check and sign in — the extension then drives that tab.`;
    }
    if (msg.error === "wrong_host") {
      return `The ${msg.site} tab landed somewhere else${msg.detail ? ` (${msg.detail})` : ""}. Check the adapter's hosts and url in extension/sites.js.`;
    }
    if (msg.error === "not_ready") {
      return `${msg.site} tab never ran the extension's script${msg.detail ? ` (${msg.detail})` : ""}. Reload that tab once (Ctrl+R) and retry.`;
    }
    if (msg.error === "limit") {
      return `${msg.site} hit a usage limit${msg.detail ? `: ${String(msg.detail).slice(0, 200)}` : ""}`;
    }
    if (msg.error === "composer_disabled") {
      return `${msg.site}'s composer is disabled${msg.detail ? ` (${msg.detail})` : ""}. Try again in a moment; it is not treated as a usage limit.`;
    }
    if (msg.error === "settings_failed") {
      return `${msg.site} could not apply the requested settings${msg.detail ? ` (${msg.detail})` : ""}`;
    }
    if (msg.error === "no_tab") return `Could not open a ${msg.site} tab. Is Chrome running with the ChatToFree extension enabled?`;
    return `${msg.site || "site"} failed: ${msg.error || "unknown error"}${msg.detail ? ` (${msg.detail})` : ""}`;
  }

  /** Fail what cannot outlive a worker restart; chats are kept. */
  failShort(reason) {
    for (const [id, p] of this.pending) {
      if (p.chat) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }

  /** A chat whose tab has shown no sign of life for a long while is lost: let the caller retry. */
  checkAlive() {
    if (!this.client || !this.clientInfo?.alive) return;
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (!p.chat || now - p.lastAlive < this.aliveTimeoutMs) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(`lost contact with the ${p.site || "chat"} tab (no sign of life for ${Math.round(this.aliveTimeoutMs / 1000)}s); retry`));
    }
  }

  failAll(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  send(obj) {
    if (!this.client || this.client.readyState !== 1) throw new Error("extension is not connected");
    this.client.send(JSON.stringify(obj));
  }

  get connected() {
    return Boolean(this.client && this.client.readyState === 1);
  }

  async waitForClient(ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.connected) return this.clientInfo;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  /** One blocking question to one web chat model. */
  chat({ site, prompt, freshChat = true, continuing = false, timeoutMs, onProgress, meta = {}, focusTab, quietMs, settings = null, strictSettings = false }) {
    if (!this.connected) {
      return Promise.reject(
        new Error("ChatToFree browser extension is not connected. Load extension/ in chrome://extensions (Developer mode → Load unpacked), then retry."),
      );
    }
    const run = () => this.chatNow({ site, prompt, freshChat, continuing, timeoutMs, onProgress, meta, focusTab, quietMs, settings, strictSettings });
    const key = site || "__any";
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(run, run);
    this.queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  chatNow({ site, prompt, freshChat, continuing, timeoutMs, onProgress, meta, focusTab, quietMs, settings, strictSettings }) {
    const id = `r${++this.seq}`;
    const timeout = timeoutMs || this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${Math.round(timeout / 1000)}s waiting for ${site || "the chat model"} (tab may be showing a dialog or rate limit)`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, onProgress, chat: true, site, lastAlive: Date.now() });
      try {
        this.send({ id, type: "chat", site, prompt, freshChat, continuing: Boolean(continuing), timeoutMs: timeout, meta, focusTab: Boolean(focusTab), quietMs, settings, strictSettings: Boolean(strictSettings) });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Ask the extension what the site's DOM looks like right now (diagnostics). */
  inspect({ site, timeoutMs = 20_000, probeText = "", anyPath = false } = {}) {
    if (!this.connected) return Promise.reject(new Error("extension is not connected"));
    const id = `i${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("inspect timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, type: "inspect", site, probeText, anyPath });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Copy the login a signed-in DeepSeek tab holds (for `c2f auth deepseek`). Resolves to the result; nothing is sent to DeepSeek. */
  collectAuth({ timeoutMs = 60_000 } = {}) {
    if (!this.connected) return Promise.reject(new Error("extension is not connected"));
    const id = `a${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("reading the DeepSeek login timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, type: "auth" });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** A quick look at a site's open tab (ready / signed out / limit notice), sending nothing. */
  probe({ site, timeoutMs = 5000 }) {
    if (!this.connected) return Promise.reject(new Error("extension is not connected"));
    const id = `p${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("probe timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, type: "probe", site });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Read what a site offers ("read") or set model / reasoning / search ("apply"). Sends nothing. */
  settings({ site, op = "read", settings = {}, timeoutMs = 60_000 }) {
    if (!this.connected) return Promise.reject(new Error("extension is not connected"));
    const id = `s${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`settings ${op} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, type: "settings", site, op, settings });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Run UI steps (snapshot / click / escape) in a site tab and return what each one saw.
   * Used to read and set the model and reasoning controls.
   */
  ui({ site, steps, target = "new", timeoutMs = 45_000 }) {
    if (!this.connected) return Promise.reject(new Error("extension is not connected"));
    const id = `u${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ui script timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, type: "ui", site, steps, target });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Ask the first reachable site from a preference list. */
  async askAny({ sites, prompt, freshChat, timeoutMs, onProgress, meta, focusTab, settings }) {
    const list = sites?.length ? sites : ["chatgpt", "claude", "gemini", "deepseek"];
    const errors = [];
    for (const site of list) {
      try {
        const res = await this.chat({ site, prompt, freshChat, timeoutMs, onProgress, meta, focusTab, settings });
        return res;
      } catch (err) {
        errors.push(`${site}: ${err.message}`);
        const fatal = /not connected|timed out/i.test(err.message);
        if (fatal) break;
      }
    }
    throw new Error(`no web chat model answered.\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  async stop() {
    clearInterval(this.watchdog);
    this.failAll("bridge stopped");
    if (!this.wss) return;
    // Terminate first: wss.close() waits for connected clients, and the
    // extension reconnects on its own heartbeat.
    for (const ws of this.wss.clients) {
      try {
        ws.terminate();
      } catch {}
    }
    await new Promise((resolve) => this.wss.close(resolve));
    this.wss = null;
    this.client = null;
  }
}
