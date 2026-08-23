import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { opaqueId, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { handoffConsentIdentity } from "./handoff-consent.mjs";
import { registerTrustedHandoffStorageCapability } from "./handoff-plan-internal.mjs";
import { planSemanticDigest, sameCanonicalJson } from "./plan-semantics-internal.mjs";
import { taskOperationBlocksNewHandoff, taskOperationDisposition } from "./task-operation-internal.mjs";

const TERMINAL_HANDOFF = new Set(["RESUMED"]);
const TRUSTED_RECOVERY_RESERVATION = Symbol("trusted-recovery-reservation");
const internalTestCapabilities = new WeakMap();
const storageDatabases = new WeakMap();

function database(storage) {
  const value = storageDatabases.get(storage);
  invariant(value, "STORAGE_CLOSED", "GuardianStorage is closed or invalid");
  return value;
}

// Internal modules and source-level tests may inspect the connection. The npm
// root does not export GuardianStorage or this accessor, and instances expose
// no raw DatabaseSync handle.
export function storageDatabaseForInternalUse(storage) { return database(storage); }
export const storageDatabaseForInternalTest = storageDatabaseForInternalUse;

// Source-level regression support only. src/storage.mjs is not a package export;
// packed consumers cannot obtain these helpers or the registered capabilities.
export function reserveHandoffForInternalTest(storage, projection, precondition) {
  const capability = internalTestCapabilities.get(storage);
  invariant(capability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED");
  return capability.reserve(projection, precondition);
}

export function claimTakeoverForInternalTest(storage, taskId, actor = "human:test-takeover") {
  const capability = internalTestCapabilities.get(storage);
  invariant(capability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED");
  return capability.claimTakeover({ taskId, actor });
}

export function claimLatchForInternalTest(storage, taskId, reason, actor, expected = null) {
  const capability = internalTestCapabilities.get(storage);
  invariant(capability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED");
  return capability.claimLatch({ taskId, reason, actor, expected });
}

export function saveHandoffForInternalTest(storage, ...args) { return internalTestCapabilities.get(storage).saveHandoff(...args); }
export function bindRunnerSessionForInternalTest(storage, ...args) { return internalTestCapabilities.get(storage).bindRunnerSession(...args); }
export function supersedeRunnerSessionBindingForInternalTest(storage, ...args) { return internalTestCapabilities.get(storage).supersedeRunnerSessionBinding(...args); }
export function beginDispatchForInternalTest(storage, ...args) { return internalTestCapabilities.get(storage).beginDispatch(...args); }
export function finishDispatchForInternalTest(storage, ...args) { return internalTestCapabilities.get(storage).finishDispatch(...args); }

const HANDOFF_RESERVATION_IDENTITY_FIELDS = Object.freeze([
  "handoff_id",
  "source_session_id",
  "source_session_file",
  "task_id",
  "task_plan_revision",
  "task_plan_digest",
  "requirements_version",
  "current_item",
  "next_item",
  "next_step",
  "latch_generation",
  "runner_instance_id",
  "session_binding_id",
  "parent_session_id",
  "parent_session_file",
  "parent_checkpoint_id",
  "recovery_of_handoff_id",
  "checkpoint_id",
  "resume_manifest_id",
  "model_policy",
  "reasoning_policy",
]);

function sameHandoffReservationIdentity(existing, projection) {
  if (!existing || !projection) return false;
  return HANDOFF_RESERVATION_IDENTITY_FIELDS.every((field) => {
    const left = existing[field] ?? null;
    const right = projection[field] ?? null;
    return left === right;
  });
}

const RECOVERY_FAILED_IDENTITY_FIELDS = Object.freeze([
  "handoff_id", "state", "source_session_id", "target_session_id", "runner_instance_id", "session_binding_id",
  "task_id", "task_plan_revision", "task_plan_digest", "requirements_version", "current_item", "next_item", "next_step",
  "latch_generation", "checkpoint_id", "checkpoint_digest", "resume_manifest_id", "resume_manifest_digest", "resume_prompt_id",
  "model_policy", "reasoning_policy", "authorization_state", "admission_state", "dispatch_state",
]);

function sameRecoveryFailedIdentity(actual, expected, expectedPlanSemanticDigest) {
  if (!actual || !expected || typeof expectedPlanSemanticDigest !== "string") return false;
  let actualPlanSemanticDigest;
  let expectedSnapshotDigest;
  try {
    actualPlanSemanticDigest = planSemanticDigest(actual.reserved_plan_snapshot, { requireAll: true });
    expectedSnapshotDigest = planSemanticDigest(expected.reserved_plan_snapshot, { requireAll: true });
  } catch {
    return false;
  }
  return RECOVERY_FAILED_IDENTITY_FIELDS.every((field) => {
    const left = actual[field] ?? null;
    const right = expected[field] ?? null;
    return left === right;
  })
    && sameCanonicalJson(actual.expected_git_state, expected.expected_git_state)
    && expectedSnapshotDigest === expectedPlanSemanticDigest
    && actualPlanSemanticDigest === expectedPlanSemanticDigest;
}

function recoveryStarted(storage, handoffId) {
  return Boolean(database(storage).prepare("SELECT 1 AS present FROM journal WHERE handoff_id=? AND event_type='CONTINUITY_RECOVERY_STARTED' LIMIT 1").get(handoffId));
}

function recoveryChildExists(storage, handoffId) {
  const rows = database(storage).prepare("SELECT handoff_id FROM handoffs WHERE task_id=(SELECT task_id FROM handoffs WHERE handoff_id=?)").all(handoffId);
  return rows.some((row) => storage.getHandoff(row.handoff_id)?.recovery_of_handoff_id === handoffId);
}

function blockingTaskOperation(storage, taskId, excludingHandoffId = null) {
  const rows = database(storage).prepare("SELECT handoff_id FROM handoffs WHERE task_id=? ORDER BY created_at, rowid").all(taskId);
  for (const row of rows) {
    if (row.handoff_id === excludingHandoffId) continue;
    const handoff = storage.getHandoff(row.handoff_id);
    const disposition = taskOperationDisposition(handoff, {
      binding: storage.getRunnerSessionBinding(handoff.handoff_id),
      recoveryStarted: recoveryStarted(storage, handoff.handoff_id),
      recoveryChildExists: recoveryChildExists(storage, handoff.handoff_id),
    });
    if (taskOperationBlocksNewHandoff(disposition)) return { handoff, disposition };
  }
  return null;
}

function assertOwnerGateAuthorityInTransaction(storage, request) {
  const { taskId, expectedHandoff, expectedLatch } = request ?? {};
  invariant(typeof taskId === "string" && taskId.length > 0
    && Object.hasOwn(request ?? {}, "expectedHandoff") && expectedLatch?.task_id === taskId,
  "HANDOFF_OWNER_GATE_AUTHORITY_INVALID");
  const latch = storage.getLatch(taskId);
  if (latch?.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
    throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover won owner-authority arbitration");
  }
  invariant(latch?.state === expectedLatch.state
    && latch.generation === expectedLatch.generation
    && (latch.reason ?? null) === (expectedLatch.reason ?? null),
  "LATCH_GENERATION_MISMATCH", "Canonical latch changed before owner-gate mutation");
  const conflict = blockingTaskOperation(storage, taskId);
  if (conflict) {
    const code = conflict.disposition === "RECOVERY_REQUIRED" ? "CONTINUITY_RECOVERY_REQUIRED" : "TASK_OPERATION_CONFLICT";
    throw new GuardianError(code, `Task ${taskId} already has unresolved handoff ${conflict.handoff.handoff_id} in ${conflict.handoff.state}; reconcile it explicitly before mutating owner authority`, {
      task_id: taskId,
      existing_handoff_id: conflict.handoff.handoff_id,
      existing_state: conflict.handoff.state,
      disposition: conflict.disposition,
    });
  }
  const latestRow = database(storage).prepare("SELECT handoff_id FROM handoffs WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId);
  const latest = latestRow ? storage.getHandoff(latestRow.handoff_id) : null;
  invariant(JSON.stringify(handoffConsentIdentity(latest)) === JSON.stringify(expectedHandoff),
    "HANDOFF_CONSENT_STALE", "Handoff lifecycle changed before owner-gate mutation");
  return { task_id: taskId, eligible: true };
}

function isExactRecoveryTransfer(storage, conflict, projection, precondition) {
  if (projection.recovery_of_handoff_id !== conflict?.handoff?.handoff_id
    || conflict.disposition !== "RECOVERY_REQUIRED"
    || JSON.stringify(handoffConsentIdentity(conflict.handoff)) !== JSON.stringify(precondition.expectedHandoff)) return false;
  const binding = storage.getRunnerSessionBinding(conflict.handoff.handoff_id);
  const event = database(storage).prepare("SELECT data_json FROM journal WHERE handoff_id=? AND event_type='CONTINUITY_RECOVERY_STARTED' LIMIT 1").get(conflict.handoff.handoff_id);
  const data = event ? JSON.parse(event.data_json) : null;
  return binding?.status === "SUPERSEDED"
    && data?.current_source_session_id === projection.source_session_id
    && data?.current_runner_instance_id === projection.runner_instance_id
    && !recoveryChildExists(storage, conflict.handoff.handoff_id);
}

function reserveHandoffInTransaction(storage, projection, precondition) {
  invariant(precondition && precondition.latch && Object.hasOwn(precondition, "expectedHandoff"), "HANDOFF_RESERVATION_PRECONDITION_REQUIRED");
  const exact = storage.getHandoff(projection.handoff_id);
  if (exact) {
    if (sameHandoffReservationIdentity(exact, projection)) return { created: false, handoff: exact };
    throw new GuardianError("TASK_OPERATION_CONFLICT", "The requested handoff identity already belongs to a different durable operation", { handoff_id: projection.handoff_id });
  }
  const latch = storage.getLatch(projection.task_id);
  if (latch?.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
    throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover won before durable handoff reservation");
  }
  invariant(latch?.state === "ENGAGED"
    && latch.generation === precondition.latch.generation
    && latch.reason === precondition.latch.reason
    && projection.latch_generation === latch.generation,
  "LATCH_GENERATION_MISMATCH", "Durable handoff reservation does not match the acquired safe-point latch");
  const active = database(storage).prepare("SELECT handoff_id FROM active_sources WHERE source_session_id=?").get(projection.source_session_id);
  if (active) {
    const existing = storage.getHandoff(active.handoff_id);
    if (sameHandoffReservationIdentity(existing, projection)) return { created: false, handoff: existing };
    throw new GuardianError("HANDOFF_ACTIVE_SOURCE_CONFLICT", "The source session is already reserved by a different handoff operation", {
      source_session_id: projection.source_session_id,
      existing_handoff_id: existing?.handoff_id ?? active.handoff_id,
      requested_handoff_id: projection.handoff_id,
    });
  }
  const latestRow = database(storage).prepare("SELECT handoff_id FROM handoffs WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(projection.task_id);
  const latest = latestRow ? storage.getHandoff(latestRow.handoff_id) : null;
  invariant(JSON.stringify(handoffConsentIdentity(latest)) === JSON.stringify(precondition.expectedHandoff),
    "HANDOFF_CONSENT_STALE", "Handoff lifecycle changed before durable reservation");
  const conflict = blockingTaskOperation(storage, projection.task_id);
  if (conflict && !isExactRecoveryTransfer(storage, conflict, projection, precondition)) {
    const code = conflict.disposition === "RECOVERY_REQUIRED" ? "CONTINUITY_RECOVERY_REQUIRED" : "TASK_OPERATION_CONFLICT";
    throw new GuardianError(code, `Task ${projection.task_id} already has unresolved handoff ${conflict.handoff.handoff_id} in ${conflict.handoff.state}; reconcile it explicitly before another handoff`, {
      task_id: projection.task_id,
      existing_handoff_id: conflict.handoff.handoff_id,
      existing_state: conflict.handoff.state,
      disposition: conflict.disposition,
    });
  }
  const now = utcNow();
  database(storage).prepare("INSERT INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(projection.handoff_id, projection.source_session_id, null, projection.task_id, projection.state, projection.latch_generation, JSON.stringify(projection), now, now);
  database(storage).prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)").run(projection.source_session_id, projection.handoff_id);
  storage.appendEvent("HANDOFF_STARTED", { source_session_id: projection.source_session_id, latch_generation: projection.latch_generation, recovery_of_handoff_id: projection.recovery_of_handoff_id ?? null }, { handoffId: projection.handoff_id, eventKey: `handoff:${projection.handoff_id}` });
  return { created: true, handoff: storage.getHandoff(projection.handoff_id) };
}

function prepareContinuityRecoveryInTransaction(storage, handoffId, request) {
  const {
    sourceSessionId,
    runnerInstanceId,
    actor,
    expectedFailed = null,
    expectedFailedPlanSemanticDigest = null,
    expectedBinding = null,
    expectedLatch = null,
  } = request;
  invariant(typeof sourceSessionId === "string" && typeof runnerInstanceId === "string" && actor?.startsWith("human:"), "CONTINUITY_RECOVERY_AUTHORITY_INVALID");
  const handoff = storage.getHandoff(handoffId);
  invariant(handoff?.state === "CONTINUITY_FAILED", "CONTINUITY_RECOVERY_NOT_ALLOWED", handoff?.state ?? "HANDOFF_NOT_FOUND");
  if (expectedFailed) invariant(
    sameRecoveryFailedIdentity(handoff, expectedFailed, expectedFailedPlanSemanticDigest),
    "CONTINUITY_RECOVERY_SOURCE_INVALID",
    "failed handoff plan semantics changed after final recovery attestation",
  );
  invariant(sourceSessionId !== handoff.source_session_id && sourceSessionId !== handoff.target_session_id, "CONTINUITY_RECOVERY_SOURCE_INVALID", "recovery requires a distinct fresh source session");
  invariant(handoff.authorization_state === "NOT_AUTHORIZED" && handoff.admission_state === "NOT_COMMITTED" && handoff.dispatch_state === "NOT_STARTED", "CONTINUITY_RECOVERY_UNSAFE", "authorization/admission/dispatch state is not provably empty");
  const authorization = database(storage).prepare("SELECT 1 AS present FROM authorizations WHERE handoff_id=? LIMIT 1").get(handoffId);
  const admission = database(storage).prepare("SELECT 1 AS present FROM admissions WHERE handoff_id=? LIMIT 1").get(handoffId);
  const dispatch = database(storage).prepare("SELECT 1 AS present FROM dispatch_attempts WHERE handoff_id=? LIMIT 1").get(handoffId);
  invariant(!authorization && !admission && !dispatch, "CONTINUITY_RECOVERY_UNSAFE", "durable authorization/admission/dispatch evidence exists");
  const continuityFailure = database(storage).prepare("SELECT 1 AS present FROM journal WHERE handoff_id=? AND event_type='CONTINUITY_FAILED' LIMIT 1").get(handoffId);
  invariant(continuityFailure, "CONTINUITY_RECOVERY_UNSAFE", "terminal continuity failure journal evidence is missing");
  const latch = storage.getLatch(handoff.task_id);
  invariant(latch?.state === "ENGAGED" && latch.generation === handoff.latch_generation, "LATCH_GENERATION_MISMATCH");
  invariant(latch.reason !== "HUMAN_TAKEOVER", "HUMAN_TAKEOVER_ACTIVE");
  if (expectedLatch) invariant(latch.state === expectedLatch.state && latch.generation === expectedLatch.generation && latch.reason === expectedLatch.reason,
    "LATCH_GENERATION_MISMATCH", "Latch changed after final recovery attestation");
  const binding = storage.getRunnerSessionBinding(handoffId);
  invariant(binding?.status === "ACTIVE" && binding.replacement_session_id === handoff.target_session_id && binding.runner_instance_id === handoff.runner_instance_id && binding.session_binding_id === handoff.session_binding_id, "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed target binding is not active and coherent");
  if (expectedBinding) invariant(binding.status === expectedBinding.status
    && binding.replacement_session_id === expectedBinding.replacement_session_id
    && binding.runner_instance_id === expectedBinding.runner_instance_id
    && binding.session_binding_id === expectedBinding.session_binding_id,
  "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed binding changed after final recovery attestation");
  const currentUse = database(storage).prepare("SELECT handoff_id,state FROM handoffs WHERE source_session_id=? OR target_session_id=? LIMIT 1").get(sourceSessionId, sourceSessionId);
  const activeSource = database(storage).prepare("SELECT handoff_id FROM active_sources WHERE source_session_id=? LIMIT 1").get(sourceSessionId);
  invariant(!currentUse && !activeSource, "CONTINUITY_RECOVERY_SOURCE_INVALID", "current recovery source already participates in a handoff");
  const reason = `explicit continuity recovery by ${actor}`;
  const now = utcNow();
  const changed = database(storage).prepare("UPDATE runner_session_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=? WHERE handoff_id=? AND status='ACTIVE'")
    .run(now, reason, handoffId);
  invariant(changed.changes === 1, "CONTINUITY_RECOVERY_UNSAFE", "failed target binding reconciliation raced");
  storage.appendEvent("RUNNER_SESSION_BINDING_SUPERSEDED", { reason }, { handoffId, eventKey: `runner-binding-superseded:${handoffId}` });
  storage.appendEvent("CONTINUITY_RECOVERY_STARTED", {
    failed_target_session_id: handoff.target_session_id,
    failed_runner_instance_id: handoff.runner_instance_id,
    current_source_session_id: sourceSessionId,
    current_runner_instance_id: runnerInstanceId,
    actor,
  }, { handoffId, eventKey: `continuity-recovery:${handoffId}` });
  return { handoff: storage.getHandoff(handoffId), binding: storage.getRunnerSessionBinding(handoffId), latch };
}

export class GuardianStorage {
  constructor(path = ".guardian/runtime/guardian.sqlite") {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    const connection = new DatabaseSync(this.path);
    storageDatabases.set(this, connection);
    connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    const trustedCapability = {
      reserve: (projection, precondition) => this.#reserveHandoff(projection, precondition),
      prepareRecovery: ({ failedHandoffId, preparation, reservation, attestation }) => this.prepareContinuityRecovery(
        failedHandoffId, preparation, { token: TRUSTED_RECOVERY_RESERVATION, reservation, attestation },
      ),
      authorizeResume: (request) => this.#authorizeAndAdmitTrustedResume(request),
      assertOwnerGateAuthority: (request) => this.transaction(() => assertOwnerGateAuthorityInTransaction(this, request)),
      claimTakeover: ({ taskId, actor }) => this.#claimLatch(taskId, "HUMAN_TAKEOVER", actor),
      claimHandoffLatch: ({ taskId, reason, actor, expectedLatch }) => this.#claimLatch(taskId, reason, actor, expectedLatch),
      saveHandoff: (...args) => this.#saveHandoff(...args),
      bindRunnerSession: (...args) => this.#bindRunnerSession(...args),
      supersedeRunnerSessionBinding: (...args) => this.#supersedeRunnerSessionBinding(...args),
      beginDispatch: (...args) => this.#beginDispatch(...args),
      finishDispatch: (...args) => this.#finishDispatch(...args),
    };
    registerTrustedHandoffStorageCapability(this, trustedCapability);
    internalTestCapabilities.set(this, Object.freeze({
      reserve: trustedCapability.reserve,
      claimTakeover: trustedCapability.claimTakeover,
      claimLatch: ({ taskId, reason, actor, expected }) => this.#claimLatch(taskId, reason, actor, expected),
      saveHandoff: trustedCapability.saveHandoff,
      bindRunnerSession: trustedCapability.bindRunnerSession,
      supersedeRunnerSessionBinding: trustedCapability.supersedeRunnerSessionBinding,
      beginDispatch: trustedCapability.beginDispatch,
      finishDispatch: trustedCapability.finishDispatch,
    }));
  }

  migrate() {
    database(this).exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authorities(
        name TEXT PRIMARY KEY,
        authority TEXT NOT NULL,
        schema_version TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calibration_runtime_identity(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        run_id TEXT NOT NULL UNIQUE,
        runtime_store_id TEXT NOT NULL UNIQUE,
        attestation_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        handoff_id TEXT,
        event_type TEXT NOT NULL,
        event_key TEXT UNIQUE,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS latches(
        task_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('ENGAGED','RELEASED')),
        generation INTEGER NOT NULL CHECK(generation >= 0),
        reason TEXT,
        engaged_at TEXT,
        engaged_by TEXT,
        released_at TEXT,
        released_by TEXT,
        last_event_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoffs(
        handoff_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        target_session_id TEXT,
        task_id TEXT NOT NULL,
        state TEXT NOT NULL,
        latch_generation INTEGER NOT NULL,
        projection_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_sources(source_session_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL UNIQUE REFERENCES handoffs(handoff_id));
      CREATE TABLE IF NOT EXISTS authorizations(
        resume_prompt_id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id),
        actor TEXT NOT NULL,
        latch_generation INTEGER NOT NULL,
        authorized_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admissions(
        admission_id TEXT PRIMARY KEY,
        resume_prompt_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id),
        committed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatch_attempts(
        dispatch_attempt_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL REFERENCES admissions(admission_id),
        handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id),
        attempt_no INTEGER NOT NULL,
        state TEXT NOT NULL,
        intent_at TEXT NOT NULL,
        outcome_at TEXT,
        error TEXT,
        UNIQUE(admission_id, attempt_no)
      );
      CREATE TABLE IF NOT EXISTS operations(
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        latch_generation INTEGER NOT NULL,
        profile TEXT NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT,
        effect_reference TEXT,
        admitted_at TEXT NOT NULL,
        terminal_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runner_session_bindings(
        handoff_id TEXT PRIMARY KEY REFERENCES handoffs(handoff_id),
        replacement_session_id TEXT NOT NULL UNIQUE,
        runner_instance_id TEXT NOT NULL,
        session_binding_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
        bound_at TEXT NOT NULL,
        bind_event_id TEXT NOT NULL UNIQUE REFERENCES journal(event_id),
        superseded_at TEXT,
        superseded_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts(
        kind TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        path TEXT NOT NULL,
        digest TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        superseded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(kind, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS metric_sessions(
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metric_samples(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES metric_sessions(session_id) ON DELETE CASCADE,
        call_index INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE(session_id, call_index)
      );
      CREATE TABLE IF NOT EXISTS metric_handoff_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_event_id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        handoff_id TEXT,
        lifecycle_state TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metric_diagnostics(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        diagnostic_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_handoff_seq ON journal(handoff_id, seq);
      CREATE INDEX IF NOT EXISTS operation_task_state ON operations(task_id, state);
      CREATE INDEX IF NOT EXISTS metric_sample_session_seq ON metric_samples(session_id, seq);
      CREATE INDEX IF NOT EXISTS metric_handoff_id_seq ON metric_handoff_events(handoff_id, seq);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO authorities(name,authority,schema_version) VALUES
        ('calibration_runtime_identity','run-specific calibration bootstrap identity','1.0.0'),
        ('journal','Guardian SQLite append-only operational lifecycle','1.0.0'),
        ('latches','Guardian SQLite canonical runtime','1.0.0'),
        ('handoffs','Guardian SQLite canonical runtime','1.0.0'),
        ('runner_session_bindings','Guardian SQLite + append-only binding event','1.0.0'),
        ('operations','Guardian SQLite canonical runtime','1.0.0'),
        ('artifacts','sealed JSON authoritative; SQLite index derived','1.0.0'),
        ('metric_sessions','Guardian SQLite bounded measurement summary','1.0.0'),
        ('metric_samples','Guardian SQLite bounded per-call measurement','1.0.0'),
        ('metric_handoff_events','Guardian SQLite bounded measurement events; journal remains operational authority','1.0.0'),
        ('metric_diagnostics','Guardian SQLite bounded collection diagnostics','1.0.0'),
        ('ledger_index','TASK_PLAN.md authoritative; no reverse write','0.1.0');
    `);
  }

  getCalibrationRuntimeIdentity() {
    return database(this).prepare("SELECT run_id,runtime_store_id,attestation_sha256,created_at FROM calibration_runtime_identity WHERE singleton=1").get() ?? null;
  }

  bindCalibrationRuntimeIdentity(identity, { allowExisting = false } = {}) {
    invariant(identity?.run_id && identity?.runtime_store_id && /^[a-f0-9]{64}$/.test(identity?.attestation_sha256 ?? ""), "CALIBRATION_RUNTIME_IDENTITY_INVALID");
    return this.transaction(() => {
      const prior = this.getCalibrationRuntimeIdentity();
      if (prior) {
        invariant(allowExisting, "STALE_RUNTIME_STORE", this.path);
        invariant(prior.run_id === identity.run_id && prior.runtime_store_id === identity.runtime_store_id && prior.attestation_sha256 === identity.attestation_sha256, "RUNTIME_IDENTITY_MISMATCH");
        return prior;
      }
      const domainTables = ["journal", "latches", "handoffs", "runner_session_bindings", "operations", "artifacts", "metric_sessions", "metric_samples", "metric_handoff_events", "metric_diagnostics"];
      const contaminated = domainTables.filter((table) => database(this).prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get());
      invariant(contaminated.length === 0, "STALE_RUNTIME_STORE", this.path, contaminated);
      database(this).prepare("INSERT INTO calibration_runtime_identity(singleton,run_id,runtime_store_id,attestation_sha256,created_at) VALUES(1,?,?,?,?)")
        .run(identity.run_id, identity.runtime_store_id, identity.attestation_sha256, utcNow());
      return this.getCalibrationRuntimeIdentity();
    });
  }

  transaction(fn) {
    database(this).exec("BEGIN IMMEDIATE");
    try { const result = fn(); database(this).exec("COMMIT"); return result; }
    catch (error) { database(this).exec("ROLLBACK"); throw error; }
  }

  appendEvent(eventType, data = {}, { handoffId = null, eventKey = null } = {}) {
    const eventId = opaqueId("EVT");
    const occurredAt = utcNow();
    try {
      database(this).prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
        .run(eventId, handoffId, eventType, eventKey, occurredAt, JSON.stringify(data));
      return { inserted: true, event_id: eventId, event_type: eventType, data, occurred_at: occurredAt };
    } catch (error) {
      if (!eventKey || !String(error.message).includes("UNIQUE")) throw error;
      const prior = database(this).prepare("SELECT * FROM journal WHERE event_key=?").get(eventKey);
      invariant(prior && prior.event_type === eventType && prior.data_json === JSON.stringify(data), "JOURNAL_EVENT_CONFLICT", eventKey);
      return { inserted: false, event_id: prior.event_id, event_type: prior.event_type, data: JSON.parse(prior.data_json), occurred_at: prior.occurred_at };
    }
  }

  ensureLatch(taskId) {
    const prior = this.getLatch(taskId);
    if (prior) return prior;
    return this.transaction(() => {
      const raced = this.getLatch(taskId);
      if (raced) return raced;
      const event = this.appendEvent("LATCH_BOOTSTRAPPED", { task_id: taskId, state: "RELEASED", actor: "human:bootstrap" }, { eventKey: `latch-bootstrap:${taskId}` });
      database(this).prepare("INSERT INTO latches(task_id,state,generation,released_at,released_by,last_event_id) VALUES(?,?,?,?,?,?)")
        .run(taskId, "RELEASED", 0, event.occurred_at, "human:bootstrap", event.event_id);
      return this.getLatch(taskId);
    });
  }

  getLatch(taskId) { return database(this).prepare("SELECT * FROM latches WHERE task_id=?").get(taskId) ?? null; }

  #claimLatch(taskId, reason, actor, expected = null) {
    invariant(typeof taskId === "string" && taskId.length > 0 && typeof reason === "string" && reason.length > 0 && typeof actor === "string" && actor.length > 0, "LATCH_CLAIM_INVALID");
    if (expected !== null) {
      invariant(expected.task_id === taskId && ["ENGAGED", "RELEASED"].includes(expected.state)
        && Number.isInteger(expected.generation) && expected.generation >= 0
        && (expected.reason === null || typeof expected.reason === "string"), "LATCH_CLAIM_INVALID");
    }
    this.ensureLatch(taskId);
    return this.transaction(() => {
      const latch = this.getLatch(taskId);
      if (reason !== "HUMAN_TAKEOVER" && latch.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
        throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover has priority over handoff safe-point acquisition");
      }
      if (expected && (latch.state !== expected.state || latch.generation !== expected.generation || (latch.reason ?? null) !== expected.reason)) {
        throw new GuardianError("LATCH_GENERATION_MISMATCH", "Canonical latch no longer matches the expected safe-point precondition", { expected, observed: latch });
      }
      if (latch.state === "ENGAGED") {
        if (reason === "HUMAN_TAKEOVER" && latch.reason !== reason) {
          const event = this.appendEvent("LATCH_ESCALATED", { task_id: taskId, generation: latch.generation, from: latch.reason, reason, actor }, { eventKey: `latch-escalated:${taskId}:${latch.generation}` });
          const changed = database(this).prepare("UPDATE latches SET reason=?,engaged_by=?,last_event_id=? WHERE task_id=? AND state='ENGAGED' AND generation=? AND reason IS ?")
            .run(reason, actor, event.event_id, taskId, latch.generation, latch.reason);
          invariant(changed.changes === 1, "LATCH_GENERATION_MISMATCH", "Latch escalation raced");
          return this.getLatch(taskId);
        }
        invariant(latch.reason === reason, "LATCH_REASON_MISMATCH", `${latch.reason} != ${reason}`);
        return latch;
      }
      const generation = latch.generation + 1;
      const event = this.appendEvent("LATCH_ENGAGED", { task_id: taskId, generation, reason, actor }, { eventKey: `latch-engaged:${taskId}:${generation}` });
      const changed = database(this).prepare("UPDATE latches SET state='ENGAGED',generation=?,reason=?,engaged_at=?,engaged_by=?,released_at=NULL,released_by=NULL,last_event_id=? WHERE task_id=? AND state='RELEASED' AND generation=? AND reason IS ?")
        .run(generation, reason, event.occurred_at, actor, event.event_id, taskId, latch.generation, latch.reason);
      invariant(changed.changes === 1, "LATCH_GENERATION_MISMATCH", "Latch acquisition raced");
      return this.getLatch(taskId);
    });
  }

  claimLatch() {
    throw new GuardianError("LATCH_TRUSTED_PATH_REQUIRED", "Canonical latch acquisition is package-private and requires plan coordination");
  }

  engageLatch() {
    throw new GuardianError("LATCH_TRUSTED_PATH_REQUIRED", "Canonical latch acquisition is package-private and requires plan coordination");
  }

  assertLatchIdentity(taskId, expected, { allowHumanTakeover = false } = {}) {
    const latch = this.getLatch(taskId);
    if (!allowHumanTakeover && latch?.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
      throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover has priority over handoff");
    }
    invariant(latch?.state === expected?.state && latch.generation === expected?.generation
      && (latch.reason ?? null) === (expected?.reason ?? null), "LATCH_GENERATION_MISMATCH", "Canonical latch identity changed");
    return latch;
  }

  isAdmissionOpen(taskId) {
    try { return this.getLatch(taskId)?.state === "RELEASED"; }
    catch { return false; }
  }

  #reserveHandoff(projection, precondition = null) {
    return this.transaction(() => reserveHandoffInTransaction(this, projection, precondition));
  }

  reserveHandoff() {
    throw new GuardianError("HANDOFF_RESERVATION_TRUSTED_PATH_REQUIRED", "Authoritative handoff reservation is package-private and requires plan coordination");
  }

  getHandoff(id) {
    const row = database(this).prepare("SELECT * FROM handoffs WHERE handoff_id=?").get(id);
    return row ? { ...JSON.parse(row.projection_json), state: row.state, target_session_id: row.target_session_id } : null;
  }

  findHandoffByTarget(targetSessionId) {
    const row = database(this).prepare("SELECT handoff_id FROM handoffs WHERE target_session_id=? ORDER BY created_at DESC LIMIT 1").get(targetSessionId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  findHandoffBySource(sourceSessionId) {
    const row = database(this).prepare("SELECT handoff_id FROM handoffs WHERE source_session_id=? ORDER BY created_at DESC LIMIT 1").get(sourceSessionId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  pendingContinuityFailureForTask(taskId) {
    const row = database(this).prepare("SELECT h.handoff_id FROM handoffs h JOIN runner_session_bindings b ON b.handoff_id=h.handoff_id WHERE h.task_id=? AND h.state='CONTINUITY_FAILED' AND b.status='ACTIVE' ORDER BY h.created_at DESC LIMIT 1").get(taskId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  assertContinuityRecoveryPrepared(handoffId, { sourceSessionId, runnerInstanceId }) {
    const binding = this.getRunnerSessionBinding(handoffId);
    invariant(binding?.status === "SUPERSEDED", "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed target binding was not superseded");
    const event = database(this).prepare("SELECT data_json FROM journal WHERE handoff_id=? AND event_key=? AND event_type='CONTINUITY_RECOVERY_STARTED'").get(handoffId, `continuity-recovery:${handoffId}`);
    const data = event ? JSON.parse(event.data_json) : null;
    invariant(data?.current_source_session_id === sourceSessionId && data?.current_runner_instance_id === runnerInstanceId, "CONTINUITY_RECOVERY_SOURCE_INVALID", "recovery preparation does not belong to the current Runner source");
    return data;
  }

  #bindRunnerSession(handoffId, binding) {
    return this.transaction(() => {
      const handoff = this.getHandoff(handoffId);
      invariant(handoff?.state === "REPLACEMENT_SESSION_CREATED_PAUSED" && handoff.target_session_id === binding.replacement_session_id, "RUNNER_BINDING_STATE_INVALID");
      const prior = database(this).prepare("SELECT * FROM runner_session_bindings WHERE handoff_id=?").get(handoffId);
      if (prior) {
        invariant(prior.status === "ACTIVE" && prior.replacement_session_id === binding.replacement_session_id && prior.runner_instance_id === binding.runner_instance_id && prior.session_binding_id === binding.session_binding_id, "RUNNER_BINDING_CONFLICT");
        return this.getRunnerSessionBinding(handoffId);
      }
      const data = {
        handoff_id: handoffId,
        replacement_session_id: binding.replacement_session_id,
        runner_instance_id: binding.runner_instance_id,
        session_binding_id: binding.session_binding_id,
      };
      const event = this.appendEvent("RUNNER_SESSION_BOUND", data, { handoffId, eventKey: `runner-binding:${handoffId}` });
      database(this).prepare("INSERT INTO runner_session_bindings(handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,bind_event_id) VALUES(?,?,?,?,?,?,?)")
        .run(handoffId, data.replacement_session_id, data.runner_instance_id, data.session_binding_id, "ACTIVE", event.occurred_at, event.event_id);
      return this.getRunnerSessionBinding(handoffId);
    });
  }

  getRunnerSessionBinding(handoffId) {
    const row = database(this).prepare("SELECT * FROM runner_session_bindings WHERE handoff_id=?").get(handoffId);
    if (!row) return null;
    const event = database(this).prepare("SELECT event_type,data_json FROM journal WHERE event_id=? AND handoff_id=?").get(row.bind_event_id, handoffId);
    invariant(event?.event_type === "RUNNER_SESSION_BOUND", "RUNNER_BINDING_JOURNAL_MISMATCH");
    return { schema_version: "1.0.0", ...row, event_data: JSON.parse(event.data_json) };
  }

  bindRunnerSession() {
    throw new GuardianError("HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED", "Runner binding mutation is package-private");
  }

  #supersedeRunnerSessionBinding(handoffId, reason) {
    return this.transaction(() => {
      const binding = this.getRunnerSessionBinding(handoffId);
      if (!binding || binding.status === "SUPERSEDED") return binding;
      const now = utcNow();
      database(this).prepare("UPDATE runner_session_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=? WHERE handoff_id=? AND status='ACTIVE'")
        .run(now, reason, handoffId);
      this.appendEvent("RUNNER_SESSION_BINDING_SUPERSEDED", { reason }, { handoffId, eventKey: `runner-binding-superseded:${handoffId}` });
      return this.getRunnerSessionBinding(handoffId);
    });
  }

  supersedeRunnerSessionBinding() {
    throw new GuardianError("HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED", "Runner binding supersession is package-private");
  }

  prepareContinuityRecovery(handoffId, request, trusted = null) {
    invariant(trusted?.token === TRUSTED_RECOVERY_RESERVATION,
      "CONTINUITY_RECOVERY_TRUSTED_PATH_REQUIRED", "Continuity recovery transfer is package-private and requires final plan/source attestation");
    return this.transaction(() => {
      const prepared = prepareContinuityRecoveryInTransaction(this, handoffId, request);
      const reserved = reserveHandoffInTransaction(this, trusted.reservation.projection, trusted.reservation.precondition);
      return { prepared, reserved, attestation: trusted.attestation };
    });
  }

  latestHandoffForTask(taskId) {
    const row = database(this).prepare("SELECT handoff_id FROM handoffs WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(taskId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  #saveHandoff(handoff, eventType = null, eventData = {}) {
    return this.transaction(() => {
      const now = utcNow();
      handoff.updated_at = now;
      database(this).prepare("UPDATE handoffs SET target_session_id=?,state=?,projection_json=?,updated_at=? WHERE handoff_id=?")
        .run(handoff.target_session_id ?? null, handoff.state, JSON.stringify(handoff), now, handoff.handoff_id);
      if (eventType) this.appendEvent(eventType, eventData, { handoffId: handoff.handoff_id, eventKey: eventData.event_key ?? null });
      return this.getHandoff(handoff.handoff_id);
    });
  }

  saveHandoff() {
    throw new GuardianError("HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED", "Handoff lifecycle mutation is package-private");
  }

  transition() {
    throw new GuardianError("HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED", "Raw handoff transition is not a supported public mutation");
  }

  #transition(id, expectedStates, next, data = {}) {
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h, "HANDOFF_NOT_FOUND", id);
      const expected = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
      invariant(expected.includes(h.state), "ILLEGAL_TRANSITION", `${h.state}->${next}`);
      const previous = h.state;
      h.state = next;
      const now = utcNow(); h.updated_at = now;
      database(this).prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=? AND state=?")
        .run(next, JSON.stringify(h), now, id, previous);
      this.appendEvent("STATE_TRANSITION", { from: previous, to: next, ...data }, { handoffId: id });
      return this.getHandoff(id);
    });
  }

  #authorizeAndAdmitTrustedResume(request) {
    const { handoffId: id, actor, idempotencyKey, admissionId, expected } = request ?? {};
    invariant(expected?.handoff && expected?.binding && expected?.latch
      && typeof expected?.planSemanticDigest === "string", "RESUME_ATTESTATION_REQUIRED");
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h, "HANDOFF_NOT_FOUND");
      invariant(h.state === "RESUME_READY" && sameCanonicalJson(h, expected.handoff),
        "RESUME_EXPECTATION_STALE", "Durable handoff identity changed before resume admission");
      invariant(h.handoff_id === expected.handoff.handoff_id
        && h.task_id === expected.handoff.task_id
        && h.target_session_id === expected.handoff.target_session_id
        && h.runner_instance_id === expected.handoff.runner_instance_id
        && h.session_binding_id === expected.handoff.session_binding_id
        && h.resume_prompt_id === expected.handoff.resume_prompt_id
        && h.resume_prompt_digest === expected.handoff.resume_prompt_digest
        && h.checkpoint_id === expected.handoff.checkpoint_id
        && h.checkpoint_digest === expected.handoff.checkpoint_digest
        && h.resume_manifest_id === expected.handoff.resume_manifest_id
        && h.resume_manifest_digest === expected.handoff.resume_manifest_digest,
      "RESUME_EXPECTATION_STALE", "Durable resume identity no longer matches the confirmed operation");
      invariant(planSemanticDigest(h.reserved_plan_snapshot, { requireAll: true }) === expected.planSemanticDigest,
        "RESUME_EXPECTATION_STALE", "Durable handoff plan semantics changed before resume admission");
      const binding = this.getRunnerSessionBinding(id);
      invariant(binding?.status === "ACTIVE"
        && binding.replacement_session_id === expected.binding.replacement_session_id
        && binding.runner_instance_id === expected.binding.runner_instance_id
        && binding.session_binding_id === expected.binding.session_binding_id
        && binding.handoff_id === expected.binding.handoff_id,
      "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "Durable Runner binding changed before resume admission");
      const latch = this.getLatch(h.task_id);
      invariant(latch?.state === expected.latch.state
        && latch.generation === expected.latch.generation
        && latch.reason === expected.latch.reason
        && latch.state === "ENGAGED"
        && latch.generation === h.latch_generation,
      "LATCH_GENERATION_MISMATCH", "Durable latch changed before resume admission");
      invariant(latch.reason !== "HUMAN_TAKEOVER", "HUMAN_TAKEOVER_ACTIVE", "A pending handoff confirmation cannot release a human takeover");
      invariant(actor?.startsWith("human:"), "HUMAN_AUTHORIZATION_REQUIRED");
      invariant(h.authorization_state === "NOT_AUTHORIZED"
        && h.admission_state === "NOT_COMMITTED"
        && h.dispatch_state === "NOT_STARTED",
      "RESUME_EXPECTATION_STALE", "Resume already has competing authorization, admission, or dispatch state");
      const authorization = database(this).prepare("SELECT 1 AS present FROM authorizations WHERE handoff_id=? OR resume_prompt_id=? LIMIT 1").get(id, h.resume_prompt_id);
      const admission = database(this).prepare("SELECT 1 AS present FROM admissions WHERE handoff_id=? OR resume_prompt_id=? LIMIT 1").get(id, h.resume_prompt_id);
      const dispatch = database(this).prepare("SELECT 1 AS present FROM dispatch_attempts WHERE handoff_id=? LIMIT 1").get(id);
      invariant(!authorization && !admission && !dispatch, "RESUME_EXPECTATION_STALE", "Competing durable resume evidence exists");
      const latest = database(this).prepare("SELECT handoff_id FROM handoffs WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(h.task_id);
      invariant(latest?.handoff_id === id && expected.taskOperationHandoffId === id,
        "TASK_OPERATION_CONFLICT", "The confirmed handoff no longer owns the task operation");

      const releaseGeneration = latch.generation + 1;
      const release = this.appendEvent("LATCH_RELEASED", { task_id: h.task_id, generation: releaseGeneration, actor }, { handoffId: id, eventKey: `latch-release:${h.task_id}:${releaseGeneration}` });
      const released = database(this).prepare("UPDATE latches SET state='RELEASED',generation=?,reason=NULL,released_at=?,released_by=?,last_event_id=? WHERE task_id=? AND state='ENGAGED' AND generation=? AND reason IS ?")
        .run(releaseGeneration, release.occurred_at, actor, release.event_id, h.task_id, latch.generation, latch.reason);
      invariant(released.changes === 1, "LATCH_GENERATION_MISMATCH", "Latch release raced final resume admission");
      const now = utcNow();
      database(this).prepare("INSERT INTO authorizations(resume_prompt_id,handoff_id,actor,latch_generation,authorized_at) VALUES(?,?,?,?,?)")
        .run(h.resume_prompt_id, id, actor, releaseGeneration, now);
      try {
        database(this).prepare("INSERT INTO admissions(admission_id,resume_prompt_id,idempotency_key,handoff_id,committed_at) VALUES(?,?,?,?,?)")
          .run(admissionId, h.resume_prompt_id, idempotencyKey, id, now);
      } catch (error) {
        if (String(error.message).includes("idempotency_key")) throw new GuardianError("IDEMPOTENCY_KEY_CONFLICT");
        throw error;
      }
      h.authorization_state = "AUTHORIZED";
      h.admission_state = "COMMITTED";
      h.admission_id = admissionId;
      h.state = "RESUME_ADMISSION_COMMITTED";
      h.updated_at = now;
      database(this).prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=? AND state='RESUME_READY'")
        .run(h.state, JSON.stringify(h), now, id);
      this.appendEvent("RESUME_AUTHORIZED", { resume_prompt_id: h.resume_prompt_id, actor }, { handoffId: id, eventKey: `authorization:${h.resume_prompt_id}` });
      this.appendEvent("RESUME_ADMISSION_COMMITTED", { resume_prompt_id: h.resume_prompt_id, admission_id: admissionId, idempotency_key: idempotencyKey }, { handoffId: id, eventKey: `admission:${h.resume_prompt_id}` });
      return { idempotent: false, admission_id: admissionId, handoff: this.getHandoff(id) };
    });
  }

  authorizeAndAdmit() {
    throw new GuardianError("RESUME_ATTESTATION_REQUIRED", "Direct durable resume admission is package-private and requires final runtime, Git, plan, and ownership attestation");
  }

  beginDispatch() {
    throw new GuardianError("RESUME_DISPATCH_TRUSTED_PATH_REQUIRED", "Resume dispatch mutation is package-private");
  }

  #beginDispatch(id, attemptId, attemptNo = 1) {
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h?.admission_state === "COMMITTED", "ADMISSION_REQUIRED");
      if (h.dispatch_state === "UNKNOWN") throw new GuardianError("RESUME_DISPATCH_UNKNOWN");
      const prior = database(this).prepare("SELECT * FROM dispatch_attempts WHERE admission_id=? AND attempt_no=?").get(h.admission_id, attemptNo);
      if (prior) return { idempotent: true, attempt: prior, handoff: h };
      const now = utcNow();
      database(this).prepare("INSERT INTO dispatch_attempts(dispatch_attempt_id,admission_id,handoff_id,attempt_no,state,intent_at) VALUES(?,?,?,?,?,?)")
        .run(attemptId, h.admission_id, id, attemptNo, "DISPATCHING", now);
      h.dispatch_state = "DISPATCHING"; h.dispatch_attempt_id = attemptId; h.dispatch_attempt_no = attemptNo; h.state = "RESUME_DISPATCHING"; h.updated_at = now;
      database(this).prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=?").run(h.state, JSON.stringify(h), now, id);
      this.appendEvent("RESUME_DISPATCH_INTENT", { dispatch_attempt_id: attemptId, admission_id: h.admission_id }, { handoffId: id, eventKey: `dispatch-intent:${attemptId}` });
      return { idempotent: false, attempt: database(this).prepare("SELECT * FROM dispatch_attempts WHERE dispatch_attempt_id=?").get(attemptId), handoff: this.getHandoff(id) };
    });
  }

  finishDispatch() {
    throw new GuardianError("RESUME_DISPATCH_TRUSTED_PATH_REQUIRED", "Resume dispatch mutation is package-private");
  }

  #finishDispatch(id, state, error = null) {
    invariant(["ACKNOWLEDGED", "DISPATCHED", "UNKNOWN", "FAILED"].includes(state), "DISPATCH_STATE_INVALID");
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h?.dispatch_attempt_id, "DISPATCH_INTENT_REQUIRED");
      const now = utcNow();
      database(this).prepare("UPDATE dispatch_attempts SET state=?,outcome_at=?,error=? WHERE dispatch_attempt_id=?").run(state, now, error, h.dispatch_attempt_id);
      h.dispatch_state = state;
      h.state = state === "ACKNOWLEDGED" ? "RESUMED" : state === "UNKNOWN" ? "RESUME_DISPATCH_UNKNOWN" : state === "FAILED" ? "RESUME_DISPATCH_FAILED" : "RESUME_DISPATCHED";
      h.updated_at = now;
      database(this).prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=?").run(h.state, JSON.stringify(h), now, id);
      if (state === "ACKNOWLEDGED") {
        this.appendEvent("RESUME_DISPATCHED", { dispatch_attempt_id: h.dispatch_attempt_id }, { handoffId: id, eventKey: `dispatch-dispatched:${h.dispatch_attempt_id}` });
        this.appendEvent("RESUME_ACKNOWLEDGED", { dispatch_attempt_id: h.dispatch_attempt_id }, { handoffId: id, eventKey: `dispatch-acknowledged:${h.dispatch_attempt_id}` });
      } else {
        this.appendEvent(state === "UNKNOWN" ? "RESUME_DISPATCH_UNKNOWN" : `RESUME_${state}`, { dispatch_attempt_id: h.dispatch_attempt_id, error }, { handoffId: id, eventKey: `dispatch-${state.toLowerCase()}:${h.dispatch_attempt_id}` });
      }
      return this.getHandoff(id);
    });
  }

  admitOperation({ operationId, taskId, generation, profile }) {
    const latch = this.getLatch(taskId);
    invariant(latch?.state === "RELEASED", "TOOL_ADMISSION_BLOCKED");
    database(this).prepare("INSERT INTO operations(operation_id,task_id,latch_generation,profile,state,admitted_at) VALUES(?,?,?,?,?,?)")
      .run(operationId, taskId, generation, profile, "ACTIVE", utcNow());
  }

  finishOperation(operationId, outcome, effectReference = null) {
    invariant(["KNOWN_SUCCESS", "KNOWN_FAILURE", "UNKNOWN"].includes(outcome), "OPERATION_OUTCOME_INVALID");
    database(this).prepare("UPDATE operations SET state='TERMINAL',outcome=?,effect_reference=?,terminal_at=? WHERE operation_id=? AND state='ACTIVE'")
      .run(outcome, effectReference, utcNow(), operationId);
  }

  operationsForTask(taskId) { return database(this).prepare("SELECT * FROM operations WHERE task_id=? ORDER BY admitted_at").all(taskId); }

  metricLimit(value) {
    invariant(Number.isInteger(value) && value > 0, "METRICS_RETENTION_INVALID");
    return value;
  }

  upsertMetricSession(record, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    this.transaction(() => {
      database(this).prepare(`INSERT INTO metric_sessions(session_id,started_at,ended_at,updated_at,record_json) VALUES(?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET started_at=excluded.started_at,ended_at=excluded.ended_at,updated_at=excluded.updated_at,record_json=excluded.record_json`)
        .run(record.session_id, record.started_at, record.ended_at, record.updated_at, JSON.stringify(record));
      database(this).prepare("DELETE FROM metric_sessions WHERE session_id NOT IN (SELECT session_id FROM metric_sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(limit);
    });
    return this.getMetricSession(record.session_id);
  }

  getMetricSession(sessionId) {
    const row = database(this).prepare("SELECT record_json FROM metric_sessions WHERE session_id=?").get(sessionId);
    return row ? JSON.parse(row.record_json) : null;
  }

  metricSessions() {
    return database(this).prepare("SELECT record_json FROM metric_sessions ORDER BY updated_at, rowid").all().map((row) => JSON.parse(row.record_json));
  }

  appendMetricSample(record, sessionSummary, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    return this.transaction(() => {
      database(this).prepare("INSERT INTO metric_samples(sample_id,session_id,call_index,captured_at,record_json) VALUES(?,?,?,?,?)")
        .run(record.sample_id, record.session_id, record.call_index, record.captured_at, JSON.stringify(record));
      database(this).prepare("UPDATE metric_sessions SET started_at=?,ended_at=?,updated_at=?,record_json=? WHERE session_id=?")
        .run(sessionSummary.started_at, sessionSummary.ended_at, sessionSummary.updated_at, JSON.stringify(sessionSummary), record.session_id);
      database(this).prepare("DELETE FROM metric_samples WHERE seq NOT IN (SELECT seq FROM metric_samples ORDER BY seq DESC LIMIT ?)").run(limit);
      return record;
    });
  }

  metricSamples(sessionId = null) {
    const rows = sessionId
      ? database(this).prepare("SELECT record_json FROM metric_samples WHERE session_id=? ORDER BY seq").all(sessionId)
      : database(this).prepare("SELECT record_json FROM metric_samples ORDER BY seq").all();
    return rows.map((row) => JSON.parse(row.record_json));
  }

  appendHandoffMetricEvent(record, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    this.transaction(() => {
      database(this).prepare("INSERT INTO metric_handoff_events(metric_event_id,session_id,handoff_id,lifecycle_state,occurred_at,record_json) VALUES(?,?,?,?,?,?)")
        .run(record.metric_event_id, record.session_id, record.handoff_id, record.lifecycle_state, record.timestamp, JSON.stringify(record));
      database(this).prepare("DELETE FROM metric_handoff_events WHERE seq NOT IN (SELECT seq FROM metric_handoff_events ORDER BY seq DESC LIMIT ?)").run(limit);
    });
    return record;
  }

  handoffMetricEvents(handoffId = null) {
    const rows = handoffId
      ? database(this).prepare("SELECT record_json FROM metric_handoff_events WHERE handoff_id=? ORDER BY seq").all(handoffId)
      : database(this).prepare("SELECT record_json FROM metric_handoff_events ORDER BY seq").all();
    return rows.map((row) => JSON.parse(row.record_json));
  }

  appendMetricDiagnostic(record, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    this.transaction(() => {
      database(this).prepare("INSERT INTO metric_diagnostics(diagnostic_id,occurred_at,record_json) VALUES(?,?,?)")
        .run(record.diagnostic_id, record.timestamp, JSON.stringify(record));
      database(this).prepare("DELETE FROM metric_diagnostics WHERE seq NOT IN (SELECT seq FROM metric_diagnostics ORDER BY seq DESC LIMIT ?)").run(limit);
    });
    return record;
  }

  metricDiagnostics() {
    return database(this).prepare("SELECT record_json FROM metric_diagnostics ORDER BY seq").all().map((row) => JSON.parse(row.record_json));
  }

  indexArtifact({ kind, id, path, digest, contentDigest }) {
    const prior = this.getArtifact(kind, id);
    if (prior) {
      invariant(prior.path === path && prior.digest === digest && prior.content_digest === contentDigest, "ARTIFACT_INDEX_CONFLICT");
      return prior;
    }
    database(this).prepare("INSERT INTO artifacts(kind,artifact_id,path,digest,content_digest,created_at) VALUES(?,?,?,?,?,?)")
      .run(kind, id, path, digest, contentDigest, utcNow());
    return this.getArtifact(kind, id);
  }
  getArtifact(kind, id) { return database(this).prepare("SELECT * FROM artifacts WHERE kind=? AND artifact_id=?").get(kind, id) ?? null; }
  events(id) { return database(this).prepare("SELECT * FROM journal WHERE handoff_id=? ORDER BY seq").all(id).map((row) => ({ ...row, data: JSON.parse(row.data_json) })); }
  close() { const connection = database(this); storageDatabases.delete(this); internalTestCapabilities.delete(this); connection.close(); }
}

export { TERMINAL_HANDOFF };
