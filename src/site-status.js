/** What each chat site's open tab looks like, read through the extension. Read-only. */

export function verdictOf(state) {
  if (state.error) return `error: ${state.error}`;
  if (state.needsLogin || state.loggedOutUI) return "needs login";
  if (state.challenge) return "blocked by a bot check";
  if (state.composerDisabled) return "composer disabled (hard usage limit?)";
  if (!state.composer) return "no composer on that tab";
  return state.limited ? `ready (text works; site notice: ${state.limited.slice(0, 80)})` : "ready";
}

/** One row per site: { site, verdict, ...state }. Never throws for a single site. */
export async function readSiteStates(bridge, sites) {
  const rows = [];
  for (const site of sites) {
    let state;
    try {
      const res = await bridge.inspect({ site, timeoutMs: 40_000, anyPath: true });
      state = res.info || res;
    } catch (err) {
      state = { error: String(err.message || err).slice(0, 160) };
    }
    rows.push({ site, verdict: verdictOf(state), ...state });
  }
  return rows;
}
