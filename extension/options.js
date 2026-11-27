const $ = (id) => document.getElementById(id);

async function init() {
  const { port = 8787, token = "" } = await chrome.storage.local.get({ port: 8787, token: "" });
  $("port").value = port;
  $("token").value = token;
  refresh();
  setInterval(refresh, 2000);
}

async function refresh() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: "c2f.status" });
  } catch {
    status = null;
  }
  const el = $("state");
  if (!status) {
    el.textContent = "Eklenti yanıt vermiyor";
    el.className = "bad";
    return;
  }
  el.textContent = status.connected ? "Bağlı ✓" : "Bağlı değil (gerekmedikçe sorun yok)";
  el.className = status.connected ? "ok" : "bad";
}

$("save").addEventListener("click", async () => {
  const port = Number($("port").value) || 8787;
  const token = $("token").value.trim();
  await chrome.storage.local.set({ port, token });
  await chrome.runtime.sendMessage({ type: "c2f.reconnect" });
  refresh();
});

$("retry").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "c2f.reconnect" });
  setTimeout(refresh, 400);
});

$("inspect").addEventListener("click", async () => {
  const out = $("tabs");
  out.textContent = "inspecting…";
  const tabs = await chrome.tabs.query({});
  const hosts = Object.values(globalThis.C2F_SITES || {})
    .flatMap((s) => s.hosts)
    .filter((h) => !["127.0.0.1", "localhost"].includes(h));
  const lines = [];
  for (const tab of tabs) {
    let host = "";
    try {
      host = new URL(tab.url).hostname;
    } catch {
      continue;
    }
    if (!hosts.includes(host)) continue;
    let info;
    try {
      info = await chrome.tabs.sendMessage(tab.id, { type: "c2f.inspect" });
    } catch (err) {
      info = { error: "no content script yet (reload the tab)" };
    }
    lines.push(`${tab.title || host}\n  ${tab.url}\n  ${JSON.stringify(info)}`);
  }
  out.textContent = lines.join("\n\n") || "No chat tabs open.";
});

init();

async function renderCustomSites() {
  const { customSites = [] } = await chrome.storage.local.get({ customSites: [] });
  const el = $("custom");
  if (!customSites.length) {
    el.textContent = "No custom sites yet.";
    return;
  }
  el.textContent = customSites.map((s) => `${s.label} (${s.hosts?.join(", ")})`).join("\n");
}

$("record").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "c2f.start-recorder" }).catch((e) => ({ ok: false, error: String(e) }));
  $("custom").textContent = res?.ok
    ? "Recording started in the active tab: click the text box, the send button, then one reply."
    : `Could not start: ${res?.error || "unknown"}. Open the chat page first.`;
});

renderCustomSites();
setInterval(renderCustomSites, 3000);
