/* ChatToFree content script: types a prompt into the site's composer, sends it,
 * and returns the assistant reply once streaming settles. */
(() => {
  // After an extension Reload the old script stays in this isolated world with its flag
  // still set, but its chrome.* APIs are dead. The runtime id does NOT change (it is
  // derived from the unpacked path), so id equality proves nothing. Probe liveness instead:
  // in an invalidated context chrome.runtime.id is undefined or throws.
  const alive = globalThis.__c2fAlive;
  if (globalThis.__c2fLoaded && typeof alive === "function" && alive()) return;
  globalThis.__c2fLoaded = true;
  globalThis.__c2fAlive = () => {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (list) => {
    for (const sel of list || []) {
      const el = document.querySelector(sel);
      if (el && visible(el)) return el;
    }
    return null;
  };
  /**
   * All matches, deduplicated AND in document order. Concatenating per selector would put
   * every element of the first selector before those of the second, so "last node" could
   * be an older turn — the stale-reply bug through another route.
   */
  const qa = (list) => {
    const out = [];
    for (const sel of list || []) {
      for (const el of document.querySelectorAll(sel)) {
        if (!out.includes(el)) out.push(el);
      }
    }
    out.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return out;
  };
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.01;
  }
  function adapterFor(site) {
    return (globalThis.C2F_SITES && (globalThis.C2F_SITES[site] || globalThis.C2F_SITES.generic)) || {};
  }

  /** True when the tab we landed on really belongs to the requested site. */
  function hostMatches(site) {
    const adapter = adapterFor(site);
    return (adapter.hosts || []).includes(location.hostname);
  }

  // A visible "sign in" control means the session is not authenticated. Measured on the
  // live sites: both ChatGPT and Gemini show their composer while logged out, so the
  // composer alone is not proof of a usable session.
  // \b is ASCII-only and fails after "aç" (ç is not a word char), so use letter lookarounds.
  const SIGNED_OUT = /(?<![\p{L}])(oturum aç|giriş yap|sign in|log in|login|connexion|anmelden|iniciar sesión|accedi)(?![\p{L}])/iu;
  function signedOutUI(adapter) {
    // Skip message content: a chat reply saying "Sign in to GitHub" must not lock the tab.
    const skip = (adapter?.assistant || []).join(",");
    for (const el of document.querySelectorAll("button, a, [role=button]")) {
      if (!visible(el)) continue;
      if (skip && el.closest(skip)) continue;
      if (el.closest("[data-message-author-role='user'], .font-user-message")) continue;
      const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      if (label && SIGNED_OUT.test(label)) return true;
    }
    return false;
  }
  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\r\n/g, "\n").trim();
  }

  // Bot checks are detected structurally first: the text is localized ("İnsan olduğunuzu
  // doğrulayalım" was not in the old regex), the widgets are not.
  const CHALLENGE_DOM = [
    "iframe[src*='challenges.cloudflare.com']",
    "iframe[src*='turnstile']",
    "#challenge-form",
    "#challenge-running",
    ".cf-turnstile",
  ];
  // "İ" (dotted capital I) does not case-fold to "i" in JS, so Turkish text needs a class.
  // Informational only. ChatGPT's "files/images paused until HH:MM, continue with text" banner
  // leaves text chat working, and c2f only sends text, so it must never make a site unusable.
  // Deliberately narrow phrases: generic ones ("usage limit", "upgrade your plan") also appear
  // in normal sidebars, chat titles and assistant replies.
  const LIMITED = /yenilenene kadar|yalnızca metinle sohbete devam|continue (the chat )?with text only|until (your limit|it) resets/i;
  const CHALLENGE = /bir dakika|just a moment|checking your browser|attention required|request could not be satisfied|access denied|verify you are human|[iİı]nsan olduğunuzu doğrula|enable javascript and cookies/i;
  function challengeUI() {
    for (const sel of CHALLENGE_DOM) if (document.querySelector(sel)) return true;
    return CHALLENGE.test(`${document.title} ${textOf(document.body).slice(0, 600)}`);
  }

  /**
   * The banner text, found only in a small element near the composer and never inside a
   * message bubble, so a reply that merely talks about limits cannot trigger it.
   */
  function limitedNotice(composer, adapter) {
    if (!composer) return null;
    let root = composer.parentElement;
    for (let i = 0; i < 5 && root?.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
    if (!root) return null;
    const inMessage = (el) =>
      el.closest("[data-message-author-role], [data-message-id], article") ||
      qa(adapter.assistant).some((n) => n.contains(el));
    for (const el of root.querySelectorAll("div, p, span")) {
      const text = textOf(el);
      if (text.length < 20 || text.length > 400 || !LIMITED.test(text)) continue;
      if (inMessage(el)) continue;
      return text.slice(0, 160);
    }
    return null;
  }

  // A hard usage limit shows up as a toast / alert / dialog, not in the chat thread. Scanning
  // only those containers keeps a reply that merely discusses limits from tripping it.
  const HARD_LIMIT = /(you'?ve (reached|hit)|limit (reached|exceeded)|reached (the|your) .*limit|too many (requests|messages)|rate.?limit|quota|usage cap|sınır|ulaştın|ulasildi|kota|çok fazla (istek|mesaj)|daha sonra tekrar|try again (in|later|after))/i;
  function hardLimitNotice() {
    const sel = "[role=alert], [role=alertdialog], [role=dialog], [role=status], [data-testid*='toast' i], [class*='toast' i], [class*='snackbar' i]";
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue;
      const text = textOf(el);
      if (text.length < 8 || text.length > 600) continue;
      if (HARD_LIMIT.test(text)) return text.slice(0, 300);
    }
    return null;
  }

  // TIME: message timestamps ("3 dakika önce") sit inside Claude's turn and are not the answer.
  const SKIP_TAGS = new Set(["BUTTON", "SVG", "STYLE", "SCRIPT", "TEXTAREA", "INPUT", "SELECT", "NOSCRIPT", "TIME"]);

  /**
   * Text sites keep for screen readers only. Claude puts a 1x1 clipped <h3 class="sr-only">
   * "Claude responded: <the whole answer again>" at the top of every turn; reading it doubles
   * the reply and, while the answer is still streaming, leaves a bare "###". Skip clipped
   * boxes the way a person never sees them.
   */
  function visuallyHidden(el) {
    if (el.classList?.contains("sr-only") || el.classList?.contains("visually-hidden")) return true;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag) || tag === "SPAN") {
      const r = el.getBoundingClientRect();
      if (r.width <= 2 && r.height <= 2 && getComputedStyle(el).position === "absolute") return true;
    }
    return false;
  }

  /** A reply that is only heading marks / punctuation has not really started yet. */
  const substantive = (text) => /[\p{L}\p{N}]/u.test(String(text).replace(/#/g, ""));
  const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "SECTION", "ARTICLE", "TABLE", "TR", "HR", "FIGURE", "DL", "DT", "DD",
  ]);

  /**
   * Real sites render fenced blocks as <pre><code> with a toolbar; rebuild the fences.
   * Pure DOM walk: no layout, and nothing is inserted into the document, so this cannot
   * retrigger the MutationObserver that calls it.
   */
  function replyText(el) {
    if (!el) return "";
    let out = "";
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return;
      if (visuallyHidden(node)) return;
      if (tag === "PRE") {
        const code = node.querySelector("code");
        const lang = (code?.className || "").match(/language-([\w+#-]+)/)?.[1] || "";
        const body = (code || node).textContent.replace(/^\n+/, "").replace(/\s+$/, "");
        // A model that needed 4 backticks did so because the file contains 3. Rebuild at
        // least as long as the longest run inside, or the block would end early.
        const longest = (body.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        out += `\n${fence}${lang}\n${body}\n${fence}\n`;
        return;
      }
      if (tag === "BR") {
        out += "\n";
        return;
      }
      // Headings lose their hashes in the DOM; restore them so "### FILE x" still parses.
      const heading = /^H([1-6])$/.exec(tag);
      if (heading) {
        out += `\n${"#".repeat(Number(heading[1]))} `;
        for (const child of node.childNodes) walk(child);
        out += "\n";
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += "\n";
      for (const child of node.childNodes) walk(child);
      if (block) out += "\n";
    };
    walk(el);
    return out.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Resolves the moment fn() is truthy: checked at once, on every DOM mutation, and on a short
   * timer as a backstop. (It used to sleep-poll, so every wait cost up to a full step.)
   */
  function waitFor(fn, timeoutMs = 15_000, stepMs = 150) {
    return globalThis.C2F_UI.waitFor(fn, timeoutMs, stepMs);
  }

  /** Yield one macrotask so a framework can process what we just did; not throttled in a hidden tab. */
  const tick = () =>
    new Promise((resolve) => {
      const c = new MessageChannel();
      c.port1.onmessage = () => {
        c.port1.close();
        resolve();
      };
      c.port2.postMessage(0);
    });

  /**
   * Waits for a streaming reply. Timers are clamped to ~1/s in a hidden tab, so the
   * loop is woken by DOM mutations from the network stream instead of sleeping.
   * Deadlines use Date.now(), which is not throttled.
   */
  function waitForReply(adapter, { baseline, timeoutMs, onTick, baselineStops = new Set(), baselineLimit = null, idleStopMs = 600_000, quietMs = 60_000 }) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const began = Date.now();
      // How long to wait for a reply to START. Kept well under the total budget so a
      // site that never answers fails fast instead of returning the previous turn.
      const startBudget = Math.min(25_000, Math.max(2_000, timeoutMs / 3));
      let lastText = "";
      let lastChange = Date.now();
      let started = false;
      let firstAt = 0;
      let sawStop = false;
      let done = false;
      // A stop control that was already on screen before we sent is stale (a dictation "stop",
      // a leftover streaming flag): only one that APPEARS for this reply means "still going".
      const liveStop = () => qa(adapter.stop).filter(visible).find((el) => !baselineStops.has(el)) || null;

      const finish = (result) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(ticker);
        resolve(result);
      };

      const evaluate = () => {
        if (done) return;
        const snap = replySnapshot(adapter);
        const text = snap?.text || "";
        if (text && text !== lastText) {
          lastText = text;
          lastChange = Date.now();
          if (onTick) onTick(text);
        }
        const stop = liveStop();
        if (stop) sawStop = true;
        if (!started && ((text && text !== baseline) || stop)) {
          started = true;
          firstAt = Date.now();
        }
        // No answer yet and the site shows a usage-limit notice: say so NOW instead of waiting
        // out the start budget on a model that will never reply.
        if (!started || !substantive(text)) {
          const limit = hardLimitNotice();
          if (limit && limit !== baselineLimit) {
            finish({ started: false, text: "", limit, firstAt });
            return;
          }
        }
        const quiet = Date.now() - lastChange;
        // "###" alone (a heading mark before its text streams in) is not a finished reply:
        // a model that pauses after its first token must not be cut off there. Once the stop
        // control has been seen and has gone, the end is certain, so settle faster.
        if (started && !stop && substantive(text) && quiet > (sawStop ? 500 : 900)) {
          finish({ started: true, text, firstAt });
          return;
        }
        // A big model that is thinking or researching shows its stop control and may stay silent
        // for many minutes: wait. Give up only after a long total silence (a hung page).
        if (started && stop && quiet > idleStopMs) {
          finish({ started: true, text, firstAt });
          return;
        }
        // A control that looks like "stop" can outlive the reply (measured: Claude's "Yanıtı durdur"
        // beside a finished answer), which used to cost the whole idle wait (10 minutes) on a one-word
        // reply. Real text that has not changed for quietMs is an answer, whatever the page still shows.
        // Silent thinking (no text yet) is untouched: that is what idleStopMs is for.
        if (started && stop && substantive(text) && quiet > quietMs) {
          finish({ started: true, text, firstAt });
          return;
        }
        // Never started: give the site a short window to begin a reply, then fail instead of
        // returning the previous turn's answer.
        if (!started && Date.now() - began > startBudget) {
          finish({ started: false, text: "", firstAt });
          return;
        }
        if (Date.now() > deadline) finish({ started, text: started ? text : "", firstAt });
      };

      const observer = new MutationObserver(evaluate);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const ticker = setInterval(evaluate, 400);
      evaluate();
    });
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function typeInto(el, text) {
    el.focus();
    el.click();
    await tick();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      setNativeValue(el, "");
      await tick();
      setNativeValue(el, text);
      return;
    }
    // contenteditable (ProseMirror, Quill, Lexical, Slate...)
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete");
    await tick();
    // insertText keeps framework state in sync; paste avoids per-char latency.
    if (!document.execCommand("insertText", false, text)) {
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    await tick();
  }

  function composerEmpty(el) {
    if (!el) return true;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return !el.value.trim();
    return !textOf(el);
  }

  /**
   * The single source of truth for "can this tab be used". Ping and inspect both call it:
   * inspect used to report ready purely because a composer existed, and both ChatGPT and
   * Gemini render one while logged out, so a signed-out tab passed as usable.
   */
  function siteState(site, adapter) {
    const composer = q(adapter.composer);
    const path = location.pathname + location.search;
    const marker = (adapter.loginMarker || []).some((sel) => document.querySelector(sel));
    // A visible "Sign in" control is the reliable logged-out signal, and it holds even with a
    // composer on screen (ChatGPT and Gemini both render one logged out). A link-based
    // marker is NOT: signed-in Gemini links accounts.google.com from its account menu, so a
    // marker only counts when there is no composer at all.
    const out = signedOutUI(adapter);
    const needsLogin = out || (!composer && (marker || (adapter.loginPath && adapter.loginPath.test(path))));
    const challenge = !needsLogin && challengeUI();
    // Hard limit: the site disables the composer itself. Detected from the control, not from
    // banner wording.
    const composerDisabled = Boolean(
      composer &&
        (composer.disabled ||
          composer.getAttribute("aria-disabled") === "true" ||
          composer.getAttribute("contenteditable") === "false"),
    );
    return {
      composer,
      limited: limitedNotice(composer, adapter),
      composerDisabled,
      ready: Boolean(composer) && !needsLogin && !challenge && !composerDisabled,
      needsLogin,
      loggedOutUI: out,
      challenge,
      wrongHost: !hostMatches(site),
      url: location.href,
      title: document.title,
    };
  }

  async function waitComposerReady(adapter, timeoutMs = 20_000) {
    return waitFor(() => q(adapter.composer), timeoutMs, 250);
  }

  async function clickSend(adapter, composer) {
    const usable = (el) => el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
    // Resolve send controls relative to the composer only: a document-wide
    // "form button[type=submit]" also matches cookie banners ("Tümünü kabul et").
    const form = composer?.closest("form") || null;
    let container = form;
    if (composer) {
      // Many UIs (measured: Gemini) have no form at all, and the send control can be a
      // sibling. Climb until an ancestor holds a send-shaped button, never past <body>.
      const looksLikeSend = (el) =>
        /mesaj gönder|send|gönder|submit/i.test(
          `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`,
        );
      for (let node = composer.parentElement, i = 0; node && node !== document.body && i < 8; node = node.parentElement, i++) {
        if ([...node.querySelectorAll("button, [role=button]")].some((b) => looksLikeSend(b) && !isCookieControl(b))) {
          container = container || node;
          break;
        }
        container = container || node;
      }
    }
    const btn = await waitFor(() => {
      for (const sel of adapter.send || []) {
        const scopes = [form, container, composer?.parentElement].filter(Boolean);
        for (const scope of scopes) {
          for (const el of scope.querySelectorAll(sel)) if (usable(el) && !isCookieControl(el)) return el;
        }
      }
      // Only an explicit submit button inside the composer's own form.
      const submit = [...(form?.querySelectorAll("button[type='submit']") || [])].find((el) => usable(el) && !isCookieControl(el));
      return submit || null;
      // A send button shows up within a few hundred ms of typing. Waiting longer only delays the
      // Enter fallback below, which every supported site accepts (measured: Claude's send step
      // took 8.0 s per turn waiting for a button its English-only selectors never matched).
    }, adapter.sendWaitMs ?? 1500, 60);
    if (btn) {
      btn.click();
      // Verify the click actually submitted: on Gemini a click on the wrong node (an icon
      // wrapper) leaves the text in place. Fall through to Enter if the composer kept text.
      const cleared = () => composerEmpty(q(adapter.composer) || composer);
      if (await waitFor(cleared, 1000, 50)) return "click";
      composer.focus();
      for (const type of ["keydown", "keypress", "keyup"]) {
        composer.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      const clearedAfterEnter = Boolean(await waitFor(cleared, 1000, 50));
      return `click+enter(${clearedAfterEnter ? "cleared" : "still-full"},${(btn.getAttribute("aria-label") || btn.className || "").toString().slice(0, 24)})`;
    }
    // No button at all (measured on DeepSeek): Enter is the only way. Synthetic events are
    // untrusted, so also try execCommand insertParagraph and a form requestSubmit, then
    // report exactly what was attempted.
    composer.focus();
    const attempts = [];
    // React/Vue composers often listen on the native input event, not on synthetic keys.
    // Fire a real-looking input first (some UIs enable the send control only after that),
    // then the key sequence.
    if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter && composer.value) {
        const v = composer.value;
        setter.call(composer, "");
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        setter.call(composer, v);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const nativeEnter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true });
      composer.dispatchEvent(nativeEnter);
      attempts.push(`nativeKeydown:${nativeEnter.defaultPrevented ? "handled" : "ignored"}`);
      if (!nativeEnter.defaultPrevented && composer.form?.requestSubmit) {
        composer.form.requestSubmit();
        attempts.push("formSubmit");
      }
      return `textarea(${attempts.join(",")})`;
    }
    for (const type of ["keydown", "keypress", "keyup"]) {
      const ev = new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true });
      composer.dispatchEvent(ev);
      attempts.push(`${type}:${ev.defaultPrevented ? "handled" : "ignored"}`);
    }
    if (form?.requestSubmit) {
      try {
        form.requestSubmit();
        attempts.push("requestSubmit");
      } catch {
        /* ignore */
      }
    }
    return `enter(${attempts.join(",")})`;
  }

  // Consent banners are never a send control. Kept narrow: a bare "accept"/"kabul" also
  // appears in normal page text, and matching that would discard the real send button.
  const COOKIE_TEXT = /çerez politikası|çerezleri (kabul|reddet)|tümünü (kabul|reddet)|kabul et ve (devam|kapat)|accept all cookies|reject all|manage (cookies|preferences)|cookie (settings|policy|consent)/i;
  function isCookieControl(el) {
    if (el.closest("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i]")) return true;
    const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();
    return COOKIE_TEXT.test(label);
  }

  function replySnapshot(adapter) {
    const nodes = qa(adapter.assistant).filter(visible);
    if (!nodes.length) return null;
    const last = nodes[nodes.length - 1];
    return { el: last, text: replyText(last) };
  }

  const turnCount = (adapter) => qa(adapter.assistant).filter(visible).length;

  async function newChat(adapter) {
    // Already a blank chat: there is nothing to reset, so do not click (and do not wait).
    if (turnCount(adapter) === 0) return false;
    const btn = q(adapter.newChat);
    if (!btn) return false;
    const before = location.href;
    btn.click();
    // Done when the address changes or the old turns are gone (an SPA that keeps the URL).
    await waitFor(() => location.href !== before || turnCount(adapter) === 0, 3000, 50);
    return true;
  }

  let busy = false;

  async function handleChat(msg) {
    if (busy) return { error: "busy", detail: "another prompt is still running in this tab" };
    busy = true;
    const started = Date.now();
    const adapter = adapterFor(msg.site);
    // Where the time goes in one turn (ms), returned with the reply so a slow turn can be
    // explained instead of guessed at.
    const marks = { start: started };
    try {
      let composer = await waitComposerReady(adapter, 12_000);
      if (!composer) {
        if (adapter.loginPath && adapter.loginPath.test(location.pathname + location.search)) return { error: "needs_login" };
        return { error: "no_composer", detail: "composer not found on page" };
      }
      let navigated = false;
      if (msg.freshChat) {
        const before = location.href;
        await newChat(adapter);
        if (location.href !== before) navigated = true;
        composer = (await waitComposerReady(adapter, 15_000)) || composer;
        await tick();
      }
      // A follow-up only makes sense inside the chat that holds the earlier turns. If this tab
      // is a blank chat (reloaded, navigated away, a new tab), say so: the caller resends the
      // full context instead of the model answering a question it has no background for.
      if (msg.continuing && turnCount(adapter) === 0) return { error: "context_lost", detail: "the chat has no earlier turns" };
      // A site that disables its own composer is at a hard limit: fail with a reason the
      // router can act on (cool down, try the next site) instead of typing into a dead box.
      if (siteState(msg.site, adapter).composerDisabled) {
        // A composer is also disabled for a moment while the page hydrates or a reply is still
        // streaming. Only a disable that persists is a limit, and only one that comes with the
        // site's own notice earns the cooldown; a silent one is a retryable error.
        await waitFor(() => !siteState(msg.site, adapter).composerDisabled, 3000, 100);
        if (siteState(msg.site, adapter).composerDisabled) {
          const notice = hardLimitNotice();
          return notice
            ? { error: "limit", detail: notice }
            : { error: "composer_disabled", detail: "the composer stayed disabled for 3 s and the page shows no limit notice" };
        }
        composer = q(adapter.composer) || composer;
      }
      let settingsReport = null;
      if (msg.settings && globalThis.C2F_SETTINGS) {
        // Settings must never stall the chat itself: give them a deadline, and say why when
        // they miss it (a hidden tab with throttled timers is the usual reason).
        const S = globalThis.C2F_SETTINGS;
        let timer;
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ site: msg.site, applied: {}, warnings: [`settings did not finish in 25s${document.visibilityState === "hidden" ? " (the tab is hidden and its timers are throttled: window minimised, covered or screen locked)" : ""}; left as they are`], timedOut: true }), 25_000);
        });
        settingsReport = await Promise.race([
          S.apply(msg.site, msg.settings).catch((e) => ({ site: msg.site, applied: {}, warnings: [`settings failed: ${e?.message || e}`] })),
          deadline,
        ]);
        clearTimeout(timer);
        if (settingsReport.timedOut) await globalThis.C2F_UI.dismiss().catch(() => {});
        if (msg.strictSettings && settingsReport.warnings.length) return { error: "settings_failed", detail: settingsReport.warnings.join("; ") };
        composer = (await waitComposerReady(adapter, 8_000)) || composer;
      }
      const baseline = replySnapshot(adapter)?.text || "";
      // What was already on screen before we send: a stale "stop" control or an old limit toast
      // must not be mistaken for this reply's state.
      const baselineStops = new Set(qa(adapter.stop).filter(visible));
      const baselineLimit = hardLimitNotice();
      marks.prepared = Date.now();
      await typeInto(composer, msg.prompt);
      // An SPA can swap the composer element right after a new-chat navigation; type again into
      // the live one rather than sending an empty box.
      if (!composer.isConnected) {
        composer = (await waitComposerReady(adapter, 5_000)) || composer;
        await typeInto(composer, msg.prompt);
      }
      const ready = await waitFor(() => !composerEmpty(q(adapter.composer) || composer), 6000, 50);
      if (!ready) return { error: "type_failed", detail: "composer stayed empty after typing" };
      marks.typed = Date.now();
      const how = await clickSend(adapter, composer);
      marks.sent = Date.now();
      // Chrome suspends an idle MV3 worker after ~30s; a pending chat would be lost and the
      // bridge would wait for a result that can never arrive. Ping for the whole wait.
      const keepAlive = setInterval(() => {
        try {
          chrome.runtime.sendMessage({ type: "c2f.ping-worker", jobId: msg.id }).catch(() => {});
        } catch {
          clearInterval(keepAlive);
        }
      }, 8_000);
      let result;
      try {
        result = await waitForReply(adapter, { baseline, timeoutMs: msg.timeoutMs || 1_800_000, baselineStops, baselineLimit, idleStopMs: msg.idleStopMs || 600_000, quietMs: msg.quietMs || 60_000 });
      } finally {
        clearInterval(keepAlive);
      }
      if (result.limit) return { error: "limit", detail: result.limit };
      const text = result.started ? (result.text || "").trim() : "";
      if (!text) {
        // Diagnose in THIS tab, at THIS moment: no tab guessing, and the answer cannot have
        // gone stale. Everything needed to tell "not sent" from "sent but unreadable".
        const nonceMatch = /C2F-[A-Z]+-[A-Z0-9]+/.exec(msg.prompt || "");
        const nonce = nonceMatch ? nonceMatch[0] : null;
        const bodyText = document.body.innerText || "";
        const afterSend = composerEmpty(q(adapter.composer) || composer);
        const assistantCount = qa(adapter.assistant).length;
        const trace = (() => {
          if (!nonce) return null;
          for (const el of document.querySelectorAll("div, p, span, article, section")) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ");
            if (!own.includes(nonce)) continue;
            const chain = [];
            for (let n = el; n && n !== document.body && chain.length < 5; n = n.parentElement) {
              chain.push(`${n.tagName.toLowerCase()}${n.getAttributeNames().filter((a) => a.startsWith("data-")).map((a) => `[${a}]`).join("")}.${(typeof n.className === "string" ? n.className : "").slice(0, 24)}`);
            }
            return { text: own.replace(/\s+/g, " ").trim().slice(0, 60), chain };
          }
          return null;
        })();
        const shadowScan = (() => {
          let hosts = 0;
          let withNonce = 0;
          const walk = (root) => {
            for (const el of root.querySelectorAll("*")) {
              if (!el.shadowRoot) continue;
              hosts++;
              if ((el.shadowRoot.textContent || "").includes(nonce || "\u0000")) withNonce++;
              walk(el.shadowRoot);
            }
          };
          walk(document);
          return { hosts, withNonce };
        })();
        const diag = {
          url: location.href,
          navigated,
          textContentHasNonce: nonce ? document.body.textContent.includes(nonce) : null,
          bodyHasNonceText: nonce ? bodyText.includes(nonce) : null,
          shadowScan,
          dsMarkdownCount: document.querySelectorAll(".ds-markdown").length,
          messageish: document.querySelectorAll("[class*='message'], [class*='chat-item'], [class*='ds-']").length,
          composerFoundAgain: Boolean(q(adapter.composer)),
          how,
          composerCleared: afterSend,
          bodyHasNonce: nonce ? bodyText.includes(nonce) : null,
          bodyChars: bodyText.length,
          assistantCount,
          assistantSelectors: adapter.assistant,
          nonce,
          trace,
        };
        const limitText = hardLimitNotice();
        if (limitText) return { error: "limit", detail: limitText };
        return {
          // A cleared composer means the prompt WAS sent; only a full one points at the send control.
          error: result.started || afterSend ? "no_reply" : how.startsWith("enter") || how.startsWith("textarea") ? "no_send_button" : "no_reply",
          detail: JSON.stringify(diag),
        };
      }
      const end = Date.now();
      const timings = {
        prepare: marks.prepared - started,
        type: marks.typed - marks.prepared,
        send: marks.sent - marks.typed,
        firstToken: result.firstAt ? result.firstAt - marks.sent : null,
        stream: result.firstAt ? end - result.firstAt : null,
        total: end - started,
      };
      return { reply: text, ms: end - started, url: location.href, settings: settingsReport, timings };
    } finally {
      busy = false;
    }
  }

  /**
   * sendResponse goes through the worker that asked, which may have been restarted meanwhile and
   * then never hears the answer (a finished reply used to be lost that way). Hand the result to
   * whichever worker is alive now, until one confirms it passed it on.
   */
  async function deliverResult(msg, result) {
    if (!msg.id) return;
    for (let i = 0; i < 150; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "c2f.done", id: msg.id, site: msg.site, result });
        if (res?.ack) return;
      } catch {
        /* worker asleep or restarting: try again */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "c2f.ping") {
      const state = siteState(msg.site, adapterFor(msg.site));
      sendResponse({
        ready: state.ready,
        needsLogin: state.needsLogin,
        loggedOutUI: state.loggedOutUI,
        challenge: state.challenge,
        limited: state.limited,
        composerDisabled: state.composerDisabled,
        // The site's own words, when a limit notice is on screen: lets the caller bench the
        // site before sending anything instead of finding out after a wasted turn.
        hardLimit: hardLimitNotice(),
        wrongHost: state.wrongHost,
        url: state.url,
        title: state.title,
      });
      return true;
    }
    if (msg?.type === "c2f.chat") {
      handleChat(msg)
        .catch((err) => ({ error: "page_error", detail: String(err?.message || err) }))
        .then((result) => {
          sendResponse(result);
          deliverResult(msg, result);
        });
      return true; // async
    }
    // Some sites (measured on DeepSeek) navigate to /a/chat/s/<id> as soon as the prompt is
    // sent. That destroys the waiting content script, so the reply is invisible to it. The
    // NEW page instance answers this instead: wait until an element's own text is exactly the
    // nonce (the prompt also contains it, but always wrapped in a sentence).
    if (msg?.type === "c2f.settings") {
      (async () => {
        const S = globalThis.C2F_SETTINGS;
        if (!S) return { error: "settings_missing", detail: "settings.js is not loaded in this tab" };

        // Own deadline: a menu that never answers must come back with its trace, not hang the
        // tab and the CLI until the outer timeout.
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`settings ${msg.op} did not finish in 40s${document.visibilityState === "hidden" ? " (this tab is hidden and its timers are throttled: window minimised, covered or screen locked)" : ""}:\n${S.trace().join("\n")}`)), 40_000);
        });
        try {
          const out = await Promise.race([msg.op === "apply" ? S.apply(msg.site, msg.settings || {}) : S.read(msg.site), deadline]);
          return { ok: true, result: out, url: location.href };
        } finally {
          clearTimeout(timer);
          await globalThis.C2F_UI.dismiss().catch(() => {});
        }
      })().then(sendResponse, (err) => sendResponse({ error: "settings_failed", detail: String(err?.message || err) }));
      return true;
    }
    if (msg?.type === "c2f.ui") {
      Promise.resolve(globalThis.C2F_UI.run(msg.steps)).then(
        (steps) => sendResponse({ ok: true, steps, url: location.href }),
        (err) => sendResponse({ error: "ui_failed", detail: String(err?.message || err) }),
      );
      return true;
    }
    if (msg?.type === "c2f.inspect") {
      (async () => {
      const adapter = adapterFor(msg.site);
      let composer = q(adapter.composer);
      // ChatGPT only renders its send button once the composer has text, so a static
      // inspection cannot see it. Optionally type a probe, then look again.
      if (msg.probeText && composer) {
        await typeInto(composer, msg.probeText);
        await sleep(600);
        composer = q(adapter.composer) || composer;
      }
      // Computed after an optional probe, so the verdict reflects what the tab really is.
      const state = siteState(msg.site, adapter);
      const form = composer?.closest("form") || null;
      let container = form;
      if (composer) {
        let node = composer.parentElement;
        for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
          if (node.querySelector("button")) {
            container = node;
            break;
          }
        }
      }
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        testid: el.getAttribute("data-testid"),
        aria: el.getAttribute("aria-label"),
        type: el.getAttribute("type"),
        disabled: el.disabled ?? null,
        ariaDisabled: el.getAttribute("aria-disabled"),
        text: (el.textContent || "").trim().slice(0, 24),
        inForm: Boolean(form && form.contains(el)),
        cookie: isCookieControl(el),
      });
      sendResponse({
        url: location.href,
        title: document.title,
        // Same verdict the chat path uses. Without these three fields, live-status fell
        // through to "composer exists" and called a signed-out tab ready.
        ready: state.ready,
        needsLogin: state.needsLogin,
        loggedOutUI: state.loggedOutUI,
        challenge: state.challenge,
        limited: state.limited,
        composerDisabled: state.composerDisabled,
        wrongHost: state.wrongHost,
        composer: Boolean(composer),
        composerTag: composer ? `${composer.tagName.toLowerCase()}${composer.id ? "#" + composer.id : ""}` : null,
        composerValue: composer ? (composer.value ?? textOf(composer)).slice(0, 60) : null,
        hasForm: Boolean(form),
        sendMatched: Boolean(q(adapter.send)),
        stopMatched: Boolean(q(adapter.stop)),
        // Which control it is: a stop control that stays after the reply is finished stalls every turn.
        stopSelectors: (adapter.stop || []).flatMap((sel) => [...document.querySelectorAll(sel)].slice(0, 2).map((el) => ({ sel, tag: el.tagName, label: el.getAttribute("aria-label"), testid: el.getAttribute("data-testid"), shown: el.getClientRects().length > 0 }))),
        assistant: qa(adapter.assistant).length,
        containerButtons: [...(container?.querySelectorAll("button, [role=button]") || [])].slice(0, 20).map(describe),
        formButtons: [...(form?.querySelectorAll("button, [role=button]") || [])].slice(0, 20).map(describe),
        // Which elements actually hold the conversation? The assistant selector matched
        // nothing on a live conversation, so dump candidates instead of guessing.
        bodyHtml: document.body.innerHTML.length,
        threadDump: (() => {
          // Walk down from body to the deepest container that holds the conversation turns,
          // then describe its children. ChatGPT's markup changes often; this measures it.
          const marks = [...document.querySelectorAll("[class*='--thread-content-max-width']")];
          const host = marks.length ? marks[0].parentElement : null;
          if (!host) return null;
          const describeNode = (el, depth) => ({
            tag: el.tagName.toLowerCase(),
            depth,
            cls: typeof el.className === "string" ? el.className.slice(0, 50) : null,
            testid: el.getAttribute("data-testid"),
            role: el.getAttribute("data-message-author-role"),
            msgId: el.getAttribute("data-message-id"),
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50),
            kids: el.children.length,
            head: el.outerHTML.slice(0, 160),
          });
          return {
            hostChildren: [...host.children].slice(0, 6).map((el) => describeNode(el, 0)),
            deep: [...host.querySelectorAll("*")].slice(0, 8).map((el) => describeNode(el, 1)),
          };
        })(),
        turnHints: [...document.querySelectorAll("[data-testid], [data-message-id], [data-turn], [class*='turn'], [class*='conversation'], [class*='thread']")]
          .slice(0, 25)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute("data-testid"),
            msgId: el.getAttribute("data-message-id"),
            turn: el.getAttribute("data-turn"),
            cls: typeof el.className === "string" ? el.className.slice(0, 50) : null,
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
            kids: el.children.length,
          })),
        // Everything that could hold a turn, so a virtualized/differently-tagged assistant
        // node cannot hide: any [data-turn-key], any element with a data-* role marker.
        // Generic truth check that works on ANY site, independent of DOM shape:
        // is the prompt still in the composer, and does the page text contain it at all?
        generic: {
          composerValue: composer ? (composer.value ?? textOf(composer)).slice(0, 80) : null,
          bodyHasNonce: /C2F-[A-Z]+-[A-Z0-9]+/.test(document.body.innerText || ""),
          bodyChars: (document.body.innerText || "").length,
          bodyTail: (document.body.innerText || "").replace(/\s+/g, " ").slice(-260),
          textareaCount: document.querySelectorAll("textarea").length,
        },
        // Every button on the page with its attributes: on Gemini/DeepSeek the send control
        // only exists once the composer has text, so a static dump must show the neighbourhood.
        allButtons: [...document.querySelectorAll("button, [role=button], [class*='send'], [class*='submit']")]
          .slice(0, 40)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            aria: el.getAttribute("aria-label"),
            testid: el.getAttribute("data-testid"),
            type: el.getAttribute("type"),
            cls: typeof el.className === "string" ? el.className.slice(0, 40) : null,
            disabled: el.disabled ?? null,
            cookie: isCookieControl(el),
            text: (el.textContent || "").trim().slice(0, 18),
            nearComposer: Boolean(composer && el.parentElement && (composer.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)),
          })),
        // DeepSeek-style UIs may have no <button> at all: dump the composer's ancestor
        // subtree with real attributes so the send affordance can be identified.
        composerNeighbourhood: composer ? (() => {
          const out = [];
          let node = composer;
          for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
            out.push({
              tag: node.tagName.toLowerCase(),
              cls: typeof node.className === "string" ? node.className.slice(0, 70) : null,
              role: node.getAttribute("role"),
              aria: node.getAttribute("aria-label"),
              kids: node.children.length,
              html: node.outerHTML.slice(0, 220),
            });
          }
          return out;
        })() : null,
        // Trace the reply by TEXT: find every element whose own text contains a C2F token
        // (or any long assistant-looking paragraph) and print its ancestor chain with all
        // data-* attributes. This finds the answer even when no turn marker is present.
        textTrace: (() => {
          const needle = /C2F-[A-Z]+-[A-Z0-9]+/;
          const hits = [];
          for (const el of document.querySelectorAll("div, p, span, article, section")) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ");
            if (!needle.test(own)) continue;
            const chain = [];
            for (let n = el; n && n !== document.body && chain.length < 6; n = n.parentElement) {
              chain.push({
                tag: n.tagName.toLowerCase(),
                data: n.getAttributeNames().filter((a) => a.startsWith("data-")).map((a) => `${a}=${String(n.getAttribute(a)).slice(0, 20)}`),
                cls: typeof n.className === "string" ? n.className.slice(0, 40) : null,
              });
            }
            hits.push({ text: own.replace(/\s+/g, " ").trim().slice(0, 70), chain });
            if (hits.length >= 6) break;
          }
          return hits;
        })(),
        mainText: (() => {
          const m = document.querySelector("main, [role=main], [class*='thread']");
          return m ? (m.innerText || "").replace(/\s+/g, " ").slice(0, 400) : null;
        })(),
        allTurnCandidates: [...document.querySelectorAll("[data-turn-key], [data-message-author-role], [data-testid*='turn'], [data-testid*='message'], article")]
          .slice(0, 12)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            attrs: el.getAttributeNames().filter((a) => a.startsWith("data-")).map((a) => `${a}=${String(el.getAttribute(a)).slice(0, 24)}`),
            kids: el.children.length,
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
          })),
        turns: [...document.querySelectorAll("[data-turn-key], [data-testid^='conversation-turn'], article")]
          .slice(0, 10)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            key: el.getAttribute("data-turn-key"),
            testid: el.getAttribute("data-testid"),
            userIsland: el.querySelector("[data-message-author-role='user'], [data-testid*='user-message']") ? "user" : null,
            assistantIsland: el.querySelector("[data-message-author-role='assistant']") ? "assistant" : null,
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 70),
            head: el.outerHTML.slice(0, 200),
          })),
        messages: [...document.querySelectorAll("article, [data-message-author-role], [data-testid*='conversation-turn'], [class*='markdown'], [class*='message'], model-response, message-content")]
          .slice(0, 14)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("data-message-author-role"),
            testid: el.getAttribute("data-testid"),
            cls: typeof el.className === "string" ? el.className.slice(0, 60) : null,
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
            childCount: el.children.length,
          })),
      });
        // Never leave probe text in the user's real composer: a later Enter would send it.
        if (msg.probeText && composer) await typeInto(composer, "").catch(() => {});
      })().catch((e) => sendResponse({ error: "inspect_failed", detail: String(e?.message || e) }));
      return true;
    }
    return false;
  });
})();
