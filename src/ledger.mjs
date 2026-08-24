import { resolve } from "node:path";
import { sha256, strictJsonClone, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { registerTrustedHandoffPlanCapability } from "./handoff-plan-internal.mjs";
import {
  assertExactSatisfiedOwnerGateTransition,
  canonicalOwnerCommand,
  commandTokens,
  HANDOFF_CONFIRM_CANONICAL_COMMAND,
  isCommandTokenWhitespace,
} from "./owner-gate-internal.mjs";
import { materializeLedgerMarkdown } from "./plan-markdown.mjs";
import { PlanRevisionWriter } from "./plan-store.mjs";

const TASK_STATUS_VALUES = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED", "SUPERSEDED"];
const TASK_STATES = new Set(TASK_STATUS_VALUES);
const TASK_STATUS_MESSAGE = `status must be one of ${TASK_STATUS_VALUES.join(", ")}`;
const MAX_RESUME_LIST_ENTRIES = 64;
const MAX_RESUME_ENTRY_LENGTH = 2048;
const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 4096;
const MAX_LEDGER_LIST_ENTRIES = 1024;
const TASK_REQUIRED_FIELDS = ["schema_version", "task_id", "title", "objective", "requirements_version", "plan_revision_id", "status", "completion_criteria", "risk", "created_at", "updated_at", "current_item", "next_item", "next_step", "task_items"];
const ITEM_REQUIRED_FIELDS = ["task_item_id", "task_id", "title", "description", "status", "depends_on", "completion_criteria", "evidence", "requirements_refs", "risk", "milestone", "last_updated_at", "last_updated_by"];
const ITEM_OPTIONAL_ID_FIELDS = ["last_session_id", "last_checkpoint_id", "supersedes", "superseded_by"];
const TERMINAL_PROVENANCE_FORMS = [
  { reason: "reason", actor: "actor", timestamp: "timestamp" },
  { reason: "terminal_reason", actor: "terminal_actor", timestamp: "terminal_at" },
];
const OWNER_GATE_COMMON_FIELDS = ["kind", "status", "item_id", "command", "satisfied_plan_revision_id", "satisfied_next_step"];
const OWNER_GATE_OPTIONAL_FIELDS = ["satisfied_task_status", "satisfied_next_item"];
const OWNER_GATE_AUDIT_FIELDS = ["satisfied_at", "satisfied_by"];
const OWNER_GATE_LEGACY_SATISFIED_AUDIT_FIELDS = [
  "evidence_handoff_id",
  "post_fix_validation_handoff_id",
  "post_fix_replacement_session_id",
  "post_fix_continuity",
  "final_acceptance",
];
const OWNER_GATE_LEGACY_ID_FIELDS = ["evidence_handoff_id", "post_fix_validation_handoff_id", "post_fix_replacement_session_id"];

function validateTerminalProvenance(value, label) {
  const present = TERMINAL_PROVENANCE_FORMS.map((form) => Object.values(form).map((field) => Object.hasOwn(value, field)));
  for (const fields of present) invariant(fields.every(Boolean) || fields.every((entry) => !entry), "LEDGER_TERMINAL_PROVENANCE_REQUIRED", `${label} ${value.status} has partial or mixed terminal provenance`);
  const complete = TERMINAL_PROVENANCE_FORMS.filter((form, index) => present[index].every(Boolean));
  invariant(complete.length > 0, "LEDGER_TERMINAL_PROVENANCE_REQUIRED", `${label} ${value.status} requires reason, actor, and timestamp provenance`);
  for (const form of complete) {
    boundedString(value[form.reason], `${label} ${form.reason}`);
    boundedString(value[form.actor], `${label} ${form.actor}`);
    canonicalUtc(value[form.timestamp], `${label} ${form.timestamp}`);
  }
  if (complete.length === 2) {
    invariant(value.reason === value.terminal_reason && value.actor === value.terminal_actor && value.timestamp === value.terminal_at, "LEDGER_TERMINAL_PROVENANCE_CONFLICT", `${label} terminal provenance aliases conflict`);
  }
}

function boundedString(value, field, { id = false, allowEmpty = false } = {}) {
  const maximum = id ? MAX_ID_LENGTH : MAX_TEXT_LENGTH;
  invariant(typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maximum, "LEDGER_FIELD_INVALID", `${field} must be ${allowEmpty ? "a" : "a non-empty"} bounded string`);
  return value;
}

function boundedStringArray(value, field, { nonEmpty = false, ids = false } = {}) {
  invariant(Array.isArray(value) && value.length <= MAX_LEDGER_LIST_ENTRIES && (!nonEmpty || value.length > 0), "LEDGER_FIELD_INVALID", `${field} must be ${nonEmpty ? "a non-empty" : "an"} bounded array`);
  for (const entry of value) boundedString(entry, `${field} entry`, { id: ids });
  return value;
}

function canonicalUtc(value, field) {
  boundedString(value, field);
  invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), "LEDGER_TIMESTAMP_INVALID", `${field} must be canonical RFC 3339 UTC`);
  const milliseconds = Date.parse(value);
  invariant(Number.isFinite(milliseconds), "LEDGER_TIMESTAMP_INVALID", `${field} must be canonical RFC 3339 UTC`);
  const iso = new Date(milliseconds).toISOString();
  invariant(value === iso || value === iso.replace(".000Z", "Z"), "LEDGER_TIMESTAMP_INVALID", `${field} must be canonical RFC 3339 UTC`);
  return value;
}

function isAuthorizedHumanActor(actor) {
  return typeof actor === "string"
    && actor.length <= MAX_TEXT_LENGTH
    && actor.startsWith("human:")
    && actor.slice("human:".length).trim().length > 0;
}

function containsCanonicalCommandMention(text, gateCommand) {
  if (typeof text !== "string") return false;
  const canonicalGateCommand = canonicalOwnerCommand(gateCommand);
  const targetTokens = commandTokens(HANDOFF_CONFIRM_CANONICAL_COMMAND);
  if (canonicalGateCommand === null) return false;
  const embeddedBoundary = /[\p{L}\p{N}\p{M}_\/-]/u;
  const commandNameCharacter = /[A-Za-z0-9-]/;
  const commandArgumentCharacter = /[A-Za-z0-9_-]/;

  for (let start = text.indexOf("/"); start !== -1; start = text.indexOf("/", start + 1)) {
    const previous = start === 0 ? undefined : text[start - 1];
    if (previous !== undefined && embeddedBoundary.test(previous)) continue;

    let cursor = start + 1;
    if (!/[A-Za-z]/.test(text[cursor] ?? "")) continue;
    while (commandNameCharacter.test(text[cursor] ?? "")) cursor += 1;

    let parsedTokens = 1;
    let end = cursor;
    while (parsedTokens < targetTokens.length) {
      if (!isCommandTokenWhitespace(text[cursor])) break;
      while (isCommandTokenWhitespace(text[cursor])) cursor += 1;
      const argumentStart = cursor;
      while (commandArgumentCharacter.test(text[cursor] ?? "")) cursor += 1;
      if (cursor === argumentStart) break;
      parsedTokens += 1;
      end = cursor;
    }
    if (parsedTokens !== targetTokens.length) continue;
    if (embeddedBoundary.test(text[end] ?? "")) continue;
    if (canonicalOwnerCommand(text.slice(start, end)) === canonicalGateCommand) return true;
  }
  return false;
}

function validateOwnerGateOpaqueId(value, field) {
  boundedString(value, field, { id: true });
  invariant(value.trim().length > 0, "LEDGER_FIELD_INVALID", `${field} must not be blank`);
}

function validateBoundedStringList(value, field, code = "LEDGER_RESUME_CONTEXT_INVALID") {
  invariant(Array.isArray(value) && value.length <= MAX_RESUME_LIST_ENTRIES, code, `${field} must be an array with at most ${MAX_RESUME_LIST_ENTRIES} entries`);
  for (const entry of value) invariant(typeof entry === "string" && entry.length > 0 && entry.length <= MAX_RESUME_ENTRY_LENGTH, code, `${field} entries must be non-empty bounded strings`);
  return value;
}

export function validateRequiredLocalPaths(value, code = "LEDGER_REQUIRED_LOCAL_PATH_INVALID") {
  validateBoundedStringList(value, "required_local_paths", code);
  for (const path of value) {
    const components = path.split("/");
    invariant(!path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && components.every((component) => component.length > 0 && component !== "." && component !== ".."), code, `required_local_paths entries must be normalized repo-relative paths: ${path}`);
  }
  return value;
}

export function canonicalRequiredLocalPaths(value = [], code = "LEDGER_REQUIRED_LOCAL_PATH_INVALID") {
  validateRequiredLocalPaths(value, code);
  const canonical = [...new Set(["TASK_PLAN.md", ...value])];
  invariant(canonical.length <= MAX_RESUME_LIST_ENTRIES, code, `required_local_paths including TASK_PLAN.md must have at most ${MAX_RESUME_LIST_ENTRIES} entries`);
  return canonical;
}

function validateOwnerGate(task, byId, inProgress) {
  if (!Object.hasOwn(task, "owner_gate")) return;
  const gate = task.owner_gate;
  const fail = (condition, message) => invariant(condition, "OWNER_GATE_INVALID", message);
  fail(gate !== null && typeof gate === "object" && !Array.isArray(gate), "owner_gate must be a known JSON object");
  fail(gate.kind === "HANDOFF_CONFIRM", "Unknown owner_gate kind is not forward-compatible");
  fail(gate.status === "BLOCKED" || gate.status === "SATISFIED", "owner_gate status must be BLOCKED or SATISFIED");
  for (const field of OWNER_GATE_COMMON_FIELDS) fail(Object.hasOwn(gate, field), `owner_gate missing ${field}`);
  const allowed = new Set([
    ...OWNER_GATE_COMMON_FIELDS,
    ...OWNER_GATE_OPTIONAL_FIELDS,
    ...(gate.status === "SATISFIED" ? [...OWNER_GATE_AUDIT_FIELDS, ...OWNER_GATE_LEGACY_SATISFIED_AUDIT_FIELDS] : []),
  ]);
  fail(Object.keys(gate).every((field) => allowed.has(field)), "owner_gate contains unsupported fields");

  try {
    validateOwnerGateOpaqueId(gate.item_id, "owner_gate item_id");
    boundedString(gate.command, "owner_gate command");
    validateOwnerGateOpaqueId(gate.satisfied_plan_revision_id, "owner_gate satisfied_plan_revision_id");
    boundedString(gate.satisfied_next_step, "owner_gate satisfied_next_step");
    if (Object.hasOwn(gate, "satisfied_next_item") && gate.satisfied_next_item !== null) validateOwnerGateOpaqueId(gate.satisfied_next_item, "owner_gate satisfied_next_item");
    for (const field of OWNER_GATE_LEGACY_ID_FIELDS) if (Object.hasOwn(gate, field)) validateOwnerGateOpaqueId(gate[field], `owner_gate ${field}`);
  } catch (error) {
    throw new GuardianError("OWNER_GATE_INVALID", error.message);
  }
  fail(canonicalOwnerCommand(gate.command) === HANDOFF_CONFIRM_CANONICAL_COMMAND, "HANDOFF_CONFIRM owner_gate command must be the fixed semantic authorization command");
  fail(gate.satisfied_next_step.trim().length > 0, "owner_gate target next step must not be blank");
  fail(!containsCanonicalCommandMention(gate.satisfied_next_step, gate.command), "owner_gate satisfied_next_step must not mention its canonical authorization command or a supported alias");
  if (Object.hasOwn(gate, "satisfied_task_status")) fail(gate.satisfied_task_status === "IN_PROGRESS", "owner_gate satisfied_task_status must be IN_PROGRESS for the active-work target projection");
  if (Object.hasOwn(gate, "satisfied_next_item") && gate.satisfied_next_item !== null) {
    fail(gate.satisfied_next_item !== gate.item_id, "owner_gate satisfied_next_item must differ from item_id");
  }

  if (gate.status === "BLOCKED") {
    fail(byId.has(gate.item_id), "A BLOCKED owner_gate item_id must reference a current TaskItem");
    if (Object.hasOwn(gate, "satisfied_next_item") && gate.satisfied_next_item !== null) {
      fail(byId.has(gate.satisfied_next_item), "A BLOCKED owner_gate satisfied_next_item must reference a current TaskItem");
      fail(["PLANNED", "BLOCKED"].includes(byId.get(gate.satisfied_next_item).status), "BLOCKED owner_gate satisfied_next_item must remain a pending lifecycle target");
    }
    fail(task.status === "BLOCKED", "A BLOCKED owner_gate requires BLOCKED task status");
    fail(gate.satisfied_plan_revision_id !== task.plan_revision_id, "A BLOCKED owner_gate must target a new plan revision");
    fail(task.current_item === null, "A BLOCKED owner_gate requires current_item=null");
    fail(task.next_item === gate.item_id, "A BLOCKED owner_gate must own task.next_item");
    fail(byId.get(gate.item_id).status === "BLOCKED", "A BLOCKED owner_gate must protect a BLOCKED TaskItem");
    fail(inProgress.length === 0, "A BLOCKED owner_gate forbids IN_PROGRESS TaskItems");
    return;
  }

  fail(Object.hasOwn(gate, "satisfied_at") && Object.hasOwn(gate, "satisfied_by"), "A SATISFIED owner_gate requires satisfied_at and satisfied_by audit fields");
  try { canonicalUtc(gate.satisfied_at, "owner_gate satisfied_at"); }
  catch (error) { throw new GuardianError("OWNER_GATE_INVALID", error.message); }
  fail(isAuthorizedHumanActor(gate.satisfied_by), "A SATISFIED owner_gate requires a bounded human:* satisfied_by actor");
  if (Object.hasOwn(gate, "post_fix_continuity")) fail(gate.post_fix_continuity === "PASS", "Historical owner_gate post_fix_continuity must be the observed PASS value");
  if (Object.hasOwn(gate, "final_acceptance")) fail(gate.final_acceptance === "PASS", "Historical owner_gate final_acceptance must be the observed PASS value");
}

function validateSatisfiedOwnerGateTransition(base, candidate, actor, now) {
  const fail = (condition, message) => invariant(condition, "OWNER_GATE_TRANSITION_INVALID", message);
  const gate = base.owner_gate;
  fail(gate?.kind === "HANDOFF_CONFIRM" && gate.status === "BLOCKED", "The base owner gate must be a BLOCKED HANDOFF_CONFIRM gate");
  fail(!Object.hasOwn(gate, "satisfied_task_status") || gate.satisfied_task_status === "IN_PROGRESS", "The owner gate target task status must be IN_PROGRESS");
  fail(!containsCanonicalCommandMention(gate.satisfied_next_step, gate.command), "The target next step must not repeat the authorization command or an alias");

  const protectedItem = base.task_items.find((item) => item.task_item_id === gate.item_id);
  fail(protectedItem?.status === "BLOCKED" && base.status === "BLOCKED" && base.current_item === null && base.next_item === gate.item_id, "The protected base lifecycle is not satisfiable");
  if (gate.satisfied_next_item !== undefined && gate.satisfied_next_item !== null) {
    const next = base.task_items.find((item) => item.task_item_id === gate.satisfied_next_item);
    fail(gate.satisfied_next_item !== gate.item_id && next && ["PLANNED", "BLOCKED"].includes(next.status), "satisfied_next_item must be a different current PLANNED or BLOCKED item");
  }

  assertExactSatisfiedOwnerGateTransition(base, candidate, actor, now);
}

export function validateTaskLedger(task) {
  strictJsonClone(task, { code: "LEDGER_JSON_DOMAIN_INVALID", field: "Ledger", clone: false });
  invariant(task !== null && typeof task === "object" && !Array.isArray(task), "LEDGER_FIELD_INVALID", "Ledger must be a JSON object");
  for (const field of TASK_REQUIRED_FIELDS) invariant(Object.hasOwn(task, field), "LEDGER_FIELD_MISSING", `Ledger missing ${field}`);
  invariant(task.schema_version === "0.1.0", "LEDGER_SCHEMA_UNSUPPORTED");
  boundedString(task.task_id, "task_id", { id: true });
  boundedString(task.title, "title");
  boundedString(task.objective, "objective");
  boundedString(task.requirements_version, "requirements_version", { id: true });
  boundedString(task.plan_revision_id, "plan_revision_id", { id: true });
  invariant(TASK_STATES.has(task.status), "LEDGER_STATUS_INVALID", `task ${TASK_STATUS_MESSAGE}`);
  boundedStringArray(task.completion_criteria, "completion_criteria", { nonEmpty: true });
  boundedString(task.risk, "risk");
  canonicalUtc(task.created_at, "created_at");
  canonicalUtc(task.updated_at, "updated_at");
  boundedString(task.next_step, "next_step");
  if (task.current_item !== null) boundedString(task.current_item, "current_item", { id: true });
  if (task.next_item !== null) boundedString(task.next_item, "next_item", { id: true });
  if (Object.hasOwn(task, "evidence")) boundedStringArray(task.evidence, "evidence");
  if (["DROPPED", "SUPERSEDED"].includes(task.status)) validateTerminalProvenance(task, "Task");
  if (Object.hasOwn(task, "minimal_reads")) validateBoundedStringList(task.minimal_reads, "minimal_reads");
  canonicalRequiredLocalPaths(Object.hasOwn(task, "required_local_paths") ? task.required_local_paths : []);
  invariant(Array.isArray(task.task_items) && task.task_items.length > 0 && task.task_items.length <= MAX_LEDGER_LIST_ENTRIES, "LEDGER_ITEMS_INVALID", "task_items must be a non-empty bounded array");

  const ids = new Set();
  for (const item of task.task_items) {
    invariant(item !== null && typeof item === "object" && !Array.isArray(item), "LEDGER_ITEM_FIELDS_INVALID", "TaskItem must be a JSON object");
    for (const field of ITEM_REQUIRED_FIELDS) invariant(Object.hasOwn(item, field), "LEDGER_FIELD_MISSING", `TaskItem missing ${field}`);
    boundedString(item.task_item_id, "task_item_id", { id: true });
    invariant(!ids.has(item.task_item_id), "LEDGER_ITEM_ID_INVALID", "task_item_id must be unique");
    boundedString(item.task_id, "TaskItem task_id", { id: true });
    invariant(item.task_id === task.task_id, "LEDGER_TASK_ID_MISMATCH");
    boundedString(item.title, "TaskItem title");
    boundedString(item.description, "TaskItem description");
    invariant(TASK_STATES.has(item.status), "LEDGER_ITEM_STATUS_INVALID", `item ${TASK_STATUS_MESSAGE}`);
    boundedStringArray(item.depends_on, "depends_on", { ids: true });
    invariant(new Set(item.depends_on).size === item.depends_on.length, "LEDGER_DEPENDENCY_INVALID", "depends_on must not contain duplicates");
    boundedStringArray(item.completion_criteria, "TaskItem completion_criteria", { nonEmpty: true });
    boundedStringArray(item.evidence, "TaskItem evidence");
    boundedStringArray(item.requirements_refs, "requirements_refs", { ids: true });
    boundedString(item.risk, "TaskItem risk");
    boundedString(item.milestone, "milestone", { id: true });
    canonicalUtc(item.last_updated_at, "last_updated_at");
    boundedString(item.last_updated_by, "last_updated_by");
    for (const field of ITEM_OPTIONAL_ID_FIELDS) if (Object.hasOwn(item, field)) boundedString(item[field], field, { id: true });
    if (["DROPPED", "SUPERSEDED"].includes(item.status)) validateTerminalProvenance(item, `TaskItem ${item.task_item_id}`);
    if (item.status === "DONE") invariant(item.evidence.length > 0, "DONE_WITHOUT_EVIDENCE");
    ids.add(item.task_item_id);
  }

  if (task.status === "DONE") {
    invariant(Array.isArray(task.evidence) && task.evidence.length > 0, "DONE_WITHOUT_EVIDENCE");
    invariant(task.task_items.every((item) => ["DONE", "DROPPED", "SUPERSEDED"].includes(item.status)), "DONE_WITH_OPEN_ITEMS");
  }
  for (const item of task.task_items) for (const dependency of item.depends_on) invariant(ids.has(dependency), "LEDGER_DEPENDENCY_UNKNOWN", dependency);
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(task.task_items.map((item) => [item.task_item_id, item]));
  for (const item of task.task_items) {
    for (const field of ["supersedes", "superseded_by"]) if (Object.hasOwn(item, field)) {
      invariant(item[field] !== item.task_item_id && byId.has(item[field]), "LEDGER_SUPERSESSION_INVALID", `${item.task_item_id}.${field} must reference another existing TaskItem`);
    }
  }
  const visit = (id) => {
    invariant(!visiting.has(id), "LEDGER_DAG_CYCLE", id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  const inProgress = task.task_items.filter((item) => item.status === "IN_PROGRESS");
  invariant(inProgress.length <= 1, "LEDGER_MULTIPLE_CURRENT_ITEMS", "at most one item may be IN_PROGRESS");
  invariant(task.current_item === null || ids.has(task.current_item), "LEDGER_CURRENT_ITEM_INVALID", "current_item must be null or reference an existing item");
  invariant(task.next_item === null || ids.has(task.next_item), "LEDGER_NEXT_ITEM_INVALID", "next_item must be null or reference an existing item");
  invariant(task.current_item !== task.next_item || task.current_item === null, "LEDGER_LIFECYCLE_INVALID", "current_item and next_item must differ");
  if (task.current_item === null) invariant(inProgress.length === 0, "LEDGER_CURRENT_ITEM_MISMATCH", "current_item must reference the sole IN_PROGRESS item, or be null when none is IN_PROGRESS");
  else invariant(inProgress.length === 1 && inProgress[0].task_item_id === task.current_item, "LEDGER_CURRENT_ITEM_MISMATCH", "current_item must reference the sole IN_PROGRESS item");
  if (task.next_item !== null) invariant(["PLANNED", "BLOCKED"].includes(byId.get(task.next_item).status), "LEDGER_NEXT_ITEM_INVALID", "next_item must reference a PLANNED or BLOCKED item");
  if (task.status === "DONE") invariant(task.current_item === null && task.next_item === null, "DONE_WITH_OPEN_LIFECYCLE");
  validateOwnerGate(task, byId, inProgress);
  return task;
}

function ledgerResult(task, contentDigest, path) {
  return Object.freeze({
    ...structuredClone(task),
    content_digest: contentDigest,
    path,
    current_item: task.current_item,
    next_item: task.next_item,
  });
}

export class TaskLedger {
  #writer;

  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve(path);
    this.#writer = options.writer ?? new PlanRevisionWriter(this.path, options.writerOptions);
    const coordinateExactPlan = (expected, use, code, message) => this.#writer.coordinate({
      validate: validateTaskLedger,
      use: (observed) => {
        const plan = ledgerResult(observed.task, observed.contentDigest, this.path);
        invariant(plan.task_id === expected?.taskId
          && plan.plan_revision_id === expected?.planRevisionId
          && plan.content_digest === expected?.contentDigest,
        code, message);
        return use(plan);
      },
    });
    registerTrustedHandoffPlanCapability(this, {
      attest: (expected, reserve) => coordinateExactPlan(
        expected, reserve, "HANDOFF_CONSENT_STALE", "The authoritative plan changed before durable handoff reservation",
      ),
      attestRecovery: (expected, capture) => coordinateExactPlan(
        expected, capture, "PLAN_REVISION_MISMATCH", "The authoritative plan no longer matches the failed handoff recovery provenance",
      ),
      attestResume: (expected, capture) => coordinateExactPlan(
        expected, capture, "RESUME_EXPECTATION_STALE", "The authoritative plan changed after resume confirmation was displayed",
      ),
      attestCurrentTakeover: (claim) => this.#writer.coordinate({
        validate: validateTaskLedger,
        use: (observed) => claim(ledgerResult(observed.task, observed.contentDigest, this.path)),
      }),
      satisfyOwnerGate: (request, assertEligible) => this.#satisfyOwnerGate(request, assertEligible),
    });
  }

  read() {
    const observed = this.#writer.readCurrent({ validate: validateTaskLedger });
    return ledgerResult(observed.task, observed.contentDigest, this.path);
  }

  #satisfyOwnerGate({ command, actor, expected = null }, assertEligible = null) {
    return this.#writer.commit({
      expected,
      validate: validateTaskLedger,
      prepare: (observed) => {
        const task = structuredClone(observed.task);
        const eligibility = assertEligible?.();
        invariant(!eligibility || typeof eligibility.then !== "function",
          "HANDOFF_OWNER_GATE_AUTHORITY_INVALID", "Task ownership eligibility must remain synchronous under plan coordination");
        const gate = task.owner_gate;
        if (!gate || gate.status === "SATISFIED") return { noWrite: true, result: ledgerResult(task, observed.contentDigest, this.path) };
        invariant(gate.kind === "HANDOFF_CONFIRM" && gate.status === "BLOCKED", "OWNER_GATE_INVALID");
        invariant(
          canonicalOwnerCommand(gate.command) === HANDOFF_CONFIRM_CANONICAL_COMMAND
            && canonicalOwnerCommand(command) === HANDOFF_CONFIRM_CANONICAL_COMMAND
            && isAuthorizedHumanActor(actor),
          "OWNER_GATE_AUTHORIZATION_REQUIRED",
        );
        invariant(task.current_item === null && task.next_item === gate.item_id, "OWNER_GATE_LIFECYCLE_MISMATCH");
        const item = task.task_items.find((candidate) => candidate.task_item_id === gate.item_id);
        invariant(item?.status === "BLOCKED", "OWNER_GATE_ITEM_NOT_BLOCKED");
        invariant(typeof gate.satisfied_plan_revision_id === "string" && gate.satisfied_plan_revision_id !== task.plan_revision_id, "OWNER_GATE_REVISION_REQUIRED");
        invariant(typeof gate.satisfied_next_step === "string" && gate.satisfied_next_step.length > 0 && !containsCanonicalCommandMention(gate.satisfied_next_step, gate.command), "OWNER_GATE_NEXT_STEP_INVALID");
        const now = utcNow();
        gate.status = "SATISFIED";
        gate.satisfied_at = now;
        gate.satisfied_by = actor;
        task.plan_revision_id = gate.satisfied_plan_revision_id;
        task.status = "IN_PROGRESS";
        task.updated_at = now;
        task.current_item = gate.item_id;
        task.next_item = gate.satisfied_next_item ?? null;
        task.next_step = gate.satisfied_next_step;
        item.status = "IN_PROGRESS";
        item.last_updated_at = now;
        item.last_updated_by = actor;
        validateSatisfiedOwnerGateTransition(observed.task, task, actor, now);
        validateTaskLedger(task);
        const json = JSON.stringify(task, null, 2).replaceAll("\n", observed.block.lineEnding);
        const { text } = materializeLedgerMarkdown(observed, {
          json,
          metadata: { plan_revision_id: task.plan_revision_id, updated_at: now },
          allowSchemalessCompact: true,
        });
        const bytes = Buffer.from(text, "utf8");
        return { bytes, result: ledgerResult(task, sha256(bytes), this.path) };
      },
    });
  }

  validate(task) {
    return validateTaskLedger(task);
  }
}
