import { GuardianError } from "./errors.mjs";
import {
  formatHumanNext,
  formatHumanStatus,
  formatHumanTechnical,
  formatHumanWhy,
  formatPlan,
  formatPlanTechnical,
  guidedHandoffEligibilityIdentity,
  observeRunnerHumanWorkflow,
  projectHumanWorkflow,
  sameGuidedHandoffEligibility,
} from "./human-workflow.mjs";

function message(error) { return error instanceof GuardianError ? `${error.code}: ${error.message}` : error?.message ?? String(error); }
function safeNotify(ctx, text, type) {
  try { ctx.ui.notify(text, type); } catch { console.error(`[aiopago] ${text}`); }
}
function safeMetric(runner, method, ...args) {
  try { return runner.metrics?.[method]?.(...args) ?? null; } catch { return null; }
}

function ledgerDiagnostic(error) {
  const detail = error instanceof GuardianError
    ? `${error.code} — ${String(error.message).replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "")}.`
    : "LEDGER_READ_FAILED — TASK_PLAN.md could not be read or validated.";
  return `Aiopago Ledger invalid:\n${detail.slice(0, 320)}\nRepair TASK_PLAN.md before continuing.`;
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

export function projectGuardianWorkflow(runner, ctx = null) {
  return projectHumanWorkflow(observeRunnerHumanWorkflow(runner, ctx));
}

/** Compatibility formatter: the old detailed status is now only a thin
 * technical presenter over the shared human projection. */
export function formatGuardianStatus(runner, ctx = null) {
  return formatHumanTechnical(projectGuardianWorkflow(runner, ctx));
}

function guidedHandoffFailure(error, projection) {
  const code = error?.code ?? "HANDOFF_FAILED";
  const detail = String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 320);
  const stale = ["HANDOFF_CONSENT_STALE", "HANDOFF_SOURCE_CHANGED", "HANDOFF_RUNNER_CHANGED", "LATCH_GENERATION_MISMATCH"].includes(code);
  const takeover = code === "HUMAN_TAKEOVER_ACTIVE";
  return [
    stale
      ? "Lo stato è cambiato dopo il consenso; l’handoff non è stato avviato."
      : takeover
        ? "Il takeover umano è attivo; l’handoff non è stato avviato."
        : "Handoff guidato non riuscito.",
    `Causa: ${detail}`,
    `Prossima azione: ${projection.nextAction}`,
    `Dettaglio tecnico: ${code}`,
    "Aiopago non ritenterà automaticamente.",
  ].join("\n");
}

function admissionOpen(runner, taskId) {
  return (runner.authorityStorage ?? runner.storage).isAdmissionOpen(taskId);
}

async function adviseHandoff(runner, ctx, guided) {
  if (guided.inFlight || !ctx.hasUI || typeof ctx.getContextUsage !== "function") return;
  const task = readLedgerForHook(runner, ctx, "warning");
  if (!task || !admissionOpen(runner, task.task_id)) return;
  const proposal = runner.contextAdvisor.observe(ctx.getContextUsage());
  if (!proposal) return;
  const expectedEligibility = guidedHandoffEligibilityIdentity(observeRunnerHumanWorkflow(runner, ctx));
  if (!expectedEligibility) return;

  guided.inFlight = true;
  const epoch = guided.shutdownEpoch;
  const percent = Math.round(proposal.percent);
  try {
    const prepare = await ctx.ui.confirm(
      "Aiopago",
      `Contesto al ${percent}% (soglia advisory: ${proposal.thresholdPercent}%).\nHandoff consigliato perché la soglia è stata raggiunta.\n\nPreparare una nuova sessione?`,
    );
    if (!prepare || guided.shutdownEpoch !== epoch) return;
    const currentEligibility = guidedHandoffEligibilityIdentity(observeRunnerHumanWorkflow(runner, ctx));
    if (!sameGuidedHandoffEligibility(expectedEligibility, currentEligibility)
      || !admissionOpen(runner, currentEligibility?.taskId)) {
      safeNotify(ctx, "Lo stato è cambiato mentre la conferma era aperta; l’handoff non è stato avviato. Ispeziona /aio status e conferma di nuovo a una futura advisory.", "warning");
      return;
    }
    await runner.handoffFromCommand(ctx, "confirm", { intent: "guided-advisor", expectedEligibility });
  } catch (error) {
    const projection = projectGuardianWorkflow(runner, ctx);
    safeNotify(ctx, guidedHandoffFailure(error, projection), "error");
  } finally {
    guided.inFlight = false;
  }
}

const USAGE = "Usage: /aio [status [technical] | why | next | plan [technical] | handoff [manual|confirm] | handoff recover <handoff-id> | takeover | resume [handoff-id]]";

export function createGuardianExtension(runner) {
  return function guardianExtension(pi) {
    const guided = { inFlight: false, shutdownEpoch: 0 };
    pi.registerCommand("aio", {
      description: "Aiopago: status, why, next, plan, handoff, takeover, resume",
      handler: async (args, ctx) => runCommand(args, ctx),
    });
    pi.registerCommand("aiopago", {
      description: "Alias of /aio",
      handler: async (args, ctx) => runCommand(args, ctx),
    });
    for (const legacyName of ["eio", "eiopago"]) {
      pi.registerCommand(legacyName, {
        description: "Deprecated alias of /aio",
        handler: async (args, ctx) => {
          safeNotify(ctx, `/${legacyName} is deprecated; use /aio`, "warning");
          return runCommand(args, ctx);
        },
      });
    }

    async function runCommand(args, ctx) {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const subcommand = parts.shift() ?? "status";
      try {
        if (["status", "why", "next", "plan"].includes(subcommand)) {
          const detail = parts.shift() ?? null;
          if (parts.length > 0 || (detail !== null && detail !== "technical") || (["why", "next"].includes(subcommand) && detail !== null)) {
            safeNotify(ctx, USAGE, "warning");
            return;
          }
          const projection = projectGuardianWorkflow(runner, ctx);
          const text = subcommand === "status"
            ? detail === "technical" ? formatHumanTechnical(projection) : formatHumanStatus(projection)
            : subcommand === "why" ? formatHumanWhy(projection)
              : subcommand === "next" ? formatHumanNext(projection)
                : detail === "technical" ? formatPlanTechnical(projection) : formatPlan(projection);
          safeNotify(ctx, text, projection.severity === "error" ? "error" : projection.severity === "attention" ? "warning" : "info");
          return projection;
        }
        if (subcommand === "handoff") {
          const value = parts.shift();
          const identifier = parts.shift();
          if (parts.length > 0) { safeNotify(ctx, USAGE, "warning"); return; }
          if (value === "recover") await runner.recoverHandoffFromCommand(ctx, identifier);
          else await runner.handoffFromCommand(ctx, value ?? "confirm");
          return;
        }
        if (subcommand === "takeover" || subcommand === "pause") {
          if (parts.length > 0) { safeNotify(ctx, USAGE, "warning"); return; }
          await runner.takeoverFromCommand(ctx);
          return;
        }
        if (subcommand === "resume") {
          if (parts.length > 1) { safeNotify(ctx, USAGE, "warning"); return; }
          await runner.resumeFromCommand(ctx, parts[0]);
          return;
        }
        safeNotify(ctx, USAGE, "warning");
      } catch (error) {
        safeNotify(ctx, isLedgerError(error, runner) ? ledgerDiagnostic(error) : message(error), "error");
      }
    }

    pi.on("session_start", (event, ctx) => {
      runner.noteSessionStart?.(event, ctx);
      runner.contextAdvisor.reset();
      safeMetric(runner, "startSession", ctx, event);
    });
    pi.on("session_shutdown", (event, ctx) => {
      guided.shutdownEpoch += 1;
      runner.noteSessionShutdown?.(event, ctx);
      safeMetric(runner, "endSession", ctx, event);
    });

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
      if (!admissionOpen(runner, task.task_id)) {
        safeNotify(ctx, "Aiopago latch engaged: only local /aio commands are admitted", "warning");
        return { action: "handled" };
      }
      return { action: "continue" };
    });

    pi.on("turn_end", async (event, ctx) => {
      safeMetric(runner, "captureModelCall", event, ctx);
      await adviseHandoff(runner, ctx, guided);
    });

    pi.on("tool_call", (event) => {
      try { runner.toolTracker.admit(event.toolCallId, event.toolName, event.input); }
      catch (error) { return { block: true, reason: message(error) }; }
    });
    pi.on("tool_execution_end", (event, ctx) => {
      runner.toolTracker.finish(event.toolCallId, event.isError, event.result, ctx.signal?.aborted === true);
    });
    pi.on("session_before_compact", (_event, ctx) => {
      const task = readLedgerForHook(runner, ctx);
      if (!task || !admissionOpen(runner, task.task_id)) return { cancel: true };
    });
    pi.on("session_before_tree", (_event, ctx) => {
      const task = readLedgerForHook(runner, ctx);
      if (!task || !admissionOpen(runner, task.task_id)) return { cancel: true };
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
