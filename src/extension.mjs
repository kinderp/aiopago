import { GuardianError } from "./errors.mjs";

function message(error) { return error instanceof GuardianError ? `${error.code}: ${error.message}` : error?.message ?? String(error); }
function safeNotify(ctx, text, type) {
  try { ctx.ui.notify(text, type); } catch { console.error(`[eiopago] ${text}`); }
}

async function adviseHandoff(runner, ctx) {
  if (!ctx.hasUI || typeof ctx.getContextUsage !== "function") return;
  const task = runner.ledger.read();
  if (!runner.storage.isAdmissionOpen(task.task_id)) return;
  const proposal = runner.contextAdvisor.observe(ctx.getContextUsage());
  if (!proposal) return;
  const percent = Math.round(proposal.percent);
  try {
    const prepare = await ctx.ui.confirm(
      "Eiopago",
      `Context: ${percent}% (soglia configurata: ${proposal.thresholdPercent}%)\nHandoff consigliato.\n\nPreparare il passaggio a una nuova sessione?`,
    );
    if (!prepare) return;
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
          const task = runner.ledger.read();
          const latch = runner.storage.ensureLatch(task.task_id);
          const handoff = runner.storage.latestHandoffForTask(task.task_id);
          const recovery = handoff?.manual_recovery?.length ? `\n${handoff.manual_recovery.join("\n")}` : "";
          ctx.ui.notify(`Eiopago latch=${latch.state} generation=${latch.generation} handoff=${handoff?.handoff_id ?? "none"} state=${handoff?.state ?? "none"}${recovery}`, handoff?.state === "HANDOFF_FAILED" ? "warning" : "info");
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
        safeNotify(ctx, message(error), "error");
      }
    }

    pi.on("session_start", () => runner.contextAdvisor.reset());

    pi.on("input", (_event, ctx) => {
      const task = runner.ledger.read();
      if (!runner.storage.isAdmissionOpen(task.task_id)) {
        ctx.ui.notify("Eiopago latch engaged: only local /eio commands are admitted", "warning");
        return { action: "handled" };
      }
      return { action: "continue" };
    });

    pi.on("turn_end", (_event, ctx) => adviseHandoff(runner, ctx));

    pi.on("tool_call", (event) => {
      try { runner.toolTracker.admit(event.toolCallId, event.toolName, event.input); }
      catch (error) { return { block: true, reason: message(error) }; }
    });
    pi.on("tool_execution_end", (event) => {
      runner.toolTracker.finish(event.toolCallId, event.isError);
    });
    pi.on("session_before_compact", () => {
      const task = runner.ledger.read();
      if (!runner.storage.isAdmissionOpen(task.task_id)) return { cancel: true };
    });
    pi.on("session_before_tree", () => {
      const task = runner.ledger.read();
      if (!runner.storage.isAdmissionOpen(task.task_id)) return { cancel: true };
    });
    pi.on("session_before_switch", () => {
      const task = runner.ledger.read();
      if (!runner.storage.isAdmissionOpen(task.task_id) && !runner.consumeReplacementPermit()) return { cancel: true };
    });
  };
}
