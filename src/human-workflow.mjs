import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./canonical.mjs";
import { GuardianError } from "./errors.mjs";
import {
  guidedHandoffEligibilityIdentityFromAuthority,
  sameGuidedHandoffEligibility,
} from "./handoff-consent.mjs";
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
const CRASH_INTENT_STATES = new Set([
  "CHECKPOINT_PERSISTING", "REPLACEMENT_SESSION_CREATING", "MANIFEST_PERSISTING",
]);
const KNOWN_HANDOFF_STATES = new Set([
  ...PREPARING_HANDOFF_STATES,
  ...FAILED_HANDOFF_STATES,
  "CONTINUITY_FAILED", "RESUME_READY", "RESUMED", "HUMAN_DECISION_REQUIRED",
]);
const HANDOFF_STATES_REQUIRING_TARGET = new Set([
  "REPLACEMENT_SESSION_CREATED_PAUSED", "RUNNER_OWNERSHIP_ATTESTATION_FAILED",
  "MANIFEST_PERSISTING", "MANIFEST_PERSISTED", "CONTINUITY_FAILED", "RESUME_READY",
  "RESUME_ADMISSION_COMMITTED", "RESUME_DISPATCHING", "RESUME_DISPATCHED",
  "RESUME_DISPATCH_FAILED", "RESUME_DISPATCH_UNKNOWN", "RESUMED",
]);
const HANDOFF_STATES_REQUIRING_FAILURE = new Set([...FAILED_HANDOFF_STATES, "CONTINUITY_FAILED"]);

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
  return {
    code: boundedText(error.code ?? fallback, 128) || fallback,
    message: boundedText(error.message ?? error),
  };
}

function projectedFailure(failure, fallback = "HANDOFF_FAILED") {
  if (!failure) return null;
  return {
    code: boundedText(failure.code ?? fallback, 128) || fallback,
    message: boundedText(failure.message ?? failure),
  };
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validIdentity(value, maximum = 320) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
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
    task_id: handoff.task_id ?? null,
    source_session_id: handoff.source_session_id ?? null,
    target_session_id: handoff.target_session_id ?? null,
    runner_instance_id: handoff.runner_instance_id ?? null,
    task_plan_revision: handoff.task_plan_revision ?? null,
    task_plan_digest: handoff.task_plan_digest ?? null,
    latch_generation: handoff.latch_generation ?? null,
    authorization_state: handoff.authorization_state ?? null,
    admission_state: handoff.admission_state ?? null,
    dispatch_state: handoff.dispatch_state ?? null,
    failure: projectedFailure(handoff.failure, handoff.state),
  } : null;
}

function observedHandoffFailure(handoff) {
  if (!handoff) return null;
  if (handoff.failure) return publicDiagnostic(handoff.failure, handoff.state);
  if (!HANDOFF_STATES_REQUIRING_FAILURE.has(handoff.state)) return null;
  return { code: handoff.state, message: `Handoff runtime is in ${handoff.state}` };
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
    const authorityStorage = runner.authorityStorage ?? runner.storage;
    const sessionBefore = runner.runtime?.session ?? null;
    if (!sessionBefore?.sessionId) throw new GuardianError("RUNTIME_SESSION_UNAVAILABLE", "The live Runner session cannot be observed");
    const latchBefore = authorityStorage.getLatch(taskId);
    if (!latchBefore) throw new GuardianError("RUNTIME_LATCH_UNAVAILABLE", "The live Runner has no latch observation for the authoritative task");
    const handoffBefore = authorityStorage.latestHandoffForTask(taskId);
    const git = runner.handoffService.observeGit();
    const context = safeContextUsage(ctx);
    const latchAfter = authorityStorage.getLatch(taskId);
    const handoffAfter = authorityStorage.latestHandoffForTask(taskId);
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
      ? authorityStorage.getRunnerSessionBinding(handoff.handoff_id)
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
        planIdentity: {
          taskId: secondPlan.plan.task_id,
          revision: secondPlan.plan.plan_revision_id,
          digest: secondPlan.digest,
        },
        latch: latchIdentity(latchAfter),
        handoff: handoff ? {
          ...handoffIdentity(handoff),
          failure: observedHandoffFailure(handoff),
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

function invalidRuntime(message) {
  return Object.freeze({
    valid: false,
    error: Object.freeze({ code: "RUNTIME_OBSERVATION_INVALID", message: boundedText(message) }),
  });
}

/** A verified live observation is a positive claim and therefore has one
 * strict coherence boundary before projection. Unverified/unavailable
 * observations intentionally use their separate conservative shape. */
function validateRuntimeObservationUnchecked(runtime, planObservation) {
  if (!isPlainRecord(runtime)) return invalidRuntime("The verified runtime observation is not a record");
  if (runtime.available !== true || runtime.verified !== true
    || runtime.workflow !== "LIVE_RUNNER" || runtime.condition !== "LIVE_RUNNER"
    || runtime.error !== null || (runtime.failure !== undefined && runtime.failure !== null)) {
    return invalidRuntime("The verified runtime claim has contradictory availability, workflow, condition, or error fields");
  }
  const plan = planObservation?.valid === true ? planObservation.plan : null;
  if (!plan || !isPlainRecord(runtime.planIdentity)
    || runtime.planIdentity.taskId !== plan.task_id
    || runtime.planIdentity.revision !== plan.plan_revision_id
    || runtime.planIdentity.digest !== planObservation.digest) {
    return invalidRuntime("The verified runtime is not bound to the authoritative task, revision, and digest");
  }
  if (!isPlainRecord(runtime.session) || !validIdentity(runtime.session.id)
    || !validIdentity(runtime.session.runnerInstanceId)
    || !validIdentity(runtime.session.model)
    || !(runtime.session.reasoning === null || runtime.session.reasoning === undefined || validIdentity(runtime.session.reasoning))
    || !(runtime.session.ownership === "source" || /^replacement:(ACTIVE|SUPERSEDED)$/.test(runtime.session.ownership ?? ""))) {
    return invalidRuntime("The verified runtime has no coherent session and Runner identity");
  }
  if (!isPlainRecord(runtime.latch) || !["ENGAGED", "RELEASED"].includes(runtime.latch.state)
    || !Number.isInteger(runtime.latch.generation) || runtime.latch.generation < 0
    || !(runtime.latch.reason === null || runtime.latch.reason === undefined || validIdentity(runtime.latch.reason))
    || (runtime.latch.state === "RELEASED" && runtime.latch.reason != null)
    || (runtime.latch.state === "ENGAGED" && !validIdentity(runtime.latch.reason))) {
    return invalidRuntime("The verified runtime has no valid latch identity");
  }
  if (runtime.handoff !== null) {
    const handoff = runtime.handoff;
    if (!isPlainRecord(handoff) || !validIdentity(handoff.handoff_id) || !KNOWN_HANDOFF_STATES.has(handoff.state)
      || handoff.task_id !== plan.task_id || !validIdentity(handoff.source_session_id)
      || !validIdentity(handoff.runner_instance_id) || !validIdentity(handoff.task_plan_revision)
      || !validIdentity(handoff.task_plan_digest) || !Number.isInteger(handoff.latch_generation) || handoff.latch_generation < 0
      || !(handoff.target_session_id === null || validIdentity(handoff.target_session_id))
      || (HANDOFF_STATES_REQUIRING_TARGET.has(handoff.state) && !validIdentity(handoff.target_session_id))
      || !["authorization_state", "admission_state", "dispatch_state"].every((key) => handoff[key] === null || validIdentity(handoff[key], 128))
      || !Array.isArray(handoff.manual_recovery) || handoff.manual_recovery.some((line) => typeof line !== "string")) {
      return invalidRuntime("The verified runtime has a malformed or incoherent handoff identity");
    }
    if (HANDOFF_STATES_REQUIRING_FAILURE.has(handoff.state)
      && (!isPlainRecord(handoff.failure) || !validIdentity(handoff.failure.code, 128) || !validIdentity(handoff.failure.message, 4096))) {
      return invalidRuntime("The verified runtime failure state has no bounded failure code and message");
    }
    if (!HANDOFF_STATES_REQUIRING_FAILURE.has(handoff.state) && handoff.failure !== null) {
      return invalidRuntime("The verified runtime has a failure object that contradicts its handoff state");
    }
  }
  if (runtime.context !== undefined && runtime.context !== null) {
    const context = runtime.context;
    if (!isPlainRecord(context) || !["available", "unavailable"].includes(context.availability)
      || typeof context.recommended !== "boolean"
      || !(context.percent === null || (Number.isFinite(context.percent) && context.percent >= 0 && context.percent <= 100))
      || !(context.tokens === null || Number.isFinite(context.tokens))
      || !(context.contextWindow === null || Number.isFinite(context.contextWindow))
      || !(context.thresholdPercent === null || (Number.isFinite(context.thresholdPercent) && context.thresholdPercent >= 0 && context.thresholdPercent <= 100))
      || (context.availability === "unavailable" && (context.percent !== null || context.tokens !== null || context.contextWindow !== null || context.recommended))
      || (context.recommended && (!Number.isFinite(context.percent) || !Number.isFinite(context.thresholdPercent) || context.percent < context.thresholdPercent))) {
      return invalidRuntime("The verified runtime has malformed or contradictory context evidence");
    }
  }
  if (runtime.git !== undefined && runtime.git !== null
    && (!isPlainRecord(runtime.git) || Object.values(runtime.git).some((value) => value !== null && !validIdentity(value, 2048)))) {
    return invalidRuntime("The verified runtime Git evidence is malformed");
  }
  return Object.freeze({ valid: true, error: null });
}

export function validateRuntimeObservation(runtime, planObservation) {
  try { return validateRuntimeObservationUnchecked(runtime, planObservation); }
  catch { return invalidRuntime("The verified runtime observation could not be safely inspected"); }
}

/** Ephemeral preparation-consent identity. It contains authority/control facts,
 * never display strings or naturally moving context percentages. */
export function guidedHandoffEligibilityIdentity(observation) {
  if (observation?.plan?.valid !== true || observation?.runtime?.verified !== true) return null;
  if (!validateRuntimeObservation(observation.runtime, observation.plan).valid) return null;
  const runtime = observation.runtime;
  if (runtime.latch.state !== "RELEASED") return null;
  return guidedHandoffEligibilityIdentityFromAuthority({
    plan: { ...observation.plan.plan, content_digest: observation.plan.digest },
    sessionId: runtime.session.id,
    runnerInstanceId: runtime.session.runnerInstanceId,
    latch: runtime.latch,
    handoff: runtime.handoff,
  });
}

export { sameGuidedHandoffEligibility };

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
      context: runtime.context ? {
        availability: runtime.context.availability,
        percent: runtime.context.percent ?? null,
        tokens: runtime.context.tokens ?? null,
        contextWindow: runtime.context.contextWindow ?? null,
        thresholdPercent: runtime.context.thresholdPercent ?? null,
        recommended: runtime.context.recommended === true,
        error: publicDiagnostic(runtime.context.error, "CONTEXT_USAGE_READ_FAILED"),
      } : null,
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
        git: runtime.git ? {
          repository: runtime.git.repository ?? null,
          worktree: runtime.git.worktree ?? null,
          branch: runtime.git.branch ?? null,
          head: runtime.git.head ?? null,
          base: runtime.git.base ?? null,
          indexDigest: runtime.git.indexDigest ?? null,
          worktreeDigest: runtime.git.worktreeDigest ?? null,
        } : null,
        latchGeneration: runtime.latch?.generation ?? null,
        handoffId: runtime.handoff?.handoff_id ?? null,
        handoffState: runtime.handoff?.state ?? null,
        failure: projectedFailure(runtime.handoff?.failure, runtime.handoff?.state ?? "HANDOFF_FAILED"),
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
    if (observation.plan?.error?.code === "PLAN_CHANGED_DURING_READ") {
      return project("NEEDS_ATTENTION", "attention", "richiede attenzione", observation,
        "Il piano autorevole è cambiato mentre veniva letto; questo non implica che TASK_PLAN.md sia corrotto.",
        "attendi che la modifica sia completa, quindi osserva di nuovo lo stato.");
    }
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

  const validation = validateRuntimeObservation(runtime, observation.plan);
  if (!validation.valid) {
    return project("NEEDS_ATTENTION", "error", "richiede attenzione", {
      ...observation,
      runtime: {
        available: true,
        verified: false,
        workflow: "NEEDS_ATTENTION",
        condition: "RUNTIME_OBSERVATION_INVALID",
        error: validation.error,
      },
    }, "L’osservazione live verificata è incompleta o incoerente e non può provare uno stato operativo sicuro.",
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
  if (CRASH_INTENT_STATES.has(handoff?.state)
    && handoff.runner_instance_id !== runtime.session.runnerInstanceId) {
    return project("NEEDS_ATTENTION", "error", "richiede riconciliazione", observation,
      `L’handoff ${handoff.handoff_id} è rimasto in ${handoff.state} dopo il cambio di Runner; l’esito dell’operazione è sconosciuto.`,
      `riconcilia manualmente l’handoff ${handoff.handoff_id} e gli eventuali artifact/target; non avviare un secondo handoff e non ritentare automaticamente.`,
      { handoff: {
        actionability: "manual-recovery",
        recovery: [
          "Il cambio di Runner rende sconosciuto l’esito dell’intent persistito.",
          "Conserva il latch e riconcilia l’operazione esistente prima di altro lavoro.",
        ],
      } });
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
    if (diagnostic.code === "PLAN_CHANGED_DURING_READ") {
      return [
        "Piano autorevole cambiato durante la lettura",
        `Artifact: ${view.planPath ?? "non disponibile"}`,
        `Diagnostica: ${diagnostic.code}: ${diagnostic.message}`,
        "Azione: attendi che la modifica sia completa, quindi osserva di nuovo lo stato.",
      ].join("\n");
    }
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
    ...(runtime?.failure ? [
      `Runtime failure code: ${runtime.failure.code}`,
      `Runtime failure message: ${runtime.failure.message}`,
    ] : []),
    ...view.handoff.recovery,
  ].join("\n");
}
