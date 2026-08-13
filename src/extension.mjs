import { GuardianError } from "./errors.mjs";

function message(error) { return error instanceof GuardianError ? `${error.code}: ${error.message}` : error?.message ?? String(error); }
function safeNotify(ctx, text, type) {
  try { ctx.ui.notify(text, type); } catch { console.error(`[eiopago] ${text}`); }
}
function safeMetric(runner, method, ...args) {
  try { return runner.metrics?.[method]?.(...args) ?? null; } catch { return null; }
}

function ledgerDiagnostic(error) {
  const detail = error instanceof GuardianError
    ? `${error.code} — ${String(error.message).replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "")}.`
    : "LEDGER_READ_FAILED — TASK_PLAN.md could not be read or validated.";
  return `Eiopago Ledger invalid:\n${detail.slice(0, 320)}\nRepair TASK_PLAN.md before continuing.`;
}
function isLedgerError(error, runner) {
  if (error instanceof GuardianError && /^(LEDGER_|DONE_|OWNER_GATE_)/.test(error.code)) return true;
  return typeof error?.path === "string" && error.path === runner.ledger.path;
}
function readLedgerForHook(runner, ctx, type = "error") {
  try { return runner.ledger.read(); }
  catch (error) {
    safeNotify(ctx, ledgerDiagnostic(error), type);
    return null;
  }
}

function availableContext(ctx) {
  try {
    const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
    if (!usage || !Number.isFinite(usage.percent)) return "unavailable";
    return `${Math.round(usage.percent)}%`;
  } catch { return "unavailable"; }
}

export function formatGuardianStatus(runner, ctx = null) {
  const task = runner.ledger.read();
  const latch = runner.storage.ensureLatch(task.task_id);
  const handoff = runner.storage.latestHandoffForTask(task.task_id);
  const session = runner.runtime?.session ?? null;
  const git = runner.handoffService.observeGit();
  const binding = handoff?.target_session_id === session?.sessionId
    ? runner.storage.getRunnerSessionBinding(handoff.handoff_id)
    : null;
  const model = session?.model?.provider && session?.model?.id ? `${session.model.provider}/${session.model.id}` : "unavailable";
  const ownership = binding
    ? `Runner-owned replacement (${binding.status})`
    : "Runner-owned source";
  return [
    "Eiopago status",
    `Target repository: ${runner.roots.targetRoot}`,
    `Git: branch=${git.branch || "detached"} HEAD=${git.head_sha ?? "unborn"}`,
    `Worktree: ${git.workdir}`,
    `Task: ${task.task_id} revision=${task.plan_revision_id} status=${task.status}`,
    `Current item: ${task.current_item ?? "none"}`,
    `Next item: ${task.next_item ?? "none"}`,
    `Runner ownership: ${ownership}; instance=${runner.runnerInstanceId}`,
    `Session: ${session?.sessionId ?? "unavailable"}; model=${model}; reasoning=${session?.thinkingLevel ?? "unavailable"}`,
    `Latch: ${latch.state}; generation=${latch.generation}; reason=${latch.reason ?? "none"}`,
    `Human takeover: ${latch.reason === "HUMAN_TAKEOVER" ? "ACTIVE" : "inactive"}`,
    `Handoff: ${handoff?.handoff_id ?? "none"}; state=${handoff?.state ?? "none"}`,
    `Advisor/context: ${availableContext(ctx)}; threshold=${runner.contextAdvisor?.thresholdPercent ?? "unavailable"}%`,
    ...(handoff?.manual_recovery ?? []),
  ].join("\n");
}

async function adviseHandoff(runner, ctx) {
  if (!ctx.hasUI || typeof ctx.getContextUsage !== "function") return;
  const task = readLedgerForHook(runner, ctx, "warning");
  if (!task || !runner.storage.isAdmissionOpen(task.task_id)) return;
  const proposal = runner.contextAdvisor.observe(ctx.getContextUsage());
  if (!proposal) return;
  safeMetric(runner, "recordHandoffEvent", "SUGGESTED", {
    ctx,
    threshold_percent: proposal.thresholdPercent,
    reason: "CONTEXT_THRESHOLD_REACHED",
  });
  const percent = Math.round(proposal.percent);
  try {
    const prepare = await ctx.ui.confirm(
      "Eiopago",
      `Context: ${percent}% (soglia configurata: ${proposal.thresholdPercent}%)\nHandoff consigliato.\n\nPreparare il passaggio a una nuova sessione?`,
    );
    if (!prepare) return;
    safeMetric(runner, "recordHandoffEvent", "PREPARED", {
      ctx,
      threshold_percent: proposal.thresholdPercent,
      reason: "USER_CONSENTED_TO_ADVISORY",
    });
    ctx.ui.setEditorText("/eio handoff confirm");
    safeNotify(ctx, "Comando /eio handoff confirm preparato. Premi Invio per avviare il percorso M1-H0.", "info");
  } catch (error) {
    safeNotify(ctx, `Context Handoff Advisor non disponibile: ${message(error)}`, "warning");
  }
}

export function createGuardianExtension(runner) {
  return function guardianExtension(pi) {
    pi.registerCommand("eio", {
      description: "Eiopago: /eio handoff [manual|confirm] | takeover | resume [handoff-id] | status",
      handler: async (args, ctx) => runCommand(args, ctx),
    });
    pi.registerCommand("eiopago", {
      description: "Alias of /eio",
      handler: async (args, ctx) => runCommand(args, ctx),
    });

    async function runCommand(args, ctx) {
      const [subcommand = "status", value] = args.trim().split(/\s+/);
      try {
        if (subcommand === "status") {
          const handoff = runner.storage.latestHandoffForTask(runner.ledger.read().task_id);
          ctx.ui.notify(formatGuardianStatus(runner, ctx), handoff?.state === "HANDOFF_FAILED" ? "warning" : "info");
          return;
        }
        if (subcommand === "handoff") {
          const mode = value ?? "confirm";
          await runner.handoffFromCommand(ctx, mode);
          return;
        }
        if (subcommand === "takeover" || subcommand === "pause") {
          await runner.takeoverFromCommand(ctx);
          return;
        }
        if (subcommand === "resume") {
          await runner.resumeFromCommand(ctx, value);
          return;
        }
        ctx.ui.notify("Usage: /eio handoff [manual|confirm] | /eio takeover | /eio resume [handoff-id] | /eio status", "warning");
      } catch (error) {
        safeNotify(ctx, isLedgerError(error, runner) ? ledgerDiagnostic(error) : message(error), "error");
      }
    }

    pi.on("session_start", (event, ctx) => {
      runner.contextAdvisor.reset();
      safeMetric(runner, "startSession", ctx, event);
    });
    pi.on("session_shutdown", (event, ctx) => safeMetric(runner, "endSession", ctx, event));

    pi.on("input", (_event, ctx) => {
      if (runner.calibration) {
        try { runner.requireCalibrationRuntime(ctx.model); }
        catch (error) {
          ctx.ui.notify(`RUN INVALID: ${message(error)}`, "error");
          return { action: "handled" };
        }
      }
      const task = readLedgerForHook(runner, ctx);
      if (!task) return { action: "handled" };
      if (!runner.storage.isAdmissionOpen(task.task_id)) {
        safeNotify(ctx, "Eiopago latch engaged: only local /eio commands are admitted", "warning");
        return { action: "handled" };
      }
      return { action: "continue" };
    });

    pi.on("turn_end", async (event, ctx) => {
      safeMetric(runner, "captureModelCall", event, ctx);
      await adviseHandoff(runner, ctx);
    });

    pi.on("tool_call", (event) => {
      try { runner.toolTracker.admit(event.toolCallId, event.toolName, event.input); }
      catch (error) { return { block: true, reason: message(error) }; }
    });
    pi.on("tool_execution_end", (event) => {
      runner.toolTracker.finish(event.toolCallId, event.isError);
    });
    pi.on("session_before_compact", (_event, ctx) => {
      const task = readLedgerForHook(runner, ctx);
      if (!task || !runner.storage.isAdmissionOpen(task.task_id)) return { cancel: true };
    });
    pi.on("session_before_tree", (_event, ctx) => {
      const task = readLedgerForHook(runner, ctx);
      if (!task || !runner.storage.isAdmissionOpen(task.task_id)) return { cancel: true };
    });
    pi.on("session_before_switch", (_event, ctx) => {
      const task = readLedgerForHook(runner, ctx);
      if (!task) return { cancel: true };
      if (!runner.consumeReplacementPermit()) return { cancel: true };
    });
    pi.on("session_before_fork", (_event, ctx) => {
      if (!readLedgerForHook(runner, ctx)) return { cancel: true };
      return { cancel: true };
    });
  };
}
