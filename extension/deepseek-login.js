/* Reads the login chat.deepseek.com keeps in the page, for `c2f auth deepseek`. Runs INSIDE the
 * signed-in DeepSeek tab (executeScript), so it must not depend on anything outside this function.
 * The token lives in localStorage (userToken), not in a cookie. Nothing is sent anywhere by this
 * code: the result goes to the local bridge on 127.0.0.1 and is saved by the CLI. */
globalThis.C2F_collectDeepSeekLogin = function collectDeepSeekLogin() {
  const read = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key) out[key] = store.getItem(key) || "";
      }
    } catch {
      /* storage blocked on this page */
    }
    return out;
  };
  const local = read(localStorage);
  const session = read(sessionStorage);
  // Values are stored as JSON, usually {"value": "...", "__version": "0"}.
  const unwrap = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : String(parsed?.value ?? "");
    } catch {
      return String(raw || "");
    }
  };
  let token = "";
  for (const key of ["userToken", "token", "auth_token", "access_token", "accessToken"]) {
    if (local[key]) token = unwrap(local[key]);
    if (token) break;
  }
  const field = (names) => {
    for (const store of [local, session]) {
      for (const [key, value] of Object.entries(store)) if (names.includes(key.toLowerCase())) return unwrap(value);
    }
    return "";
  };
  let wasmUrl = "";
  try {
    wasmUrl = performance.getEntriesByType("resource").map((r) => r.name).find((name) => /sha3.*\.wasm/i.test(name)) || "";
  } catch {
    /* no resource timing */
  }
  // The WASM module is only fetched when a message is first sent, so it is usually not in the timing
  // list yet: hand over the page's script addresses and let the CLI look the module up in them.
  const scripts = [];
  try {
    for (const el of document.scripts) if (el.src) scripts.push(el.src);
    for (const r of performance.getEntriesByType("resource")) if (/\.js(\?|$)/i.test(r.name)) scripts.push(r.name);
  } catch {
    /* no resource timing */
  }
  return {
    scripts: [...new Set(scripts)].slice(0, 80),
    token,
    hif_dliq: field(["hif_dliq", "x-hif-dliq"]),
    hif_leim: field(["hif_leim", "x-hif-leim"]),
    cookie: document.cookie,
    wasmUrl,
    href: location.href,
  };
};
