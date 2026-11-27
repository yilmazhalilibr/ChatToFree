import fs from "node:fs";
import path from "node:path";
import { globalConfigPath } from "./config.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function usagePath() {
  return path.join(path.dirname(globalConfigPath()), "usage.json");
}

/**
 * Parse when a site says it will work again: "05:23" (next time the clock shows that),
 * "in 3 hours", "45 dakika", "2 saat". Returns an epoch ms or null.
 */
export function parseResetTime(text, now = Date.now()) {
  const t = String(text || "");
  const rel = /(\d+)\s*(saat|hours?|hrs?|h)\b/i.exec(t);
  const relMin = /(\d+)\s*(dakika|dk|minutes?|mins?|m)\b/i.exec(t);
  if (rel || relMin) {
    return now + (rel ? Number(rel[1]) * HOUR : 0) + (relMin ? Number(relMin[1]) * 60_000 : 0);
  }
  const clock = /(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/.exec(t);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

/**
 * How much of each site's budget this tool has spent, and which sites are cooling down after
 * the site itself reported a usage limit. Stored in one small JSON file shared by every
 * terminal, so two sessions cannot each spend the whole hour.
 */
export class Limits {
  constructor({ file = usagePath(), now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /** Can this site take a request now? `limit` is sites.<name>.limit from the config. */
  check(site, limit = {}) {
    const now = this.now();
    const s = this.load()[site] || {};
    if (s.cooldownUntil && s.cooldownUntil > now) {
      return { ok: false, retryAt: s.cooldownUntil, reason: `cooling down until ${hhmm(s.cooldownUntil)}${s.reason ? ` (${String(s.reason).slice(0, 80)})` : ""}` };
    }
    const hits = (s.hits || []).filter((t) => t > now - DAY);
    for (const [windowMs, max, name] of [
      [HOUR, limit.perHour, "hour"],
      [DAY, limit.perDay, "day"],
    ]) {
      if (!max) continue;
      const inWindow = hits.filter((t) => t > now - windowMs);
      if (inWindow.length >= max) {
        const retryAt = Math.min(...inWindow) + windowMs;
        return { ok: false, retryAt, reason: `budget of ${max}/${name} used up, free again at ${hhmm(retryAt)}` };
      }
    }
    return { ok: true };
  }

  /** Count one request against the site's budget. */
  record(site) {
    const now = this.now();
    const state = this.load();
    const s = state[site] || { hits: [] };
    s.hits = [...(s.hits || []).filter((t) => t > now - DAY), now];
    state[site] = s;
    this.save(state);
  }

  /** The site said it is at its limit: stay away until `until`, or for `minutes` when unknown. */
  trip(site, { until = null, minutes = 60, reason = "" } = {}) {
    const now = this.now();
    const state = this.load();
    const s = state[site] || { hits: [] };
    // A parsed reset in the past or absurdly far ahead is noise: fall back to the cooldown.
    const sane = until && until > now && until < now + 2 * DAY ? until : now + minutes * 60_000;
    s.cooldownUntil = sane;
    s.reason = reason;
    state[site] = s;
    this.save(state);
    return sane;
  }

  clear(site) {
    const state = this.load();
    if (site) delete state[site];
    else for (const k of Object.keys(state)) delete state[k];
    this.save(state);
  }

  /** One row per site for `c2f usage`. */
  status(cfg) {
    const now = this.now();
    const state = this.load();
    return Object.entries(cfg.sites).map(([site, conf]) => {
      const s = state[site] || {};
      const hits = (s.hits || []).filter((t) => t > now - DAY);
      const check = this.check(site, conf.limit);
      return {
        site,
        enabled: conf.enabled,
        lastHour: hits.filter((t) => t > now - HOUR).length,
        lastDay: hits.length,
        perHour: conf.limit.perHour,
        perDay: conf.limit.perDay,
        available: conf.enabled && check.ok,
        note: !conf.enabled ? "disabled" : check.ok ? "" : check.reason,
      };
    });
  }
}
