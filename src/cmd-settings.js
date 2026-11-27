/**
 * `c2f config | use | models | apply | usage`: look at and change what each web chat model
 * is asked to do (model, reasoning level, search), and how much of each site we may spend.
 */
import path from "node:path";
import {
  SITE_NAMES,
  REASONING,
  TOGGLE,
  PHASES,
  SITE_DEFAULTS,
  loadConfig,
  validate,
  merge,
  DEFAULTS,
  globalConfigPath,
  localConfigPath,
  readConfigFile,
  writeConfigFile,
  setPath,
  unsetPath,
  coerce,
  sitePairs,
} from "./config.js";
import { Limits } from "./limits.js";

const clock = (ms) => new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

/** Check a candidate config file before writing it, so a typo can never break every later run. */
export function assertValid(fileObj, key) {
  const candidate = merge(DEFAULTS, fileObj);
  for (const site of Object.keys(candidate.sites)) candidate.sites[site] = merge(SITE_DEFAULTS, candidate.sites[site]);
  const problems = validate(candidate);
  if (problems.length) throw new Error(`refusing to save ${key}:\n  - ${problems.join("\n  - ")}`);
}

export function makeSettingsCommands({ flags, positional, log, c, dim, die, ensureBridge, makeConfig }) {
  const targetFile = () => (flags.local ? localConfigPath(process.cwd()) : globalConfigPath());

  function save(mutate, label) {
    const file = targetFile();
    const obj = readConfigFile(file);
    mutate(obj);
    assertValid(obj, label);
    writeConfigFile(file, obj);
    return file;
  }

  function showConfig() {
    const cfg = loadConfig(process.cwd());
    log(c.bold("ChatToFree settings"));
    log(dim(`  user defaults : ${globalConfigPath()}`));
    log(dim(`  this project  : ${localConfigPath(process.cwd())}\n`));
    log(`  order         ${cfg.preferredSites.join(" → ")}`);
    log(`  strict        ${cfg.strictSettings ? "on (a setting that cannot be applied fails the request)" : "off (warn and carry on)"}\n`);
    const head = ["site", "on", "model", "reasoning", "search", "per hour", "per day", "cooldown"];
    const rows = Object.entries(cfg.sites).map(([name, s]) => [
      name,
      s.enabled ? "yes" : "NO",
      s.model,
      s.reasoning,
      s.search,
      s.limit.perHour || "∞",
      s.limit.perDay || "∞",
      `${s.limit.cooldownMinutes}m`,
    ]);
    table(head, rows);
    if (Object.keys(cfg.phases).length) {
      log(`\n${c.bold("phases")}`);
      for (const [p, v] of Object.entries(cfg.phases)) log(`  ${p.padEnd(9)} ${Object.entries(v).map(([k, x]) => `${k}=${Array.isArray(x) ? x.join(",") : x}`).join("  ")}`);
    }
    log(dim(`\n  change:  c2f use claude --model "Haiku 5.5" --reasoning low --per-hour 20`));
    log(dim(`           c2f config set phases.design.reasoning high`));
  }

  function table(head, rows) {
    const all = [head, ...rows].map((r) => r.map(String));
    const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
    const line = (r) => `  ${r.map((x, i) => x.padEnd(w[i])).join("  ")}`;
    log(c.bold(line(all[0])));
    for (const r of all.slice(1)) log(line(r));
  }

  async function cmdConfig() {
    const sub = positional[0];
    if (!sub || sub === "show") return showConfig();
    if (sub === "path") {
      log(globalConfigPath());
      log(localConfigPath(process.cwd()));
      return;
    }
    if (sub === "set") {
      const [, key, ...valueParts] = positional;
      if (!key || !valueParts.length) die('usage: c2f config set <key> <value> [--local]   e.g. c2f config set sites.claude.model "Haiku 5.5"');
      const value = coerce(key, valueParts.join(" "));
      const file = save((o) => setPath(o, key, value), `${key}=${JSON.stringify(value)}`);
      log(`${c.green("✓")} ${key} = ${JSON.stringify(value)}  ${dim(`(${file})`)}`);
      return;
    }
    if (sub === "unset") {
      const key = positional[1];
      if (!key) die("usage: c2f config unset <key> [--local]");
      const file = save((o) => unsetPath(o, key), `unset ${key}`);
      log(`${c.green("✓")} ${key} reset to its default  ${dim(`(${file})`)}`);
      return;
    }
    die(`unknown config command "${sub}". Use: show | set | unset | path`);
  }

  /** c2f use <site> --model … --reasoning … : several settings of one site in one go. */
  async function cmdUse() {
    const site = positional[0];
    if (!site) die(`usage: c2f use <site> [--model X] [--reasoning ${REASONING.join("|")}] [--search on|off] [--per-hour N] [--per-day N] [--cooldown MIN] [--timeout MS] [--enable|--disable]`);
    if (!SITE_NAMES.includes(site) && !flags.force) die(`unknown site "${site}" (${SITE_NAMES.join(", ")})`);
    const pairs = sitePairs(site, {
      model: flags.model,
      reasoning: flags.reasoning,
      search: flags.search,
      perHour: flags["per-hour"],
      perDay: flags["per-day"],
      cooldown: flags.cooldown,
      timeout: flags.timeout,
      enable: flags.enable,
      disable: flags.disable,
    });
    if (!pairs.length) die("nothing to change; pass at least one option (see c2f help)");
    const file = save((o) => {
      for (const [k, v] of pairs) setPath(o, k, v);
    }, `use ${site}`);
    for (const [k, v] of pairs) log(`${c.green("✓")} ${k} = ${JSON.stringify(v)}`);
    log(dim(`  saved to ${file}`));
  }

  async function withBridge(fn) {
    const cfg = makeConfig();
    const bridge = await ensureBridge(cfg);
    try {
      return await fn(cfg, bridge);
    } finally {
      await bridge.stop();
    }
  }

  function printSite(site, r) {
    log(`\n${c.bold(site)}`);
    if (r.error) return log(`  ${c.red("✗")} ${r.error}`);
    const m = r.model;
    if (!m.supported) log(`  model      ${dim(r.note ? `not available (${r.note})` : "no model picker on this account")}`);
    else
      log(
        `  model      ${m.options
          .map((o) => (o.selected ? c.green(`${o.title} ●`) : o.locked ? dim(`${o.title} 🔒`) : o.title))
          .join("   ")}`,
      );
    const q = r.reasoning;
    if (!q.supported) log(`  reasoning  ${dim("not available")}`);
    else if (q.kind === "toggle") log(`  reasoning  ${q.options.map((o) => (o.level === q.current ? c.green(`${o.level} ●`) : o.level)).join("   ")}  ${dim("(on/off only)")}`);
    else log(`  reasoning  ${q.options.map((o) => ((o.level || o.title) === q.current ? c.green(`${o.level || o.title} ●`) : o.level || o.title)).join("   ")}`);
    if (r.search?.supported) log(`  search     ${["off", "on"].map((x) => (x === r.search.current ? c.green(`${x} ●`) : x)).join("   ")}`);
  }

  async function cmdModels() {
    const sites = positional.length ? positional : SITE_NAMES;
    await withBridge(async (_cfg, bridge) => {
      const all = {};
      for (const site of sites) {
        try {
          all[site] = (await bridge.settings({ site, op: "read" })).result;
        } catch (err) {
          all[site] = { error: err.message };
        }
      }
      if (flags.json) return log(JSON.stringify(all, null, 2));
      log(c.bold("what each site offers right now") + dim("   ● = selected   🔒 = needs a paid plan"));
      for (const [site, r] of Object.entries(all)) printSite(site, r);
      log(dim("\nset one:  c2f use <site> --model <name> --reasoning <level>"));
    });
  }

  /** Apply the configured settings now, without sending a message: a dry run you can see. */
  async function cmdApply() {
    await withBridge(async (cfg, bridge) => {
      const sites = positional.length ? positional : cfg.preferredSites.filter((s) => cfg.sites[s]?.enabled !== false);
      for (const site of sites) {
        const s = cfg.sites[site];
        if (!s) {
          log(`${c.red("✗")} ${site}: not configured`);
          continue;
        }
        try {
          const res = (await bridge.settings({ site, op: "apply", settings: { model: s.model, reasoning: s.reasoning, search: s.search } })).result;
          const applied = Object.entries(res.applied).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing to change";
          log(`${c.green("✓")} ${site.padEnd(9)} ${applied}`);
          for (const w of res.warnings) log(`    ${c.yellow("!")} ${w}`);
        } catch (err) {
          log(`${c.red("✗")} ${site.padEnd(9)} ${err.message}`);
        }
      }
    });
  }

  async function cmdUsage() {
    const cfg = loadConfig(process.cwd());
    const limits = new Limits();
    if (flags.reset) {
      const site = flags.reset === true ? positional[0] : flags.reset;
      limits.clear(site);
      log(`${c.green("✓")} ${site ? `${site} budget and cooldown cleared` : "all budgets and cooldowns cleared"}`);
      return;
    }
    log(c.bold("usage (this tool's requests, shared by every terminal)"));
    const rows = limits.status(cfg).map((r) => [
      r.site,
      r.enabled ? "yes" : "NO",
      `${r.lastHour}${r.perHour ? `/${r.perHour}` : ""}`,
      `${r.lastDay}${r.perDay ? `/${r.perDay}` : ""}`,
      r.available ? c.green("available") : c.yellow(r.note || "unavailable"),
    ]);
    table(["site", "on", "last hour", "last 24h", "state"], rows.map((r) => r.map((x) => String(x))));
    log(dim("\n  reset a cooldown:  c2f usage --reset claude      limits: c2f use claude --per-hour 20 --per-day 100"));
  }

  return { cmdConfig, cmdUse, cmdModels, cmdApply, cmdUsage, SITE_NAMES, REASONING, TOGGLE, PHASES, clock, path };
}
