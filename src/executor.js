/**
 * Deterministic step runner: executes model ops against the workspace and
 * produces a compact report for the next round.
 */
export class Executor {
  constructor(workspace, { log = () => {}, design = true, runTimeoutMs = 120_000 } = {}) {
    this.ws = workspace;
    this.log = log;
    this.design = design;
    this.runTimeoutMs = runTimeoutMs;
    this.touched = new Set();
  }

  async execute(ops) {
    const results = [];
    for (const op of ops) {
      try {
        results.push({ op, ...(await this.one(op)) });
      } catch (err) {
        results.push({ op, ok: false, out: `ERROR: ${err.message}` });
      }
    }
    return results;
  }

  async one(op) {
    switch (op.op) {
      case "write": {
        const out = this.ws.write(op.path, op.content);
        this.touched.add(op.path);
        return { ok: true, out };
      }
      case "append": {
        const out = this.ws.append(op.path, op.content);
        this.touched.add(op.path);
        return { ok: true, out };
      }
      case "read": {
        const { text, truncated } = this.ws.read(op.path);
        return { ok: true, out: `${text}${truncated ? "\n... (truncated)" : ""}` };
      }
      case "list":
        return { ok: true, out: this.ws.tree(op.path || ".") };
      case "delete": {
        const out = this.ws.del(op.path);
        this.touched.delete(op.path);
        return { ok: true, out };
      }
      case "run": {
        const res = await this.ws.run(op.cmd, { timeoutMs: op.timeoutMs || this.runTimeoutMs });
        return { ok: res.code === 0, out: `exit ${res.code} in ${res.ms}ms\n${res.out}` };
      }
      case "done":
        return { ok: true, out: op.summary || "done" };
      default:
        return { ok: false, out: `ERROR: unknown op ${op.op}` };
    }
  }

  /** Files worth sending back to the big model this round. */
  changedFiles(limitBytes = 40_000) {
    const out = [];
    let used = 0;
    for (const rel of this.touched) {
      try {
        const { text } = this.ws.read(rel);
        if (used + text.length > limitBytes) continue;
        used += text.length;
        out.push([rel, text]);
      } catch {
        /* deleted */
      }
    }
    return out;
  }
}

export function reportFor(ops, results) {
  const lines = ops.map((op, i) => {
    const r = results[i];
    const head = `- ${op.op}${op.path ? ` ${op.path}` : ""}${op.cmd ? `: ${op.cmd}` : ""} → ${r?.ok ? "ok" : "FAILED"}`;
    if (!r) return head;
    if (op.op === "read") return `${head}\n${r.out}`;
    if (op.op === "list") return `${head}\n${r.out}`;
    if (op.op === "run") return `${head}\n${r.out}`;
    if (!r.ok) return `${head}\n${r.out}`;
    return head;
  });
  return lines.join("\n") || "No ops were executed (the reply had no valid ops block).";
}

export function hasDone(ops) {
  return ops.some((o) => o.op === "done");
}

export function doneSummary(ops) {
  const d = [...ops].reverse().find((o) => o.op === "done");
  return d?.summary || "step complete";
}
