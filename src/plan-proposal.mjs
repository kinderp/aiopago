import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalJson, sha256, stableId, strictJsonClone, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { validateTaskLedger } from "./ledger.mjs";
import { LEGACY_TASK_LEDGER_SCHEMA, PlanRevisionWriter, TASK_LEDGER_SCHEMA, parseTaskPlanBytes, sameFilesystemIdentity } from "./plan-store.mjs";

export const PLAN_PROPOSAL_SCHEMA = "aiopago.plan-proposal/0.1.0";
export const PLAN_DIFF_SCHEMA = "aiopago.plan-diff/0.1.0";
export const PLAN_REVISION_SCHEMA = "aiopago.plan-revision/0.2.0";
export const PLAN_APPLY_RESULT_SCHEMA = "aiopago.plan-apply-result/0.2.0";
const PROPOSAL_REGISTRATION_SCHEMA = "aiopago.plan-proposal-registration/0.2.0";
const COMMIT_INTENT_SCHEMA = "aiopago.plan-commit-intent/0.2.0";
const COMMIT_WITNESS_SCHEMA = "aiopago.plan-commit-witness/0.2.0";

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
const REGISTRATION_FIELDS = ["authority", "proposal", "proposal_digest", "schema"].sort();
const IDENTITY_FIELDS = ["device", "inode"].sort();
const INTENT_FIELDS = [
  "attempt_token", "authority", "base_content_digest", "base_filesystem_identity", "base_plan_revision_id",
  "candidate_content_digest", "candidate_plan_revision_id", "candidate_temp_filesystem_identity", "candidate_temp_reference",
  "diff", "prepared_at", "previous_snapshot_reference", "proposal_digest", "proposal_id", "provenance", "schema", "state",
].sort();
const REVISION_FIELDS = [
  "authority", "change_reason", "content_digest", "created_at", "plan_revision_id", "previous_content_digest",
  "previous_revision_id", "previous_snapshot_reference", "producer", "requirements_version", "schema", "task_id",
].sort();
const WITNESS_FIELDS = ["attempt_token", "commit_intent_reference", "filesystem_identity", "schema"].sort();
const APPLY_RESULT_FIELDS = [
  "applied_at", "commit_witness", "content_digest", "diff", "plan_revision_id", "prepared_at", "previous_content_digest",
  "previous_revision_id", "proposal_digest", "proposal_id", "provenance", "provenance_reference", "recovered_at", "schema", "task_id",
].sort();

function exactFields(value, fields, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(fields), code, `${label} fields are invalid`);
}

function deepFreeze(value) {
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone(value) {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (value !== null && typeof value === "object") {
    const clone = {};
    for (const key of Object.keys(value).sort()) Object.defineProperty(clone, key, { value: canonicalClone(value[key]), enumerable: true, writable: true, configurable: true });
    return clone;
  }
  return value;
}

function nonEmptyString(value, field, maximum = 4096) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= maximum, "PLAN_PROPOSAL_INVALID", `${field} must be a non-empty bounded string`);
}

function exactUtcTimestamp(value, field, code = "PLAN_PROPOSAL_INVALID") {
  invariant(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, code, `${field} must be a canonical RFC 3339 UTC timestamp`);
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
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
  return JSON.stringify(value);
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

function proposalPayload(proposal) {
  const payload = {};
  for (const field of PROPOSAL_FIELDS) Object.defineProperty(payload, field, { value: proposal[field], enumerable: true, writable: true, configurable: true });
  return payload;
}

export class PlanProposal {
  constructor(input) {
    const payload = strictJsonClone(input, { code: "PLAN_PROPOSAL_JSON_DOMAIN_INVALID", field: "PlanProposal" });
    exactFields(payload, PROPOSAL_FIELDS, "PLAN_PROPOSAL_FIELDS_INVALID", "PlanProposal");
    invariant(payload.schema === PLAN_PROPOSAL_SCHEMA, "PLAN_PROPOSAL_SCHEMA_UNSUPPORTED", `Expected ${PLAN_PROPOSAL_SCHEMA}`);
    for (const field of ["proposal_id", "task_id", "base_plan_revision_id", "base_content_digest", "proposed_plan_revision_id", "requirements_version", "producer", "change_reason"]) nonEmptyString(payload[field], field);
    exactUtcTimestamp(payload.created_at, "created_at");
    invariant(/^sha256:[a-f0-9]{64}$/.test(payload.base_content_digest), "PLAN_PROPOSAL_INVALID", "base_content_digest must be an exact SHA-256 digest");
    invariant(payload.proposed_plan_revision_id !== payload.base_plan_revision_id, "PLAN_REVISION_REUSE", "A proposal must create a new plan_revision_id");
    const candidate = payload.candidate_plan;
    validateTaskLedger(candidate);
    invariant(candidate.task_id === payload.task_id, "PLAN_TASK_ID_MISMATCH", "candidate_plan task_id must match proposal task_id");
    invariant(candidate.plan_revision_id === payload.proposed_plan_revision_id, "PLAN_REVISION_MISMATCH", "candidate_plan plan_revision_id must match proposed_plan_revision_id");
    invariant(candidate.requirements_version === payload.requirements_version, "PLAN_REQUIREMENTS_MISMATCH", "candidate_plan requirements_version must match proposal requirements_version");
    invariant(candidate.updated_at === payload.created_at, "PLAN_UPDATED_AT_MISMATCH", "candidate_plan updated_at must equal proposal created_at for deterministic materialization");
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
  const candidate = proposal.candidate_plan;
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

function readJson(writer, path) {
  try {
    const parsed = JSON.parse(writer.readImmutable(path).toString("utf8"));
    return strictJsonClone(parsed, { code: "PLAN_PROVENANCE_INVALID", field: path });
  } catch (error) {
    if (error?.code === "PLAN_PROVENANCE_INVALID") throw error;
    throw new GuardianError("PLAN_PROVENANCE_INVALID", `${path}: ${error.message}`);
  }
}

function validateIdentity(value, label) {
  exactFields(value, IDENTITY_FIELDS, "PLAN_PROVENANCE_INVALID", label);
  invariant(/^[0-9]+$/.test(value.device) && /^[0-9]+$/.test(value.inode), "PLAN_PROVENANCE_INVALID", `${label} is invalid`);
}

function revisionFor(proposal, materialized, previousSnapshotReference) {
  return deepFreeze({
    schema: PLAN_REVISION_SCHEMA,
    authority: "DERIVED_EVIDENCE",
    plan_revision_id: proposal.proposed_plan_revision_id,
    task_id: proposal.task_id,
    previous_revision_id: proposal.base_plan_revision_id,
    previous_content_digest: proposal.base_content_digest,
    previous_snapshot_reference: previousSnapshotReference,
    requirements_version: proposal.requirements_version,
    content_digest: materialized.content_digest,
    created_at: proposal.created_at,
    producer: proposal.producer,
    change_reason: proposal.change_reason,
  });
}

function validateRegistration(registration, proposal) {
  exactFields(registration, REGISTRATION_FIELDS, "PLAN_PROVENANCE_INVALID", "Proposal registration");
  invariant(registration.schema === PROPOSAL_REGISTRATION_SCHEMA && registration.authority === "DERIVED_EVIDENCE", "PLAN_PROVENANCE_INVALID", "Proposal registration schema or authority is invalid");
  if (registration.proposal_digest !== proposal.proposal_digest) throw new GuardianError("PLAN_PROPOSAL_ID_CONFLICT", "The same proposal_id was already registered with different content");
  invariant(sameValue(registration.proposal, proposalPayload(proposal)), "PLAN_PROVENANCE_INVALID", "Registered proposal payload does not match its digest and caller proposal");
}

function validateIntent(intent, proposal, materialized, previousSnapshotReference) {
  exactFields(intent, INTENT_FIELDS, "PLAN_PROVENANCE_INVALID", "Commit intent");
  invariant(intent.schema === COMMIT_INTENT_SCHEMA && intent.authority === "DERIVED_EVIDENCE" && intent.state === "COMMIT_INTENT", "PLAN_PROVENANCE_INVALID", "Commit intent schema, authority, or state is invalid");
  invariant(intent.proposal_id === proposal.proposal_id && intent.proposal_digest === proposal.proposal_digest, "PLAN_PROVENANCE_INVALID", "Commit intent proposal identity is invalid");
  invariant(/^[a-f0-9]{64}$/.test(intent.attempt_token), "PLAN_PROVENANCE_INVALID", "Commit intent attempt token is invalid");
  exactUtcTimestamp(intent.prepared_at, "prepared_at", "PLAN_PROVENANCE_INVALID");
  invariant(intent.base_plan_revision_id === proposal.base_plan_revision_id && intent.base_content_digest === proposal.base_content_digest, "PLAN_PROVENANCE_INVALID", "Commit intent base identity is invalid");
  invariant(intent.candidate_plan_revision_id === proposal.proposed_plan_revision_id && intent.candidate_content_digest === materialized.content_digest, "PLAN_PROVENANCE_INVALID", "Commit intent candidate identity is invalid");
  invariant(intent.previous_snapshot_reference === previousSnapshotReference, "PLAN_PROVENANCE_INVALID", "Commit intent history reference is invalid");
  validateIdentity(intent.base_filesystem_identity, "Base filesystem identity");
  validateIdentity(intent.candidate_temp_filesystem_identity, "Candidate filesystem identity");
  invariant(!sameFilesystemIdentity(intent.base_filesystem_identity, intent.candidate_temp_filesystem_identity), "PLAN_PROVENANCE_INVALID", "Candidate witness must differ from the base filesystem identity");
  invariant(typeof intent.candidate_temp_reference === "string" && !intent.candidate_temp_reference.includes("/") && !intent.candidate_temp_reference.includes("\\") && intent.candidate_temp_reference.endsWith(".replace.tmp"), "PLAN_PROVENANCE_INVALID", "Candidate temp reference is invalid");
  invariant(sameValue(intent.diff, materialized.diff), "PLAN_PROVENANCE_INVALID", "Commit intent diff does not match deterministic materialization");
  invariant(sameValue(intent.provenance, revisionFor(proposal, materialized, previousSnapshotReference)), "PLAN_PROVENANCE_INVALID", "Commit intent PlanRevision does not match deterministic materialization");
  return intent;
}

function resultFor({ proposal, materialized, provenance, provenanceReference, intent, intentReference, appliedAt, recoveredAt }) {
  return deepFreeze({
    schema: PLAN_APPLY_RESULT_SCHEMA,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    task_id: proposal.task_id,
    previous_revision_id: proposal.base_plan_revision_id,
    plan_revision_id: proposal.proposed_plan_revision_id,
    previous_content_digest: proposal.base_content_digest,
    content_digest: materialized.content_digest,
    prepared_at: intent.prepared_at,
    applied_at: appliedAt,
    recovered_at: recoveredAt,
    diff: materialized.diff,
    provenance,
    provenance_reference: provenanceReference,
    commit_witness: {
      schema: COMMIT_WITNESS_SCHEMA,
      attempt_token: intent.attempt_token,
      filesystem_identity: intent.candidate_temp_filesystem_identity,
      commit_intent_reference: intentReference,
    },
  });
}

function validateStoredResult(result, proposal, materialized, provenanceReference, intent, intentReference) {
  exactFields(result, APPLY_RESULT_FIELDS, "PLAN_PROVENANCE_INVALID", "Stored apply result");
  invariant(result.schema === PLAN_APPLY_RESULT_SCHEMA && result.proposal_id === proposal.proposal_id && result.proposal_digest === proposal.proposal_digest, "PLAN_PROVENANCE_INVALID", "Stored apply result identity is invalid");
  invariant(result.task_id === proposal.task_id && result.previous_revision_id === proposal.base_plan_revision_id && result.plan_revision_id === proposal.proposed_plan_revision_id, "PLAN_PROVENANCE_INVALID", "Stored apply result revision identity is invalid");
  invariant(result.previous_content_digest === proposal.base_content_digest && result.content_digest === materialized.content_digest, "PLAN_PROVENANCE_INVALID", "Stored apply result digest identity is invalid");
  invariant(result.prepared_at === intent.prepared_at && result.provenance_reference === provenanceReference && sameValue(result.diff, materialized.diff), "PLAN_PROVENANCE_INVALID", "Stored apply result deterministic fields are invalid");
  const normal = typeof result.applied_at === "string" && result.recovered_at === null;
  const recovered = result.applied_at === null && typeof result.recovered_at === "string";
  invariant(normal || recovered, "PLAN_PROVENANCE_INVALID", "Stored apply/recovery timestamps are not truthful");
  if (normal) exactUtcTimestamp(result.applied_at, "applied_at", "PLAN_PROVENANCE_INVALID");
  else exactUtcTimestamp(result.recovered_at, "recovered_at", "PLAN_PROVENANCE_INVALID");
  exactFields(result.provenance, REVISION_FIELDS, "PLAN_PROVENANCE_INVALID", "Stored PlanRevision");
  invariant(sameValue(result.provenance, revisionFor(proposal, materialized, intent.previous_snapshot_reference)), "PLAN_PROVENANCE_INVALID", "Stored PlanRevision does not match deterministic materialization");
  exactFields(result.commit_witness, WITNESS_FIELDS, "PLAN_PROVENANCE_INVALID", "Stored commit witness");
  invariant(result.commit_witness.schema === COMMIT_WITNESS_SCHEMA && result.commit_witness.attempt_token === intent.attempt_token && result.commit_witness.commit_intent_reference === intentReference && sameValue(result.commit_witness.filesystem_identity, intent.candidate_temp_filesystem_identity), "PLAN_PROVENANCE_INVALID", "Stored commit witness is invalid");
  return result;
}

export class PlanPort {
  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve(path);
    this.writer = options.writer ?? new PlanRevisionWriter(this.path, options.writerOptions);
    this.now = options.now ?? utcNow;
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
      plan: canonicalClone(observed.task),
    });
  }

  materialize(input, baseBytes) {
    const proposal = this.proposal(input);
    const observed = parseTaskPlanBytes(baseBytes ?? this.writer.readPlanBytes(), { requireSingleBlock: true });
    validateTaskLedger(observed.task);
    return materializeObserved(observed, proposal);
  }

  apply(input) {
    const proposal = this.proposal(input);
    const recordId = stableId("proposal", proposal.proposal_id);
    const recordRoot = join(this.provenanceRoot, recordId);
    const registrationPath = join(recordRoot, "proposal.json");
    const attemptsRoot = join(recordRoot, "attempts");
    const appliedPath = join(recordRoot, "applied.json");
    const provenanceReference = relative(dirname(this.path), appliedPath).replaceAll("\\", "/");
    const expectedRegistration = deepFreeze({
      schema: PROPOSAL_REGISTRATION_SCHEMA,
      authority: "DERIVED_EVIDENCE",
      proposal_digest: proposal.proposal_digest,
      proposal: proposalPayload(proposal),
    });
    let activeIntent;
    let activeIntentPath;
    let activeIntentReference;
    let activeMaterialized;

    const inspectTree = () => {
      if (!this.writer.stateExists(recordRoot)) return { registration: null, intents: [], applied: null };
      const names = this.writer.stateDirectoryEntries(recordRoot);
      invariant(names.length <= 3 && names.every((entry) => ["proposal.json", "attempts", "applied.json"].includes(entry.name)), "PLAN_PROVENANCE_INVALID", "Proposal record directory contains an unexpected entry");
      invariant(this.writer.stateExists(registrationPath), "PLAN_PROVENANCE_INVALID", "Proposal record directory has no immutable proposal registration");
      const registration = readJson(this.writer, registrationPath);
      validateRegistration(registration, proposal);
      const intents = [];
      if (this.writer.stateExists(attemptsRoot)) {
        const attemptEntries = this.writer.stateDirectoryEntries(attemptsRoot);
        invariant(attemptEntries.length <= 128, "PLAN_PROVENANCE_INVALID", "Too many plan commit attempts");
        for (const entry of attemptEntries) {
          invariant(entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name), "PLAN_PROVENANCE_INVALID", "Invalid plan commit-intent record");
          const path = join(attemptsRoot, entry.name);
          intents.push({ path, reference: relative(dirname(this.path), path).replaceAll("\\", "/"), value: readJson(this.writer, path) });
        }
      }
      const applied = this.writer.stateExists(appliedPath) ? readJson(this.writer, appliedPath) : null;
      return { registration, intents, applied };
    };

    return deepFreeze(this.writer.commit({
      expected: { planRevisionId: proposal.base_plan_revision_id, contentDigest: proposal.base_content_digest },
      requireSingleBlock: true,
      validate: validateTaskLedger,
      inspectExisting: (current) => {
        const tree = inspectTree();
        if (!tree.registration) return null;
        const currentIsBase = current.task.plan_revision_id === proposal.base_plan_revision_id && current.contentDigest === proposal.base_content_digest;
        if (currentIsBase && tree.applied) throw new GuardianError("PLAN_PROVENANCE_INVALID", "Applied provenance exists while the authoritative plan is still the proposal base");
        if (currentIsBase && tree.intents.length === 0) return null;

        const previousSnapshotReference = `.guardian/plan-history/sha256-${proposal.base_content_digest.slice("sha256:".length)}.md`;
        const snapshotPath = resolve(dirname(this.path), previousSnapshotReference);
        invariant(this.writer.stateExists(snapshotPath), "PLAN_PROVENANCE_INVALID", "Commit evidence exists without the exact previous revision snapshot");
        const baseBytes = this.writer.readImmutable(snapshotPath);
        invariant(sha256(baseBytes) === proposal.base_content_digest, "PLAN_HISTORY_CORRUPT", "Previous plan snapshot digest is corrupt");
        const base = parseTaskPlanBytes(baseBytes, { requireSingleBlock: true });
        validateTaskLedger(base.task);
        const materialized = materializeObserved(base, proposal);
        for (const attempt of tree.intents) validateIntent(attempt.value, proposal, materialized, previousSnapshotReference);
        if (currentIsBase) return null;

        const currentIsCandidate = current.task.plan_revision_id === proposal.proposed_plan_revision_id
          && current.contentDigest === materialized.content_digest
          && sameValue(current.task, proposal.candidate_plan);
        if (!currentIsCandidate) throw new GuardianError("PLAN_PROPOSAL_RECOVERY_CONFLICT", "Current authoritative plan is neither the exact proposal base nor its deterministic candidate");
        const witnesses = tree.intents.filter((attempt) => sameFilesystemIdentity(attempt.value.candidate_temp_filesystem_identity, current.fileIdentity));
        if (witnesses.length !== 1) throw new GuardianError("PLAN_RECOVERY_AMBIGUOUS", "Current candidate bytes do not have one verifiable Aiopago replacement witness");
        const witnessed = witnesses[0];
        const provenance = revisionFor(proposal, materialized, previousSnapshotReference);
        if (tree.applied) return deepFreeze(validateStoredResult(tree.applied, proposal, materialized, provenanceReference, witnessed.value, witnessed.reference));
        const recoveredAt = this.now();
        exactUtcTimestamp(recoveredAt, "recovered_at", "PLAN_RECOVERED_AT_INVALID");
        const recovered = resultFor({
          proposal, materialized, provenance, provenanceReference,
          intent: witnessed.value, intentReference: witnessed.reference,
          appliedAt: null, recoveredAt,
        });
        this.writer.writeImmutable(appliedPath, jsonBytes(recovered));
        return recovered;
      },
      prepare: (current, { previousSnapshotReference }) => {
        const materialized = materializeObserved(current, proposal);
        activeMaterialized = materialized;
        const provenance = revisionFor(proposal, materialized, previousSnapshotReference);
        return {
          bytes: Buffer.from(materialized.bytes),
          beforeFinalAttestation: ({ candidateTempIdentity, candidateTempReference }) => {
            this.writer.writeImmutable(registrationPath, jsonBytes(expectedRegistration), { conflictCode: "PLAN_PROPOSAL_ID_CONFLICT" });
            const preparedAt = this.now();
            exactUtcTimestamp(preparedAt, "prepared_at", "PLAN_PREPARED_AT_INVALID");
            const attemptToken = randomBytes(32).toString("hex");
            activeIntent = deepFreeze({
              schema: COMMIT_INTENT_SCHEMA,
              authority: "DERIVED_EVIDENCE",
              state: "COMMIT_INTENT",
              proposal_id: proposal.proposal_id,
              proposal_digest: proposal.proposal_digest,
              attempt_token: attemptToken,
              prepared_at: preparedAt,
              base_plan_revision_id: proposal.base_plan_revision_id,
              base_content_digest: proposal.base_content_digest,
              base_filesystem_identity: current.fileIdentity,
              candidate_plan_revision_id: proposal.proposed_plan_revision_id,
              candidate_content_digest: materialized.content_digest,
              candidate_temp_filesystem_identity: candidateTempIdentity,
              candidate_temp_reference: candidateTempReference,
              previous_snapshot_reference: previousSnapshotReference,
              diff: materialized.diff,
              provenance,
            });
            activeIntentPath = join(attemptsRoot, `${attemptToken}.json`);
            activeIntentReference = relative(dirname(this.path), activeIntentPath).replaceAll("\\", "/");
            this.writer.writeImmutable(activeIntentPath, jsonBytes(activeIntent));
          },
          afterCommit: ({ committed }) => {
            invariant(activeIntent && activeMaterialized && sameFilesystemIdentity(committed.fileIdentity, activeIntent.candidate_temp_filesystem_identity), "PLAN_COMMIT_WITNESS_INVALID", "Post-commit authority does not match the durable commit intent witness");
            const appliedAt = this.now();
            exactUtcTimestamp(appliedAt, "applied_at", "PLAN_APPLIED_AT_INVALID");
            const result = resultFor({
              proposal, materialized: activeMaterialized, provenance, provenanceReference,
              intent: activeIntent, intentReference: activeIntentReference,
              appliedAt, recoveredAt: null,
            });
            this.writer.writeImmutable(appliedPath, jsonBytes(result));
            return result;
          },
        };
      },
    }));
  }
}
