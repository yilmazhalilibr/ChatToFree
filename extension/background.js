/* ChatToFree Bridge — MV3 service worker.
 * Owns the WebSocket to the local CLI and one browser tab per chat site.
 * It never proxies HTTP traffic; it drives the page the user is logged in to. The one exception is
 * `c2f auth deepseek` (runAuth): it copies the DeepSeek login from that tab's page storage to the
 * local bridge once, so the CLI can talk to DeepSeek without a tab. Nothing leaves this computer.
 */
importScripts("sites.js", "custom-sites.js", "deepseek-login.js");

const DEFAULT_PORT = 8787;
const HEARTBEAT_MS = 20_000;
let ws = null;
let connecting = false;
let startedAt = 0;
const tabJobs = new Map(); // site -> Promise chain, keeps one request per tab at a time
const liveTabs = new Map(); // site -> tabId

chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("c2f-keepalive", { periodInMinutes: 0.5 });
  ensureConnected();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "c2f-keepalive") ensureConnected();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [site, id] of liveTabs) if (id === tabId) liveTabs.delete(site);
});
loadSites().then(() => {
  ensureConnected();
  setInterval(ensureConnected, 15_000);
});

/** Recorded sites from the options page, merged over the built-ins. */
async function loadSites() {
  try {
    const { customSites = [] } = await chrome.storage.local.get({ customSites: [] });
    C2F_SITES = C2F_mergeCustomSites(C2F_SITES, customSites);
  } catch {
    /* keep the built-in table */
  }
}

async function settings() {
  const s = await chrome.storage.local.get({ port: DEFAULT_PORT, autoOpen: false, token: "" });
  const out = { port: Number(s.port) || DEFAULT_PORT, autoOpen: Boolean(s.autoOpen), token: String(s.token || "") };
  if (out.token) return out;
  // `c2f link` drops a token file next to the extension, so the user never pastes one.
  // It is not web_accessible, so pages cannot read it.
  try {
    const res = await fetch(chrome.runtime.getURL("bridge-token.json"));
    if (res.ok) {
      const file = await res.json();
      if (file.token) {
        out.token = String(file.token);
        if (Number(file.port) > 0) out.port = Number(file.port);
      }
    }
  } catch {
    /* no file: the user sets it in the options page instead */
  }
  return out;
}

async function ensureConnected() {
  // Set the guard BEFORE any await: two callers (startup, alarm, interval) otherwise both
  // pass the check while settings() is pending and open duplicate sockets.
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  connecting = true;
  let port;
  let token;
  try {
    ({ port, token } = await settings());
  } catch {
    connecting = false;
    return;
  }
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    connecting = false;
    return;
  }
  ws.onopen = () => {
    connecting = false;
    startedAt = Date.now();
    // alive: this worker reports the chat tab's sign of life (chat.alive), so the bridge may
    // give up on a silent tab.
    ws.send(JSON.stringify({ type: "hello", token, version: chrome.runtime.getManifest().version, sites: Object.keys(C2F_SITES), alive: true }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "chat") handleChat(msg);
    if (msg.type === "reload") reloadExtension();
    if (msg.type === "inspect") runInspect(msg);
    if (msg.type === "ui") runUi(msg);
    if (msg.type === "settings") runSettings(msg);
    if (msg.type === "probe") runProbe(msg);
    if (msg.type === "auth") runAuth(msg);
  };
  ws.onclose = () => {
    connecting = false;
    ws = null;
  };
  ws.onerror = () => {
    connecting = false;
    try {
      ws && ws.close();
    } catch {}
    ws = null;
  };
}

function post(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function handleChat(msg) {
  const site = msg.site || pickSite();
  const chain = tabJobs.get(site) || Promise.resolve();
  const next = chain.then(
    () => runChat({ ...msg, site }),
    () => runChat({ ...msg, site }),
  );
  tabJobs.set(site, next.catch(() => {}));
}

function pickSite() {
  const hosts = Object.keys(C2F_SITES).filter((k) => k !== "generic");
  return hosts[0] || "generic";
}

/**
 * The bridge gives up on a chat that shows no sign of life, so the worker says "still here"
 * for as long as it is working on one. The tab says it too (c2f.ping-worker), which is what
 * keeps a restarted worker informed.
 */
async function runChat(job) {
  const beat = setInterval(() => post({ type: "chat.alive", id: job.id }), 10_000);
  try {
    return await runChatNow(job);
  } finally {
    clearInterval(beat);
  }
}

async function runChatNow(job) {
  const { id, site, prompt, freshChat, timeoutMs } = job;
  const adapter = C2F_SITES[site] || C2F_SITES.generic;
  const startUrl = job.meta?.startUrl;
  let tabId = liveTabs.get(site);
  try {
    tabId = await ensureTab(site, adapter, tabId, startUrl);
  } catch (err) {
    // ensureTab rejects with err.kind for needs_login / blocked / wrong_host; losing it
    // here made every one of those look like "could not open a tab".
    return post({ type: "chat.result", id, site, ok: false, error: err.kind || "no_tab", detail: String(err.message || err) });
  }
  let resp;
  try {
    // A tab hidden for ~5 minutes gets intensively throttled: chained timers fire about
    // once a minute, which slows the "streaming settled" check. focusTab:true brings the
    // tab forward to pay for that with visible focus. Default off: the content script
    // detects streaming through DOM mutations, which are not throttled.
    // Work happens in the background: nothing is raised, focused or restored on the user's
    // screen. Only an explicit request (--focus-tab / focusTab: true) brings the tab forward.
    if (adapter.keepRendering) await keepRendering(tabId);
    if (job.focusTab === true) await bringToFront(tabId);
    resp = await askTab(tabId, { id, site, prompt, freshChat, continuing: Boolean(job.continuing), quietMs: job.quietMs, settings: job.settings, strictSettings: Boolean(job.strictSettings), timeoutMs: Math.max(20_000, (timeoutMs || 1_800_000) - 15_000) });
  } catch (err) {
    return postChatResult(id, site, { error: err.kind || "page_error", detail: String(err.message || err) });
  }
  postChatResult(id, site, resp);
}

// A result can arrive twice (through the worker that asked, and from the tab itself); the
// bridge must see it once. Only remembered once it was really sent.
const delivered = new Set();
function postChatResult(id, site, resp) {
  if (delivered.has(id)) return true;
  const msg = resp.error
    ? { type: "chat.result", id, site, ok: false, error: resp.error, detail: resp.detail || resp.error }
    : { type: "chat.result", id, site, ok: true, reply: resp.reply, ms: resp.ms, url: resp.url, settings: resp.settings || null, timings: resp.timings || null };
  if (!post(msg)) return false;
  delivered.add(id);
  if (delivered.size > 200) delivered.delete(delivered.values().next().value);
  return true;
}

async function ensureTab(site, adapter, knownId, startUrl) {
  if (knownId) {
    let alive = false;
    try {
      alive = Boolean(await chrome.tabs.get(knownId));
    } catch {
      alive = false; // the tab was closed
    }
    if (alive) {
      // waitForReady's needs_login / blocked / not_ready must escape to the caller, so it
      // is deliberately outside the try above.
      await closeDuplicateTabs(adapter, knownId, site);
      await waitForReady(knownId, site, 45_000);
      return knownId;
    }
    liveTabs.delete(site);
  }
  // Prefer the tab the user touched most recently, then drop the older root tabs.
  const adopted = await adoptNewestTab(adapter, site);
  if (adopted != null) {
    await waitForReady(adopted, site, 45_000);
    return adopted;
  }
  const tab = await chrome.tabs.create({ url: startUrl || adapter.url, active: false });
  if (!tab.id) throw new Error("tab creation failed");
  liveTabs.set(site, tab.id);
  // The user asked to keep exactly one tab per site: close the older duplicates so the
  // extension always drives a single tab and their window does not fill with copies.
  await closeDuplicateTabs(adapter, tab.id, site);
  await waitForReady(tab.id, site, 45_000);
  return tab.id;
}

async function closeDuplicateTabs(adapter, keepId, site) {
  // `generic` covers 127.0.0.1/localhost: closing there would kill the user's dev servers
  // and the very pages under test.
  if (site === "generic" || adapter.custom) return [];
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const closed = [];
  for (const t of tabs) {
    if (t.id == null || t.id === keepId) continue;
    if (t.pinned || t.audible) continue;
    let url;
    try {
      url = new URL(t.url);
    } catch {
      continue;
    }
    if (!adapter.hosts.includes(url.hostname)) continue;
    // A specific conversation can be work the user has open; only close the site root.
    const isRoot = url.pathname === "/" || url.pathname === "" || /^\/(new|app)\/?$/.test(url.pathname);
    if (!isRoot) continue;
    try {
      await chrome.tabs.remove(t.id);
      closed.push(t.id);
    } catch {
      /* already closed by the user */
    }
  }
  return closed;
}

/** Keep the most recently used tab for a host and drop the older root tabs. */
async function adoptNewestTab(adapter, site) {
  if (site === "generic" || adapter.custom) return null;
  const tabs = (await chrome.tabs.query({}).catch(() => [])).filter((t) => {
    if (t.id == null || t.pinned) return false;
    try {
      const url = new URL(t.url);
      if (!adapter.hosts.includes(url.hostname)) return false;
      // Never adopt a specific conversation the user may be working in: freshChat would
      // navigate it away. Only root / new-chat pages are ours to drive.
      return url.pathname === "/" || url.pathname === "" || /^\/(new|app)\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  });
  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const newest = tabs[0];
  liveTabs.set(site, newest.id);
  await closeDuplicateTabs(adapter, newest.id, site);
  return newest.id;
}

function waitForReady(tabId, site, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let challengeSince = 0;
    let pingsTried = 0;
    let injected = false;
    let injectionAttempts = 0;
    const startedAt = Date.now();
    let lastInject = 0;
    // Ask again quickly at first (a tab is usually ready within a few hundred ms), then back off.
    let delay = 60;
    const tick = async () => {
      const now = Date.now();
      if (now > deadline) {
        // Distinguish "never got a working content script" from "no tab at all": the user
        // can fix the first by reloading the tab, and nothing by reloading the browser.
        const err = new Error(
          injected
            ? `the ${site} tab accepted the injected script but never reported ready`
            : `the ${site} tab never ran the content script; reload that tab once`,
        );
        err.kind = "not_ready";
        return reject(err);
      }
      try {
        const res = await sendToTab(tabId, { type: "c2f.ping", site });
        // A composer the site disabled itself is a hard usage limit: let the chat run so it can
        // report "limit" with the site's own wording, instead of waiting 45s for a composer
        // that will never come back.
        if (res && (res.ready || res.composerDisabled)) return resolve(res);
        if (res && (res.needsLogin || res.loggedOutUI)) {
          const err = new Error("sign in required");
          err.kind = "needs_login";
          return reject(err);
        }
        if (res && res.wrongHost) {
          const err = new Error(`landed on ${res.url}, which is not the ${site} adapter's host`);
          err.kind = "wrong_host";
          return reject(err);
        }
        if (res && res.challenge) {
          // Cloudflare's interstitial usually clears itself in a few seconds once the
          // challenge is solved; only give up if it is still there after 20s.
          if (!challengeSince) challengeSince = now;
          if (now - challengeSince > 20_000) {
            const err = new Error(`the site is showing a bot check ("${String(res.title).slice(0, 60)}")`);
            err.kind = "blocked";
            return reject(err);
          }
        } else {
          challengeSince = 0;
        }
      } catch {
        // Declarative content scripts are NOT injected into tabs that existed before the
        // extension was loaded/reloaded. After a few failed pings, inject them by hand.
        pingsTried++;
        // Injection is for tabs that predate the extension; give a loading page ~2.5 s first.
        if (pingsTried >= 3 && now - startedAt > 2500 && now - lastInject > 3000 && injectionAttempts < 3) {
          injectionAttempts++;
          lastInject = now;
          // Only stop retrying once an injection actually succeeded.
          if (await injectInto(tabId)) injected = true;
        }
      }
      setTimeout(tick, delay);
      delay = Math.min(700, Math.round(delay * 1.7));
    };
    tick();
  });
}

/** Push sites.js + content.js into an existing tab (needs the "scripting" permission). */
async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["sites.js", "custom-sites.js", "controls.js", "settings.js", "content.js"] });
  } catch (err) {
    // Not injectable (chrome:// page, still loading, or a host we lack permission for).
    return false;
  }
  return true;
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch((err) => {
    throw new Error(`tab ${tabId} unreachable: ${err.message}`);
  });
}

async function askTab(tabId, payload) {
  const res = await sendToTab(tabId, { type: "c2f.chat", ...payload });
  if (!res) throw new Error("empty response from content script");
  if (res.error) {
    const err = new Error(res.detail || res.error);
    err.kind = res.error;
    throw err;
  }
  return res;
}

async function runInspect(job) {
  const site = job.site || "chatgpt";
  const adapter = C2F_SITES[site] || C2F_SITES.generic;
  try {
    // Diagnostics must be able to look at a CONVERSATION (/c/<id>), which ensureTab would
    // never adopt. anyPath picks the most recently used tab on the host, whatever its path.
    let tabId = null;
    if (job.anyPath) {
      const tabs = (await chrome.tabs.query({})).filter((t) => {
        if (t.id == null) return false;
        try {
          return adapter.hosts.includes(new URL(t.url).hostname);
        } catch {
          return false;
        }
      });
      // Prefer a real conversation over the root page: the reply lives in /c/<id>.
      const isConversation = (t) => { try { return new URL(t.url).pathname.startsWith("/c/"); } catch { return false; } };
      tabs.sort((a, b) => Number(isConversation(b)) - Number(isConversation(a)) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
      tabId = tabs[0]?.id ?? null;
      if (tabId == null) throw new Error(`no open ${site} tab`);
      await injectInto(tabId);
      // The most recent tab can be an old conversation scrolled away from its composer; report
      // on a tab that can actually take a message when there is one.
      const first = await sendToTab(tabId, { type: "c2f.ping", site }).catch(() => null);
      if (!first?.ready) {
        for (const t of tabs.slice(1, 5)) {
          if (!(await injectInto(t.id))) continue;
          const p = await sendToTab(t.id, { type: "c2f.ping", site }).catch(() => null);
          if (p?.ready) {
            tabId = t.id;
            break;
          }
        }
      }
    } else {
      tabId = await ensureTab(site, adapter, liveTabs.get(site), job.meta?.startUrl);
    }
    const info = await sendToTab(tabId, { type: "c2f.inspect", site, probeText: job.probeText });
    post({ type: "inspect.result", id: job.id, site, ok: true, info });
  } catch (err) {
    post({ type: "inspect.result", id: job.id, site, ok: false, error: err.kind || "inspect_failed", detail: String(err.message || err) });
  }
}

/**
 * Let a tab that c2f drives keep rendering while it sits in the background. Gemini and DeepSeek
 * draw nothing while the page says it is hidden, and a background tab always says so; rather than
 * pulling the tab (or its window) onto the user's screen, only THIS tab is told it is visible.
 * Runs in the page's own JavaScript world; other tabs are untouched; safe to repeat.
 */
async function keepRendering(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (window.__c2fVisible) return;
        window.__c2fVisible = true;
        const fixed = (name, value) => {
          try {
            Object.defineProperty(Document.prototype, name, { get: () => value, configurable: true });
          } catch {}
        };
        fixed("hidden", false);
        fixed("visibilityState", "visible");
        fixed("webkitHidden", false);
        fixed("webkitVisibilityState", "visible");
        Document.prototype.hasFocus = () => true;
        // Pages also act on the change event itself: swallow it so they never see "hidden".
        const swallow = (e) => e.stopImmediatePropagation();
        for (const type of ["visibilitychange", "webkitvisibilitychange"]) {
          document.addEventListener(type, swallow, true);
          window.addEventListener(type, swallow, true);
        }
      },
    });
  } catch {
    /* not injectable (chrome:// page, still loading): nothing to keep rendering */
  }
}

/**
 * Make a tab really visible: restore a minimised window, focus it, activate the tab. A hidden
 * tab throttles timers and pauses CSS transitions, and Gemini / DeepSeek render nothing in it.
 */
async function bringToFront(tabId) {
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.windowId == null) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  // Only a MINIMISED window is changed; a maximised one stays maximised.
  if (win?.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true, drawAttention: false }).catch(() => {});
}

/**
 * Run a UI script (snapshot / click / escape) against a site tab. The tab is brought to the
 * front first: Gemini and DeepSeek render nothing in a hidden tab, so there would be no menu
 * to read. `target:"any"` uses the most recently used tab on the host instead of the root page.
 */
async function runUi(job) {
  const site = job.site || "chatgpt";
  const adapter = C2F_SITES[site] || C2F_SITES.generic;
  try {
    let tabId;
    if (job.target === "any") {
      const tabs = (await chrome.tabs.query({})).filter((t) => {
        try {
          return t.id != null && adapter.hosts.includes(new URL(t.url).hostname);
        } catch {
          return false;
        }
      });
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      tabId = tabs[0]?.id ?? null;
      if (tabId == null) throw new Error(`no open ${site} tab`);
      await injectInto(tabId);
    } else {
      tabId = await ensureTab(site, adapter, liveTabs.get(site), job.meta?.startUrl);
    }
    if (adapter.keepRendering) await keepRendering(tabId);
    const res = await sendToTab(tabId, { type: "c2f.ui", site, steps: job.steps });
    if (!res || res.error) throw new Error(res?.detail || res?.error || "empty response from content script");
    post({ type: "ui.result", id: job.id, site, ok: true, steps: res.steps, url: res.url });
  } catch (err) {
    post({ type: "ui.result", id: job.id, site, ok: false, error: err.kind || "ui_failed", detail: String(err.message || err) });
  }
}

/**
 * Quick, side-effect-free look at a site's tab before a request is sent to it: ready, signed out,
 * blocked, composer disabled, limit notice. Never opens, navigates or focuses anything; with no
 * tab open it says so and the caller carries on.
 */
/**
 * `c2f auth deepseek`: copy the login the user's own signed-in DeepSeek tab holds, so the CLI can talk
 * to DeepSeek directly (no tab). Reads page storage only; the answer goes to the local bridge.
 * The WASM address only shows up in resource timing right after the page loaded, so when it is
 * missing the tab is reloaded once and read again.
 */
async function runAuth(job) {
  const reply = (extra) => post({ type: "auth.result", id: job.id, site: "deepseek", ...extra });
  try {
    const tabs = (await chrome.tabs.query({})).filter((t) => {
      try {
        return new URL(t.url).hostname === "chat.deepseek.com";
      } catch {
        return false;
      }
    });
    if (!tabs.length) return reply({ ok: false, error: "no_tab", detail: "no open chat.deepseek.com tab: open it, signed in, and retry" });
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tabId = tabs[0].id;
    const collect = async () => (await chrome.scripting.executeScript({ target: { tabId }, func: globalThis.C2F_collectDeepSeekLogin }))[0]?.result;
    let auth = await collect();
    if (auth?.token && !auth.wasmUrl) {
      await chrome.tabs.reload(tabId);
      await new Promise((resolve) => {
        const done = (id, info) => {
          if (id === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(done);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }, 20_000);
      });
      await new Promise((r) => setTimeout(r, 1500));
      auth = await collect();
    }
    if (!auth?.token) return reply({ ok: false, error: "not_signed_in", detail: "the DeepSeek tab holds no login: sign in at chat.deepseek.com and retry" });
    reply({ ok: true, auth });
  } catch (err) {
    reply({ ok: false, error: "auth_failed", detail: String(err.message || err) });
  }
}

async function runProbe(job) {
  const site = job.site || "chatgpt";
  const adapter = C2F_SITES[site] || C2F_SITES.generic;
  try {
    let tabId = liveTabs.get(site);
    if (tabId != null && !(await chrome.tabs.get(tabId).catch(() => null))) tabId = null;
    if (tabId == null) {
      const tabs = (await chrome.tabs.query({})).filter((t) => {
        try {
          return t.id != null && adapter.hosts.includes(new URL(t.url).hostname);
        } catch {
          return false;
        }
      });
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      tabId = tabs[0]?.id ?? null;
    }
    if (tabId == null) return post({ type: "probe.result", id: job.id, site, ok: true, tab: false });
    const state = await sendToTab(tabId, { type: "c2f.ping", site }).catch(() => null);
    post({ type: "probe.result", id: job.id, site, ok: true, tab: true, state });
  } catch (err) {
    post({ type: "probe.result", id: job.id, site, ok: false, error: "probe_failed", detail: String(err.message || err) });
  }
}

/** Read ("read") or set ("apply") a site's model / reasoning / search from the CLI, sending nothing. */
async function runSettings(job) {
  const site = job.site || "chatgpt";
  const adapter = C2F_SITES[site] || C2F_SITES.generic;
  try {
    const tabId = await ensureTab(site, adapter, liveTabs.get(site), job.meta?.startUrl);
    if (adapter.keepRendering) await keepRendering(tabId);
    const res = await sendToTab(tabId, { type: "c2f.settings", site, op: job.op, settings: job.settings });
    if (!res || res.error) throw new Error(res?.detail || res?.error || "empty response from content script");
    post({ type: "settings.result", id: job.id, site, ok: true, result: res.result, url: res.url });
  } catch (err) {
    post({ type: "settings.result", id: job.id, site, ok: false, error: err.kind || "settings_failed", detail: String(err.message || err) });
  }
}

/** Reload the extension from the CLI, so a code change needs no manual click. */
function reloadExtension() {
  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch {
      /* shutting down anyway */
    }
  }, 200);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Answered by the content script: keeps this worker's idle timer from expiring while a
  // chat is pending, so the in-flight job is never dropped mid-reply.
  if (msg?.type === "c2f.start-recorder") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return sendResponse({ ok: false, error: "no active tab" });
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["custom-sites.js", "recorder.js"] });
        sendResponse({ ok: true, url: tab.url });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === "c2f.ping-worker") {
    if (msg.jobId) post({ type: "chat.alive", id: msg.jobId });
    sendResponse({ alive: true });
    return true;
  }
  if (msg?.type === "c2f.done") {
    ensureConnected();
    sendResponse({ ack: postChatResult(msg.id, msg.site, msg.result || { error: "page_error", detail: "empty result" }) });
    return true;
  }
  if (msg?.type === "c2f.status") {
    sendResponse({
      connected: Boolean(ws && ws.readyState === 1),
      upMs: startedAt ? Date.now() - startedAt : 0,
      tabs: Object.fromEntries(liveTabs),
      sites: Object.keys(C2F_SITES),
    });
    return true;
  }
  if (msg?.type === "c2f.reconnect") {
    try {
      ws && ws.close();
    } catch {}
    ws = null;
    ensureConnected();
    sendResponse({ ok: true });
    return true;
  }
});
