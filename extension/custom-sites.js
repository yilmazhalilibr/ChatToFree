/* Custom chat sites: connect ChatToFree to ANY web chat by recording it once.
 *
 * The four built-in adapters cover the big models. Everything else is learned the way a
 * human would learn it: open the page, point at the composer, point at the send control,
 * point at one reply. Those three elements become a selector set stored in
 * chrome.storage.local under `customSites`, and the service worker merges them over the
 * built-in table.
 *
 * Selectors prefer stable hooks (data-testid, name, aria-label) over generated ids and fall
 * back to a structural nth-of-type path, so a redesign does not silently break them.
 */

const UNSTABLE_ID = /^(react|radix|headlessui|ember|:r\d)|[0-9a-f]{8,}|\d{4,}/i;

/** Describe an element as a selector a human could have written. */
globalThis.C2F_describeElement = function describeElement(el) {
  if (!el || el.nodeType !== 1) return null;
  const esc = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&"));
  const tag = el.tagName.toLowerCase();

  if (el.id && !UNSTABLE_ID.test(el.id)) return `#${esc(el.id)}`;

  for (const attr of ["data-testid", "data-test-id", "data-test", "name", "aria-label", "placeholder"]) {
    const v = el.getAttribute(attr);
    if (!v || v.length > 60) continue;
    return `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`;
  }
  if (el.getAttribute("role") === "textbox") return `${tag}[role="textbox"]`;

  const parts = [];
  for (let node = el; node && node.nodeType === 1 && parts.length < 8; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) break;
    const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
    parts.unshift(sameTag.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${sameTag.indexOf(node) + 1})` : node.tagName.toLowerCase());
    if (parent === document.body) break;
  }
  return parts.join(" > ") || null;
};

/**
 * Merge user-recorded sites over the built-ins. A recording may extend a built-in (adding a
 * missing selector) but never replace one, so a bad recording cannot break a working site.
 */
globalThis.C2F_mergeCustomSites = function mergeCustomSites(builtins, custom) {
  const out = { ...builtins };
  for (const site of custom || []) {
    if (!site || !site.key || !Array.isArray(site.hosts) || !site.hosts.length) continue;
    if (builtins[site.key]) continue;
    out[site.key] = {
      ...(builtins.generic || {}),
      ...site,
      label: site.label || site.key,
      url: site.url || `https://${site.hosts[0]}/`,
      custom: true,
    };
  }
  return out;
};

/** Build a site record from the three elements the user pointed at. */
globalThis.C2F_buildSite = function buildSite({ key, label, host, composer, send, assistant }) {
  const clean = (s) => String(s || "").trim();
  const site = {
    key: clean(key).toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
    label: clean(label) || clean(key),
    hosts: [clean(host).toLowerCase()],
    url: `https://${clean(host).toLowerCase()}/`,
    composer: [clean(composer)].filter(Boolean),
    send: [clean(send)].filter(Boolean),
    stop: [],
    assistant: [clean(assistant)].filter(Boolean),
    newChat: [],
    loginMarker: [],
    custom: true,
  };
  if (!site.key || !site.hosts[0] || !site.composer.length) {
    throw new Error("a name, a host and a composer are required");
  }
  if (!site.assistant.length) throw new Error("point at one reply so answers can be read");
  return site;
};
