import fs from "node:fs";
import { Executor, reportFor, hasDone, doneSummary } from "./executor.js";
import { planPrompt, parsePlan, designPrompt, critiquePrompt, stepPrompt, verifyPrompt, parseReply, critiqueFollowUp, planFollowUp, planRetryFollowUp, stepFollowUp, verifyFollowUp, planOutline } from "./protocol.js";
import { Router, phaseOf, fmtTimings } from "./router.js";

/**
 * The orchestration loop. Every piece of code comes from the web chat model;
 * the local model only compresses context and clarifies the request.
 */
export class Agent {
  constructor({ cfg, bridge, local, workspace, log = () => {}, ask = null, router = null, onEvent = () => {} }) {
    this.cfg = cfg;
    this.bridge = bridge;
    this.router = router || new Router({ cfg, bridge, log });
    this.local = local;
    this.ws = workspace;
    this.log = log;
    // Structured progress for whoever drives the build (the MCP server reports it to the user).
    this.onEvent = onEvent;
    this.exec = new Executor(workspace, { log, runTimeoutMs: 180_000 });
    this.ask = ask || ((prompt, meta) => this.askModel(prompt, meta));
    this.turns = [];
  }

  async askModel(prompt, { freshChat, label, followUp = null } = {}) {
    // The router picks the site for this phase (design / plan / step / verify), skips any that
    // are disabled, over budget or cooling down, and applies that site's model + reasoning.
    const res = await this.router.ask({
      phase: phaseOf(label),
      prompt,
      // Short message for a chat that already holds the earlier turns; the router sends the
      // full prompt instead when it has to start a new chat (new site, session full, tab lost).
      followUp,
      meta: this.cfg.chatMeta || {},
      freshChat: freshChat ?? this.cfg.freshChatPerRequest,
    });
    this.turns.push({ label, site: res.site, continued: Boolean(res.continued), chars: res.reply.length, preview: res.reply.slice(0, 400), at: Date.now(), timings: res.timings || null });
    this.log(`  ← ${res.site}${res.continued ? " (same chat)" : ""} replied ${res.reply.length} chars${res.ms ? ` in ${Math.round(res.ms / 1000)}s` : ""}`);
    const timing = fmtTimings(res.timings);
    if (timing) this.log(`     ${timing}`);
    this.onEvent({ type: "turn", label, site: res.site, continued: Boolean(res.continued), chars: res.reply.length, ms: res.ms || null });
    return res;
  }

  async context({ files = true } = {}) {
    const tree = this.ws.tree(".");
    let digest = "";
    if (files) {
      const list = this.exec.changedFiles().filter(([rel]) => !rel.endsWith(".lock"));
      if (list.length) digest = await this.local.digest(list, { budget: this.cfg.local.maxDigestChars });
    }
    return { tree, digest };
  }

  async design(goal, tree) {
    const first = await this.ask(designPrompt({ goal, tree }), { label: "design", freshChat: true });
    // The review is a whole extra model turn; it only runs when asked for (cfg.critique).
    if (!this.cfg.critique) return first.reply;
    const critique = await this.ask(critiquePrompt({ goal, design: first.reply }), { label: "critique", freshChat: true, followUp: critiqueFollowUp() });
    return `${first.reply}\n\n--- review round ---\n${critique.reply}`;
  }

  async plan(goal, design, tree) {
    let reply = await this.ask(planPrompt({ goal, design, tree }), { label: "plan", freshChat: true, followUp: planFollowUp({ tree }) });
    let steps = parsePlan(reply.reply);
    if (!steps.length) {
      // One corrective retry: models sometimes answer the plan in prose.
      reply = await this.ask(
        `${planPrompt({ goal, design, tree })}\n\nYour previous reply did not contain a parsable fenced json block. Reply with ONLY the json block this time.`,
        { label: "plan-retry", freshChat: true, followUp: planRetryFollowUp() },
      );
      steps = parsePlan(reply.reply);
    }
    if (!steps.length) throw new Error("the chat model never returned a parsable plan (3 attempts of prose)");
    // A step with neither files nor a check cannot be told apart from one that did nothing.
    const bare = steps.filter((s) => !s.files.length && !s.check);
    if (bare.length) {
      this.log(`plan: ${bare.length} step(s) name no files and no check; asking once for them`);
      const ask = `Your plan has steps with neither "files" nor "check": ${bare.map((s) => `"${s.title}"`).join(", ")}. Resend the COMPLETE json block. Every step needs "files" (what it creates) or a "check" (a headless command that exits 0).`;
      try {
        const again = parsePlan((await this.ask(`${planPrompt({ goal, design, tree })}\n\n${ask}`, { label: "plan-retry", freshChat: true, followUp: ask })).reply);
        if (again.length && again.filter((s) => !s.files.length && !s.check).length < bare.length) steps = again;
      } catch (err) {
        if (/no web chat model answered|did not come back/.test(err.message)) throw err;
      }
    }
    return steps;
  }

  /** Planned files that are not there (or empty), and the failing check if there is one. */
  async gate(step) {
    const missing = (step.files || []).filter((f) => {
      try {
        return !(fs.statSync(this.ws.resolve(f)).size > 0 || fs.statSync(this.ws.resolve(f)).isDirectory());
      } catch {
        return true;
      }
    });
    let check = null;
    if (!missing.length && step.check) {
      const res = await this.ws.run(step.check, { timeoutMs: 180_000 });
      if (res.code !== 0) check = `${step.check} exited with ${res.code}\n${String(res.out).slice(-1500)}`;
    }
    return { missing, check, ok: !missing.length && !check };
  }

  async runStep({ goal, design, step, index, total, seed = "" }) {
    let history = "";
    // Did this step write anything? Reading, listing and running the old tests build nothing, so a
    // step with neither files nor a check only counts once a FILE/APPEND of its own succeeded.
    let worked = false;
    // What happened in the latest round only: that is all a follow-up into the same chat needs.
    let note = "";
    for (let round = 1; round <= this.cfg.maxRoundsPerStep; round++) {
      const { tree, digest } = await this.context();
      const prompt = stepPrompt({
        goal,
        design,
        tree,
        digest,
        step: { ...step, index, total },
        round,
        history,
        feedback: round === 1 ? seed : this.lastFeedback,
      });
      const res = await this.ask(prompt, {
        label: `step ${index + 1} round ${round}`,
        freshChat: this.cfg.freshChatPerRequest,
        followUp: stepFollowUp({ step: { ...step, index, total }, tree, round, note, feedback: round === 1 ? seed : this.lastFeedback }),
      });
      const { ops, errors, text } = parseReply(res.reply);
      if (text) this.log(`     ${text.split("\n").slice(0, 3).join(" | ").slice(0, 240)}`);
      for (const e of errors) this.log(`     ⚠ ${e}`);
      // A parse error means a file the model meant to write was lost. Executing the rest
      // and accepting ### DONE would silently leave that file unwritten, so re-ask.
      if (errors.length) {
        this.keepReply(res.reply, index, round);
        this.lastFeedback = `These parts of your last reply could not be read, so nothing was run:\n${errors
          .map((e) => `- ${e}`)
          .join("\n")}\nResend the COMPLETE reply in the documented format: one "### FILE path" heading per file, each immediately followed by a fenced block, then "### RUN" and "### DONE".`;
        note = `Round ${round}: PARSE ERRORS, nothing executed.\n${errors.map((e) => `- ${e}`).join("\n")}`;
        history += `\n${note}\n`;
        this.log("     ! reply had unparseable instructions, retrying without executing");
        continue;
      }
      if (!ops.length) {
        this.keepReply(res.reply, index, round);
        this.lastFeedback = "Your last reply had no instructions I could read. Resend it in the documented format: one \"### FILE path\" heading per file, each followed by a fenced block with the complete contents, then \"### RUN\" and \"### DONE\" lines. Do not put the files inside JSON.";
        note = `Round ${round}: NO OPS PARSED from your reply.`;
        history += `\n${note}\n`;
        this.log("     ! reply had no parsable ops block, retrying");
        continue;
      }
      this.log(`     → ${ops.map((o) => o.op + (o.path ? `:${o.path}` : "") + (o.cmd ? `:${o.cmd}` : "")).join(", ")}`);
      const results = await this.exec.execute(ops);
      const report = reportFor(ops, results);
      this.lastFeedback = "";
      const failed = results.filter((r) => !r.ok);
      if (results.some((r) => r.ok && ["write", "append"].includes(r.op.op))) worked = true;
      for (const f of failed) this.log(`     ✗ ${f.op.op} ${f.op.path || f.op.cmd}: ${String(f.out).split("\n")[0]}`);
      note = `Round ${round} results:\n${report}`;
      history += `\n${note}\n`;
      if (history.length > 24_000) history = history.slice(-24_000);
      if (hasDone(ops) && !failed.length) {
        // "### DONE" is a claim. The step is finished when what it promised is really there.
        const gate = await this.gate(step);
        if (gate.ok && !step.files?.length && !step.check && !worked) {
          gate.ok = false;
          gate.idle = true;
        }
        if (gate.ok) {
          this.log(`     ✓ ${doneSummary(ops)}`);
          return { ok: true, summary: doneSummary(ops) };
        }
        const why = gate.idle ? "nothing was written in this step (reading files or running existing tests builds nothing; name the files to write, or give the step a check)" : gate.missing.length ? `these planned files do not exist: ${gate.missing.join(", ")}` : `the step's check failed: ${gate.check}`;
        this.lastFeedback = `You wrote DONE, but ${why}. The step is not finished until they are written and the check passes. Write them now.`;
        note += `\nDONE refused: ${why}`;
        history += `\nDONE refused: ${why}\n`;
        this.log(`     ! DONE refused: ${why.split("\n")[0]}`);
        continue;
      }
    }
    this.log(`     ⚠ hit ${this.cfg.maxRoundsPerStep} rounds without done; moving on`);
    return { ok: false, summary: "round limit reached" };
  }

  /** A reply that could not be read is kept, so what the model really wrote can be looked at. */
  keepReply(reply, index, round) {
    try {
      const file = `.c2f/failed/step-${index + 1}-round-${round}.txt`;
      this.ws.write(file, reply);
      this.log(`     (the unreadable reply is saved in ${file})`);
    } catch {
      /* diagnostics only */
    }
  }

  saveState(state) {
    try {
      this.ws.write(".c2f/state.json", JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2));
    } catch {
      /* progress notes only */
    }
  }

  /** The unfinished build of this same request in this workspace, or null. */
  loadState(goal) {
    let state;
    try {
      state = JSON.parse(this.ws.read(".c2f/state.json").text);
    } catch {
      return null;
    }
    const same = (a, b) => String(a).replace(/\s+/g, " ").trim().toLowerCase() === String(b).replace(/\s+/g, " ").trim().toLowerCase();
    if (!state?.steps?.length || state.finished || !same(state.goal, goal)) return null;
    return state;
  }

  async build(goal, { plan = null, approve = null, resume = false } = {}) {
    const saved = resume ? this.loadState(goal) : null;
    if (resume && !saved) this.log("resume: no unfinished build of this request here; starting from the beginning");
    let brief;
    let design = "";
    let steps;
    const results = [];
    if (saved) {
      ({ brief, design, steps } = saved);
      results.push(...(saved.results || []));
      this.log(`resume: ${results.length}/${steps.length} steps were already built; continuing with step ${results.length + 1}`);
    } else {
      brief = await this.local.brief(goal);
      if (brief !== goal) this.log(`brief: ${brief.replace(/\s+/g, " ").slice(0, 300)}`);
      const tree = this.ws.tree(".");
      if (this.cfg.design) {
        this.log("design: asking the chat model for a build plan and a review");
        this.onEvent({ type: "phase", phase: "design" });
        design = await this.design(brief, tree);
        this.ws.write(".c2f/design.md", design);
      }
      this.onEvent({ type: "phase", phase: "plan" });
      steps = plan || (await this.plan(brief, design, tree));
    }
    this.log(`plan: ${steps.length} steps`);
    steps.forEach((s, i) => this.log(`  ${i + 1}. ${s.title}${s.acceptance ? ` — ${s.acceptance}` : ""}`));
    this.onEvent({ type: "plan", steps: steps.map((s) => s.title) });
    const progress = (extra = {}) => this.saveState({ goal, brief, design, steps, results, ...extra });
    progress();

    // The user asked to see the options before anything is written.
    if (approve && !(await approve({ design, steps }))) {
      this.ws.write(".c2f/plan.json", JSON.stringify(steps, null, 2));
      return { steps: steps.length, turns: this.turns, stopped: "awaiting approval" };
    }

    for (let i = results.length; i < steps.length; i++) {
      this.log(`step ${i + 1}/${steps.length}: ${steps[i].title}`);
      this.onEvent({ type: "step", index: i, total: steps.length, title: steps[i].title });
      let done;
      try {
        done = await this.runStep({ goal: brief, design, step: steps[i], index: i, total: steps.length });
      } catch (err) {
        // No model could be reached. Everything built so far stays, and the run can continue later.
        progress({ error: err.message });
        err.message += `\nprogress: ${i}/${steps.length} steps were built and are saved in ${this.ws.root}/.c2f/state.json; ask for the same build again with resume to continue from step ${i + 1}.`;
        throw err;
      }
      results.push({ title: steps[i].title, ok: done.ok, summary: done.summary });
      progress();
      this.onEvent({ type: "step-done", index: i, total: steps.length, title: steps[i].title, ok: done.ok, summary: done.summary });
      if (!done.ok) this.log(`  ! step ${i + 1} did not finish: ${done.summary}`);
    }
    // Steps that said they were done but whose planned files are not there: build them again.
    for (let pass = 1; pass <= (this.cfg.gapRounds ?? 2); pass++) {
      const gaps = [];
      for (let i = 0; i < steps.length; i++) {
        const g = await this.gate(steps[i]);
        if (!g.ok) gaps.push({ i, g });
      }
      if (!gaps.length) break;
      this.log(`gaps: ${gaps.length} step(s) are not really built (${gaps.map((x) => x.i + 1).join(", ")}); reopening (${pass}/${this.cfg.gapRounds ?? 2})`);
      this.onEvent({ type: "phase", phase: "gaps" });
      for (const { i, g } of gaps) {
        const why = g.missing.length ? `these planned files do not exist: ${g.missing.join(", ")}` : `the step's check failed: ${g.check}`;
        let done;
        try {
          done = await this.runStep({ goal: brief, design, step: steps[i], index: i, total: steps.length, seed: `This step was reported finished, but ${why}. Do it properly now.` });
        } catch (err) {
          progress({ error: err.message });
          err.message += `\nprogress: saved in ${this.ws.root}/.c2f/state.json; ask for the same build again with resume to continue.`;
          throw err;
        }
        results[i] = { title: steps[i].title, ok: done.ok, summary: done.summary };
        progress();
      }
    }
    const incomplete = [];
    for (let i = 0; i < steps.length; i++) {
      const g = await this.gate(steps[i]);
      if (!g.ok) incomplete.push(`${steps[i].title} (missing: ${g.missing.join(", ") || "its check fails"})`);
      else if (!results[i]?.ok) incomplete.push(steps[i].title);
    }

    const missingByStep = [];
    for (let i = 0; i < steps.length; i++) missingByStep[i] = (await this.gate(steps[i])).missing;
    const outline = planOutline(steps, missingByStep);
    this.log("verify: asking the chat model to audit the result");
    this.onEvent({ type: "phase", phase: "verify" });
    let verified = false;
    let nudge = "";
    try {
      for (let round = 1; round <= 3 && !verified; round++) {
        const { tree: t, digest } = await this.context({ files: true });
        const res = await this.ask(verifyPrompt({ goal: brief, tree: t, digest, plan: outline }) + nudge, { label: `verify ${round}`, freshChat: true, followUp: verifyFollowUp({ tree: t, plan: outline }) + nudge });
        const { ops } = parseReply(res.reply);
        if (!ops.length) {
          // An empty, truncated or prose-only reply says nothing about the project. Only an
          // explicit "### DONE" (or fixes) is a verdict; treating silence as "all clear" let a
          // reply of "###" pass as a clean audit.
          this.log(`  ! verify ${round}: no verdict in the reply (no fixes and no "### DONE"), asking again`);
          nudge = '\n\nYour previous reply contained neither fixes nor a verdict. Reply with the fixes in the documented format, or with exactly one line: ### DONE all good';
          continue;
        }
        if (ops.length === 1 && ops[0].op === "done") {
          this.log(`verify: ${doneSummary(ops) || "clean"}`);
          verified = true;
          break;
        }
        const results = await this.exec.execute(ops);
        for (const r of results) this.log(`  ${r.ok ? "✓" : "✗"} ${r.op.op} ${r.op.path || r.op.cmd || ""}`);
        if (ops.some((o) => o.op === "done")) verified = true;
      }
    } catch (err) {
      progress({ error: err.message });
      err.message += `\nprogress: all ${steps.length} steps were built; only the final audit failed. Ask for the same build again with resume to run just the audit.`;
      throw err;
    }
    if (!verified) this.log("verify: inconclusive — no round gave a verdict, so the result was not audited");
    progress({ finished: true });
    return { steps: steps.length, turns: this.turns, incomplete, verified, resumed: Boolean(saved) };
  }
}
