import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./canonical.mjs";
import { GuardianError } from "./errors.mjs";
import { TaskLedger } from "./ledger.mjs";
import { discoverTargetRepository, readRepositoryConfig, REPOSITORY_CONFIG_FILE } from "./repository.mjs";
import { readRuntimeProjection } from "./runtime-reader.mjs";

const TERMINAL_ITEM_STATES = new Set(["DONE", "DROPPED", "SUPERSEDED"]);
const FAILED_HANDOFF_STATES = new Set([
  "HANDOFF_FAILED", "CHECKPOINT_PERSIST_FAILED", "MANIFEST_PERSIST_FAILED",
  "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "RESUME_DISPATCH_FAILED", "RESUME_DISPATCH_UNKNOWN",
]);
const PREPARING_HANDOFF_STATES = new Set([
  "SAFE_TO_HANDOFF", "CHECKPOINT_PERSISTING", "CHECKPOINT_PERSISTED",
  "REPLACEMENT_SESSION_CREATING", "REPLACEMENT_SESSION_CREATED_PAUSED",
  "MANIFEST_PERSISTING", "MANIFEST_PERSISTED", "RESUME_ADMISSION_COMMITTED",
  "RESUME_DISPATCHING", "RESUME_DISPATCHED",
]);

function boundedText(value, length = 320) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}

function diagnostic(error, fallback = "READ_FAILED") {
  return Object.freeze({
    code: error?.code ?? fallback,
    message: boundedText(error?.message ?? error),
    source: error,
  });
}

function publicDiagnostic(error, fallback = "READ_FAILED") {
  if (!error) return null;
  const result = {
    code: error.code ?? fallback,
    message: boundedText(error.message ?? error),
  };
  if (error.details !== undefined) {
    try { result.details = structuredClone(error.details); } catch { /* diagnostics remain bounded */ }
  }
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function observeRawTaskPlan(path) {
  if (!existsSync(path)) {
    const error = new GuardianError("LEDGER_NOT_FOUND", `Authoritative task plan not found: ${path}`);
    return Object.freeze({ path, exists: false, valid: null, bytes: null, text: null, digest: null, plan: null, error: diagnostic(error) });
  }
  try {
    const bytes = readFileSync(path);
    return Object.freeze({ path, exists: true, valid: null, bytes, text: bytes.toString("utf8"), digest: sha256(bytes), plan: null, error: null });
  } catch (error) {
    return Object.freeze({ path, exists: true, valid: null, bytes: null, text: null, digest: null, plan: null, error: diagnostic(error, "LEDGER_READ_FAILED") });
  }
}

export function observeTaskPlan(path, options = {}) {
  const raw = (options.observeRawTaskPlan ?? observeRawTaskPlan)(path);
  if (!raw.exists || raw.error) return Object.freeze({ ...raw, valid: false });
  try {
    const plan = (options.readTaskLedger ?? (() => new TaskLedger(path).read()))();
    if (plan.content_digest !== raw.digest) throw new GuardianError("PLAN_CHANGED_DURING_READ", "TASK_PLAN.md changed while it was being observed; read it again");
    return Object.freeze({ ...raw, valid: true, plan, error: null });
  } catch (error) {
    return Object.freeze({ ...raw, valid: false, plan: null, error: diagnostic(error, "LEDGER_READ_FAILED") });
  }
}

const EMPTY_RUNTIME = Object.freeze({
  available: false,
  verified: false,
  workflow: "NEEDS_ATTENTION",
  condition: "RUNTIME_NOT_OBSERVED",
  error: Object.freeze({ code: "RUNTIME_NOT_VERIFIED", message: "No canonical core runtime observation was produced" }),
});

export function observeHumanWorkflow(input = process.cwd(), options = {}) {
  const targetRoot = (options.discoverTargetRepository ?? discoverTargetRepository)(input, options.repositoryOptions);
  const configPath = join(targetRoot, REPOSITORY_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return Object.freeze({ initialized: false, targetRoot, repository: null, configError: null, plan: null, runtime: EMPTY_RUNTIME });
  }

  let repository;
  try { repository = (options.readRepositoryConfig ?? readRepositoryConfig)(targetRoot); }
  catch (error) {
    return Object.freeze({ initialized: true, targetRoot, repository: null, configError: diagnostic(error, "REPOSITORY_CONFIG_READ_FAILED"), plan: null, runtime: EMPTY_RUNTIME });
  }

  const plan = options.planMode === "raw"
    ? (options.observeRawTaskPlan ?? observeRawTaskPlan)(repository.taskLedgerPath)
    : (options.observeTaskPlan ?? observeTaskPlan)(repository.taskLedgerPath, options.planOptions);
  const runtime = plan.valid && options.includeRuntime !== false
    ? (options.readRuntimeProjection ?? readRuntimeProjection)(join(repository.runtimeRoot, "guardian.sqlite"), plan.plan, options.runtimeOptions)
    : EMPTY_RUNTIME;
  return Object.freeze({ initialized: true, targetRoot, repository, configError: null, plan, runtime });
}

function safeContextUsage(ctx) {
  try {
    const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
    if (!usage || !Number.isFinite(usage.percent)) return { availability: "unavailable", percent: null, tokens: null, contextWindow: null };
    return {
      availability: "available",
      percent: usage.percent,
      tokens: Number.isFinite(usage.tokens) ? usage.tokens : null,
      contextWindow: Number.isFinite(usage.contextWindow) ? usage.contextWindow : null,
    };
  } catch (error) {
    return { availability: "unavailable", percent: null, tokens: null, contextWindow: null, error: publicDiagnostic(error, "CONTEXT_USAGE_READ_FAILED") };
  }
}

function latchIdentity(latch) {
  return latch ? { state: latch.state, generation: latch.generation, reason: latch.reason ?? null } : null;
}

function handoffIdentity(handoff) {
  return handoff ? {
    handoff_id: handoff.handoff_id,
    state: handoff.state,
    target_session_id: handoff.target_session_id ?? null,
    authorization_state: handoff.authorization_state ?? null,
    admission_state: handoff.admission_state ?? null,
    dispatch_state: handoff.dispatch_state ?? null,
  } : null;
}

function sameIdentity(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

/**
 * Read adapter for the live Runner. It exposes selected facts only: no storage,
 * writer, service, session manager, or callback crosses into the projection.
 */
export function observeRunnerHumanWorkflow(runner, ctx = null, options = {}) {
  const readPlan = options.observeTaskPlan ?? observeTaskPlan;
  const planOptions = { readTaskLedger: () => runner.ledger.read() };
  const firstPlan = readPlan(runner.ledger.path, planOptions);
  const base = {
    initialized: true,
    targetRoot: runner.roots?.targetRoot ?? runner.cwd ?? null,
    repository: {
      taskLedgerPath: runner.ledger.path,
      runtimeRoot: runner.roots?.runtimeRoot ?? null,
      artifactRoot: runner.roots?.artifactRoot ?? null,
    },
    configError: null,
    plan: firstPlan,
  };
  if (!firstPlan.valid) return Object.freeze({ ...base, runtime: EMPTY_RUNTIME });

  try {
    const taskId = firstPlan.plan.task_id;
    const sessionBefore = runner.runtime?.session ?? null;
    if (!sessionBefore?.sessionId) throw new GuardianError("RUNTIME_SESSION_UNAVAILABLE", "The live Runner session cannot be observed");
    const latchBefore = runner.storage.getLatch(taskId);
    if (!latchBefore) throw new GuardianError("RUNTIME_LATCH_UNAVAILABLE", "The live Runner has no latch observation for the authoritative task");
    const handoffBefore = runner.storage.latestHandoffForTask(taskId);
    const git = runner.handoffService.observeGit();
    const context = safeContextUsage(ctx);
    const latchAfter = runner.storage.getLatch(taskId);
    const handoffAfter = runner.storage.latestHandoffForTask(taskId);
    const sessionAfter = runner.runtime?.session ?? null;
    const secondPlan = readPlan(runner.ledger.path, planOptions);
    if (!secondPlan.valid || firstPlan.digest !== secondPlan.digest
      || sessionBefore?.sessionId !== sessionAfter?.sessionId
      || !sameIdentity(latchIdentity(latchBefore), latchIdentity(latchAfter))
      || !sameIdentity(handoffIdentity(handoffBefore), handoffIdentity(handoffAfter))) {
      return Object.freeze({
        ...base,
        plan: secondPlan.valid ? secondPlan : firstPlan,
        runtime: Object.freeze({
          available: true, verified: false, workflow: "NEEDS_ATTENTION", condition: "RUNTIME_CHANGED_DURING_READ",
          error: Object.freeze({ code: "RUNTIME_CHANGED_DURING_READ", message: "Live Runner state changed during observation; observe it again" }),
        }),
      });
    }

    const session = sessionAfter;
    const handoff = handoffAfter;
    const binding = handoff?.target_session_id === session?.sessionId
      ? runner.storage.getRunnerSessionBinding(handoff.handoff_id)
      : null;
    const model = session?.model?.provider && session?.model?.id
      ? `${session.model.provider}/${session.model.id}`
      : null;
    return Object.freeze({
      ...base,
      plan: secondPlan,
      runtime: deepFreeze({
        available: true,
        verified: true,
        workflow: "LIVE_RUNNER",
        condition: "LIVE_RUNNER",
        error: null,
        latch: latchIdentity(latchAfter),
        handoff: handoff ? {
          ...handoffIdentity(handoff),
          failure: publicDiagnostic(handoff.failure, handoff.failure?.code ?? "HANDOFF_FAILED"),
          manual_recovery: Array.isArray(handoff.manual_recovery) ? handoff.manual_recovery.map((line) => boundedText(line, 640)) : [],
        } : null,
        session: {
          id: session?.sessionId ?? null,
          model,
          reasoning: session?.thinkingLevel ?? null,
          runnerInstanceId: runner.runnerInstanceId ?? null,
          ownership: binding ? `replacement:${binding.status}` : "source",
        },
        git: {
          repository: git.repository_id ?? null,
          worktree: git.workdir ?? null,
          branch: git.branch ?? null,
          head: git.head_sha ?? null,
          base: git.base_sha ?? null,
          indexDigest: git.index_digest ?? null,
          worktreeDigest: git.worktree_digest ?? null,
        },
        context: {
          ...context,
          thresholdPercent: runner.contextAdvisor?.thresholdPercent ?? null,
          recommended: context.percent !== null && Number.isFinite(runner.contextAdvisor?.thresholdPercent)
            ? context.percent >= runner.contextAdvisor.thresholdPercent
            : false,
        },
      }),
    });
  } catch (error) {
    return Object.freeze({
      ...base,
      runtime: Object.freeze({
        available: true, verified: false, workflow: "NEEDS_ATTENTION", condition: "RUNTIME_READ_FAILED",
        error: Object.freeze(publicDiagnostic(error, "RUNTIME_READ_FAILED")),
      }),
    });
  }
}

function itemById(plan, id) {
  return id ? plan.task_items.find((item) => item.task_item_id === id) ?? null : null;
}

function progress(plan) {
  const completed = plan.task_items.filter((item) => TERMINAL_ITEM_STATES.has(item.status)).length;
  return { completed, total: plan.task_items.length, remaining: plan.task_items.length - completed };
}

function planSummary(observation) {
  const plan = observation.plan?.valid ? observation.plan.plan : null;
  if (!plan) return null;
  return {
    status: plan.status,
    nextStep: plan.next_step,
    currentItem: plan.current_item,
    nextItem: plan.next_item,
    revision: plan.plan_revision_id,
    taskId: plan.task_id,
    requirementsVersion: plan.requirements_version,
    digest: observation.plan.digest,
    artifact: observation.plan.path,
    modelPolicy: plan.model_policy ?? null,
    reasoningPolicy: plan.reasoning_policy ?? null,
    minimalReads: [...(plan.minimal_reads ?? [])],
    requiredLocalPaths: [...(plan.required_local_paths ?? [])],
    items: plan.task_items.map((item) => ({ id: item.task_item_id, title: item.title, status: item.status })),
  };
}

function baseProjection(observation, fields) {
  const plan = observation.plan?.valid ? observation.plan.plan : null;
  const runtime = observation.runtime ?? EMPTY_RUNTIME;
  const diagnosticError = observation.configError
    ?? (!observation.plan?.valid ? observation.plan?.error : null)
    ?? runtime.error
    ?? (runtime.verified === true ? null : { code: "RUNTIME_NOT_VERIFIED", message: "No canonical core runtime observation was produced" });
  return {
    schema: "aiopago.human-workflow-projection/0.2-e",
    targetRoot: observation.targetRoot ?? null,
    planPath: observation.plan?.path ?? observation.repository?.taskLedgerPath ?? null,
    objective: plan?.objective ?? null,
    title: plan?.title ?? null,
    currentActivity: itemById(plan ?? { task_items: [] }, plan?.current_item)?.title ?? null,
    progress: plan ? progress(plan) : null,
    planSummary: planSummary(observation),
    runtimeSummary: {
      availability: runtime.verified === true ? "available" : runtime.available ? "unverified" : "unavailable",
      verified: runtime.verified === true,
      condition: runtime.condition ?? "RUNTIME_NOT_OBSERVED",
      context: runtime.context ? { ...runtime.context } : null,
    },
    humanControl: {
      latchState: runtime.latch?.state ?? "unverified",
      takeoverState: runtime.latch?.reason === "HUMAN_TAKEOVER" ? "active" : runtime.verified === true ? "inactive" : "unverified",
      reason: runtime.latch?.reason ?? null,
      generation: runtime.latch?.generation ?? null,
    },
    handoff: {
      state: runtime.handoff?.state ?? (runtime.verified === true ? "none" : "unverified"),
      id: runtime.handoff?.handoff_id ?? null,
      actionability: "none",
      recommendation: runtime.context?.recommended === true ? "recommended" : "none",
      recovery: [...(runtime.handoff?.manual_recovery ?? [])],
    },
    technical: {
      diagnostic: publicDiagnostic(diagnosticError, "READ_FAILED"),
      code: diagnosticError?.code ?? null,
      message: boundedText(diagnosticError?.message ?? "") || null,
      plan: plan ? {
        taskId: plan.task_id,
        revision: plan.plan_revision_id,
        status: plan.status,
        requirementsVersion: plan.requirements_version,
        digest: observation.plan.digest,
        currentItem: plan.current_item,
        nextItem: plan.next_item,
      } : null,
      runtime: runtime.verified === true ? {
        session: runtime.session?.id ?? null,
        runnerInstance: runtime.session?.runnerInstanceId ?? null,
        ownership: runtime.session?.ownership ?? null,
        model: runtime.session?.model ?? null,
        reasoning: runtime.session?.reasoning ?? null,
        git: runtime.git ? { ...runtime.git } : null,
        latchGeneration: runtime.latch?.generation ?? null,
        handoffId: runtime.handoff?.handoff_id ?? null,
        handoffState: runtime.handoff?.state ?? null,
        failure: runtime.handoff?.failure ?? null,
      } : null,
    },
    ...fields,
  };
}

function project(state, severity, headline, observation, reason, nextAction, extras = {}) {
  const { handoff: handoffExtras, ...fields } = extras;
  const value = baseProjection(observation, { state, severity, headline, reason, nextAction, next: nextAction, ...fields });
  if (handoffExtras) value.handoff = { ...value.handoff, ...handoffExtras };
  return deepFreeze(value);
}

export function projectHumanWorkflow(observation) {
  if (!observation.initialized) {
    return project("NOT_CONFIGURED", "attention", "da configurare", observation,
      "Questo repository non è ancora inizializzato per Aiopago.",
      "esegui “aio init”, poi ispeziona il piano autorevole con “aio plan”.");
  }
  if (observation.configError) {
    return project("NEEDS_ATTENTION", "error", "richiede attenzione", observation,
      "La configurazione Aiopago non può essere letta o validata.",
      "ispeziona la diagnostica tecnica e correggi la configurazione; non continuare il lavoro alla cieca.");
  }
  if (!observation.plan?.valid) {
    return project("NEEDS_ATTENTION", "error", "richiede attenzione", observation,
      "TASK_PLAN.md non è valido e non può essere usato come piano autorevole.",
      "esegui “aio plan --check”, ispeziona “aio plan --raw” e correggi manualmente il piano.");
  }

  const runtime = observation.runtime ?? EMPTY_RUNTIME;
  if (runtime.verified !== true) {
    const error = runtime.error ?? { code: "RUNTIME_NOT_VERIFIED", message: "No canonical core runtime observation was produced" };
    const changing = error.code === "RUNTIME_NOT_QUIESCENT" || error.code === "RUNTIME_CHANGED_DURING_READ" || error.code === "PLAN_CHANGED_DURING_READ";
    const failed = !changing && !["RUNTIME_NOT_VERIFIED"].includes(error.code);
    return project("NEEDS_ATTENTION", failed ? "error" : "attention", "richiede attenzione", observation,
      changing
        ? "Lo stato runtime è concorrente o in transizione e non può essere verificato in sicurezza dall’osservatore esterno."
        : failed
          ? "La lettura dello stato runtime è fallita e Aiopago non può presentarlo come verificato."
          : "Il core Portable Alpha 0.1 non espone ancora una verifica read-only canonica dell’autorità runtime all’osservatore esterno.",
      changing
        ? "non avviare né riprovare aio; attendi che il runtime sia quiescente, quindi osserva di nuovo lo stato."
        : failed
          ? "ispeziona la diagnostica tecnica, conserva il codice di errore e osserva di nuovo solo dopo aver corretto la causa."
          : "usa il piano autorevole per orientarti, ma non dedurre avvio o retry da questa projection; serve un Core Observation Port esterno.");
  }

  if (!runtime.latch || !["ENGAGED", "RELEASED"].includes(runtime.latch.state) || !Number.isInteger(runtime.latch.generation) || runtime.latch.generation < 0) {
    return project("NEEDS_ATTENTION", "error", "richiede attenzione", {
      ...observation,
      runtime: {
        available: true,
        verified: false,
        condition: "RUNTIME_OBSERVATION_INVALID",
        error: { code: "RUNTIME_OBSERVATION_INVALID", message: "The live runtime observation has no valid latch identity" },
      },
    }, "L’osservazione live non contiene un’identità latch valida e non può provare l’ammissione.",
    "ispeziona la diagnostica tecnica e osserva di nuovo senza dedurre permessi runtime.");
  }
  const latch = runtime.latch;
  const handoff = runtime.handoff;
  if (latch.reason === "HUMAN_TAKEOVER") {
    return project("PAUSED", "attention", "in pausa per controllo umano", observation,
      "Il takeover umano è attivo e l’ammissione di nuovo lavoro resta chiusa.",
      "mantieni il controllo umano e ispeziona lo stato tecnico; questa vista non può rilasciare il latch.");
  }
  if (handoff?.state === "CONTINUITY_FAILED") {
    return project("NEEDS_ATTENTION", "error", "richiede attenzione", observation,
      "La continuità dell’handoff non è stata verificata; il target resta in pausa.",
      `recupera esplicitamente l’handoff con “/aio handoff recover ${handoff.handoff_id}” da una sessione Runner fresca.`,
      { handoff: { actionability: "recover" } });
  }
  if (FAILED_HANDOFF_STATES.has(handoff?.state)) {
    const unknown = handoff.state === "RESUME_DISPATCH_UNKNOWN";
    return project("NEEDS_ATTENTION", "error", "richiede attenzione", observation,
      unknown
        ? "L’esito dell’invio di resume è ambiguo e non può essere ritentato automaticamente."
        : "L’handoff è fallito e richiede riconciliazione umana senza retry automatico.",
      unknown
        ? "ispeziona la diagnostica tecnica e riconcilia l’effetto del resume senza ripetere l’invio."
        : "ispeziona la diagnostica tecnica e segui le istruzioni di recovery preservando il target in pausa.",
      { handoff: { actionability: "manual-recovery" } });
  }
  if (handoff?.state === "RESUME_READY") {
    return project("PAUSED", "attention", "handoff pronto, target in pausa", observation,
      "La continuità è verificata, ma il resume non è ancora autorizzato dall’essere umano.",
      "usa “/aio resume” e conferma esplicitamente solo se vuoi autorizzare una singola ripresa.",
      { handoff: { actionability: "resume-confirmation" } });
  }
  if (PREPARING_HANDOFF_STATES.has(handoff?.state)) {
    return project("PAUSED", "attention", "handoff in preparazione", observation,
      "L’handoff esistente sta raggiungendo o mantenendo un target sicuro in pausa.",
      "attendi l’esito del percorso esistente; non avviare un secondo handoff.",
      { handoff: { actionability: "wait" } });
  }
  if (handoff && !["RESUMED"].includes(handoff.state)) {
    return project("NEEDS_ATTENTION", "error", "richiede attenzione", observation,
      "Lo stato handoff osservato non è riconosciuto dalla projection umana.",
      "ispeziona la vista tecnica e non dedurre autorizzazioni dallo stato sconosciuto.",
      { handoff: { actionability: "inspect" } });
  }
  if (latch.state !== "RELEASED") {
    return project("PAUSED", "attention", "in pausa", observation,
      "Il latch del Runner è attivo e Aiopago non può provare che nuovo lavoro sia ammesso.",
      "ispeziona lo stato tecnico e il percorso handoff corrente; questa vista non può rilasciare il latch.");
  }
  if (observation.plan.plan.status === "BLOCKED") {
    return project("NEEDS_ATTENTION", "attention", "richiede attenzione", observation,
      "Il piano autorevole è bloccato e richiede l’azione descritta nel prossimo passo.",
      observation.plan.plan.next_step);
  }
  if (runtime.context?.recommended === true) {
    return project("WORKING", "attention", "al lavoro — handoff consigliato", observation,
      `Il contesto è al ${Math.round(runtime.context.percent)}%, oltre la soglia advisory del ${runtime.context.thresholdPercent}%.`,
      "continua l’attività corrente oppure prepara un handoff soltanto con consenso umano esplicito.",
      { handoff: { recommendation: "recommended", actionability: "prepare-with-consent" } });
  }
  if (observation.plan.plan.status === "DONE") {
    return project("COMPLETED", "info", "piano completato", observation,
      "TASK_PLAN.md dichiara concluse le attività; questa projection non inferisce acceptance esterna.",
      "ispeziona il piano e le evidenze senza dedurre acceptance esterna.");
  }
  return project("WORKING", "info", "al lavoro", observation,
    "Il Runner live verifica l’ammissione aperta e non osserva un handoff che richieda azione.",
    observation.plan.plan.next_step || "continua l’attività corrente.");
}

const STATE_LABELS = Object.freeze({
  NOT_CONFIGURED: "da configurare",
  NEEDS_ATTENTION: "richiede attenzione",
  WORKING: "al lavoro",
  PAUSED: "in pausa",
  COMPLETED: "piano completato",
});

function asProjection(value) {
  return value?.schema === "aiopago.human-workflow-projection/0.2-e" ? value : projectHumanWorkflow(value);
}

export function formatHumanStatus(value) {
  const view = asProjection(value);
  const lines = [`Aiopago — ${view.headline ?? STATE_LABELS[view.state] ?? view.state}`];
  if (view.objective) lines.push(`Obiettivo: ${view.objective}`);
  if (view.currentActivity) lines.push(`Attività corrente: ${view.currentActivity}`);
  if (view.progress) lines.push(`Progresso: ${view.progress.completed}/${view.progress.total} attività concluse`);
  if (view.runtimeSummary.verified) {
    const control = view.humanControl.takeoverState === "active"
      ? "takeover attivo"
      : view.humanControl.latchState === "RELEASED" ? "ammissione aperta" : "in pausa";
    lines.push(`Controllo umano: ${control}`);
    const context = view.runtimeSummary.context;
    if (context?.percent !== null) lines.push(`Contesto: ${Math.round(context.percent)}%${context.recommended ? " — handoff consigliato" : ""}`);
  }
  lines.push(`Motivo: ${view.reason}`);
  lines.push(`Prossima azione: ${view.nextAction}`);
  return lines.join("\n");
}

export function formatHumanWhy(value) {
  const view = asProjection(value);
  return ["Perché", view.reason, `Prossima azione: ${view.nextAction}`].join("\n");
}

export function formatHumanNext(value) {
  const view = asProjection(value);
  return `Prossima azione: ${view.nextAction}`;
}

const PLAN_STATUS_LABELS = Object.freeze({
  PLANNED: "pianificato",
  IN_PROGRESS: "in corso",
  BLOCKED: "bloccato",
  DONE: "completato",
  DROPPED: "abbandonato",
  SUPERSEDED: "superato",
});

export function formatPlan(value) {
  const view = asProjection(value);
  const plan = view.planSummary;
  if (!plan) {
    const diagnostic = view.technical.diagnostic ?? { code: "PLAN_UNAVAILABLE", message: "Piano autorevole non disponibile" };
    return [
      "Piano autorevole non valido",
      `Artifact: ${view.planPath ?? "non disponibile"}`,
      `Diagnostica: ${diagnostic.code}: ${diagnostic.message}`,
      "Verifica: aio plan --check",
      "Ispezione: aio plan --raw",
    ].join("\n");
  }
  return [
    `Piano autorevole: ${view.title}`,
    `Obiettivo: ${view.objective}`,
    `Stato: ${PLAN_STATUS_LABELS[plan.status] ?? plan.status}`,
    `Progresso: ${view.progress.completed}/${view.progress.total} attività concluse`,
    "Attività:",
    ...plan.items.map((item) => `  - ${item.title} — ${PLAN_STATUS_LABELS[item.status] ?? item.status}`),
    `Prossimo passo: ${plan.nextStep}`,
    `Artifact: ${plan.artifact}`,
  ].join("\n");
}

export function formatPlanTechnical(value) {
  const view = asProjection(value);
  const plan = view.planSummary;
  if (!plan) return formatPlan(view);
  return [
    "Aiopago plan — technical",
    `Artifact: ${plan.artifact}`,
    `Task ID: ${plan.taskId}`,
    `Revisione: ${plan.revision}`,
    `Requirements: ${plan.requirementsVersion}`,
    `Digest: ${plan.digest}`,
    `Status: ${plan.status}`,
    `Current item: ${plan.currentItem ?? "none"}`,
    `Next item: ${plan.nextItem ?? "none"}`,
    `Next step: ${plan.nextStep}`,
    `Model policy: ${plan.modelPolicy ?? "runtime-selected"}`,
    `Reasoning policy: ${plan.reasoningPolicy ?? "unspecified"}`,
    `Minimal reads: ${JSON.stringify(plan.minimalReads)}`,
    `Required local paths: ${JSON.stringify(plan.requiredLocalPaths)}`,
  ].join("\n");
}

export function formatHumanTechnical(value) {
  const view = asProjection(value);
  const plan = view.technical.plan;
  const runtime = view.technical.runtime;
  const diagnostic = view.technical.diagnostic;
  return [
    "Aiopago status — technical",
    `Target repository: ${view.targetRoot ?? "unavailable"}`,
    `Plan artifact: ${view.planPath ?? "unavailable"}`,
    `Git: branch=${runtime?.git?.branch ?? "unavailable"} HEAD=${runtime?.git?.head ?? "unavailable"}`,
    `Worktree: ${runtime?.git?.worktree ?? "unavailable"}`,
    `Task: ${plan?.taskId ?? "unavailable"} revision=${plan?.revision ?? "unavailable"} status=${plan?.status ?? "unavailable"}`,
    `Plan digest: ${plan?.digest ?? "unavailable"}`,
    `Current item: ${plan?.currentItem ?? "none"}`,
    `Next item: ${plan?.nextItem ?? "none"}`,
    `Runtime: ${view.runtimeSummary.availability}; condition=${view.runtimeSummary.condition}`,
    `Runner ownership: ${runtime?.ownership === "source" ? "Runner-owned source" : runtime?.ownership?.startsWith("replacement:") ? `Runner-owned replacement (${runtime.ownership.slice("replacement:".length)})` : "unavailable"}; instance=${runtime?.runnerInstance ?? "unavailable"}`,
    `Session: ${runtime?.session ?? "unavailable"}; model=${runtime?.model ?? "unavailable"}; reasoning=${runtime?.reasoning ?? "unavailable"}`,
    `Latch: ${view.humanControl.latchState}; generation=${view.humanControl.generation ?? "unavailable"}; reason=${view.humanControl.reason ?? "none"}`,
    `Handoff: ${view.handoff.id ?? "none"}; state=${view.handoff.state}`,
    `Advisor/context: ${view.runtimeSummary.context?.percent == null ? "unavailable" : `${Math.round(view.runtimeSummary.context.percent)}%`}; threshold=${view.runtimeSummary.context?.thresholdPercent ?? "unavailable"}%`,
    ...(diagnostic ? [`Diagnostic: ${diagnostic.code}: ${diagnostic.message}`] : []),
    ...view.handoff.recovery,
  ].join("\n");
}
