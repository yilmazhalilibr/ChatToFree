/**
 * A stand-in for the model / effort picker of a chat site, built from what was measured on the
 * live sites (CONTROLS-MEASURED.md) so the extension's settings driver is tested against the
 * same traps:
 *   - the trigger opens on `click` (Claude today) or ONLY on `pointerdown` (Radix);
 *   - radio rows live in a [role=group] while submenu openers sit outside it;
 *   - locked rows are plain menuitems with an upgrade label;
 *   - submenus open on pointerdown only, and the popup fades in;
 *   - Escape closes everything, choosing a row closes the whole popup.
 */
const TEXT = {
  tr: { model: "Model", effort: "Çaba", more: "Daha fazla model", upgrade: "Yükselt", levels: ["Düşük", "Orta", "Yüksek", "Ekstra yüksek"], think: "Düşünme", notnow: "Şimdi değil" },
  en: { model: "Model", effort: "Effort", more: "More models", upgrade: "Upgrade", levels: ["Low", "Medium", "High", "Extra high"], think: "Thinking", notnow: "Not now" },
};

export function pickerPage({ mode = "click", lang = "tr", stale = false } = {}) {
  const t = TEXT[lang];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Picker</title>
<style>
  body{font:14px sans-serif;padding:40px}
  .popup{position:fixed;left:200px;top:120px;background:#fff;border:1px solid #888;padding:6px;opacity:0;transition:opacity .25s}
  .popup.in{opacity:1}
  .popup.sub{left:420px}
  [role=menuitem],[role=menuitemradio]{display:block;padding:6px 10px;cursor:pointer;min-width:160px}
</style></head><body>
<main>
  <textarea id="prompt-textarea"></textarea>
  <button id="trigger" data-testid="model-selector-dropdown" aria-haspopup="menu" aria-expanded="false"></button>
  <button id="think" aria-pressed="false">${t.think}</button>
</main>
<script>
  const T = ${JSON.stringify(t)};
  const MODE = ${JSON.stringify(mode)};
  const STALE = ${JSON.stringify(stale)};
  const state = { model: "Sonnet 5.5", effort: 1, opened: 0, upgradeClicks: 0 };
  window.__state = state;
  const trigger = document.getElementById("trigger");
  const think = document.getElementById("think");
  const paint = () => { trigger.textContent = T.model + ": " + state.model + " " + T.levels[state.effort]; };
  paint();

  function closeAll() {
    // STALE: a submenu portal that outlives its parent (seen on Claude after an interrupted run).
    // A Radix popup in a hidden tab never finishes its exit animation: it stays in the DOM,
    // marked closed. Main menus are removed; submenus linger when STALE.
    document.querySelectorAll(".popup").forEach((p) => { if (STALE && p.classList.contains("sub")) p.style.pointerEvents = "none"; else p.remove(); });
    trigger.setAttribute("aria-expanded", "false");
  }
  function popup(cls) {
    const p = document.createElement("div");
    p.className = "popup " + (cls || "");
    p.setAttribute("role", "menu");
    document.body.append(p);
    requestAnimationFrame(() => requestAnimationFrame(() => p.classList.add("in")));
    return p;
  }
  function radio(parent, label, checked, onPick) {
    const el = document.createElement("div");
    el.setAttribute("role", "menuitemradio");
    el.setAttribute("aria-checked", String(checked));
    el.innerHTML = "<span>" + label + "</span><small> description of " + label + "</small>";
    el.addEventListener("click", () => { onPick(); closeAll(); paint(); });
    parent.append(el);
  }
  function opener(parent, label, build) {
    const el = document.createElement("div");
    el.setAttribute("role", "menuitem");
    el.setAttribute("aria-haspopup", "menu");
    el.setAttribute("aria-expanded", "false");
    el.textContent = label;
    // Submenus open on pointerdown only, like Radix.
    el.addEventListener("pointerdown", () => {
      document.querySelectorAll(".popup.sub").forEach((p) => p.remove());
      el.setAttribute("aria-expanded", "true");
      build(popup("sub"));
    });
    parent.append(el);
  }
  function upsell() {
    const d = document.createElement("div");
    d.setAttribute("role", "dialog");
    d.id = "upsell";
    d.style.cssText = "position:fixed;left:300px;top:300px;background:#fff;border:2px solid #333;padding:12px";
    d.innerHTML = "<p>Try Pro</p><button id='up'>" + T.upgrade + "</button><button id='notnow'>" + T.notnow + "</button>";
    d.querySelector("#up").addEventListener("click", () => { state.upgradeClicks++; d.remove(); });
    d.querySelector("#notnow").addEventListener("click", () => d.remove());
    document.body.append(d);
  }
  function openMain() {
    closeAll();
    // Reopening the main menu while a stale submenu is around: the stale one stays too.
    state.opened++;
    trigger.setAttribute("aria-expanded", "true");
    const p = popup();
    // The leftover submenu sits AFTER the new main menu in the document (portals append and the
    // old one is reused), so "the newest group" is the stale submenu: the measured Claude failure.
    if (STALE) queueMicrotask(() => document.querySelectorAll(".popup.sub").forEach((sub) => document.body.append(sub)));
    const locked = document.createElement("div");
    locked.setAttribute("role", "menuitem");
    locked.innerHTML = "<span>Opus 5.5</span><small> Pro </small><b>" + T.upgrade + "</b>";
    p.append(locked);
    // Radio rows sit in a group; the openers below are OUTSIDE it.
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    for (const m of ["Sonnet 5.5", "Haiku 5.5"]) radio(group, m, state.model === m, () => { state.model = m; });
    // A paid mode that LOOKS selectable (measured on Gemini): choosing it only opens an upsell.
    radio(group, "Pro Mode", false, () => upsell());
    p.append(group);
    opener(p, T.effort + " " + T.levels[state.effort], (sub) => {
      T.levels.forEach((l, i) => radio(sub, l, state.effort === i, () => { state.effort = i; }));
    });
    opener(p, T.more, (sub) => {
      for (const m of ["Sonnet 4.6", "Sonnet 5"]) radio(sub, m, state.model === m, () => { state.model = m; });
      const old = document.createElement("div");
      old.setAttribute("role", "menuitem");
      old.innerHTML = "<span>Opus 3</span><b>" + T.upgrade + "</b>";
      sub.append(old);
    });
  }
  const toggle = () => (document.querySelector(".popup:not(.sub)") ? closeAll() : openMain());
  if (MODE === "pointerdown") trigger.addEventListener("pointerdown", (e) => { if (e.button === 0) toggle(); });
  else trigger.addEventListener("click", toggle);
  think.addEventListener("click", () => think.setAttribute("aria-pressed", String(think.getAttribute("aria-pressed") !== "true")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
</script></body></html>`;
}
