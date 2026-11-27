/* Recorder UI: injected into any page the user wants to add.
 *
 * Flow: the user presses "Record" in the options page, this script highlights whatever the
 * cursor hovers inside the page, and three clicks capture composer -> send -> one reply.
 * Each element is described with C2F_describeElement and the finished site is stored in
 * chrome.storage.local, so nothing needs a code change per site.
 */
(() => {
  if (globalThis.__c2fRecorder) return;
  globalThis.__c2fRecorder = true;

  const STEPS = [
    { key: "composer", label: "the text box you type in" },
    { key: "send", label: "the button that sends the message" },
    { key: "assistant", label: "one of the model's replies" },
  ];
  let step = 0;
  let picked = {};
  let hovered = null;
  let bar = null;
  let outline = null;

  function buildBar() {
    bar = document.createElement("div");
    bar.setAttribute("data-c2f-recorder", "1");
    bar.style.cssText = [
      "position:fixed", "z-index:2147483647", "left:16px", "bottom:16px", "max-width:420px",
      "background:#111", "color:#fff", "font:13px/1.4 system-ui", "padding:12px 14px",
      "border-radius:10px", "box-shadow:0 8px 30px rgba(0,0,0,.45)", "pointer-events:auto",
    ].join(";");
    outline = document.createElement("div");
    outline.setAttribute("data-c2f-recorder", "1");
    outline.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4ade80;border-radius:6px;display:none";
    document.documentElement.append(outline, bar);
    bar.innerHTML = "";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:6px";
    title.textContent = "ChatToFree — add this site";
    const hint = document.createElement("div");
    hint.style.cssText = "color:#bbb;margin-bottom:10px";
    hint.textContent = `Click ${STEPS[step].label} (${step + 1}/${STEPS.length}). Esc cancels.`;
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "background:#333;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer";
    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      stop("cancelled");
    });
    bar.append(title, hint, cancel);
  }

  function describe(el) {
    try {
      return globalThis.C2F_describeElement ? globalThis.C2F_describeElement(el) : null;
    } catch {
      return null;
    }
  }

  function onMove(e) {
    const el = e.target;
    if (!el || el.closest?.("[data-c2f-recorder]")) return;
    hovered = el;
    const r = el.getBoundingClientRect();
    outline.style.display = "block";
    outline.style.left = `${r.left}px`;
    outline.style.top = `${r.top}px`;
    outline.style.width = `${r.width}px`;
    outline.style.height = `${r.height}px`;
  }

  function onClick(e) {
    if (!hovered || hovered.closest?.("[data-c2f-recorder]")) return;
    e.preventDefault();
    e.stopPropagation();
    const selector = describe(hovered);
    if (!selector) return;
    picked[STEPS[step].key] = selector;
    step++;
    if (step >= STEPS.length) {
      finish();
      return;
    }
    buildBar();
  }

  function finish() {
    try {
      const site = globalThis.C2F_buildSite({
        key: location.hostname.split(".")[0],
        label: document.title.split(/[-|—]/)[0].trim() || location.hostname,
        host: location.hostname,
        composer: picked.composer,
        send: picked.send,
        assistant: picked.assistant,
      });
      chrome.storage.local.get({ customSites: [] }).then(({ customSites }) => {
        const next = (customSites || []).filter((s) => s.key !== site.key).concat(site);
        return chrome.storage.local.set({ customSites: next }).then(() => site);
      }).then((site2) => {
        stop(null, site2);
      }).catch((err) => stop(String(err && err.message || err)));
    } catch (err) {
      stop(String(err && err.message || err));
    }
  }

  function stop(error, site) {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    hovered = null;
    if (bar) {
      bar.innerHTML = "";
      const msg = document.createElement("div");
      msg.style.cssText = "font-weight:600;color:" + (error ? "#f87171" : "#4ade80");
      msg.textContent = error ? `Recording failed: ${error}` : `Added ${site?.label || "site"} — you can close this page.`;
      bar.append(msg);
      setTimeout(() => {
        bar?.remove();
        outline?.remove();
        globalThis.__c2fRecorder = false;
      }, error ? 6000 : 4000);
    }
  }

  function onKey(e) {
    if (e.key === "Escape") stop("cancelled");
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  buildBar();
})();
