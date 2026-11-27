/* Shared by background.js (importScripts) and content.js (manifest js list). */
globalThis.C2F_SITES = {
  chatgpt: {
    label: "ChatGPT",
    url: "https://chatgpt.com/",
    hosts: ["chatgpt.com", "chat.openai.com"],
    // Checked against the live site: the composer is a textarea (responsive id) and the
    // ProseMirror variant covers the logged-in desktop build.
    composer: [
      "#prompt-textarea",
      "textarea#mobile-composer-prompt",
      "textarea[placeholder*='ChatGPT']",
      "div.ProseMirror[contenteditable='true']",
      "form textarea",
    ],
    send: [
      "[data-testid='send-button']",
      "#composer-submit-button",
      "form button[type='submit'][aria-label*='Send']",
      "button[aria-label*='Send prompt']",
      // Measured on the Turkish UI: the button is type=submit with aria-label
      // "Mesaj gönder", so aria text is not a reliable selector. The form's submit
      // button next to the composer is.
      "button[aria-label*='Mesaj gönder']",
    ],
    stop: ["[data-testid='stop-button']", "button[aria-label*='Stop' i], button[aria-label*='Durdur' i]"],
    // Measured on the live site (2026-11): assistant replies render inside the "Dil"
    // renderer as [data-dil-message-id] > ... [data-d-component=text]; the old
    // data-message-author-role marker is gone from this build. Role-scoped first, then the
    // measured container. No bare article/turn fallback: right after a send the last turn is
    // the USER bubble, and c2f build would execute the ### FILE lines inside the prompt.
    assistant: [
      "[data-message-author-role='assistant']",
      "[data-dil-message-id]",
      "[data-dil-response]",
    ],
    newChat: ["[data-testid='create-new-chat-button']", "a[href='/']", "button[aria-label*='New chat']"],
    loginMarker: ["[data-testid='login-button']", "a[href*='/auth/login']", "button[data-testid*='login']"],
    loginPath: /^\/(auth|login)/i,
  },
  claude: {
    label: "Claude",
    url: "https://claude.ai/new",
    hosts: ["claude.ai"],
    composer: ["div[contenteditable='true'].ProseMirror", "fieldset div[contenteditable='true']", "div[contenteditable='true']"],
    send: ["button[aria-label='Send message']", "button[aria-label*='Send']", "button[aria-label*='gönder' i]"],
    // Measured: Claude marks the live turn with data-is-streaming="true", which works in any
    // UI language; the Turkish stop button reads "Durdur".
    // keepRendering is OFF here. Observed live (v0.10.5, spoof on): Claude's "Yanıtı durdur" button was
    // still showing next to a finished reply. Cause not proven (it may still have been generating).
    stop: ["[data-is-streaming='true']", "button[aria-label*='Stop' i]", "button[aria-label*='Durdur' i]"],
    assistant: [".font-claude-message", "[data-testid='assistant-message']", "div[data-is-streaming]"],
    newChat: ["a[href='/new']", "button[aria-label*='New chat']"],
    loginMarker: ["a[href*='/login']", "button[data-testid*='login']"],
    // Measured: logged out, claude.ai redirects to /login.
    loginPath: /^\/(login|auth)/i,
  },
  gemini: {
    label: "Gemini",
    url: "https://gemini.google.com/app",
    hosts: ["gemini.google.com"],
    // Measured on the live page: div.ql-editor[contenteditable][role=textbox].
    composer: ["div.ql-editor[contenteditable='true']", "rich-textarea div[contenteditable='true']", "div[contenteditable='true']"],
    // Measured on the live Turkish UI: aria-label is "Mesaj gönder" and the element has no
    // type attribute, so an English aria match never fires. Structure first, then locales.
    send: [
      "button.send-button",
      "button[aria-label*='Mesaj gönder']",
      "button[aria-label*='Send message']",
      "button[aria-label*='Send']",
      "button[aria-label*='Gönder']",
    ],
    stop: ["button[aria-label*='Stop' i], button[aria-label*='Durdur' i]"],
    // Measured: assistantCount was 2 while the text was not found, so the selector must
    // target the text container inside the response, not the outer custom element.
    assistant: [
      "message-content .markdown",
      "model-response .markdown",
      ".model-response-text",
      "message-content",
      "model-response",
    ],
    newChat: ["button[aria-label*='New chat']", "a[href='/app']"],
    loginMarker: ["a[href*='accounts.google.com']"],
    loginPath: /accounts\.google\.com/i,
    // Measured: nothing drawn (~132-char body) while the page reports hidden. background.js
    // keepRendering() tells this tab it is visible. Proven on a mock page that draws only while
    // "visible"; NOT yet proven on the live site in a truly hidden tab (the Gemini tab used in the
    // live test was in front).
    keepRendering: true,
  },
  deepseek: {
    label: "DeepSeek",
    url: "https://chat.deepseek.com/",
    hosts: ["chat.deepseek.com"],
    composer: ["textarea#chat-input", "textarea", "div[contenteditable='true']"],
    send: ["button[aria-label*='Send']", "div[role='button'][aria-disabled='false']", "button[type='submit']"],
    stop: ["button[aria-label*='Stop' i], button[aria-label*='Durdur' i]", "div[role='button'][aria-label*='Stop' i], div[role='button'][aria-label*='Durdur' i]"],
    assistant: [".ds-markdown", "div[class*='ds-markdown']", "div[class*='markdown']"],
    newChat: ["button[aria-label*='New chat']", "a[href='/']"],
    loginMarker: [],
    loginPath: /sign_in|login/i,
    // Measured live in a background tab: timers run but the message list stays empty, even with the
    // visibility told as "visible". config.js NEEDS_FOREGROUND skips it unless focusTab is allowed.
  },
  generic: {
    label: "Generic chat page",
    // Unknown pages: assume the Gemini-like case (draws only while "visible"). Claude is the counter-example.
    keepRendering: true,
    url: "http://127.0.0.1/",
    hosts: ["127.0.0.1", "localhost"],
    composer: ["#prompt-textarea", "textarea", "div[contenteditable='true']"],
    send: ["[data-testid='send-button']", "button[aria-label*='Send']", "button[type='submit']"],
    stop: ["[data-testid='stop-button']", "button[aria-label*='Stop' i], button[aria-label*='Durdur' i]"],
    assistant: ["[data-message-author-role='assistant']", "article", ".message.assistant"],
    newChat: ["[data-testid='create-new-chat-button']", "a[href='/']"],
    loginMarker: [],
    loginPath: /login/i,
  },
};

globalThis.C2F_resolveSite = function resolveSite(site, hostname) {
  const table = globalThis.C2F_SITES;
  if (site && table[site] && (table[site].hosts.includes(hostname) || table.generic.hosts.includes(hostname))) {
    return { key: site, adapter: table[site] };
  }
  for (const [key, adapter] of Object.entries(table)) {
    if (adapter.hosts.includes(hostname)) return { key, adapter };
  }
  return { key: "generic", adapter: table.generic };
};
