import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Local model = middleman. It never writes code; it compresses context so the
 * big web chat model gets a short, high-signal prompt, and it keeps the
 * relayed conversation digestible across rounds.
 *
 * Speaks the OpenAI-compatible /v1/chat/completions API (llama-server, Ollama,
 * LM Studio, Unsloth).
 */
export class LocalModel {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.cacheDir = path.join(process.env.LOCALAPPDATA || process.env.HOME || ".", "ChatToFree", "digest-cache");
    this.reachable = null;
  }

  get enabled() {
    return this.cfg?.enabled !== false;
  }

  async available() {
    if (!this.enabled) return false;
    if (this.reachable !== null) return this.reachable;
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/models`, {
        signal: AbortSignal.timeout(2500),
      });
      this.reachable = res.ok;
    } catch {
      this.reachable = false;
    }
    return this.reachable;
  }

  async modelName() {
    if (this.cfg.model && this.cfg.model !== "auto") return this.cfg.model;
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      const first = data?.data?.[0]?.id;
      if (first) return first;
    } catch {
      /* fall through */
    }
    return "local-model";
  }

  async complete(prompt, { maxTokens = 900, temperature = 0.2, system } = {}) {
    if (!(await this.available())) return null;
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: await this.modelName(),
          temperature,
          max_tokens: maxTokens,
          messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      return typeof text === "string" && text.trim() ? text.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Condense files for the big model. Cached by content hash so re-runs are free.
   * Falls back to head+tail truncation when the local model is down.
   */
  async digest(files, { budget = this.cfg?.maxDigestChars || 12_000 } = {}) {
    const parts = [];
    for (const [rel, text] of files) {
      if (text.length <= 6000) {
        parts.push(`## ${rel}\n${text}`);
        continue;
      }
      const key = crypto.createHash("sha256").update(`${rel}\n${text}`).digest("hex").slice(0, 24);
      const cached = this.readCache(key);
      if (cached) {
        parts.push(`## ${rel} (digest)\n${cached}`);
        continue;
      }
      const summary = await this.complete(
        `Summarize this file for another engineer who must edit it without reading it in full. Keep: imports, exported names with signatures, data shapes, invariants, TODO/bugs, and anything surprising. Drop boilerplate. Max 350 words.\n\nFILE: ${rel}\n\n${text.slice(0, 60_000)}`,
        { maxTokens: 700 },
      );
      const body = summary || `${text.slice(0, 2600)}\n... (${text.length} chars, cut)\n${text.slice(-1600)}`;
      this.writeCache(key, body);
      parts.push(`## ${rel}${summary ? " (digest)" : " (truncated)"}\n${body}`);
    }
    let out = parts.join("\n\n");
    if (out.length > budget) out = `${out.slice(0, budget)}\n... (digest truncated)`;
    return out;
  }

  /** Turn a vague human goal into a spec the big model can act on. */
  async brief(goal) {
    const text = await this.complete(
      `Rewrite this software request as an actionable spec in at most 180 words. Keep the user's intent and constraints, name the likely stack, list the deliverables, and list 3 open questions ONLY if they block implementation. Do not invent features.\n\nREQUEST:\n${goal}`,
      { maxTokens: 400 },
    );
    return text || goal;
  }

  cachePath(key) {
    return path.join(this.cacheDir, `${key}.txt`);
  }

  readCache(key) {
    try {
      return fs.readFileSync(this.cachePath(key), "utf8");
    } catch {
      return null;
    }
  }

  writeCache(key, text) {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(this.cachePath(key), text);
    } catch {
      /* cache is best effort */
    }
  }
}
