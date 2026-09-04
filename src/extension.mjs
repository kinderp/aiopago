import { ChatgptHumanSidecar } from "./chatgpt-human-sidecar.mjs";
import { GuardianError } from "./errors.mjs";
import { evaluateExternalStatefulToolAdmission } from "./external-tool-profile.mjs";
import { TOOL_PROFILES } from "./safety.mjs";

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

function availableContext(ctx) {
  try {
    const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
    if (!usage || !Number.isFinite(usage.percent)) return "unavailable";
    return `${Math.round(usage.percent)}%`;
  } catch { return "unavailable"; }
}

function externalToolAdmission(runner, ctx, toolName) {
  const model = ctx?.model ?? runner.runtime?.session?.model ?? null;
  if (!model) return { admitted: true, domain: null, reason: "NO_MODEL" };
  let domain;
  try { domain = runner.contextDomains?.resolve?.(model) ?? null; }
  catch { return { admitted: false, domain: null, reason: "CONTEXT_DOMAIN_UNRESOLVED" }; }
  const decision = evaluateExternalStatefulToolAdmission(domain, toolName, TOOL_PROFILES);
  return { admitted: decision.admitted, domain, reason: decision.reason };
}

function canCreateChatgptSidecar(runner) {
  return Boolean(
    runner?.contextDomains
    && runner?.contextCursors
    && runner?.contextState
    && runner?.ledger
    && runner?.handoffService
    && runner?.contextSync,
  );
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
    "Aiopago status",
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

function formatSidecarStatus(status) {
  const cursor = status.cursor?.entry_id ?? "ROOT";
  return [
    "ChatGPT human sidecar",
    "Transport: human copy/paste (not automated ChatGPT Normal)",
    `State: ${status.delivery_state}`,
    `Transfer: ${status.transfer_id ?? "none"}`,
    `Attempt: ${status.attempt}`,
    `Cursor: ${cursor}`,
  ].join("\n");
}

async function adviseHandoff(runner, ctx) {
  if (!ctx.hasUI || typeof ctx.getContextUsage !== "function") return;
  const task = readLedgerForHook(runner, ctx, "warning");
  if (!task || !runner.storage.isAdmissionOpen(task.task_id)) return;
  const proposal = runner.contextAdvisor.observe(ctx.getContextUsage());
  if (!proposal) return;
  safeMetric(runner, "recordHandoffEvent", "SUGGESTED", { ctx, threshold_percent: proposal.thresholdPercent, reason: "CONTEXT_THRESHOLD_REACHED" });
  const percent = Math.round(proposal.percent);
  try {
    const prepare = await ctx.ui.confirm("Aiopago", `Context: ${percent}% (soglia configurata: ${proposal.thresholdPercent}%)\nHandoff consigliato.\n\nPreparare il passaggio a una nuova sessione?`);
    if (!prepare) return;
    safeMetric(runner, "recordHandoffEvent", "PREPARED", { ctx, threshold_percent: proposal.thresholdPercent, reason: "USER_CONSENTED_TO_ADVISORY" });
    ctx.ui.setEditorText("/aio handoff confirm");
    safeNotify(ctx, "Comando /aio handoff confirm preparato. Premi Invio per avviare il percorso M1-H0.", "info");
  } catch (error) {
    safeNotify(ctx, `Context Handoff Advisor non disponibile: ${message(error)}`, "warning");
  }
}

export function createGuardianExtension(runner) {
  const chatgptSidecar = canCreateChatgptSidecar(runner)
    ? new ChatgptHumanSidecar({
        contextDomains: runner.contextDomains,
        cursorBook: runner.contextCursors,
        stateStore: runner.contextState,
        ledger: runner.ledger,
        observeGit: () => runner.handoffService.observeGit(),
        evidenceProvider: runner.contextSync.evidenceProvider ?? (() => []),
        hydrationBudget: runner.contextSync.hydrationBudget,
      })
    : null;

  return function guardianExtension(pi) {
    pi.registerCommand("aio", { description: "Aiopago: /aio handoff [manual|confirm] | handoff recover <handoff-id> | takeover | resume [handoff-id] | status", handler: async (args, ctx) => runCommand(args, ctx) });
    pi.registerCommand("aiopago", { description: "Alias of /aio", handler: async (args, ctx) => runCommand(args, ctx) });
    if (chatgptSidecar) {
      pi.registerCommand("chatgpt", { description: "Human sidecar: /chatgpt ask <question> | import | status | retry [question]", handler: async (args, ctx) => runChatgptCommand(args, ctx) });
    }
    for (const legacyName of ["eio", "eiopago"]) {
      pi.registerCommand(legacyName, { description: `Deprecated alias of /aio`, handler: async (args, ctx) => { safeNotify(ctx, `/${legacyName} is deprecated; use /aio`, "warning"); return runCommand(args, ctx); } });
    }

    async function runChatgptCommand(args, ctx) {
      const raw = String(args ?? "").trim();
      const separator = raw.indexOf(" ");
      const subcommand = raw.length === 0 ? "status" : separator < 0 ? raw : raw.slice(0, separator);
      const rest = separator < 0 ? "" : raw.slice(separator + 1).trim();
      try {
        if (subcommand === "status") {
          if (rest) throw new GuardianError("CHATGPT_SIDECAR_USAGE_INVALID", "/chatgpt status takes no arguments");
          safeNotify(ctx, formatSidecarStatus(chatgptSidecar.status()), "info");
          return;
        }

        const task = readLedgerForHook(runner, ctx);
        if (!task) return;
        if (!runner.storage.isAdmissionOpen(task.task_id)) {
          throw new GuardianError("CHATGPT_SIDECAR_ADMISSION_BLOCKED", "Aiopago latch is engaged; human sidecar mutation is unavailable until admission reopens");
        }
        await ctx.waitForIdle?.();

        if (subcommand === "ask") {
          const result = chatgptSidecar.ask({ sessionManager: ctx.sessionManager, question: rest });
          safeNotify(ctx, `ChatGPT sidecar capsule copied (${result.clipboard_chars} chars). Paste it into ordinary ChatGPT, copy the reply, then run /chatgpt import. No automated ChatGPT transport was used.`, "info");
          return result;
        }
        if (subcommand === "import") {
          if (rest) throw new GuardianError("CHATGPT_SIDECAR_USAGE_INVALID", "/chatgpt import takes no arguments");
          const result = chatgptSidecar.importReply({ sessionManager: ctx.sessionManager });
          const detail = result.response_chars === null ? "existing persisted reply reconciled" : `${result.response_chars} chars imported`;
          safeNotify(ctx, `ChatGPT sidecar: ${detail}; cursor acknowledged. No Pi model was invoked. Continue normally or switch with /model.`, "info");
          return result;
        }
        if (subcommand === "retry") {
          const result = chatgptSidecar.retry({ sessionManager: ctx.sessionManager, question: rest || undefined });
          safeNotify(ctx, `ChatGPT sidecar retry prepared (attempt ${chatgptSidecar.status().attempt}) and copied to clipboard. Paste it into ordinary ChatGPT, then copy the reply and run /chatgpt import.`, "warning");
          return result;
        }
        throw new GuardianError("CHATGPT_SIDECAR_USAGE_INVALID", "Usage: /chatgpt ask <question> | /chatgpt import | /chatgpt status | /chatgpt retry [question]");
      } catch (error) {
        safeNotify(ctx, isLedgerError(error, runner) ? ledgerDiagnostic(error) : message(error), "error");
      }
    }

    async function runCommand(args, ctx) {
      const [subcommand = "status", value, identifier] = args.trim().split(/\s+/);
      try {
        if (subcommand === "status") {
          const handoff = runner.storage.latestHandoffForTask(runner.ledger.read().task_id);
          ctx.ui.notify(formatGuardianStatus(runner, ctx), ["HANDOFF_FAILED", "CONTINUITY_FAILED"].includes(handoff?.state) ? "warning" : "info"); return;
        }
        if (subcommand === "handoff") { if (value === "recover") await runner.recoverHandoffFromCommand(ctx, identifier); else await runner.handoffFromCommand(ctx, value ?? "confirm"); return; }
        if (subcommand === "takeover" || subcommand === "pause") { await runner.takeoverFromCommand(ctx); return; }
        if (subcommand === "resume") { await runner.resumeFromCommand(ctx, value); return; }
        ctx.ui.notify("Usage: /aio handoff [manual|confirm] | /aio handoff recover <handoff-id> | /aio takeover | /aio resume [handoff-id] | /aio status", "warning");
      } catch (error) { safeNotify(ctx, isLedgerError(error, runner) ? ledgerDiagnostic(error) : message(error), "error"); }
    }

    pi.on("session_start", (event, ctx) => { runner.contextAdvisor.reset(); safeMetric(runner, "startSession", ctx, event); });
    pi.on("session_shutdown", (event, ctx) => safeMetric(runner, "endSession", ctx, event));
    pi.on("input", (_event, ctx) => {
      if (runner.calibration) {
        try { runner.requireCalibrationRuntime(ctx.model); } catch (error) { ctx.ui.notify(`RUN INVALID: ${message(error)}`, "error"); return { action: "handled" }; }
      }
      const task = readLedgerForHook(runner, ctx);
      if (!task) return { action: "handled" };
      if (!runner.storage.isAdmissionOpen(task.task_id)) { safeNotify(ctx, "Aiopago latch engaged: only local /aio commands are admitted", "warning"); return { action: "handled" }; }
      return { action: "continue" };
    });

    pi.on("context", (event, ctx) => { const projection = runner.contextSync?.project(event, ctx); if (projection) return { messages: projection.messages }; });
    pi.on("turn_end", async (event, ctx) => { runner.contextSync?.acknowledgeTurn(event, ctx); safeMetric(runner, "captureModelCall", event, ctx); await adviseHandoff(runner, ctx); });
    pi.on("tool_call", (event, ctx) => {
      const admission = externalToolAdmission(runner, ctx, event.toolName);
      if (!admission.admitted) {
        const domainId = admission.domain?.context_domain_id ?? "unknown";
        return { block: true, reason: `EXTERNAL_CONTEXT_TOOL_NOT_ADMITTED: ${domainId}/${event.toolName}/${admission.reason}` };
      }
      try { runner.toolTracker.admit(event.toolCallId, event.toolName, event.input); }
      catch (error) { return { block: true, reason: message(error) }; }
    });
    pi.on("tool_execution_end", (event, ctx) => { runner.toolTracker.finish(event.toolCallId, event.isError, event.result, ctx.signal?.aborted === true); });
    pi.on("session_before_compact", (_event, ctx) => { const task = readLedgerForHook(runner, ctx); if (!task || !runner.storage.isAdmissionOpen(task.task_id)) return { cancel: true }; });
    pi.on("session_before_tree", (_event, ctx) => { const task = readLedgerForHook(runner, ctx); if (!task || !runner.storage.isAdmissionOpen(task.task_id)) return { cancel: true }; });
    pi.on("session_before_switch", (_event, ctx) => { const task = readLedgerForHook(runner, ctx); if (!task) return { cancel: true }; if (!runner.consumeReplacementPermit()) return { cancel: true }; });
    pi.on("session_before_fork", (_event, ctx) => { if (!readLedgerForHook(runner, ctx)) return { cancel: true }; return { cancel: true }; });
  };
}
