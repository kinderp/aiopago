import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./canonical.mjs";
import { GuardianError } from "./errors.mjs";
import { TaskLedger } from "./ledger.mjs";
import { discoverTargetRepository, readRepositoryConfig, REPOSITORY_CONFIG_FILE } from "./repository.mjs";
import { readRuntimeProjection } from "./runtime-reader.mjs";

const TERMINAL_ITEM_STATES = new Set(["DONE", "DROPPED", "SUPERSEDED"]);
function diagnostic(error, fallback = "READ_FAILED") {
  return Object.freeze({
    code: error?.code ?? fallback,
    message: String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 320),
    source: error,
  });
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

function itemById(plan, id) {
  return id ? plan.task_items.find((item) => item.task_item_id === id) ?? null : null;
}

function progress(plan) {
  const completed = plan.task_items.filter((item) => TERMINAL_ITEM_STATES.has(item.status)).length;
  return Object.freeze({ completed, total: plan.task_items.length, remaining: plan.task_items.length - completed });
}

function view(state, observation, fields) {
  const plan = observation.plan?.plan ?? null;
  return Object.freeze({
    state,
    targetRoot: observation.targetRoot ?? null,
    planPath: observation.plan?.path ?? observation.repository?.taskLedgerPath ?? null,
    objective: plan?.objective ?? null,
    title: plan?.title ?? null,
    currentActivity: itemById(plan ?? { task_items: [] }, plan?.current_item)?.title ?? null,
    progress: plan ? progress(plan) : null,
    ...fields,
  });
}

export function projectHumanWorkflow(observation) {
  if (!observation.initialized) {
    return view("NOT_CONFIGURED", observation, {
      reason: "Questo repository non è ancora inizializzato per Aiopago.",
      next: "esegui “aio init”, poi ispeziona il piano autorevole con “aio plan”.",
      technical: null,
    });
  }
  if (observation.configError) {
    return view("NEEDS_ATTENTION", observation, {
      reason: "La configurazione Aiopago non può essere letta o validata.",
      next: "ispeziona la diagnostica tecnica e correggi la configurazione; non continuare il lavoro alla cieca.",
      technical: observation.configError,
    });
  }
  if (!observation.plan?.valid) {
    return view("NEEDS_ATTENTION", observation, {
      reason: "TASK_PLAN.md non è valido e non può essere usato come piano autorevole.",
      next: "esegui “aio plan --check”, ispeziona “aio plan --raw” e correggi manualmente il piano.",
      technical: observation.plan?.error ?? null,
    });
  }
  const error = observation.runtime?.error ?? { code: "RUNTIME_NOT_VERIFIED", message: "No canonical core runtime observation was produced" };
  const live = error.code === "RUNTIME_NOT_QUIESCENT" || error.code === "RUNTIME_CHANGED_DURING_READ";
  return view("NEEDS_ATTENTION", observation, {
    reason: live
      ? "Lo stato runtime è concorrente o in transizione e non può essere verificato in sicurezza dall’osservatore esterno."
      : "Il core Portable Alpha 0.1 non espone ancora una verifica read-only canonica dell’autorità runtime.",
    next: live
      ? "non avviare né riprovare aio; attendi che il Runner sia chiuso e il runtime sia quiescente, quindi osserva di nuovo lo stato."
      : "usa il piano autorevole per orientarti, ma non dedurre avvio o retry da questa projection; serve un futuro Core Observation Port.",
    technical: error,
  });
}

const STATE_LABELS = Object.freeze({
  NOT_CONFIGURED: "da configurare",
  NEEDS_ATTENTION: "richiede attenzione",
});

export function formatHumanStatus(view) {
  const lines = [`Aiopago — ${STATE_LABELS[view.state]}`];
  if (view.objective) lines.push(`Obiettivo: ${view.objective}`);
  if (view.currentActivity) lines.push(`Attività corrente: ${view.currentActivity}`);
  if (view.progress) lines.push(`Progresso: ${view.progress.completed}/${view.progress.total} attività concluse`);
  if (view.state === "NEEDS_ATTENTION") {
    lines.push(`Motivo: ${view.reason}`);
    lines.push(`Prossima azione: ${view.next}`);
  }
  return lines.join("\n");
}

export function formatHumanWhy(view) {
  return ["Perché", view.reason, `Prossima azione: ${view.next}`].join("\n");
}

export function formatHumanNext(view) {
  return `Prossima azione: ${view.next}`;
}

const PLAN_STATUS_LABELS = Object.freeze({
  PLANNED: "pianificato",
  IN_PROGRESS: "in corso",
  BLOCKED: "bloccato",
  DONE: "completato",
  DROPPED: "abbandonato",
  SUPERSEDED: "superato",
});

export function formatPlan(observation) {
  if (!observation.plan?.valid) {
    const code = observation.plan?.error?.code ?? observation.configError?.code ?? "PLAN_UNAVAILABLE";
    const message = observation.plan?.error?.message ?? observation.configError?.message ?? "Piano autorevole non disponibile";
    return [`Piano autorevole non valido`, `Artifact: ${observation.plan?.path ?? observation.repository?.taskLedgerPath ?? "non disponibile"}`, `Diagnostica: ${code}: ${message}`, "Verifica: aio plan --check", "Ispezione: aio plan --raw"].join("\n");
  }
  const plan = observation.plan.plan;
  const completed = progress(plan);
  return [
    `Piano autorevole: ${plan.title}`,
    `Obiettivo: ${plan.objective}`,
    `Stato: ${PLAN_STATUS_LABELS[plan.status] ?? plan.status}`,
    `Progresso: ${completed.completed}/${completed.total} attività concluse`,
    "Attività:",
    ...plan.task_items.map((item) => `  - ${item.title} — ${PLAN_STATUS_LABELS[item.status] ?? item.status}`),
    `Prossimo passo: ${plan.next_step}`,
    `Artifact: ${observation.plan.path}`,
  ].join("\n");
}

export function formatPlanTechnical(observation) {
  if (!observation.plan?.valid) return formatPlan(observation);
  const plan = observation.plan.plan;
  return [
    "Aiopago plan — technical",
    `Artifact: ${observation.plan.path}`,
    `Task ID: ${plan.task_id}`,
    `Revisione: ${plan.plan_revision_id}`,
    `Requirements: ${plan.requirements_version}`,
    `Digest: ${observation.plan.digest}`,
    `Status: ${plan.status}`,
    `Current item: ${plan.current_item ?? "none"}`,
    `Next item: ${plan.next_item ?? "none"}`,
    `Next step: ${plan.next_step}`,
    `Model policy: ${plan.model_policy ?? "runtime-selected"}`,
    `Reasoning policy: ${plan.reasoning_policy ?? "unspecified"}`,
    `Minimal reads: ${JSON.stringify(plan.minimal_reads ?? [])}`,
    `Required local paths: ${JSON.stringify(plan.required_local_paths ?? [])}`,
  ].join("\n");
}
