/* ChatToFree site settings: read and set the model, reasoning level and search toggle of a
 * chat site through its own UI (the same clicks a person makes).
 *
 * Measured per site (CONTROLS-MEASURED.md): Claude and Gemini put the model and the effort /
 * thinking level in one popup (the effort is a submenu); ChatGPT and DeepSeek expose reasoning
 * as an on/off pill. Nothing here guesses: a control that cannot be found is reported as
 * unsupported and left alone.
 *
 * Loaded after controls.js; exposes globalThis.C2F_SETTINGS = { read, apply }.
 */
(() => {
  // No "already loaded" guard: after an extension reload the old copy would otherwise stay
  // in open tabs and the new one never run. Loading again just overwrites the global.
  const UI = globalThis.C2F_UI;
  const { sleep, settle, waitFor } = UI;

  /** Accent-, case- and dotless-i-insensitive form, so "Düşük" matches "dusuk" and "İ" folds. */
  const fold = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/ı/g, "i")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  // Canonical reasoning levels, with the names the sites use. Longer aliases first.
  const LEVELS = [
    ["xhigh", ["ekstra yuksek", "extra high", "extra-high", "xhigh", "x-high", "very high", "cok yuksek"]],
    ["max", ["maksimum", "maximum", "max"]],
    ["high", ["yuksek", "high", "extended", "genisletilmis"]],
    ["medium", ["orta", "medium", "standard", "standart", "balanced", "dengeli"]],
    ["low", ["dusuk", "low", "light", "hafif", "minimal"]],
  ];
  const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

  function levelOf(text) {
    const t = fold(text);
    for (const [level, aliases] of LEVELS) {
      for (const a of aliases) {
        if (t === a || t.startsWith(a + " ")) return level;
      }
    }
    return null;
  }

  // A short log of what the driver did, returned with failures so a stuck menu can be read
  // off the page instead of guessed at.
  let traceLog = [];
  const trace = (msg) => {
    traceLog.push(`${String(Date.now() % 100000).padStart(5, "0")} ${msg}`);
    if (traceLog.length > 80) traceLog.shift();
  };

  // Verified settings, per request shape, so a build does not reopen every menu on each turn.
  const memo = new Map();
  const MEMO_MS = 10 * 60_000;

  const ON = new Set(["on", "true", "yes", "low", "medium", "high", "xhigh", "max"]);

  // --- generic helpers -------------------------------------------------------------------

  const infoOf = (el) => ({
    el,
    title: UI.title(el),
    role: UI.roleOf(el),
    state: UI.stateOf(el),
    link: el.tagName === "A" || Boolean(el.closest("a[href]") || el.querySelector("a[href]")),
  });

  function matchText(rowTitle, wanted) {
    const w = String(wanted || "").trim();
    if (!w) return 0;
    const lit = /^\/(.+)\/([a-z]*)$/.exec(w);
    if (lit) return new RegExp(lit[1], lit[2] || "iu").test(rowTitle) ? 1 : 0;
    const t = fold(rowTitle);
    const f = fold(w);
    if (t === f) return 3;
    if (t.startsWith(f)) return 2;
    if (t.includes(f)) return 1;
    return 0;
  }

  /** Visible control in a scope whose folded name matches one of the folded patterns. */
  function findControl(patterns, { scope = "main", role = null, needState = null } = {}) {
    const { items } = UI.collect(scope, { limit: 400 });
    for (const el of items) {
      if (role && UI.roleOf(el) !== role) continue;
      const st = UI.stateOf(el);
      if (needState && st[needState] === undefined) continue;
      const names = [fold(UI.accName(el)), fold(UI.title(el)), fold(el.getAttribute("data-testid"))];
      if (patterns.some((p) => names.some((n) => (p instanceof RegExp ? p.test(n) : n === p || n.startsWith(p + " "))))) return el;
    }
    return null;
  }

  /**
   * The MAIN menu's rows. The newest group is not always it: a submenu left open by an earlier
   * attempt hid the effort row (measured on Claude). The main menu is the one that holds the
   * submenu openers; a menu without any (Gemini-style flat list, ChatGPT) is just the newest.
   */
  function currentRows() {
    const groups = UI.layerGroups().map((g) => g.rows.map(infoOf));
    if (!groups.length) return [];
    const main = groups.find((rows) => rows.some((r) => isOpener(r) && (EFFORT_OPENER.test(fold(r.title)) || MORE_MODELS.test(fold(r.title)))));
    return main || groups[groups.length - 1];
  }

  /** Press a trigger until its popup rows appear. */
  async function openMenu(trigger) {
    if (!trigger) return null;
    trace(`openMenu ${UI.accName(trigger).slice(0, 30)}`);
    // Opened means the trigger says so (when it exposes aria-expanded) AND a menu is there:
    // stale rows from a previous popup must not count as the answer to this press.
    const opened = () => (!trigger.hasAttribute("aria-expanded") || trigger.getAttribute("aria-expanded") === "true") && UI.layerGroups().length > 0;
    const mode = await UI.pressUntil(trigger, opened);
    trace(`openMenu -> ${mode}`);
    if (!mode) return null;
    await settle(200);
    return currentRows();
  }

  /** Press a submenu opener until a different row group appears. */
  async function openSubmenu(opener, parentRows) {
    const before = new Set(parentRows.map((r) => r.el));
    const fresh = () => {
      const layer = UI.layerRows();
      return layer && layer.rows.some((el) => !before.has(el)) ? layer : null;
    };
    trace(`openSubmenu ${opener.title}`);
    const mode = await UI.pressUntil(opener.el, fresh, { modes: ["pointerdown", "click", "pointer"] });
    trace(`openSubmenu -> ${mode}`);
    if (!mode) return null;
    await settle(200);
    return fresh()?.rows.map(infoOf) || null;
  }

  const isOpener = (r) => r.role === "menuitem" && (r.state.popup || r.state.expanded !== undefined);
  const isChoice = (r) => ["menuitemradio", "option", "menuitemcheckbox"].includes(r.role) && !r.state.disabled;
  // A plain menuitem that is neither a choice nor a submenu is a locked upgrade row.
  // (A footer "Learn more (opens in a new tab)" link is a menuitem too; it is not a model.)
  const isLocked = (r) => !isChoice(r) && !isOpener(r) && !r.link && !r.state.disabled;

  const MORE_MODELS = /^(daha fazla model|more models|other models|diger modeller|weitere modelle)/;
  const EFFORT_OPENER = /^(caba|effort|dusunme duzeyi|thinking level|reasoning|dusunme seviyesi|akil yurutme)/;

  async function selectRow(row) {
    trace(`selectRow ${row.title}`);
    // A choice is done when the popup closes (Radix) or the row reads as checked (Angular).
    const done = () => !UI.layerRows() || (row.el.isConnected && UI.stateOf(row.el).checked === true);
    await UI.pressUntil(row.el, done, { modes: ["click", "pointerdown", "pointer"] });
    // Make sure nothing stays open under the user.
    if (UI.layerRows()) await UI.dismiss();
  }

  const UPSELL = /(yukselt|upgrade|subscribe|abone ol|satin al|buy|get (plus|pro|premium)|try (plus|pro))/;
  const NOT_NOW = /^(simdi degil|not now|no thanks|no, thanks|hayir|kapat|close|cancel|iptal|later|sonra|maybe later|dismiss|vazgec|skip|atla)/;

  /**
   * Picking a model the plan does not include opens an upgrade prompt and leaves the old
   * choice in place (measured on Gemini: "Kod ve analiz" -> Yükselt / Şimdi değil). Close it
   * the way a person would, and never press anything that looks like an upgrade.
   */
  async function closeUpsell() {
    let closed = false;
    for (let i = 0; i < 3; i++) {
      const { items } = UI.collect("page", { limit: 400 });
      const buttons = items.filter((el) => UI.roleOf(el) === "button" || el.tagName === "BUTTON");
      const upsell = buttons.find((el) => UPSELL.test(fold(UI.accName(el))) && !el.closest("nav, aside"));
      const notNow = upsell && buttons.find((el) => NOT_NOW.test(fold(UI.accName(el))));
      if (!upsell || !notNow) {
        // A bare modal with no upgrade button is not ours to touch.
        return closed;
      }
      // The two buttons must belong to the same prompt, not be unrelated page chrome.
      const box = (el) => el.closest("[role=dialog],[role=alertdialog],mat-dialog-container,.cdk-overlay-pane") || el.parentElement?.parentElement;
      if (box(upsell) !== box(notNow)) return closed;
      UI.press(notNow, "click");
      closed = true;
      await settle(500);
    }
    return closed;
  }

  function pickBest(rows, wanted) {
    let best = null;
    let bestScore = 0;
    for (const r of rows) {
      const sc = matchText(r.title, wanted);
      if (sc > bestScore) {
        best = r;
        bestScore = sc;
      }
    }
    return best;
  }

  // --- popup driver: Claude and Gemini ---------------------------------------------------

  /**
   * One popup holds the model choices; the effort / thinking level is a submenu of it.
   * `trigger()` returns the button that opens it.
   */
  function popupDriver({ trigger, hasModels = true }) {
    async function read() {
      const out = { model: { supported: false, current: null, options: [] }, reasoning: { supported: false, kind: "levels", current: null, options: [] } };
      const t = trigger();
      out.note = t ? undefined : "picker button not found on this page";
      if (!t) return out;
      try {
        const rows = await openMenu(t);
        if (!rows || !rows.length) {
          out.note = `picker button found (${UI.accName(t).slice(0, 40)}) but no menu rows appeared after pressing it`;
          return out;
        }
        const choices = rows.filter(isChoice);
        const locked = rows.filter(isLocked);
        const more = rows.find((r) => isOpener(r) && MORE_MODELS.test(fold(r.title)));
        const effort = rows.find((r) => isOpener(r) && EFFORT_OPENER.test(fold(r.title)));
        if (hasModels) {
          out.model.supported = choices.length > 0 || locked.length > 0;
          for (const r of choices) out.model.options.push({ title: r.title, selected: r.state.checked === true, locked: false });
          for (const r of locked) out.model.options.push({ title: r.title, selected: false, locked: true });
          out.model.current = choices.find((r) => r.state.checked === true)?.title || null;
          if (more) {
            const sub = await openSubmenu(more, rows);
            for (const r of sub || []) {
              if (isChoice(r)) out.model.options.push({ title: r.title, selected: r.state.checked === true, locked: false, more: true });
              else if (isLocked(r)) out.model.options.push({ title: r.title, selected: false, locked: true, more: true });
            }
            const picked = (sub || []).find((r) => isChoice(r) && r.state.checked === true);
            if (picked && !out.model.current) out.model.current = picked.title;
            // Reopen from scratch: submenus close the parent state we hold.
            await UI.dismiss();
            const again = await openMenu(trigger());
            const eff2 = (again || []).find((r) => isOpener(r) && EFFORT_OPENER.test(fold(r.title)));
            if (eff2) return await readEffort(out, eff2, again);
            return out;
          }
        }
        if (effort) return await readEffort(out, effort, rows);
        return out;
      } finally {
        await UI.dismiss();
      }
    }

    async function readEffort(out, opener, parentRows) {
      const sub = await openSubmenu(opener, parentRows);
      const levels = (sub || []).filter(isChoice);
      out.reasoning.supported = levels.length > 0;
      for (const r of levels) {
        const level = levelOf(r.title);
        out.reasoning.options.push({ title: r.title, level, selected: r.state.checked === true });
        if (r.state.checked === true) out.reasoning.current = level || r.title;
      }
      return out;
    }

    async function apply({ model, reasoning }) {
      const res = { applied: {}, warnings: [] };
      const wantModel = model && model !== "default";
      const wantLevel = reasoning && reasoning !== "default";
      // A site with levels has no plain "on"; the middle level is the neutral reading of it.
      if (reasoning === "on") reasoning = "medium";
      // What we pressed, to be checked against what the site shows afterwards.
      const intent = {};
      let pressed = false;

      if (wantModel) {
        try {
          const rows = await openMenu(trigger());
          if (!rows) {
            res.warnings.push("model: picker did not open");
          } else {
            let pool = rows;
            const offered = [...rows.filter(isChoice)];
            let pick = pickBest(rows.filter(isChoice), model);
            let lockedHit = pickBest(rows.filter(isLocked), model);
            if (!pick) {
              const more = rows.find((r) => isOpener(r) && MORE_MODELS.test(fold(r.title)));
              if (more) {
                const sub = await openSubmenu(more, rows);
                pool = sub || [];
                offered.push(...pool.filter(isChoice));
                pick = pickBest(pool.filter(isChoice), model);
                lockedHit = lockedHit || pickBest(pool.filter(isLocked), model);
              }
            }
            if (!pick) {
              res.warnings.push(
                lockedHit
                  ? `model "${model}" is locked on this account (needs an upgrade: ${lockedHit.title})`
                  : `model "${model}" not offered; available: ${offered.map((r) => r.title).join(", ") || "none"}`,
              );
            } else if (pick.state.checked === true) {
              res.applied.model = pick.title;
            } else {
              await selectRow(pick);
              pressed = true;
              intent.model = pick.title;
            }
          }
        } finally {
          await UI.dismiss();
        }
      }

      if (wantLevel) {
        try {
          const rows = await openMenu(trigger());
          const opener = (rows || []).find((r) => isOpener(r) && EFFORT_OPENER.test(fold(r.title)));
          if (!opener) {
            res.warnings.push(`reasoning: this site has no effort / thinking-level menu for this account`);
          } else if (reasoning === "off") {
            res.warnings.push(`reasoning "off" is not offered here (the level is left as it is)`);
          } else {
            const sub = await openSubmenu(opener, rows);
            const levels = (sub || []).filter(isChoice).map((r) => ({ ...r, level: levelOf(r.title) }));
            let target = levels.find((r) => r.level === reasoning);
            if (!target) {
              // Nearest offered level BELOW the request: never silently spend more than asked.
              const wantIdx = LEVEL_ORDER.indexOf(reasoning);
              const lower = levels.filter((r) => r.level && LEVEL_ORDER.indexOf(r.level) <= wantIdx).sort((a, b) => LEVEL_ORDER.indexOf(b.level) - LEVEL_ORDER.indexOf(a.level));
              target = lower[0] || null;
              res.warnings.push(
                target
                  ? `reasoning "${reasoning}" not offered; using "${target.level}" (offered: ${levels.map((r) => r.level || r.title).join(", ")})`
                  : `reasoning "${reasoning}" not offered (offered: ${levels.map((r) => r.level || r.title).join(", ") || "none"})`,
              );
            }
            if (target) {
              if (target.state.checked === true) res.applied.reasoning = target.level || target.title;
              else {
                await selectRow(target);
                pressed = true;
                intent.reasoning = target.level || target.title;
              }
            }
          }
        } finally {
          await UI.dismiss();
        }
      }

      if (pressed) {
        if (await closeUpsell()) res.warnings.push("the site showed an upgrade prompt after the change; it was dismissed (nothing was upgraded)");
        // Trust the page, not the click: read the choice back from the menus.
        const now = await read();
        if (intent.model) {
          if (fold(now.model.current) === fold(intent.model)) res.applied.model = now.model.current;
          else res.warnings.push(`model "${intent.model}" was selected but the site still shows "${now.model.current || "?"}" (the plan may not include it)`);
        }
        if (intent.reasoning) {
          if (now.reasoning.current === intent.reasoning) res.applied.reasoning = now.reasoning.current;
          else res.warnings.push(`reasoning "${intent.reasoning}" was selected but the site still shows "${now.reasoning.current || "?"}"`);
        }
      }
      return res;
    }

    return { read, apply };
  }

  // --- toggle driver: ChatGPT and DeepSeek reasoning pills --------------------------------

  function toggleControl(patterns) {
    return () => findControl(patterns, { scope: "main", needState: "pressed" });
  }

  async function setToggle(find, wantOn) {
    const el = find();
    if (!el) return { found: false };
    const was = UI.stateOf(el).pressed === true;
    if (was !== wantOn) {
      const reacted = () => (UI.stateOf(find() || el).pressed === true) === wantOn;
      await UI.pressUntil(el, reacted, { modes: ["click", "pointerdown", "pointer"] });
    }
    const now = UI.stateOf(find() || el).pressed === true;
    return { found: true, now, changed: was !== now };
  }

  // --- per-site drivers --------------------------------------------------------------------

  const DRIVERS = {
    claude: (() => {
      const popup = popupDriver({ trigger: () => [...document.querySelectorAll("[data-testid='model-selector-dropdown']")].find(UI.visible) || null });
      return { ...popup, search: null };
    })(),

    gemini: (() => {
      const popup = popupDriver({
        trigger: () =>
          findControl([/^(mod seciciyi ac|open mode picker|mode picker|modus|select mode|mod secici)/], { scope: "main" }) ||
          // Structural fallback: the composer's popup button that is not the tools menu.
          [...UI.collect("main").items].find((el) => UI.stateOf(el).popup === "true" && UI.stateOf(el).expanded !== undefined && /mod|mode/.test(fold(UI.accName(el)))) ||
          null,
      });
      return { ...popup, search: null };
    })(),

    chatgpt: (() => {
      const thinking = toggleControl([/^(dusunme|think|thinking|dusun)$/]);
      // Header model switcher: present on plans that have one; the free plan has none
      // (measured), so absence is reported as unsupported, not as an error.
      const modelTrigger = () => document.querySelector("[data-testid='model-switcher-dropdown-button']");
      const popup = popupDriver({ trigger: modelTrigger });
      return {
        async read() {
          const base = modelTrigger() ? await popup.read() : { model: { supported: false, current: null, options: [] }, reasoning: { supported: false, kind: "toggle", current: null, options: [] } };
          const el = thinking();
          if (el) {
            base.reasoning = { supported: true, kind: "toggle", current: UI.stateOf(el).pressed === true ? "on" : "off", options: [{ level: "off" }, { level: "on" }] };
          }
          return base;
        },
        async apply({ model, reasoning }) {
          const res = { applied: {}, warnings: [] };
          if (model && model !== "default") {
            if (modelTrigger()) {
              const r = await popup.apply({ model });
              Object.assign(res.applied, r.applied);
              res.warnings.push(...r.warnings);
            } else {
              res.warnings.push(`model: this ChatGPT account has no model picker; "${model}" ignored`);
            }
          }
          if (reasoning && reasoning !== "default") {
            const r = await setToggle(thinking, ON.has(String(reasoning)));
            if (!r.found) res.warnings.push("reasoning: no Thinking control on this page");
            else {
              res.applied.reasoning = r.now ? "on" : "off";
              if (r.now && !["on", "true", "yes"].includes(reasoning)) res.warnings.push(`reasoning "${reasoning}": this site only has on/off, using "on"`);
            }
          }
          return res;
        },
      };
    })(),

    deepseek: (() => {
      const think = toggleControl([/^(derin dusunme|deepthink|deep think|derin dusun)/]);
      const search = toggleControl([/^(akilli arama|smart search|search|arama|web search)/]);
      return {
        async read() {
          const t = think();
          const s = search();
          return {
            model: { supported: false, current: null, options: [] },
            reasoning: t ? { supported: true, kind: "toggle", current: UI.stateOf(t).pressed === true ? "on" : "off", options: [{ level: "off" }, { level: "on" }] } : { supported: false, kind: "toggle", current: null, options: [] },
            search: s ? { supported: true, current: UI.stateOf(s).pressed === true ? "on" : "off" } : { supported: false, current: null },
          };
        },
        async apply({ model, reasoning, search: wantSearch }) {
          const res = { applied: {}, warnings: [] };
          if (model && model !== "default") res.warnings.push(`model: DeepSeek has no model picker; "${model}" ignored`);
          if (reasoning && reasoning !== "default") {
            const r = await setToggle(think, ON.has(String(reasoning)));
            if (!r.found) res.warnings.push("reasoning: no DeepThink control on this page");
            else {
              res.applied.reasoning = r.now ? "on" : "off";
              if (r.now && !["on", "true", "yes"].includes(reasoning)) res.warnings.push(`reasoning "${reasoning}": this site only has on/off, using "on"`);
            }
          }
          if (wantSearch && wantSearch !== "default") {
            const r = await setToggle(search, ON.has(String(wantSearch)));
            if (!r.found) res.warnings.push("search: no Search control on this page");
            else res.applied.search = r.now ? "on" : "off";
          }
          return res;
        },
      };
    })(),
  };

  const NONE = { model: { supported: false, current: null, options: [] }, reasoning: { supported: false, kind: "levels", current: null, options: [] } };

  globalThis.C2F_SETTINGS = {
    fold,
    levelOf,
    matchText,
    LEVEL_ORDER,
    /** What this site offers right now and what is selected. Opens menus, sends nothing. */
    trace: () => traceLog.slice(),
    async read(site) {
      traceLog = [];
      const d = DRIVERS[site];
      if (!d) return { site, supported: false, ...NONE };
      // A previous run that died mid-menu must not leave its popup open under this one.
      await UI.dismiss();
      const r = await d.read();
      return { site, supported: true, ...r };
    },
    /** Set what was asked, verify by reading back, and report what could not be done. */
    async apply(site, wanted = {}) {
      traceLog = [];
      // The same request, verified moments ago in this very page, needs no menus opened again.
      const key = JSON.stringify([site, wanted.model, wanted.reasoning, wanted.search]);
      const hit = memo.get(key);
      if (hit && Date.now() - hit.at < MEMO_MS && hit.url === location.origin) return { ...hit.res, cached: true };
      const out = await this.applyNow(site, wanted);
      if (!out.warnings.length) memo.set(key, { at: Date.now(), url: location.origin, res: out });
      else memo.delete(key);
      return out;
    },
    async applyNow(site, wanted = {}) {
      const d = DRIVERS[site];
      const res = { site, applied: {}, warnings: [] };
      if (!d) {
        if (Object.values(wanted).some((v) => v && v !== "default")) res.warnings.push(`no settings driver for "${site}"`);
        return res;
      }
      const todo = {
        model: wanted.model && wanted.model !== "default" ? wanted.model : null,
        reasoning: wanted.reasoning && wanted.reasoning !== "default" ? wanted.reasoning : null,
        search: wanted.search && wanted.search !== "default" ? wanted.search : null,
      };
      if (!todo.model && !todo.reasoning && !todo.search) return res;
      await UI.dismiss();
      const r = await d.apply(todo);
      Object.assign(res.applied, r.applied);
      res.warnings.push(...r.warnings);
      return res;
    },
  };
})();
