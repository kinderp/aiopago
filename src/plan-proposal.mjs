import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalJson, sha256, stableId, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { validateTaskLedger } from "./ledger.mjs";
import { LEGACY_TASK_LEDGER_SCHEMA, PlanRevisionWriter, TASK_LEDGER_SCHEMA, parseTaskPlanBytes } from "./plan-store.mjs";

export const PLAN_PROPOSAL_SCHEMA = "aiopago.plan-proposal/0.1.0";
export const PLAN_DIFF_SCHEMA = "aiopago.plan-diff/0.1.0";
export const PLAN_REVISION_SCHEMA = "aiopago.plan-revision/0.1.0";
export const PLAN_APPLY_RESULT_SCHEMA = "aiopago.plan-apply-result/0.1.0";
const PROPOSAL_RECORD_SCHEMA = "aiopago.plan-proposal-record/0.1.0";

const PROPOSAL_FIELDS = [
  "base_content_digest",
  "base_plan_revision_id",
  "candidate_plan",
  "change_reason",
  "created_at",
  "producer",
  "proposal_id",
  "proposed_plan_revision_id",
  "requirements_version",
  "schema",
  "task_id",
].sort();

function deepFreeze(value) {
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function canonicalClone(value) {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalClone(value[key])]));
  return value;
}

function nonEmptyString(value, field) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 4096, "PLAN_PROPOSAL_INVALID", `${field} must be a non-empty bounded string`);
}

function exactUtcTimestamp(value, field) {
  nonEmptyString(value, field);
  invariant(!Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "PLAN_PROPOSAL_INVALID", `${field} must be an RFC 3339 UTC timestamp in canonical ISO form`);
}

function canonicalPrettyJson(value, depth = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `[\n${value.map((entry) => `${childIndent}${canonicalPrettyJson(entry, depth + 1)}`).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `{\n${keys.map((key) => `${childIndent}${JSON.stringify(key)}: ${canonicalPrettyJson(value[key], depth + 1)}`).join(",\n")}\n${indent}}`;
  }
  invariant(value !== undefined, "PLAN_MATERIALIZATION_INVALID", "candidate plan cannot contain undefined");
  return JSON.stringify(value);
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function fieldDiff(before, after, excluded = new Set()) {
  const added = [];
  const removed = [];
  const changed = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !excluded.has(key)).sort();
  for (const field of keys) {
    const hasBefore = Object.hasOwn(before, field);
    const hasAfter = Object.hasOwn(after, field);
    if (!hasBefore) added.push({ field, value: canonicalClone(after[field]) });
    else if (!hasAfter) removed.push({ field, value: canonicalClone(before[field]) });
    else if (!sameValue(before[field], after[field])) changed.push({ field, before: canonicalClone(before[field]), after: canonicalClone(after[field]) });
  }
  return { added, removed, changed };
}

export function diffTaskPlans(basePlan, candidatePlan) {
  validateTaskLedger(basePlan);
  validateTaskLedger(candidatePlan);
  invariant(basePlan.task_id === candidatePlan.task_id, "PLAN_TASK_ID_MISMATCH", "Plan diff requires the same task_id");
  const baseItems = new Map(basePlan.task_items.map((item) => [item.task_item_id, item]));
  const candidateItems = new Map(candidatePlan.task_items.map((item) => [item.task_item_id, item]));
  const added = [];
  const removed = [];
  const changed = [];
  const itemIds = [...new Set([...baseItems.keys(), ...candidateItems.keys()])].sort();
  for (const taskItemId of itemIds) {
    const before = baseItems.get(taskItemId);
    const after = candidateItems.get(taskItemId);
    if (!before) added.push({ task_item_id: taskItemId, value: canonicalClone(after) });
    else if (!after) removed.push({ task_item_id: taskItemId, value: canonicalClone(before) });
    else {
      const fields = fieldDiff(before, after, new Set(["task_item_id"]));
      if (fields.added.length || fields.removed.length || fields.changed.length) changed.push({ task_item_id: taskItemId, fields });
    }
  }
  return deepFreeze({
    schema: PLAN_DIFF_SCHEMA,
    task_id: basePlan.task_id,
    base_plan_revision_id: basePlan.plan_revision_id,
    candidate_plan_revision_id: candidatePlan.plan_revision_id,
    plan: fieldDiff(basePlan, candidatePlan, new Set(["task_items"])),
    task_items: { added, removed, changed },
  });
}

export class PlanProposal {
  constructor(input) {
    invariant(input && typeof input === "object" && !Array.isArray(input), "PLAN_PROPOSAL_INVALID", "PlanProposal must be an object");
    invariant(JSON.stringify(Object.keys(input).sort()) === JSON.stringify(PROPOSAL_FIELDS), "PLAN_PROPOSAL_FIELDS_INVALID", `PlanProposal fields must be exactly: ${PROPOSAL_FIELDS.join(", ")}`);
    invariant(input.schema === PLAN_PROPOSAL_SCHEMA, "PLAN_PROPOSAL_SCHEMA_UNSUPPORTED", `Expected ${PLAN_PROPOSAL_SCHEMA}`);
    for (const field of ["proposal_id", "task_id", "base_plan_revision_id", "base_content_digest", "proposed_plan_revision_id", "requirements_version", "producer", "change_reason"]) nonEmptyString(input[field], field);
    exactUtcTimestamp(input.created_at, "created_at");
    invariant(/^sha256:[a-f0-9]{64}$/.test(input.base_content_digest), "PLAN_PROPOSAL_INVALID", "base_content_digest must be an exact SHA-256 digest");
    invariant(input.proposed_plan_revision_id !== input.base_plan_revision_id, "PLAN_REVISION_REUSE", "A proposal must create a new plan_revision_id");
    const candidate = clone(input.candidate_plan);
    validateTaskLedger(candidate);
    invariant(candidate.task_id === input.task_id, "PLAN_TASK_ID_MISMATCH", "candidate_plan task_id must match proposal task_id");
    invariant(candidate.plan_revision_id === input.proposed_plan_revision_id, "PLAN_REVISION_MISMATCH", "candidate_plan plan_revision_id must match proposed_plan_revision_id");
    invariant(candidate.requirements_version === input.requirements_version, "PLAN_REQUIREMENTS_MISMATCH", "candidate_plan requirements_version must match proposal requirements_version");
    invariant(candidate.updated_at === input.created_at, "PLAN_UPDATED_AT_MISMATCH", "candidate_plan updated_at must equal proposal created_at for deterministic materialization");
    const payload = { ...clone(input), candidate_plan: candidate };
    const proposalDigest = sha256(Buffer.from(canonicalJson(payload), "utf8"));
    Object.assign(this, payload, { proposal_digest: proposalDigest });
    deepFreeze(this);
  }
}

function assertMetadata(observed) {
  invariant(observed.schemaHeaderCount === 1, "PLAN_METADATA_INVALID", "A mutable TASK_PLAN.md must contain exactly one Schema header");
  if (observed.ledgerSchema === LEGACY_TASK_LEDGER_SCHEMA) {
    throw new GuardianError("PLAN_LEGACY_MIGRATION_REQUIRED", `Reading ${LEGACY_TASK_LEDGER_SCHEMA} remains supported, but Plan Proposal mutation requires an explicit migration to ${TASK_LEDGER_SCHEMA}`);
  }
  invariant(observed.ledgerSchema === TASK_LEDGER_SCHEMA, "PLAN_LEDGER_SCHEMA_UNSUPPORTED", `Plan Proposal mutation requires ${TASK_LEDGER_SCHEMA}`);
  const expected = [
    `**Current revision:** \`${observed.task.plan_revision_id}\``,
    `**Requirements version:** \`${observed.task.requirements_version}\``,
    `**Updated:** ${observed.task.updated_at}`,
  ];
  for (const line of expected) invariant(observed.text.split(line).length - 1 === 1, "PLAN_METADATA_MISMATCH", `Missing or ambiguous Ledger metadata: ${line}`);
}

function replaceOnce(text, before, after) {
  invariant(text.split(before).length - 1 === 1, "PLAN_METADATA_MISMATCH", `Missing or ambiguous Ledger metadata: ${before}`);
  return text.replace(before, after);
}

function materializeObserved(observed, proposal) {
  assertMetadata(observed);
  invariant(observed.task.task_id === proposal.task_id, "PLAN_TASK_ID_MISMATCH", "Proposal task_id does not match the observed Ledger");
  invariant(observed.task.plan_revision_id === proposal.base_plan_revision_id, "PLAN_CAS_CONFLICT", "Observed revision does not match proposal base revision");
  invariant(observed.contentDigest === proposal.base_content_digest, "PLAN_CAS_CONFLICT", "Observed bytes do not match proposal base digest");
  const candidate = clone(proposal.candidate_plan);
  validateTaskLedger(candidate);
  const json = canonicalPrettyJson(candidate).replaceAll("\n", observed.block.lineEnding);
  let text = observed.text.slice(0, observed.block.jsonIndex) + json + observed.text.slice(observed.block.jsonIndex + observed.block.json.length);
  text = replaceOnce(text, `**Current revision:** \`${observed.task.plan_revision_id}\``, `**Current revision:** \`${candidate.plan_revision_id}\``);
  text = replaceOnce(text, `**Requirements version:** \`${observed.task.requirements_version}\``, `**Requirements version:** \`${candidate.requirements_version}\``);
  text = replaceOnce(text, `**Updated:** ${observed.task.updated_at}`, `**Updated:** ${candidate.updated_at}`);
  const bytes = Buffer.from(text, "utf8");
  const parsed = parseTaskPlanBytes(bytes, { requireSingleBlock: true });
  validateTaskLedger(parsed.task);
  invariant(sameValue(parsed.task, candidate), "PLAN_MATERIALIZATION_INVALID", "Materialized Ledger does not equal candidate_plan");
  return deepFreeze({
    bytes,
    content_digest: sha256(bytes),
    candidate_plan: candidate,
    diff: diffTaskPlans(observed.task, candidate),
  });
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new GuardianError("PLAN_PROVENANCE_INVALID", `${path}: ${error.message}`); }
}

const APPLY_RESULT_FIELDS = ["applied_at", "content_digest", "diff", "plan_revision_id", "previous_content_digest", "previous_revision_id", "proposal_digest", "proposal_id", "provenance", "provenance_reference", "schema", "task_id"].sort();
const REVISION_FIELDS = ["authority", "change_reason", "content_digest", "created_at", "plan_revision_id", "previous_revision_id", "producer", "requirements_version", "schema", "task_id"].sort();
function validateStoredResult(result, proposal, provenanceReference) {
  invariant(result && JSON.stringify(Object.keys(result).sort()) === JSON.stringify(APPLY_RESULT_FIELDS), "PLAN_PROVENANCE_INVALID", "Stored apply result fields are invalid");
  invariant(result.schema === PLAN_APPLY_RESULT_SCHEMA && result.proposal_id === proposal.proposal_id && result.proposal_digest === proposal.proposal_digest, "PLAN_PROVENANCE_INVALID", "Stored apply result identity is invalid");
  invariant(result.task_id === proposal.task_id && result.previous_revision_id === proposal.base_plan_revision_id && result.plan_revision_id === proposal.proposed_plan_revision_id, "PLAN_PROVENANCE_INVALID", "Stored apply result revision identity is invalid");
  invariant(result.previous_content_digest === proposal.base_content_digest && /^sha256:[a-f0-9]{64}$/.test(result.content_digest), "PLAN_PROVENANCE_INVALID", "Stored apply result digest identity is invalid");
  invariant(result.provenance_reference === provenanceReference && result.diff?.schema === PLAN_DIFF_SCHEMA, "PLAN_PROVENANCE_INVALID", "Stored apply result references are invalid");
  invariant(typeof result.applied_at === "string" && !Number.isNaN(Date.parse(result.applied_at)) && new Date(result.applied_at).toISOString() === result.applied_at, "PLAN_PROVENANCE_INVALID", "Stored applied_at is invalid");
  const provenance = result.provenance;
  invariant(provenance && JSON.stringify(Object.keys(provenance).sort()) === JSON.stringify(REVISION_FIELDS), "PLAN_PROVENANCE_INVALID", "Stored PlanRevision fields are invalid");
  invariant(provenance.schema === PLAN_REVISION_SCHEMA && provenance.authority === "DERIVED_PROVENANCE", "PLAN_PROVENANCE_INVALID", "Stored PlanRevision schema or authority is invalid");
  invariant(provenance.plan_revision_id === result.plan_revision_id && provenance.task_id === result.task_id && provenance.previous_revision_id === result.previous_revision_id, "PLAN_PROVENANCE_INVALID", "Stored PlanRevision identity is invalid");
  invariant(provenance.requirements_version === proposal.requirements_version && provenance.content_digest === result.content_digest, "PLAN_PROVENANCE_INVALID", "Stored PlanRevision content identity is invalid");
  invariant(provenance.created_at === proposal.created_at && provenance.producer === proposal.producer && provenance.change_reason === proposal.change_reason, "PLAN_PROVENANCE_INVALID", "Stored PlanRevision provenance is invalid");
  return result;
}

export class PlanPort {
  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve(path);
    this.writer = options.writer ?? new PlanRevisionWriter(this.path, options.writerOptions);
    this.now = options.now ?? utcNow;
    this.beforeFinalAttestation = options.beforeFinalAttestation;
    this.provenanceRoot = resolve(options.provenanceRoot ?? join(dirname(this.path), ".guardian", "plan-proposals"));
  }

  proposal(input) {
    return input instanceof PlanProposal ? input : new PlanProposal(input);
  }

  observe() {
    const observed = this.writer.readCurrent({ requireSingleBlock: true, validate: validateTaskLedger });
    return deepFreeze({
      task_id: observed.task.task_id,
      plan_revision_id: observed.task.plan_revision_id,
      content_digest: observed.contentDigest,
      bytes: Buffer.from(observed.bytes),
      plan: clone(observed.task),
    });
  }

  materialize(input, baseBytes) {
    const proposal = this.proposal(input);
    const observed = parseTaskPlanBytes(baseBytes ?? this.writer.io.readFileSync(this.path), { requireSingleBlock: true });
    validateTaskLedger(observed.task);
    return materializeObserved(observed, proposal);
  }

  apply(input) {
    const proposal = this.proposal(input);
    const recordId = stableId("proposal", proposal.proposal_id);
    const recordRoot = join(this.provenanceRoot, recordId);
    const preparedPath = join(recordRoot, "prepared.json");
    const appliedPath = join(recordRoot, "applied.json");
    const provenanceReference = relative(dirname(this.path), appliedPath).replaceAll("\\", "/");
    let priorPrepared = null;

    return deepFreeze(this.writer.commit({
      expected: { planRevisionId: proposal.base_plan_revision_id, contentDigest: proposal.base_content_digest },
      requireSingleBlock: true,
      validate: validateTaskLedger,
      inspectExisting: (current) => {
        const hasPrepared = this.writer.io.existsSync(preparedPath);
        const hasApplied = this.writer.io.existsSync(appliedPath);
        invariant(hasPrepared || !hasApplied, "PLAN_PROVENANCE_INVALID", "Applied proposal provenance exists without its prepared recovery record");
        if (!hasPrepared) return null;
        const prepared = readJson(preparedPath);
        invariant(JSON.stringify(Object.keys(prepared).sort()) === JSON.stringify(["authority", "proposal_digest", "proposal_id", "result", "schema", "state"]), "PLAN_PROVENANCE_INVALID", "Prepared proposal provenance fields are invalid");
        invariant(prepared.schema === PROPOSAL_RECORD_SCHEMA && prepared.authority === "DERIVED_PROVENANCE" && prepared.state === "PREPARED" && prepared.proposal_id === proposal.proposal_id, "PLAN_PROVENANCE_INVALID", "Prepared proposal provenance is invalid");
        if (prepared.proposal_digest !== proposal.proposal_digest) throw new GuardianError("PLAN_PROPOSAL_ID_CONFLICT", "The same proposal_id was already registered with different content");
        validateStoredResult(prepared.result, proposal, provenanceReference);
        priorPrepared = prepared;
        if (hasApplied) {
          const applied = readJson(appliedPath);
          validateStoredResult(applied, proposal, provenanceReference);
          invariant(sameValue(applied, prepared.result), "PLAN_PROVENANCE_INVALID", "Prepared and applied provenance records disagree");
          invariant(current.task.plan_revision_id === applied.plan_revision_id && current.contentDigest === applied.content_digest, "PLAN_PROPOSAL_RECOVERY_CONFLICT", "Applied provenance does not match the current authoritative plan");
          return deepFreeze(applied);
        }
        if (current.task.plan_revision_id === prepared.result.plan_revision_id && current.contentDigest === prepared.result.content_digest) {
          this.writer.writeImmutable(appliedPath, jsonBytes(prepared.result));
          return deepFreeze(prepared.result);
        }
        return null;
      },
      prepare: (current) => {
        const materialized = materializeObserved(current, proposal);
        let record = priorPrepared;
        if (record) {
          invariant(record.result.content_digest === materialized.content_digest && sameValue(record.result.diff, materialized.diff), "PLAN_PROPOSAL_RECOVERY_CONFLICT", "Prepared provenance does not match deterministic materialization");
        } else {
          const provenance = deepFreeze({
            schema: PLAN_REVISION_SCHEMA,
            authority: "DERIVED_PROVENANCE",
            plan_revision_id: proposal.proposed_plan_revision_id,
            task_id: proposal.task_id,
            previous_revision_id: proposal.base_plan_revision_id,
            requirements_version: proposal.requirements_version,
            content_digest: materialized.content_digest,
            created_at: proposal.created_at,
            producer: proposal.producer,
            change_reason: proposal.change_reason,
          });
          const appliedAt = this.now();
          invariant(typeof appliedAt === "string" && !Number.isNaN(Date.parse(appliedAt)) && new Date(appliedAt).toISOString() === appliedAt, "PLAN_APPLIED_AT_INVALID", "Plan apply clock must return a canonical UTC timestamp");
          const result = deepFreeze({
            schema: PLAN_APPLY_RESULT_SCHEMA,
            proposal_id: proposal.proposal_id,
            proposal_digest: proposal.proposal_digest,
            task_id: proposal.task_id,
            previous_revision_id: proposal.base_plan_revision_id,
            plan_revision_id: proposal.proposed_plan_revision_id,
            previous_content_digest: proposal.base_content_digest,
            content_digest: materialized.content_digest,
            applied_at: appliedAt,
            diff: materialized.diff,
            provenance,
            provenance_reference: provenanceReference,
          });
          record = deepFreeze({
            schema: PROPOSAL_RECORD_SCHEMA,
            authority: "DERIVED_PROVENANCE",
            state: "PREPARED",
            proposal_id: proposal.proposal_id,
            proposal_digest: proposal.proposal_digest,
            result,
          });
          this.writer.writeImmutable(preparedPath, jsonBytes(record));
        }
        return {
          bytes: Buffer.from(materialized.bytes),
          result: deepFreeze(record.result),
          afterCommit: () => this.writer.writeImmutable(appliedPath, jsonBytes(record.result)),
        };
      },
      beforeFinalAttestation: this.beforeFinalAttestation,
    }));
  }
}
