/* ChatToFree UI controls: read and operate the model / reasoning pickers of a chat site.
 *
 * Works from the accessibility surface of the page (role, accessible name, expanded / checked
 * state) instead of CSS classes, which change weekly. Same idea as the snapshot tool of
 * chrome-devtools-mcp, without a debugger attached: Cloudflare scores CDP artefacts, a
 * content script has none.
 *
 * Loaded before content.js; exposes globalThis.C2F_UI.
 */
(() => {
  // No "already loaded" guard: after an extension reload the old copy would otherwise stay
  // in open tabs and the new one never run. Loading again just overwrites the global.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * A short pause to let a page finish reacting. In a hidden tab every timer crawls (chained
   * ones fire about once a minute), so a pause there would stall the whole flow; the checks
   * that follow look at real state anyway, so skip the pause instead.
   */
  const settle = (ms) => (document.visibilityState === "visible" ? sleep(ms) : Promise.resolve());

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.01;
  }

  /** Like visible(), but a popup mid fade-in (or frozen at opacity 0 in a hidden tab) still counts. */
  function shown(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  const INTERACTIVE = [
    "button",
    "a[href]",
    "summary",
    "[role=button]",
    "[role=menuitem]",
    "[role=menuitemradio]",
    "[role=menuitemcheckbox]",
    "[role=option]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=combobox]",
    "[aria-haspopup]",
    "[data-radix-collection-item]",
    "mat-option",
    "[mat-menu-item]",
    ".mat-mdc-menu-item",
    ".mat-mdc-option",
    "[class*='menu-item' i]",
    "[class*='option' i][tabindex]",
    "[tabindex='0']",
  ].join(",");

  // Popups render in a portal at the end of <body>, so the newest one wins.
  const LAYERS = [
    "[role=menu]",
    "[role=listbox]",
    "[role=dialog]",
    "[data-radix-popper-content-wrapper]",
    "[data-radix-menu-content]",
    ".cdk-overlay-pane",
    "mat-bottom-sheet-container",
    ".mat-mdc-menu-panel",
    "[class*='popover' i]",
    "[class*='dropdown' i]",
  ].join(",");

  function accName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim();
      if (t) return t;
    }
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return text || el.getAttribute("title") || el.getAttribute("placeholder") || "";
  }

  function roleOf(el) {
    return el.getAttribute("role") || ({ BUTTON: "button", A: "link", SUMMARY: "button", INPUT: el.type || "textbox", TEXTAREA: "textbox" })[el.tagName] || el.tagName.toLowerCase();
  }

  function stateOf(el) {
    const bool = (n) => {
      const v = el.getAttribute(n);
      return v === null ? undefined : v === "true";
    };
    const out = {
      expanded: bool("aria-expanded"),
      checked: el.getAttribute("aria-checked") === "mixed" ? "mixed" : bool("aria-checked"),
      selected: bool("aria-selected"),
      pressed: bool("aria-pressed"),
      current: el.getAttribute("aria-current") || undefined,
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true" || undefined,
      popup: el.getAttribute("aria-haspopup") || undefined,
      data: el.getAttribute("data-state") || undefined,
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  function describe(el, index) {
    const r = el.getBoundingClientRect();
    return {
      i: index,
      role: roleOf(el),
      name: accName(el).slice(0, 120),
      title: title(el),
      testid: el.getAttribute("data-testid") || undefined,
      id: el.id || undefined,
      ...stateOf(el),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  const ROWS = "[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option]";

  /**
   * The newest open popup's rows. Portals differ per framework (Radix wrapper, Angular cdk
   * overlay, plain role=menu), so instead of knowing every wrapper this goes by what every
   * menu has in common: rows with a menu/option role. Rows are grouped by their menu, and the
   * group that comes last in the document is the most recently opened one, so a submenu wins
   * over its parent.
   */
  function layerRows() {
    const groups = layerGroups();
    return groups.length ? groups[groups.length - 1] : null;
  }

  /** Every open popup's rows, grouped by menu, in document order (a submenu comes after its parent). */
  function layerGroups() {
    // A popup that has been CLOSED stays mounted while its exit animation runs, and in a hidden
    // tab (locked screen) that animation never ends, so it lingers. Radix marks it
    // data-state="closed"; Claude's own menu just turns pointer-events off (measured). Neither
    // is an open menu.
    const closed = (el) => {
      if (el.closest("[data-state='closed']")) return true;
      const root = el.closest("[role=menu],[role=listbox]");
      return Boolean(root && getComputedStyle(root).pointerEvents === "none");
    };
    const rows = [...document.querySelectorAll(ROWS)].filter((el) => shown(el) && !closed(el));
    if (!rows.length) return [];
    const groups = new Map();
    for (const row of rows) {
      // The real popup first: a Radix menu splits its radio rows into a [role=group] while the
      // submenu openers sit outside it, and grouping by that would drop half the menu.
      const key = row.closest("[role=menu],[role=listbox]") || row.closest("mat-action-list,.mat-mdc-menu-panel,.cdk-overlay-pane,[role=group]") || row.parentElement;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const entries = [...groups.entries()];
    entries.sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    // A submenu opens to the right of its parent; with equal order prefer the right-most.
    return entries.map(([root, list]) => ({ root, rows: list }));
  }

  /** Topmost open popup root, or null. */
  function topLayer() {
    const found = layerRows();
    if (found) return found.root;
    const layers = [...document.querySelectorAll(LAYERS)].filter(visible);
    const holding = layers.filter((l) => l.querySelector(INTERACTIVE));
    const pool = holding.length ? holding : layers;
    return pool.length ? pool[pool.length - 1] : null;
  }

  // Sidebars hold hundreds of chat-history buttons; model pickers live in the header or the
  // composer, so "main" skips navigation regions.
  const NAV = "nav, aside, [role=navigation], bard-sidenav, mat-sidenav";

  function scopeRoot(scope) {
    if (scope === "layer") return topLayer();
    if (scope && typeof scope === "object" && scope.selector) return document.querySelector(scope.selector);
    return document.body;
  }

  /** Interactive, visible elements under a scope, in document order. */
  function collect(scope, { limit = 160 } = {}) {
    if (scope === "layer") {
      const found = layerRows();
      if (found) return { root: found.root, items: found.rows.slice(0, limit) };
    }
    const root = scopeRoot(scope);
    if (!root) return { root: null, items: [] };
    const seen = new Set();
    const items = [];
    const skipNav = scope === "main";
    for (const el of root.querySelectorAll(INTERACTIVE)) {
      if (seen.has(el) || !visible(el)) continue;
      if (skipNav && el.closest(NAV)) continue;
      // A menu row is a <button> wrapping a <div>: report the outer control once.
      const outer = el.parentElement?.closest(INTERACTIVE);
      if (outer && root.contains(outer) && seen.has(outer)) continue;
      seen.add(el);
      items.push(el);
      if (items.length >= limit) break;
    }
    return { root, items };
  }

  function snapshot(scope = "page", opts = {}) {
    const { root, items } = collect(scope, opts);
    return {
      scope: typeof scope === "string" ? scope : "custom",
      found: Boolean(root),
      items: items.map(describe),
    };
  }

  /** Match a control by role/name/testid/selector. `name` is a regex source, case-insensitive. */
  function find(spec, scope = "page") {
    const { items } = collect(scope, { limit: 400 });
    let rx = null;
    if (spec.name) rx = new RegExp(spec.name, "iu");
    let list = items.filter((el) => {
      if (spec.testid && el.getAttribute("data-testid") !== spec.testid) return false;
      if (spec.selector && !el.matches(spec.selector)) return false;
      if (spec.role && roleOf(el) !== spec.role) return false;
      if (rx && !rx.test(accName(el)) && !rx.test(el.getAttribute("data-testid") || "")) return false;
      return true;
    });
    if (spec.selector && !list.length) {
      const el = document.querySelector(spec.selector);
      if (el && visible(el)) list = [el];
    }
    return list[spec.nth || 0] || null;
  }

  /**
   * Radix / Headless menus open on pointerdown, not on click, so a bare .click() does nothing.
   * Native buttons (Gemini's send) fire twice if given the full sequence, so this is opt-in.
   */
  function press(el, how = "click") {
    el.scrollIntoView?.({ block: "nearest" });
    if (how === "pointerdown") {
      // Radix opens on pointerdown and would toggle shut again on the click that follows.
      const r = el.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, pointerType: "mouse", isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    } else if (how === "pointer") {
      const r = el.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, pointerType: "mouse", isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
    } else {
      el.click();
    }
  }

  /**
   * Operate a control the way it actually responds. Sites differ (and change): some menus
   * open on click, some on pointerdown only, and a full pointer sequence can open then
   * immediately re-close one. So try the gentlest input first and keep going only while the
   * page has not reacted, checking real state after each attempt.
   * Returns the mode that worked, or null.
   */
  async function pressUntil(el, reacted, { modes = ["click", "pointerdown", "pointer"], waitMs = 1200 } = {}) {
    for (const mode of modes) {
      press(el, mode);
      if (await waitFor(reacted, waitMs)) return mode;
    }
    return null;
  }

  /** Close any open popup the way a user does: Escape, until nothing is expanded. */
  async function dismiss() {
    const open = () => Boolean(topLayer() || document.querySelector("[aria-expanded='true']:not([aria-haspopup='false']):not(nav *)") || document.querySelector("[data-state='open']"));
    // Nothing open: do not even start waiting (every wait is a timer, which a hidden tab crawls).
    if (!open()) return true;
    for (let i = 0; i < 3; i++) {
      for (const target of [document.activeElement, document.body, document]) {
        if (!target) continue;
        for (const type of ["keydown", "keyup"]) {
          target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        }
      }
      await settle(300);
      if (!open()) return true;
    }
    return !open();
  }

  /**
   * Run a short script of UI steps and return what the page looked like after each one.
   * Used both for measuring a site's controls and by the product to apply settings.
   *   {op:"snapshot", scope}        {op:"click", ...spec, how, scope}   {op:"wait", ms}
   *   {op:"escape"}                 {op:"text", scope}
   */
  async function run(steps) {
    const out = [];
    for (const step of steps || []) {
      const rec = { op: step.op };
      try {
        if (step.op === "snapshot") {
          Object.assign(rec, snapshot(step.scope || "page", step));
        } else if (step.op === "click") {
          const el = find(step, step.scope || "page");
          if (!el) {
            rec.error = "not_found";
            rec.spec = { name: step.name, testid: step.testid, selector: step.selector, scope: step.scope };
          } else {
            rec.clicked = describe(el, 0);
            press(el, step.how || "click");
          }
        } else if (step.op === "wait") {
          await sleep(Math.min(Number(step.ms) || 300, 5000));
        } else if (step.op === "tree") {
          // Structure of whatever matches a selector: tag, size, whether it is visually hidden
          // (the 1px clipped "sr-only" boxes sites use for screen readers) and its own text.
          const walk = (el, depth) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ").replace(/\s+/g, " ").trim();
            const node = {
              tag: el.tagName.toLowerCase(),
              cls: typeof el.className === "string" ? el.className.slice(0, 50) : undefined,
              w: Math.round(r.width),
              h: Math.round(r.height),
              clipped: st.position === "absolute" && (r.width <= 2 || r.height <= 2) ? true : undefined,
              role: el.getAttribute("role") || undefined,
              state: el.getAttribute("data-state") || undefined,
              ariaHidden: el.getAttribute("aria-hidden") || undefined,
              inert: el.hasAttribute("inert") || undefined,
              vis: st.visibility !== "visible" ? st.visibility : undefined,
              op: Number(st.opacity) < 1 ? st.opacity : undefined,
              pe: st.pointerEvents === "none" ? "none" : undefined,
              own: own ? own.slice(0, 70) : undefined,
            };
            if (depth > 0) node.kids = [...el.children].slice(0, 12).map((c) => walk(c, depth - 1));
            return node;
          };
          rec.nodes = [...document.querySelectorAll(step.selector || "main")].slice(-(step.limit || 2)).map((el) => walk(el, step.depth ?? 3));
        } else if (step.op === "state") {
          // Is this tab really being rendered? A hidden / occluded tab (minimised window,
          // locked screen) throttles timers and pauses CSS transitions, which stalls menus.
          const t0 = performance.now();
          await sleep(200);
          rec.visibility = document.visibilityState;
          rec.focused = document.hasFocus();
          rec.sleep200Took = Math.round(performance.now() - t0);
          rec.raf = await new Promise((r) => {
            const t = performance.now();
            let done = false;
            requestAnimationFrame(() => { done = true; r(Math.round(performance.now() - t)); });
            setTimeout(() => !done && r("blocked"), 1500);
          });
        } else if (step.op === "reload") {
          // The reply is sent first; the page goes away right after.
          setTimeout(() => location.reload(), 150);
        } else if (step.op === "escape") {
          rec.closed = await dismiss();
        } else if (step.op === "text") {
          const root = scopeRoot(step.scope || "page");
          rec.text = root ? (root.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500) : null;
        } else {
          rec.error = `unknown op ${step.op}`;
        }
      } catch (err) {
        rec.error = String(err?.message || err);
      }
      out.push(rec);
      if (step.settle !== false && step.op === "click") await sleep(step.ms ?? 800);
    }
    return out;
  }

  /**
   * What a row is called: its first piece of real text. "Sonnet 5.5" out of
   * <div>Sonnet 5.5</div><div>Daha basit görevler için…</div>, and also out of inline markup
   * where innerText runs the name and its description together. Icon glyphs (private-use
   * characters) and empty nodes are skipped.
   */
  function title(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
      // Screen-reader-only spans ("(opens in a new tab)") are 1px boxes: not the row's name.
      if (n.parentElement && n.parentElement !== el && !shown(n.parentElement)) continue;
      return text.slice(0, 120);
    }
    return (el.getAttribute("aria-label") || accName(el)).slice(0, 120);
  }

  /**
   * Resolve with fn()'s truthy value as soon as it appears. Checked straight away, on every
   * DOM mutation (observers are not throttled in hidden tabs, timers are) and on a timer as a
   * backstop; gives up with null after timeoutMs.
   */
  function waitFor(fn, timeoutMs = 2500, stepMs = 100) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let tick = null;
      let deadline = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearInterval(tick);
        clearTimeout(deadline);
        resolve(v || null);
      };
      const check = () => {
        if (done) return;
        let v = null;
        try {
          v = fn();
        } catch {
          v = null;
        }
        if (v) finish(v);
      };
      const first = (() => {
        try {
          return fn();
        } catch {
          return null;
        }
      })();
      if (first) return finish(first);
      observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      tick = setInterval(check, stepMs);
      deadline = setTimeout(() => {
        let v = null;
        try {
          v = fn();
        } catch {}
        finish(v);
      }, timeoutMs);
    });
  }

  globalThis.C2F_UI = { sleep, settle, waitFor, visible, accName, title, roleOf, stateOf, describe, topLayer, layerRows, layerGroups, collect, snapshot, find, press, pressUntil, dismiss, run };
})();
