/**
 * Prove, on the real sites in your browser, that model / reasoning / search can be changed and
 * read back, then put everything back the way it was. Sends no message.
 *
 * For each site: read the current state, change something that is safe to change, read it back
 * and compare, then restore the original and read again.
 *
 * Works with the screen locked (menu waits follow DOM changes, not timers). A site that cannot
 * be tested (tab stalled, extension not answering) is reported as SKIPPED or FAIL, never as a pass.
 *
 * Usage: node src/live-settings.js [site ...]
 * Exit code: 0 all checked sites passed, 1 a mismatch, 2 nothing could be tested.
 */
import { Bridge } from "./bridge.js";
import { ensureToken } from "./token.js";
import { loadConfig, SITE_NAMES } from "./config.js";

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const sites = wanted.length ? wanted : SITE_NAMES;
const cfg = loadConfig(process.cwd());
const bridge = new Bridge({ port: cfg.port, token: ensureToken(), log: () => {} });
await bridge.start();
if (!(await bridge.waitForClient(40_000))) {
  console.error("extension is not connected");
  await bridge.stop();
  process.exit(2);
}

const read = async (site) => (await bridge.settings({ site, op: "read" })).result;
const apply = async (site, settings) => (await bridge.settings({ site, op: "apply", settings })).result;

/** The first value of `levels` that is not `current`, preferring the cheapest. */
const otherLevel = (options, current) => options.map((o) => o.level || o.title).find((l) => l && l !== current);

const rows = [];
for (const site of sites) {
  const row = { site, checks: [], verdict: "pass" };
  rows.push(row);
  const note = (what, ok, detail = "") => {
    row.checks.push({ what, ok, detail });
    if (!ok && row.verdict === "pass") row.verdict = "FAIL";
  };
  let before;
  try {
    before = await read(site);
  } catch (err) {
    row.verdict = /hidden/.test(err.message) ? "SKIPPED (tab hidden and stalled: bring the browser window forward)" : `FAIL (${err.message.split("\n")[0]})`;
    continue;
  }
  const restore = {};
  try {
    // reasoning
    if (before.reasoning.supported) {
      const cur = before.reasoning.current;
      const target = before.reasoning.kind === "toggle" ? (cur === "on" ? "off" : "on") : otherLevel(before.reasoning.options, cur);
      if (target) {
        restore.reasoning = cur;
        const res = await apply(site, { reasoning: target });
        const after = await read(site);
        note(`reasoning ${cur} -> ${target}`, after.reasoning.current === target && res.applied.reasoning === target, `site shows "${after.reasoning.current}"${res.warnings.length ? `; ${res.warnings.join("; ")}` : ""}`);
      }
    } else note("reasoning", true, "no reasoning control on this account (reported as unsupported)");

    // search toggle
    if (before.search?.supported) {
      const cur = before.search.current;
      const target = cur === "on" ? "off" : "on";
      restore.search = cur;
      await apply(site, { search: target });
      const after = await read(site);
      note(`search ${cur} -> ${target}`, after.search.current === target, `site shows "${after.search.current}"`);
    }

    // model: another model this account can use (never a locked one)
    if (before.model.supported) {
      const cur = before.model.current;
      const other = before.model.options.find((o) => !o.locked && !o.selected && !o.more);
      if (other) {
        restore.model = cur;
        const res = await apply(site, { model: other.title });
        const after = await read(site);
        // A choice the plan quietly refuses is reported, not claimed: either outcome is fine
        // as long as the report and the page agree.
        const took = after.model.current === other.title;
        note(`model ${cur} -> ${other.title}`, took === Boolean(res.applied.model), took ? "changed" : `unchanged, reported: ${res.warnings.join("; ") || "(nothing)"}`);
      } else note("model", true, "no other model available to switch to");
      // a locked model must be refused with a reason and must change nothing
      const locked = before.model.options.find((o) => o.locked);
      if (locked) {
        const was = (await read(site)).model.current;
        const res = await apply(site, { model: locked.title });
        const after = await read(site);
        note(`locked model "${locked.title}" refused`, after.model.current === was && Boolean(res.warnings.length), res.warnings.join("; ") || "(no warning given)");
      }
    }
  } catch (err) {
    note("run", false, err.message.split("\n")[0]);
  } finally {
    // Always put the account back the way it was.
    if (Object.keys(restore).length) {
      try {
        await apply(site, restore);
        const after = await read(site);
        const same =
          (restore.reasoning === undefined || after.reasoning.current === restore.reasoning) &&
          (restore.model === undefined || after.model.current === restore.model) &&
          (restore.search === undefined || after.search?.current === restore.search);
        note(`restored to ${JSON.stringify(restore)}`, same, same ? "" : `still ${after.model.current}/${after.reasoning.current}/${after.search?.current}`);
      } catch (err) {
        note("restore", false, `${err.message.split("\n")[0]} -- CHECK THE SITE'S SETTINGS BY HAND`);
      }
    }
  }
}
await bridge.stop();

for (const r of rows) {
  console.log(`\n${r.site.padEnd(9)} ${r.verdict}`);
  for (const c of r.checks) console.log(`   ${c.ok ? "ok  " : "FAIL"} ${c.what}${c.detail ? `  — ${c.detail}` : ""}`);
}
const tested = rows.filter((r) => !r.verdict.startsWith("SKIPPED"));
console.log(`\n${tested.length}/${rows.length} sites tested, ${tested.filter((r) => r.verdict === "pass").length} passed`);
process.exit(!tested.length ? 2 : tested.every((r) => r.verdict === "pass") ? 0 : 1);
