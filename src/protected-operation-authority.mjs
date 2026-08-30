import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { canonicalJson, opaqueId, sha256, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import {
  HANDOFF_OPERATION_AUTHORITY_SCHEMA,
  LATCH_OPERATION_AUTHORITY_SCHEMA,
  LIFECYCLE_OPERATION_AUTHORITY_SCHEMA,
  OPERATION_AUTHORITY_SCHEMA,
  PREVIOUS_OPERATION_AUTHORITY_SCHEMA,
  RECOVERY_INPUT_OPERATION_AUTHORITY_SCHEMA,
  RESUME_OPERATION_AUTHORITY_SCHEMA,
  SECURE_OPERATION_AUTHORITY_LABEL,
  detachedOperation,
  operationIdentifier,
  validateOperationAdmission,
  validateOperationTerminal,
} from "./operation-authority.mjs";
import {
  SECURE_LATCH_AUTHORITY_LABEL,
  assertLatchIdentityValue,
  detachedLatch,
  validateLatchClaim,
} from "./latch-authority.mjs";
import {
  SECURE_HANDOFF_AUTHORITY_LABEL,
  detachedReservation,
  sameHandoffReservationIdentity,
  validateHandoffReservationRequest,
} from "./handoff-reservation-authority.mjs";
import {
  SECURE_LIFECYCLE_AUTHORITY_LABEL,
  detachedLifecycleBinding,
  sameLifecycleBindingIdentity,
  validateLifecycleBindingCreate,
  validateLifecycleBindingTransition,
} from "./lifecycle-binding-authority.mjs";
import {
  SECURE_RESUME_AUTHORITY_LABEL,
  detachedResumeReadiness,
  detachedResumeState,
  validateResumeDecision,
  validateResumeDispatchOutcome,
  validateResumeReadiness,
} from "./resume-authority.mjs";
import {
  SECURE_RECOVERY_INPUT_AUTHORITY_LABEL,
  detachedArtifactAuthority,
  detachedPlanAuthority,
  protectedPlanSnapshot,
  validateArtifactActual,
  validateArtifactRegistration,
} from "./recovery-input-authority.mjs";
import {
  SECURE_RECOVERY_AUTHORITY_LABEL,
  detachedContinuityFailure,
  detachedContinuityRecovery,
  validateContinuityFailure,
  validateContinuityRecovery,
} from "./recovery-authority.mjs";

const require = createRequire(typeof __AIOPAGO_OPERATIONAL_ENTRY_URL__ === "string"
  ? __AIOPAGO_OPERATIONAL_ENTRY_URL__
  : import.meta.url);

function sameProtectedGit(left, right) {
  const fields = ["repository_id", "workdir", "branch", "head_sha", "base_sha", "index_digest", "worktree_digest"];
  return fields.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null))
    && canonicalJson(left?.status_entries ?? []) === canonicalJson(right?.status_entries ?? []);
}

function secureUnavailable(error, path) {
  if (error instanceof GuardianError) return error;
  return new GuardianError("SECURE_OPERATION_AUTHORITY_UNAVAILABLE", "Protected operation/latch authority is unavailable; portable storage was not consulted", {
    path,
    cause: error?.code ?? error?.message ?? String(error),
  });
}

export class ProtectedSqliteOperationAuthority {
  #connection;

  constructor(path, { allowInitialize = false, expectedSchema = OPERATION_AUTHORITY_SCHEMA } = {}) {
    this.path = resolve(path);
    this.security = SECURE_OPERATION_AUTHORITY_LABEL;
    this.latchSecurity = SECURE_LATCH_AUTHORITY_LABEL;
    this.handoffSecurity = SECURE_HANDOFF_AUTHORITY_LABEL;
    this.lifecycleSecurity = SECURE_LIFECYCLE_AUTHORITY_LABEL;
    this.resumeSecurity = SECURE_RESUME_AUTHORITY_LABEL;
    this.recoveryInputSecurity = SECURE_RECOVERY_INPUT_AUTHORITY_LABEL;
    this.recoverySecurity = SECURE_RECOVERY_AUTHORITY_LABEL;
    this.schema = expectedSchema;
    const existed = existsSync(this.path);
    invariant(existed || allowInitialize, "SECURE_OPERATION_AUTHORITY_MISSING", "Protected operation/latch database is missing; portable storage was not consulted", { path: this.path });
    try {
      const { DatabaseSync } = require("node:sqlite");
      this.#connection = new DatabaseSync(this.path);
      this.#connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000;");
      this.#migrate(allowInitialize, existed);
      const integrity = this.#connection.prepare("PRAGMA integrity_check").get();
      invariant(integrity?.integrity_check === "ok", "SECURE_OPERATION_AUTHORITY_INTEGRITY_FAILED");
      const metadata = this.#connection.prepare("SELECT schema_version FROM authority_metadata WHERE singleton=1").get();
      invariant(metadata?.schema_version === expectedSchema, "SECURE_OPERATION_AUTHORITY_VERSION_MISMATCH", `${metadata?.schema_version ?? "MISSING"} != ${expectedSchema}`);
      this.#verifySchema();
      const journal = this.#connection.prepare("PRAGMA journal_mode").get();
      invariant(String(journal?.journal_mode).toLowerCase() === "wal", "SECURE_OPERATION_AUTHORITY_JOURNAL_INVALID");
    } catch (error) {
      try { this.#connection?.close(); } catch {}
      this.#connection = null;
      throw secureUnavailable(error, this.path);
    }
  }

  #database() {
    invariant(this.#connection, "SECURE_OPERATION_AUTHORITY_CLOSED");
    return this.#connection;
  }

  #migrate(allowInitialize, existed) {
    const db = this.#database();
    if (!existed) invariant(allowInitialize, "SECURE_OPERATION_AUTHORITY_MISSING");
    if (existed) {
      const metadataTable = db.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='authority_metadata'").get();
      invariant(metadataTable, "SECURE_OPERATION_AUTHORITY_METADATA_MISSING");
      const existingMetadata = db.prepare("SELECT schema_version FROM authority_metadata WHERE singleton=1").get();
      invariant(existingMetadata, "SECURE_OPERATION_AUTHORITY_METADATA_MISSING");
      if (existingMetadata.schema_version === this.schema) return;
      if (!([PREVIOUS_OPERATION_AUTHORITY_SCHEMA, LATCH_OPERATION_AUTHORITY_SCHEMA, HANDOFF_OPERATION_AUTHORITY_SCHEMA, LIFECYCLE_OPERATION_AUTHORITY_SCHEMA, RESUME_OPERATION_AUTHORITY_SCHEMA, RECOVERY_INPUT_OPERATION_AUTHORITY_SCHEMA].includes(existingMetadata.schema_version)
        && this.schema === OPERATION_AUTHORITY_SCHEMA)) return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS authority_metadata(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        schema_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations(
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        latch_generation INTEGER NOT NULL CHECK(latch_generation >= 0),
        profile TEXT NOT NULL CHECK(profile IN ('READ_ONLY','LOCAL_ATOMIC_MUTATION','SHELL_ATOMIC_OPERATION')),
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','TERMINAL')),
        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('KNOWN_SUCCESS','KNOWN_FAILURE','UNKNOWN')),
        effect_reference TEXT,
        admitted_at TEXT NOT NULL,
        terminal_at TEXT,
        admission_digest TEXT NOT NULL,
        terminal_digest TEXT,
        CHECK((state='ACTIVE' AND outcome IS NULL AND terminal_at IS NULL AND terminal_digest IS NULL)
          OR (state='TERMINAL' AND outcome IS NOT NULL AND terminal_at IS NOT NULL AND terminal_digest IS NOT NULL)),
        CHECK(outcome='KNOWN_SUCCESS' OR effect_reference IS NULL)
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
        last_event_id TEXT NOT NULL,
        CHECK((state='RELEASED' AND reason IS NULL) OR (state='ENGAGED' AND reason IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS latch_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        request_id TEXT UNIQUE,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('LATCH_BOOTSTRAPPED','LATCH_ENGAGED','LATCH_ESCALATED')),
        generation INTEGER NOT NULL CHECK(generation >= 0),
        from_reason TEXT,
        reason TEXT,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoff_reservations(
        handoff_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_plan_revision TEXT NOT NULL,
        task_plan_digest TEXT NOT NULL,
        latch_generation INTEGER NOT NULL CHECK(latch_generation >= 0),
        latch_reason TEXT NOT NULL,
        runner_instance_id TEXT NOT NULL,
        recovery_of_handoff_id TEXT,
        checkpoint_id TEXT NOT NULL,
        resume_manifest_id TEXT NOT NULL,
        reservation_digest TEXT NOT NULL,
        reservation_event_id TEXT NOT NULL UNIQUE,
        projection_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_sources(
        source_session_id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL UNIQUE REFERENCES handoff_reservations(handoff_id)
      );
      CREATE TABLE IF NOT EXISTS handoff_reservation_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        handoff_id TEXT NOT NULL UNIQUE REFERENCES handoff_reservations(handoff_id),
        task_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type='HANDOFF_RESERVED'),
        latch_generation INTEGER NOT NULL CHECK(latch_generation >= 0),
        latch_reason TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_authority_snapshots(
        snapshot_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        plan_content_digest TEXT NOT NULL,
        plan_semantic_digest TEXT NOT NULL UNIQUE,
        current_item TEXT,
        next_item TEXT,
        next_step TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id,plan_revision_id)
      );
      CREATE TABLE IF NOT EXISTS handoff_plan_authority(
        handoff_id TEXT PRIMARY KEY REFERENCES handoff_reservations(handoff_id),
        snapshot_id TEXT NOT NULL REFERENCES plan_authority_snapshots(snapshot_id),
        reservation_digest TEXT NOT NULL,
        bound_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_authority(
        artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('checkpoint','manifest')),
        artifact_id TEXT NOT NULL,
        handoff_id TEXT NOT NULL REFERENCES handoff_reservations(handoff_id),
        snapshot_id TEXT NOT NULL REFERENCES plan_authority_snapshots(snapshot_id),
        artifact_digest TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        checkpoint_id TEXT,
        checkpoint_digest TEXT,
        relationship_digest TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY(artifact_kind,artifact_id),
        CHECK((artifact_kind='checkpoint' AND checkpoint_id IS NULL AND checkpoint_digest IS NULL)
          OR (artifact_kind='manifest' AND checkpoint_id IS NOT NULL AND checkpoint_digest IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS lifecycle_bindings(
        handoff_id TEXT PRIMARY KEY REFERENCES handoff_reservations(handoff_id),
        replacement_session_id TEXT NOT NULL UNIQUE,
        runner_instance_id TEXT NOT NULL,
        session_binding_id TEXT NOT NULL UNIQUE,
        lifecycle_incarnation INTEGER NOT NULL CHECK(lifecycle_incarnation > 0),
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
        bound_at TEXT NOT NULL,
        bind_event_id TEXT NOT NULL UNIQUE,
        superseded_at TEXT,
        superseded_reason TEXT,
        supersede_event_id TEXT UNIQUE,
        CHECK((status='ACTIVE' AND superseded_at IS NULL AND superseded_reason IS NULL AND supersede_event_id IS NULL)
          OR (status='SUPERSEDED' AND superseded_at IS NOT NULL AND superseded_reason IS NOT NULL AND supersede_event_id IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS lifecycle_binding_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        handoff_id TEXT NOT NULL REFERENCES lifecycle_bindings(handoff_id),
        replacement_session_id TEXT NOT NULL,
        runner_instance_id TEXT NOT NULL,
        session_binding_id TEXT NOT NULL,
        lifecycle_incarnation INTEGER NOT NULL CHECK(lifecycle_incarnation > 0),
        event_type TEXT NOT NULL CHECK(event_type IN ('RUNNER_SESSION_BOUND','RUNNER_SESSION_BINDING_SUPERSEDED')),
        from_status TEXT,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
        reason TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resume_readiness(
        handoff_id TEXT PRIMARY KEY REFERENCES handoff_reservations(handoff_id),
        reservation_digest TEXT NOT NULL,
        replacement_session_id TEXT NOT NULL UNIQUE,
        runner_instance_id TEXT NOT NULL,
        session_binding_id TEXT NOT NULL UNIQUE,
        lifecycle_incarnation INTEGER NOT NULL CHECK(lifecycle_incarnation > 0),
        latch_generation INTEGER NOT NULL CHECK(latch_generation >= 0),
        latch_reason TEXT NOT NULL,
        checkpoint_digest TEXT NOT NULL,
        resume_manifest_digest TEXT NOT NULL,
        resume_prompt_id TEXT NOT NULL UNIQUE,
        resume_prompt_digest TEXT NOT NULL,
        resume_prompt TEXT NOT NULL,
        plan_semantic_digest TEXT NOT NULL,
        readiness_digest TEXT NOT NULL UNIQUE,
        ready_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resume_authorizations(
        authorization_id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL UNIQUE REFERENCES resume_readiness(handoff_id),
        resume_prompt_id TEXT NOT NULL UNIQUE,
        actor TEXT NOT NULL,
        readiness_digest TEXT NOT NULL,
        engaged_latch_generation INTEGER NOT NULL,
        released_latch_generation INTEGER NOT NULL,
        authorized_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resume_admissions(
        admission_id TEXT PRIMARY KEY,
        authorization_id TEXT NOT NULL UNIQUE REFERENCES resume_authorizations(authorization_id),
        handoff_id TEXT NOT NULL UNIQUE,
        resume_prompt_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        committed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resume_dispatch_attempts(
        dispatch_attempt_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL UNIQUE REFERENCES resume_admissions(admission_id),
        handoff_id TEXT NOT NULL UNIQUE,
        attempt_no INTEGER NOT NULL CHECK(attempt_no=1),
        state TEXT NOT NULL CHECK(state IN ('DISPATCHING','ACKNOWLEDGED','DISPATCHED','FAILED','UNKNOWN')),
        intent_at TEXT NOT NULL,
        outcome_at TEXT,
        error TEXT,
        CHECK((state='DISPATCHING' AND outcome_at IS NULL AND error IS NULL)
          OR (state<>'DISPATCHING' AND outcome_at IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS resume_authority_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL,
        handoff_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('RESUME_READY','LATCH_RELEASED','RESUME_AUTHORIZED','RESUME_ADMISSION_COMMITTED','RESUME_DISPATCH_INTENT','RESUME_DISPATCHED','RESUME_ACKNOWLEDGED','RESUME_FAILED','RESUME_DISPATCH_UNKNOWN')),
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS continuity_failures(
        failed_handoff_id TEXT PRIMARY KEY REFERENCES handoff_reservations(handoff_id),
        reservation_digest TEXT NOT NULL,
        failure_digest TEXT NOT NULL UNIQUE,
        failed_projection_json TEXT NOT NULL,
        failure_code TEXT NOT NULL,
        failure_message TEXT NOT NULL,
        failed_at TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS continuity_recovery_decisions(
        decision_id TEXT PRIMARY KEY,
        failed_handoff_id TEXT NOT NULL UNIQUE REFERENCES continuity_failures(failed_handoff_id),
        failure_digest TEXT NOT NULL,
        recovery_handoff_id TEXT NOT NULL UNIQUE,
        source_session_id TEXT NOT NULL,
        source_runner_instance_id TEXT NOT NULL,
        source_lifecycle_incarnation INTEGER NOT NULL CHECK(source_lifecycle_incarnation > 0),
        actor TEXT NOT NULL,
        attestation_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS continuity_recovery_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        failed_handoff_id TEXT NOT NULL REFERENCES continuity_failures(failed_handoff_id),
        recovery_handoff_id TEXT,
        event_type TEXT NOT NULL CHECK(event_type IN ('CONTINUITY_FAILED','CONTINUITY_RECOVERY_STARTED')),
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authority_requests(
        request_id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operation_task_state ON operations(task_id,state,admitted_at);
      CREATE INDEX IF NOT EXISTS latch_event_task_sequence ON latch_events(task_id,sequence);
      CREATE INDEX IF NOT EXISTS handoff_reservation_task_created ON handoff_reservations(task_id,created_at,handoff_id);
      CREATE INDEX IF NOT EXISTS plan_authority_task_revision ON plan_authority_snapshots(task_id,plan_revision_id);
      CREATE INDEX IF NOT EXISTS artifact_authority_handoff_kind ON artifact_authority(handoff_id,artifact_kind);
      CREATE INDEX IF NOT EXISTS lifecycle_binding_session_status ON lifecycle_bindings(replacement_session_id,status);
      CREATE INDEX IF NOT EXISTS lifecycle_binding_event_handoff_sequence ON lifecycle_binding_events(handoff_id,sequence);
      CREATE INDEX IF NOT EXISTS resume_authority_event_handoff_sequence ON resume_authority_events(handoff_id,sequence);
      CREATE INDEX IF NOT EXISTS continuity_recovery_event_failed_sequence ON continuity_recovery_events(failed_handoff_id,sequence);
    `);
    for (const reservation of db.prepare("SELECT * FROM handoff_reservations ORDER BY rowid").all()) {
      this.#bindPlanAuthorityInTransaction(db, JSON.parse(reservation.projection_json), reservation.reservation_digest, reservation.created_at);
    }
    const metadata = db.prepare("SELECT schema_version FROM authority_metadata WHERE singleton=1").get();
    if (!metadata) {
      invariant(allowInitialize && !existed, "SECURE_OPERATION_AUTHORITY_METADATA_MISSING");
      db.prepare("INSERT INTO authority_metadata(singleton,schema_version,created_at) VALUES(1,?,?)").run(this.schema, utcNow());
    } else if ([PREVIOUS_OPERATION_AUTHORITY_SCHEMA, LATCH_OPERATION_AUTHORITY_SCHEMA, HANDOFF_OPERATION_AUTHORITY_SCHEMA, LIFECYCLE_OPERATION_AUTHORITY_SCHEMA, RESUME_OPERATION_AUTHORITY_SCHEMA, RECOVERY_INPUT_OPERATION_AUTHORITY_SCHEMA].includes(metadata.schema_version)
      && this.schema === OPERATION_AUTHORITY_SCHEMA) {
      db.prepare("UPDATE authority_metadata SET schema_version=? WHERE singleton=1 AND schema_version=?")
        .run(OPERATION_AUTHORITY_SCHEMA, metadata.schema_version);
    }
  }

  #verifySchema() {
    const db = this.#database();
    const expected = Object.freeze({
      authority_metadata: ["singleton", "schema_version", "created_at"],
      operations: ["operation_id", "task_id", "latch_generation", "profile", "state", "outcome", "effect_reference", "admitted_at", "terminal_at", "admission_digest", "terminal_digest"],
      latches: ["task_id", "state", "generation", "reason", "engaged_at", "engaged_by", "released_at", "released_by", "last_event_id"],
      latch_events: ["sequence", "event_id", "request_id", "task_id", "event_type", "generation", "from_reason", "reason", "actor", "occurred_at"],
      handoff_reservations: ["handoff_id", "source_session_id", "task_id", "task_plan_revision", "task_plan_digest", "latch_generation", "latch_reason", "runner_instance_id", "recovery_of_handoff_id", "checkpoint_id", "resume_manifest_id", "reservation_digest", "reservation_event_id", "projection_json", "created_at"],
      active_sources: ["source_session_id", "handoff_id"],
      handoff_reservation_events: ["sequence", "event_id", "request_id", "handoff_id", "task_id", "source_session_id", "event_type", "latch_generation", "latch_reason", "occurred_at"],
      plan_authority_snapshots: ["snapshot_id", "task_id", "plan_revision_id", "plan_content_digest", "plan_semantic_digest", "current_item", "next_item", "next_step", "snapshot_json", "created_at"],
      handoff_plan_authority: ["handoff_id", "snapshot_id", "reservation_digest", "bound_at"],
      artifact_authority: ["artifact_kind", "artifact_id", "handoff_id", "snapshot_id", "artifact_digest", "content_digest", "checkpoint_id", "checkpoint_digest", "relationship_digest", "registered_at"],
      lifecycle_bindings: ["handoff_id", "replacement_session_id", "runner_instance_id", "session_binding_id", "lifecycle_incarnation", "status", "bound_at", "bind_event_id", "superseded_at", "superseded_reason", "supersede_event_id"],
      lifecycle_binding_events: ["sequence", "event_id", "request_id", "handoff_id", "replacement_session_id", "runner_instance_id", "session_binding_id", "lifecycle_incarnation", "event_type", "from_status", "status", "reason", "occurred_at"],
      resume_readiness: ["handoff_id", "reservation_digest", "replacement_session_id", "runner_instance_id", "session_binding_id", "lifecycle_incarnation", "latch_generation", "latch_reason", "checkpoint_digest", "resume_manifest_digest", "resume_prompt_id", "resume_prompt_digest", "resume_prompt", "plan_semantic_digest", "readiness_digest", "ready_at"],
      resume_authorizations: ["authorization_id", "handoff_id", "resume_prompt_id", "actor", "readiness_digest", "engaged_latch_generation", "released_latch_generation", "authorized_at"],
      resume_admissions: ["admission_id", "authorization_id", "handoff_id", "resume_prompt_id", "idempotency_key", "committed_at"],
      resume_dispatch_attempts: ["dispatch_attempt_id", "admission_id", "handoff_id", "attempt_no", "state", "intent_at", "outcome_at", "error"],
      resume_authority_events: ["sequence", "event_id", "request_id", "handoff_id", "event_type", "occurred_at", "data_json"],
      continuity_failures: ["failed_handoff_id", "reservation_digest", "failure_digest", "failed_projection_json", "failure_code", "failure_message", "failed_at", "event_id"],
      continuity_recovery_decisions: ["decision_id", "failed_handoff_id", "failure_digest", "recovery_handoff_id", "source_session_id", "source_runner_instance_id", "source_lifecycle_incarnation", "actor", "attestation_digest", "request_digest", "started_at"],
      continuity_recovery_events: ["sequence", "event_id", "request_id", "failed_handoff_id", "recovery_handoff_id", "event_type", "occurred_at", "data_json"],
      authority_requests: ["request_id", "operation_type", "payload_digest", "result_json", "recorded_at"],
    });
    for (const [table, columns] of Object.entries(expected)) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      invariant(JSON.stringify(actual) === JSON.stringify(columns), "SECURE_OPERATION_AUTHORITY_SCHEMA_INVALID", `${table} schema is missing or incompatible`);
    }
  }

  #transaction(fn) {
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #recordedRequest(db, requestId, operationType, payloadDigest, conflictCode = "OPERATION_REQUEST_CONFLICT") {
    const prior = db.prepare("SELECT operation_type,payload_digest,result_json FROM authority_requests WHERE request_id=?").get(requestId);
    if (!prior) return null;
    invariant(prior.operation_type === operationType && prior.payload_digest === payloadDigest,
      conflictCode, "The protected request identity already binds different authority payload");
    return Object.freeze({ ...JSON.parse(prior.result_json), idempotent: true, request_code: "IDEMPOTENT_RECORDED_RESULT" });
  }

  #saveRequest(db, requestId, operationType, payloadDigest, result) {
    db.prepare("INSERT INTO authority_requests(request_id,operation_type,payload_digest,result_json,recorded_at) VALUES(?,?,?,?,?)")
      .run(requestId, operationType, payloadDigest, JSON.stringify(result), utcNow());
  }

  #ensureLatchInTransaction(db, taskId) {
    const prior = db.prepare("SELECT * FROM latches WHERE task_id=?").get(taskId);
    if (prior) return prior;
    const occurredAt = utcNow();
    const eventId = opaqueId("LEV");
    db.prepare("INSERT INTO latch_events(event_id,task_id,event_type,generation,reason,actor,occurred_at) VALUES(?,?,?,?,?,?,?)")
      .run(eventId, taskId, "LATCH_BOOTSTRAPPED", 0, null, "human:bootstrap", occurredAt);
    db.prepare("INSERT INTO latches(task_id,state,generation,released_at,released_by,last_event_id) VALUES(?,?,?,?,?,?)")
      .run(taskId, "RELEASED", 0, occurredAt, "human:bootstrap", eventId);
    return db.prepare("SELECT * FROM latches WHERE task_id=?").get(taskId);
  }

  ensureLatch(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.#transaction((db) => this.#ensureLatchInTransaction(db, taskId)));
  }

  getLatch(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.#database().prepare("SELECT * FROM latches WHERE task_id=?").get(taskId));
  }

  #claimLatchInTransaction(db, value, requestId, payloadDigest) {
    const recorded = this.#recordedRequest(db, requestId, "LATCH_CLAIM", payloadDigest, "LATCH_REQUEST_CONFLICT");
    if (recorded) return recorded;
    const latch = this.#ensureLatchInTransaction(db, value.taskId);
    if (value.reason !== "HUMAN_TAKEOVER" && latch.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
      throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover has priority over safe-point acquisition");
    }
    if (value.expected && (latch.state !== value.expected.state || latch.generation !== value.expected.generation
      || (latch.reason ?? null) !== value.expected.reason)) {
      throw new GuardianError("LATCH_GENERATION_MISMATCH", "Canonical latch no longer matches the expected safe-point precondition", { expected: value.expected, observed: latch });
    }
    let changedLatch = latch;
    let idempotent = true;
    let requestCode = "IDEMPOTENT_LATCH";
    if (latch.state === "ENGAGED") {
      if (value.reason === "HUMAN_TAKEOVER" && latch.reason !== value.reason) {
        const eventId = opaqueId("LEV");
        const occurredAt = utcNow();
        db.prepare("INSERT INTO latch_events(event_id,request_id,task_id,event_type,generation,from_reason,reason,actor,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(eventId, requestId, value.taskId, "LATCH_ESCALATED", latch.generation, latch.reason, value.reason, value.actor, occurredAt);
        const changed = db.prepare("UPDATE latches SET reason=?,engaged_by=?,last_event_id=? WHERE task_id=? AND state='ENGAGED' AND generation=? AND reason IS ?")
          .run(value.reason, value.actor, eventId, value.taskId, latch.generation, latch.reason);
        invariant(changed.changes === 1, "LATCH_GENERATION_MISMATCH", "Latch escalation raced");
        changedLatch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.taskId);
        idempotent = false;
        requestCode = "MUTATION_ACCEPTED";
      } else {
        invariant(latch.reason === value.reason, "LATCH_REASON_MISMATCH", `${latch.reason} != ${value.reason}`);
      }
    } else {
      const generation = latch.generation + 1;
      const eventId = opaqueId("LEV");
      const occurredAt = utcNow();
      db.prepare("INSERT INTO latch_events(event_id,request_id,task_id,event_type,generation,reason,actor,occurred_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(eventId, requestId, value.taskId, "LATCH_ENGAGED", generation, value.reason, value.actor, occurredAt);
      const changed = db.prepare("UPDATE latches SET state='ENGAGED',generation=?,reason=?,engaged_at=?,engaged_by=?,released_at=NULL,released_by=NULL,last_event_id=? WHERE task_id=? AND state='RELEASED' AND generation=? AND reason IS NULL")
        .run(generation, value.reason, occurredAt, value.actor, eventId, value.taskId, latch.generation);
      invariant(changed.changes === 1, "LATCH_GENERATION_MISMATCH", "Latch acquisition raced");
      changedLatch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.taskId);
      idempotent = false;
      requestCode = "MUTATION_ACCEPTED";
    }
    const result = { latch: changedLatch, idempotent, request_code: requestCode };
    this.#saveRequest(db, requestId, "LATCH_CLAIM", payloadDigest, result);
    return Object.freeze(result);
  }

  requestLatchClaim(requestId, request) {
    operationIdentifier(requestId, "LATCH_REQUEST_ID_INVALID", "requestId");
    const value = validateLatchClaim(request);
    const payloadDigest = sha256(Buffer.from(canonicalJson(value), "utf8"));
    const ledgerRequestId = `latch:${requestId}`;
    return this.#transaction((db) => this.#claimLatchInTransaction(db, value, ledgerRequestId, payloadDigest));
  }

  claimLatch(request) {
    const requestId = request?.requestId ?? opaqueId("LREQ");
    return detachedLatch(this.requestLatchClaim(requestId, request).latch);
  }

  claimHumanTakeover({ taskId, actor, requestId = undefined, expected = null }) {
    return this.claimLatch({ taskId, reason: "HUMAN_TAKEOVER", actor, requestId, expected });
  }

  assertLatchIdentity(taskId, expected, options = {}) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(assertLatchIdentityValue(this.getLatch(taskId), expected, options));
  }

  isAdmissionOpen(taskId) {
    try { return this.getLatch(taskId)?.state === "RELEASED"; }
    catch { return false; }
  }

  latchEventsForTask(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return Object.freeze(this.#database().prepare("SELECT * FROM latch_events WHERE task_id=? ORDER BY sequence").all(taskId).map((row) => Object.freeze({ ...row })));
  }

  #reservationRow(db, handoffId) {
    return db.prepare("SELECT * FROM handoff_reservations WHERE handoff_id=?").get(handoffId) ?? null;
  }

  #planAuthorityRow(db, handoffId) {
    return db.prepare(`SELECT p.*,h.handoff_id,h.reservation_digest FROM handoff_plan_authority h
      JOIN plan_authority_snapshots p ON p.snapshot_id=h.snapshot_id WHERE h.handoff_id=?`).get(handoffId) ?? null;
  }

  #bindPlanAuthorityInTransaction(db, projection, reservationDigest, occurredAt) {
    const value = protectedPlanSnapshot(projection);
    const priorRevision = db.prepare("SELECT * FROM plan_authority_snapshots WHERE task_id=? AND plan_revision_id=?").get(
      projection.task_id, projection.task_plan_revision,
    );
    if (priorRevision) {
      invariant(priorRevision.snapshot_id === value.snapshot_id
        && priorRevision.plan_content_digest === projection.task_plan_digest
        && priorRevision.plan_semantic_digest === value.semantic_digest
        && priorRevision.snapshot_json === canonicalJson(value.snapshot),
      "PLAN_AUTHORITY_CONFLICT", "The protected task/revision already binds different canonical plan content");
    } else {
      db.prepare(`INSERT INTO plan_authority_snapshots(
        snapshot_id,task_id,plan_revision_id,plan_content_digest,plan_semantic_digest,current_item,next_item,next_step,snapshot_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        value.snapshot_id, projection.task_id, projection.task_plan_revision, projection.task_plan_digest,
        value.semantic_digest, value.snapshot.current_item, value.snapshot.next_item, value.snapshot.next_step,
        canonicalJson(value.snapshot), occurredAt,
      );
    }
    const priorBinding = db.prepare("SELECT * FROM handoff_plan_authority WHERE handoff_id=?").get(projection.handoff_id);
    if (priorBinding) {
      invariant(priorBinding.snapshot_id === value.snapshot_id && priorBinding.reservation_digest === reservationDigest,
        "PLAN_AUTHORITY_CONFLICT", "The protected handoff already binds a different plan identity");
    } else {
      db.prepare("INSERT INTO handoff_plan_authority(handoff_id,snapshot_id,reservation_digest,bound_at) VALUES(?,?,?,?)")
        .run(projection.handoff_id, value.snapshot_id, reservationDigest, occurredAt);
    }
    return this.#planAuthorityRow(db, projection.handoff_id);
  }

  #reservationResult(db, handoffId, created, requestCode) {
    const reservation = this.#reservationRow(db, handoffId);
    const activeSource = db.prepare("SELECT source_session_id,handoff_id FROM active_sources WHERE handoff_id=?").get(handoffId) ?? null;
    const event = db.prepare("SELECT * FROM handoff_reservation_events WHERE handoff_id=?").get(handoffId) ?? null;
    const planAuthority = this.#planAuthorityRow(db, handoffId);
    return Object.freeze({ reservation, plan_authority: planAuthority, active_source: activeSource, event, created, idempotent: !created, request_code: requestCode });
  }

  #reserveHandoffInTransaction(db, value, ledgerRequestId, payloadDigest, { crashBeforeEvent = false, recoveryFailure = null, crashSeam = null } = {}) {
    const recorded = this.#recordedRequest(db, ledgerRequestId, "HANDOFF_RESERVE", payloadDigest, "HANDOFF_REQUEST_CONFLICT");
    if (recorded) return Object.freeze({ ...recorded, created: false, idempotent: true });
    const projection = value.projection;
    const exact = this.#reservationRow(db, projection.handoff_id);
    if (exact) {
      const existingProjection = JSON.parse(exact.projection_json);
      invariant(exact.reservation_digest === payloadDigest
        && exact.latch_reason === value.expectedLatch.reason
        && sameHandoffReservationIdentity(existingProjection, projection)
        && canonicalJson(existingProjection) === canonicalJson(projection),
      "HANDOFF_RESERVATION_CONFLICT", "The handoff identity already binds different canonical reservation provenance");
      const result = this.#reservationResult(db, projection.handoff_id, false, "IDEMPOTENT_HANDOFF_RESERVATION");
      this.#saveRequest(db, ledgerRequestId, "HANDOFF_RESERVE", payloadDigest, result);
      return result;
    }

    const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(projection.task_id);
    if (latch?.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
      throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover committed before protected handoff reservation");
    }
    invariant(latch?.state === value.expectedLatch.state
      && latch.generation === value.expectedLatch.generation
      && latch.reason === value.expectedLatch.reason,
    "LATCH_GENERATION_MISMATCH", "Protected handoff reservation used stale canonical latch identity");

    const active = db.prepare("SELECT handoff_id FROM active_sources WHERE source_session_id=?").get(projection.source_session_id);
    if (active) {
      const existing = this.#reservationRow(db, active.handoff_id);
      throw new GuardianError("HANDOFF_ACTIVE_SOURCE_CONFLICT", "The canonical source session is already reserved by a different handoff operation", {
        source_session_id: projection.source_session_id,
        existing_handoff_id: existing?.handoff_id ?? active.handoff_id,
        requested_handoff_id: projection.handoff_id,
      });
    }

    const latest = db.prepare("SELECT handoff_id,reservation_digest FROM handoff_reservations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(projection.task_id) ?? null;
    const expectedLatest = value.expectedLatest;
    invariant((latest === null && expectedLatest === null)
      || (latest !== null && expectedLatest !== null && latest.handoff_id === expectedLatest.handoff_id && latest.reservation_digest === expectedLatest.reservation_digest),
    "HANDOFF_LATEST_RESERVATION_STALE", "Canonical latest handoff reservation changed");
    if (latest) {
      const priorBinding = this.#lifecycleBindingRow(db, latest.handoff_id);
      if (recoveryFailure) {
        invariant(latest.handoff_id === recoveryFailure.failed_handoff_id
          && latest.reservation_digest === recoveryFailure.reservation_digest
          && projection.recovery_of_handoff_id === recoveryFailure.failed_handoff_id
          && priorBinding?.status === "SUPERSEDED",
        "CONTINUITY_RECOVERY_CONFLICT", "Recovery child does not transfer the exact failed protected lifecycle");
      } else {
        invariant(priorBinding?.status === "ACTIVE"
          && priorBinding.replacement_session_id === projection.source_session_id
          && priorBinding.runner_instance_id === projection.runner_instance_id,
        "HANDOFF_TASK_RESERVATION_CONFLICT", "The latest protected lifecycle does not authorize this exact active target as the next source", {
          task_id: projection.task_id,
          existing_handoff_id: latest.handoff_id,
        });
      }
    }

    const eventId = opaqueId("HEV");
    const occurredAt = utcNow();
    db.prepare(`INSERT INTO handoff_reservations(
      handoff_id,source_session_id,task_id,task_plan_revision,task_plan_digest,latch_generation,latch_reason,
      runner_instance_id,recovery_of_handoff_id,checkpoint_id,resume_manifest_id,reservation_digest,reservation_event_id,projection_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      projection.handoff_id, projection.source_session_id, projection.task_id, projection.task_plan_revision,
      projection.task_plan_digest, projection.latch_generation, value.expectedLatch.reason, projection.runner_instance_id,
      projection.recovery_of_handoff_id ?? null, projection.checkpoint_id, projection.resume_manifest_id,
      payloadDigest, eventId, JSON.stringify(projection), occurredAt,
    );
    this.#bindPlanAuthorityInTransaction(db, projection, payloadDigest, occurredAt);
    db.prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)")
      .run(projection.source_session_id, projection.handoff_id);
    if (crashSeam === "after_child_reservation") process.exit(107);
    if (crashBeforeEvent) process.exit(99);
    db.prepare(`INSERT INTO handoff_reservation_events(
      event_id,request_id,handoff_id,task_id,source_session_id,event_type,latch_generation,latch_reason,occurred_at
    ) VALUES(?,?,?,?,?,'HANDOFF_RESERVED',?,?,?)`).run(
      eventId, ledgerRequestId, projection.handoff_id, projection.task_id, projection.source_session_id,
      projection.latch_generation, value.expectedLatch.reason, occurredAt,
    );
    const result = this.#reservationResult(db, projection.handoff_id, true, "MUTATION_ACCEPTED");
    this.#saveRequest(db, ledgerRequestId, "HANDOFF_RESERVE", payloadDigest, result);
    return result;
  }

  assertHandoffOwnerAuthority({ taskId, expectedLatch, expectedLatest = null }) {
    operationIdentifier(taskId, "HANDOFF_TASK_INVALID", "taskId");
    return this.#transaction((db) => {
      const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(taskId);
      if (latch?.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
        throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover won protected owner-gate arbitration");
      }
      invariant(latch?.state === expectedLatch?.state && latch.generation === expectedLatch?.generation
        && (latch.reason ?? null) === (expectedLatch?.reason ?? null),
      "LATCH_GENERATION_MISMATCH", "Protected latch changed before owner-gate mutation");
      const latest = db.prepare("SELECT handoff_id,reservation_digest FROM handoff_reservations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId) ?? null;
      invariant((latest === null && expectedLatest === null)
        || (latest !== null && expectedLatest?.handoff_id === latest.handoff_id && expectedLatest?.reservation_digest === latest.reservation_digest),
      "HANDOFF_LATEST_RESERVATION_STALE", "Protected handoff lifecycle changed before owner-gate mutation");
      if (latest) {
        const binding = this.#lifecycleBindingRow(db, latest.handoff_id);
        invariant(binding?.status === "ACTIVE", "HANDOFF_TASK_RESERVATION_CONFLICT", "Latest protected reservation has no ACTIVE lifecycle successor");
      }
      return Object.freeze({ task_id: taskId, eligible: true });
    });
  }

  requestHandoffReservation(requestId, request) {
    operationIdentifier(requestId, "HANDOFF_REQUEST_ID_INVALID", "requestId");
    const value = validateHandoffReservationRequest(request);
    const payload = { projection: value.projection, expectedLatch: value.expectedLatch, expectedLatest: value.expectedLatest };
    const payloadDigest = sha256(Buffer.from(canonicalJson(payload), "utf8"));
    return this.#transaction((db) => this.#reserveHandoffInTransaction(db, value, `handoff:${requestId}`, payloadDigest));
  }

  reserveHandoff(request) {
    const requestId = request?.requestId ?? request?.projection?.handoff_id;
    return this.requestHandoffReservation(requestId, request);
  }

  getHandoffReservation(handoffId) {
    operationIdentifier(handoffId, "HANDOFF_ID_INVALID", "handoffId");
    return detachedReservation(this.#reservationRow(this.#database(), handoffId));
  }

  latestHandoffReservationForTask(taskId) {
    operationIdentifier(taskId, "HANDOFF_TASK_INVALID", "taskId");
    const row = this.#database().prepare("SELECT * FROM handoff_reservations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId);
    return detachedReservation(row);
  }

  getActiveSource(sourceSessionId) {
    operationIdentifier(sourceSessionId, "HANDOFF_SOURCE_INVALID", "sourceSessionId");
    const row = this.#database().prepare("SELECT source_session_id,handoff_id FROM active_sources WHERE source_session_id=?").get(sourceSessionId);
    return row ? Object.freeze({ ...row }) : null;
  }

  handoffReservationEvents(handoffId) {
    operationIdentifier(handoffId, "HANDOFF_ID_INVALID", "handoffId");
    return Object.freeze(this.#database().prepare("SELECT * FROM handoff_reservation_events WHERE handoff_id=? ORDER BY sequence").all(handoffId).map((row) => Object.freeze({ ...row })));
  }

  getPlanAuthorityForHandoff(handoffId) {
    operationIdentifier(handoffId, "PLAN_AUTHORITY_HANDOFF_INVALID", "handoffId");
    return detachedPlanAuthority(this.#planAuthorityRow(this.#database(), handoffId));
  }

  getPlanAuthority(taskId, planRevisionId) {
    operationIdentifier(taskId, "PLAN_AUTHORITY_TASK_INVALID", "taskId");
    operationIdentifier(planRevisionId, "PLAN_AUTHORITY_REVISION_INVALID", "planRevisionId");
    const row = this.#database().prepare("SELECT * FROM plan_authority_snapshots WHERE task_id=? AND plan_revision_id=?")
      .get(taskId, planRevisionId);
    return detachedPlanAuthority(row);
  }

  requestArtifactRegistration(requestId, request) {
    operationIdentifier(requestId, "ARTIFACT_AUTHORITY_REQUEST_INVALID", "requestId");
    const validated = validateArtifactRegistration(request);
    const value = validated.value;
    const ledgerRequestId = `artifact:${requestId}`;
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, ledgerRequestId, "ARTIFACT_REGISTER", validated.payload_digest, "ARTIFACT_AUTHORITY_REQUEST_CONFLICT");
      if (recorded) return Object.freeze({ ...recorded, artifact: detachedArtifactAuthority(
        db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind=? AND artifact_id=?").get(value.kind, value.artifact_id),
      ) });
      const reservation = this.#reservationRow(db, value.handoff_id);
      invariant(reservation, "ARTIFACT_AUTHORITY_HANDOFF_NOT_FOUND");
      const projection = JSON.parse(reservation.projection_json);
      const plan = this.#planAuthorityRow(db, value.handoff_id);
      invariant(plan && plan.plan_semantic_digest === value.plan_semantic_digest,
        "ARTIFACT_AUTHORITY_PLAN_MISMATCH", "Artifact does not bind the protected handoff plan snapshot");
      const expectedId = value.kind === "checkpoint" ? reservation.checkpoint_id : reservation.resume_manifest_id;
      invariant(value.artifact_id === expectedId, "ARTIFACT_AUTHORITY_RELATIONSHIP_MISMATCH", "Artifact ID is not reserved for this handoff");
      if (value.kind === "manifest") {
        const binding = this.#lifecycleBindingRow(db, value.handoff_id);
        invariant(binding?.status === "ACTIVE", "LIFECYCLE_BINDING_STALE", "Manifest registration requires the exact protected ACTIVE target binding");
        const checkpoint = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='checkpoint' AND artifact_id=?").get(value.checkpoint_id);
        invariant(checkpoint?.handoff_id === value.handoff_id
          && checkpoint.artifact_digest === value.checkpoint_digest
          && checkpoint.snapshot_id === plan.snapshot_id,
        "ARTIFACT_AUTHORITY_RELATIONSHIP_MISMATCH", "Manifest checkpoint link is absent, stale, or cross-handoff");
      }
      invariant(projection.task_id === plan.task_id, "ARTIFACT_AUTHORITY_PLAN_MISMATCH");
      const prior = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind=? AND artifact_id=?").get(value.kind, value.artifact_id);
      if (prior) {
        invariant(prior.relationship_digest === validated.payload_digest,
          "ARTIFACT_AUTHORITY_CONFLICT", "Artifact identity already binds different bytes or relationships");
        const result = { artifact: detachedArtifactAuthority(prior), created: false, idempotent: true, request_code: "IDEMPOTENT_ARTIFACT_AUTHORITY" };
        this.#saveRequest(db, ledgerRequestId, "ARTIFACT_REGISTER", validated.payload_digest, result);
        return Object.freeze(result);
      }
      const now = utcNow();
      db.prepare(`INSERT INTO artifact_authority(
        artifact_kind,artifact_id,handoff_id,snapshot_id,artifact_digest,content_digest,checkpoint_id,checkpoint_digest,relationship_digest,registered_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        value.kind, value.artifact_id, value.handoff_id, plan.snapshot_id, value.artifact_digest,
        value.content_digest, value.checkpoint_id, value.checkpoint_digest, validated.payload_digest, now,
      );
      const artifact = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind=? AND artifact_id=?").get(value.kind, value.artifact_id);
      const result = { artifact: detachedArtifactAuthority(artifact), created: true, idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, ledgerRequestId, "ARTIFACT_REGISTER", validated.payload_digest, result);
      return Object.freeze(result);
    });
  }

  getArtifactAuthority(kind, artifactId) {
    invariant(kind === "checkpoint" || kind === "manifest", "ARTIFACT_AUTHORITY_KIND_INVALID");
    operationIdentifier(artifactId, "ARTIFACT_AUTHORITY_ID_INVALID", "artifactId");
    return detachedArtifactAuthority(this.#database().prepare(
      "SELECT * FROM artifact_authority WHERE artifact_kind=? AND artifact_id=?",
    ).get(kind, artifactId));
  }

  verifyArtifactAuthority(actual) {
    const value = validateArtifactActual(actual);
    const expected = this.getArtifactAuthority(value.kind, value.artifact_id);
    invariant(expected && expected.handoff_id === value.handoff_id
      && expected.artifact_digest === value.artifact_digest
      && expected.content_digest === value.content_digest,
    value.kind === "checkpoint" ? "CHECKPOINT_MISMATCH" : "MANIFEST_MISMATCH",
    "Physical artifact bytes do not match protected expected identity or relationship");
    return expected;
  }

  recoveryInputReadiness(request) {
    invariant(request && typeof request === "object" && !Array.isArray(request), "RECOVERY_INPUT_INVALID");
    const handoffId = operationIdentifier(request.handoff_id, "RECOVERY_INPUT_HANDOFF_INVALID", "handoff_id");
    const db = this.#database();
    const reservation = this.#reservationRow(db, handoffId);
    const plan = this.#planAuthorityRow(db, handoffId);
    invariant(reservation && plan, "RECOVERY_INPUT_PLAN_UNAVAILABLE");
    const suppliedPlan = protectedPlanSnapshot({
      task_id: request.plan?.task_id,
      task_plan_revision: request.plan?.plan_revision_id,
      task_plan_digest: request.plan?.content_digest,
      current_item: request.plan?.current_item ?? null,
      next_item: request.plan?.next_item ?? null,
      next_step: request.plan?.next_step,
      requirements_version: request.plan?.requirements_version,
      model_policy: request.plan?.model_policy ?? null,
      reasoning_policy: request.plan?.reasoning_policy ?? null,
      reserved_plan_snapshot: request.plan,
    });
    invariant(suppliedPlan.semantic_digest === plan.plan_semantic_digest
      && canonicalJson(suppliedPlan.snapshot) === plan.snapshot_json,
    "RECOVERY_INPUT_PLAN_MISMATCH", "Supplied plan input does not equal the protected authoritative snapshot");
    const checkpointActual = validateArtifactActual({ ...request.checkpoint, kind: "checkpoint", handoff_id: handoffId });
    const manifestActual = validateArtifactActual({ ...request.manifest, kind: "manifest", handoff_id: handoffId });
    const checkpoint = this.verifyArtifactAuthority(checkpointActual);
    const manifest = this.verifyArtifactAuthority(manifestActual);
    invariant(checkpoint.snapshot_id === plan.snapshot_id && manifest.snapshot_id === plan.snapshot_id
      && manifest.checkpoint_id === checkpoint.artifact_id
      && manifest.checkpoint_digest === checkpoint.artifact_digest,
    "RECOVERY_INPUT_RELATIONSHIP_MISMATCH", "Protected recovery inputs are individually valid but not mutually related");
    const binding = this.#lifecycleBindingRow(db, handoffId);
    invariant(binding?.status === "ACTIVE", "RECOVERY_INPUT_LIFECYCLE_STALE");
    const readiness = this.#resumeReadinessRow(db, handoffId);
    if (readiness) invariant(readiness.plan_semantic_digest === plan.plan_semantic_digest
      && readiness.checkpoint_digest === checkpoint.artifact_digest
      && readiness.resume_manifest_digest === manifest.artifact_digest,
    "RECOVERY_INPUT_READINESS_MISMATCH", "Protected resume readiness does not bind the exact recovery inputs");
    const dispatch = db.prepare("SELECT * FROM resume_dispatch_attempts WHERE handoff_id=?").get(handoffId) ?? null;
    return Object.freeze({
      ready: true,
      result: "RECOVERY_INPUT_READY",
      handoff_id: handoffId,
      plan: detachedPlanAuthority(plan),
      checkpoint: detachedArtifactAuthority(checkpoint),
      manifest: detachedArtifactAuthority(manifest),
      lifecycle: this.#detachedLifecycleBinding(db, binding),
      resume_readiness: detachedResumeReadiness(readiness),
      dispatch: dispatch ? Object.freeze({ ...dispatch }) : null,
      recovery_authority_available: true,
      reconciliation: dispatch ? this.#dispatchReconciliation(dispatch) : null,
    });
  }

  #continuityFailureRow(db, handoffId) {
    return db.prepare("SELECT * FROM continuity_failures WHERE failed_handoff_id=?").get(handoffId) ?? null;
  }

  #continuityRecoveryState(db, handoffId) {
    const failure = this.#continuityFailureRow(db, handoffId);
    if (!failure) return null;
    const decision = db.prepare("SELECT * FROM continuity_recovery_decisions WHERE failed_handoff_id=?").get(handoffId) ?? null;
    const event = db.prepare("SELECT * FROM continuity_recovery_events WHERE failed_handoff_id=? AND event_type='CONTINUITY_RECOVERY_STARTED'").get(handoffId) ?? null;
    return detachedContinuityRecovery({
      failure,
      decision,
      event,
      child: decision ? detachedReservation(this.#reservationRow(db, decision.recovery_handoff_id)) : null,
      binding: this.#detachedLifecycleBinding(db, this.#lifecycleBindingRow(db, handoffId)),
    });
  }

  requestContinuityFailure(requestId, request) {
    operationIdentifier(requestId, "RECOVERY_REQUEST_ID_INVALID", "requestId");
    const validated = validateContinuityFailure(request);
    const value = validated.value;
    const handoffId = value.failed_handoff.handoff_id;
    const ledgerRequestId = `continuity-failure:${requestId}`;
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, ledgerRequestId, "CONTINUITY_FAILURE", validated.payload_digest, "RECOVERY_REQUEST_CONFLICT");
      if (recorded) return Object.freeze({ ...recorded, recovery: this.#continuityRecoveryState(db, handoffId) });
      const reservation = this.#reservationRow(db, handoffId);
      invariant(reservation?.reservation_digest === value.reservation_digest, "CONTINUITY_FAILURE_RESERVATION_STALE");
      const initial = JSON.parse(reservation.projection_json);
      invariant(sameHandoffReservationIdentity(initial, value.failed_handoff)
        && value.failed_handoff.target_session_id === value.binding.replacement_session_id
        && value.failed_handoff.runner_instance_id === value.binding.runner_instance_id
        && value.failed_handoff.session_binding_id === value.binding.session_binding_id
        && value.failed_handoff.checkpoint_id === value.checkpoint.id
        && value.failed_handoff.checkpoint_digest === value.checkpoint.digest
        && value.failed_handoff.resume_manifest_id === value.manifest.id
        && value.failed_handoff.resume_manifest_digest === value.manifest.digest
        && value.failed_handoff.authorization_state === "NOT_AUTHORIZED"
        && value.failed_handoff.admission_state === "NOT_COMMITTED"
        && value.failed_handoff.dispatch_state === "NOT_STARTED"
        && canonicalJson(value.failed_handoff.reserved_plan_snapshot) === canonicalJson(initial.reserved_plan_snapshot)
        && canonicalJson(value.failed_handoff.expected_git_state) === canonicalJson(initial.expected_git_state),
      "CONTINUITY_FAILURE_SUBJECT_MISMATCH", "Continuity failure does not equal its protected reservation subject");
      const plan = this.#planAuthorityRow(db, handoffId);
      invariant(plan?.plan_semantic_digest === value.plan_semantic_digest, "CONTINUITY_FAILURE_PLAN_STALE");
      const binding = this.#lifecycleBindingRow(db, handoffId);
      invariant(binding?.status === "ACTIVE" && sameLifecycleBindingIdentity(binding, value.binding), "LIFECYCLE_BINDING_STALE");
      const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.latch.task_id);
      if (latch?.reason === "HUMAN_TAKEOVER") throw new GuardianError("HUMAN_TAKEOVER_ACTIVE");
      invariant(latch?.state === value.latch.state && latch.generation === value.latch.generation && latch.reason === value.latch.reason
        && latch.generation === reservation.latch_generation, "LATCH_GENERATION_MISMATCH");
      const checkpoint = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='checkpoint' AND artifact_id=?").get(value.checkpoint.id);
      const manifest = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='manifest' AND artifact_id=?").get(value.manifest.id);
      invariant(checkpoint?.handoff_id === handoffId && checkpoint.artifact_digest === value.checkpoint.digest
        && checkpoint.content_digest === value.checkpoint.content_digest
        && manifest?.handoff_id === handoffId && manifest.artifact_digest === value.manifest.digest
        && manifest.content_digest === value.manifest.content_digest
        && manifest.checkpoint_id === checkpoint.artifact_id && manifest.checkpoint_digest === checkpoint.artifact_digest,
      "CONTINUITY_FAILURE_ARTIFACT_STALE");
      invariant(!this.#resumeReadinessRow(db, handoffId)
        && !db.prepare("SELECT 1 present FROM resume_authorizations WHERE handoff_id=?").get(handoffId)
        && !db.prepare("SELECT 1 present FROM resume_admissions WHERE handoff_id=?").get(handoffId)
        && !db.prepare("SELECT 1 present FROM resume_dispatch_attempts WHERE handoff_id=?").get(handoffId),
      "CONTINUITY_RECOVERY_UNSAFE", "Continuity failure cannot coexist with protected resume effects");
      const prior = this.#continuityFailureRow(db, handoffId);
      if (prior) {
        invariant(prior.failure_digest === validated.payload_digest, "CONTINUITY_FAILURE_CONFLICT");
      } else {
        const now = utcNow();
        const eventId = opaqueId("RFEV");
        db.prepare(`INSERT INTO continuity_failures(
          failed_handoff_id,reservation_digest,failure_digest,failed_projection_json,failure_code,failure_message,failed_at,event_id
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
          handoffId, reservation.reservation_digest, validated.payload_digest, canonicalJson(value.failed_handoff),
          value.failed_handoff.failure.code, value.failed_handoff.failure.message, now, eventId,
        );
        db.prepare(`INSERT INTO continuity_recovery_events(
          event_id,request_id,failed_handoff_id,recovery_handoff_id,event_type,occurred_at,data_json
        ) VALUES(?,?,?,?,?,?,?)`).run(
          eventId, ledgerRequestId, handoffId, null, "CONTINUITY_FAILED", now,
          JSON.stringify({ code: value.failed_handoff.failure.code, error: value.failed_handoff.failure.message }),
        );
      }
      const result = { recovery: this.#continuityRecoveryState(db, handoffId), created: !prior, idempotent: Boolean(prior), request_code: prior ? "IDEMPOTENT_CONTINUITY_FAILURE" : "MUTATION_ACCEPTED" };
      this.#saveRequest(db, ledgerRequestId, "CONTINUITY_FAILURE", validated.payload_digest, result);
      return Object.freeze(result);
    });
  }

  #recoverContinuityInTransaction(db, requestId, validated, { crashSeam = null } = {}) {
    const value = validated.value;
    const ledgerRequestId = `continuity-recovery:${requestId}`;
    const recorded = this.#recordedRequest(db, ledgerRequestId, "CONTINUITY_RECOVERY", validated.payload_digest, "RECOVERY_REQUEST_CONFLICT");
    if (recorded) return Object.freeze({ ...recorded, recovery: this.#continuityRecoveryState(db, value.failed_handoff_id) });
    const failure = this.#continuityFailureRow(db, value.failed_handoff_id);
    invariant(failure?.failure_digest === value.failure_digest, "CONTINUITY_RECOVERY_SOURCE_INVALID", "Protected failure identity changed");
    const failed = JSON.parse(failure.failed_projection_json);
    const priorDecision = db.prepare("SELECT * FROM continuity_recovery_decisions WHERE failed_handoff_id=? OR decision_id=? OR recovery_handoff_id=? LIMIT 1")
      .get(value.failed_handoff_id, value.decision_id, value.child_projection.handoff_id);
    if (priorDecision) {
      invariant(priorDecision.failed_handoff_id === value.failed_handoff_id
        && priorDecision.decision_id === value.decision_id
        && priorDecision.recovery_handoff_id === value.child_projection.handoff_id
        && priorDecision.request_digest === validated.payload_digest,
      "CONTINUITY_RECOVERY_CONFLICT", "Failed handoff already binds a different recovery identity");
      const childReserved = this.#reservationResult(db, priorDecision.recovery_handoff_id, false, "IDEMPOTENT_HANDOFF_RESERVATION");
      const result = {
        recovery: this.#continuityRecoveryState(db, value.failed_handoff_id),
        child_projection_proof: {
          canonical: true, created: true, reservation_digest: childReserved.reservation.reservation_digest,
          active_source: childReserved.active_source, event: childReserved.event,
        },
        created: false, idempotent: true, request_code: "IDEMPOTENT_CONTINUITY_RECOVERY",
      };
      this.#saveRequest(db, ledgerRequestId, "CONTINUITY_RECOVERY", validated.payload_digest, result);
      return Object.freeze(result);
    }
    const latest = db.prepare("SELECT handoff_id,reservation_digest FROM handoff_reservations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(failed.task_id) ?? null;
    invariant(latest?.handoff_id === value.expected_latest.handoff_id
      && latest.reservation_digest === value.expected_latest.reservation_digest
      && latest.handoff_id === value.failed_handoff_id,
    "HANDOFF_LATEST_RESERVATION_STALE", "Failed handoff is no longer the exact protected task owner");
    const binding = this.#lifecycleBindingRow(db, value.failed_handoff_id);
    invariant(binding?.status === "ACTIVE" && sameLifecycleBindingIdentity(binding, value.binding), "LIFECYCLE_BINDING_STALE");
    const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.latch.task_id);
    if (latch?.reason === "HUMAN_TAKEOVER") throw new GuardianError("HUMAN_TAKEOVER_ACTIVE");
    invariant(latch?.state === value.latch.state && latch.generation === value.latch.generation && latch.reason === value.latch.reason
      && latch.generation === failed.latch_generation, "LATCH_GENERATION_MISMATCH");
    const plan = this.#planAuthorityRow(db, value.failed_handoff_id);
    invariant(plan?.plan_semantic_digest === value.plan_semantic_digest
      && value.child_projection.task_plan_revision === plan.plan_revision_id
      && value.child_projection.task_plan_digest === plan.plan_content_digest
      && canonicalJson(value.child_projection.reserved_plan_snapshot) === plan.snapshot_json,
    "CONTINUITY_RECOVERY_SOURCE_INVALID", "Recovery child plan does not equal protected failed plan authority");
    invariant(sameProtectedGit(value.git, failed.expected_git_state),
      "GIT_STATE_MISMATCH", "Final recovery Git attestation differs from the protected failed subject");
    invariant(sameProtectedGit(value.child_projection.expected_git_state, failed.expected_git_state),
      "GIT_STATE_MISMATCH", "Recovery child Git provenance differs from the protected failed subject");
    invariant(value.model_policy === failed.model_policy && value.reasoning_policy === failed.reasoning_policy
      && value.child_projection.model_policy === failed.model_policy && value.child_projection.reasoning_policy === failed.reasoning_policy,
    "MODEL_POLICY_MISMATCH", "Recovery model/reasoning provenance changed after final attestation");
    invariant(value.child_projection.parent_checkpoint_id === failed.checkpoint_id,
      "CONTINUITY_RECOVERY_SOURCE_INVALID", "Recovery parent checkpoint changed after final attestation");
    const checkpoint = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='checkpoint' AND artifact_id=?").get(value.checkpoint.id);
    const manifest = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='manifest' AND artifact_id=?").get(value.manifest.id);
    invariant(checkpoint?.handoff_id === value.failed_handoff_id && checkpoint.artifact_digest === value.checkpoint.digest
      && checkpoint.content_digest === value.checkpoint.content_digest
      && manifest?.handoff_id === value.failed_handoff_id && manifest.artifact_digest === value.manifest.digest
      && manifest.content_digest === value.manifest.content_digest
      && failed.checkpoint_id === value.checkpoint.id && failed.resume_manifest_id === value.manifest.id,
    "CONTINUITY_RECOVERY_SOURCE_INVALID", "Recovery artifacts changed after final attestation");
    invariant(!this.#resumeReadinessRow(db, value.failed_handoff_id)
      && !db.prepare("SELECT 1 present FROM resume_authorizations WHERE handoff_id=?").get(value.failed_handoff_id)
      && !db.prepare("SELECT 1 present FROM resume_admissions WHERE handoff_id=?").get(value.failed_handoff_id)
      && !db.prepare("SELECT 1 present FROM resume_dispatch_attempts WHERE handoff_id=?").get(value.failed_handoff_id),
    "CONTINUITY_RECOVERY_UNSAFE");
    invariant(!db.prepare("SELECT 1 present FROM active_sources WHERE source_session_id=?").get(value.source.session_id)
      && !db.prepare("SELECT 1 present FROM handoff_reservations WHERE source_session_id=?").get(value.source.session_id)
      && !db.prepare("SELECT 1 present FROM lifecycle_bindings WHERE replacement_session_id=?").get(value.source.session_id),
    "CONTINUITY_RECOVERY_SOURCE_INVALID", "Recovery source already participates in protected lifecycle authority");

    const now = utcNow();
    db.prepare(`INSERT INTO continuity_recovery_decisions(
      decision_id,failed_handoff_id,failure_digest,recovery_handoff_id,source_session_id,source_runner_instance_id,
      source_lifecycle_incarnation,actor,attestation_digest,request_digest,started_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      value.decision_id, value.failed_handoff_id, value.failure_digest, value.child_projection.handoff_id,
      value.source.session_id, value.source.runner_instance_id, value.source.lifecycle_incarnation,
      value.actor, validated.attestation_digest, validated.payload_digest, now,
    );
    if (crashSeam === "after_decision") process.exit(104);
    const bindingEventId = opaqueId("BEV");
    const reason = `explicit continuity recovery by ${value.actor}`;
    const changed = db.prepare("UPDATE lifecycle_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=?,supersede_event_id=? WHERE handoff_id=? AND status='ACTIVE' AND lifecycle_incarnation=?")
      .run(now, reason, bindingEventId, value.failed_handoff_id, value.binding.lifecycle_incarnation);
    invariant(changed.changes === 1, "CONTINUITY_RECOVERY_UNSAFE", "Failed binding supersession raced");
    db.prepare(`INSERT INTO lifecycle_binding_events(
      event_id,request_id,handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,event_type,from_status,status,reason,occurred_at
    ) VALUES(?,?,?,?,?,?,?,'RUNNER_SESSION_BINDING_SUPERSEDED','ACTIVE','SUPERSEDED',?,?)`).run(
      bindingEventId, `recovery-binding:${value.decision_id}`, value.failed_handoff_id, value.binding.replacement_session_id,
      value.binding.runner_instance_id, value.binding.session_binding_id, value.binding.lifecycle_incarnation, reason, now,
    );
    if (crashSeam === "after_binding") process.exit(105);
    const recoveryEventId = opaqueId("RCEV");
    db.prepare(`INSERT INTO continuity_recovery_events(
      event_id,request_id,failed_handoff_id,recovery_handoff_id,event_type,occurred_at,data_json
    ) VALUES(?,?,?,?,?,?,?)`).run(
      recoveryEventId, ledgerRequestId, value.failed_handoff_id, value.child_projection.handoff_id,
      "CONTINUITY_RECOVERY_STARTED", now, JSON.stringify({
        decision_id: value.decision_id, failed_target_session_id: value.binding.replacement_session_id,
        failed_runner_instance_id: value.binding.runner_instance_id, current_source_session_id: value.source.session_id,
        current_runner_instance_id: value.source.runner_instance_id, actor: value.actor,
      }),
    );
    if (crashSeam === "after_recovery_event") process.exit(106);
    const childValue = { projection: value.child_projection, expectedLatch: value.latch, expectedLatest: value.expected_latest };
    const childReserved = this.#reserveHandoffInTransaction(db, childValue, `recovery-child:${value.decision_id}`, validated.child_reservation_digest, {
      recoveryFailure: failure, crashSeam,
    });
    if (crashSeam === "before_commit") process.exit(108);
    const result = {
      recovery: this.#continuityRecoveryState(db, value.failed_handoff_id),
      child_projection_proof: {
        canonical: true, created: childReserved.created, reservation_digest: childReserved.reservation.reservation_digest,
        active_source: childReserved.active_source, event: childReserved.event,
      },
      created: true, idempotent: false, request_code: "MUTATION_ACCEPTED",
    };
    this.#saveRequest(db, ledgerRequestId, "CONTINUITY_RECOVERY", validated.payload_digest, result);
    return Object.freeze(result);
  }

  requestContinuityRecovery(requestId, request) {
    operationIdentifier(requestId, "RECOVERY_REQUEST_ID_INVALID", "requestId");
    const validated = validateContinuityRecovery(request);
    return this.#transaction((db) => this.#recoverContinuityInTransaction(db, requestId, validated));
  }

  getContinuityRecovery(handoffId) {
    operationIdentifier(handoffId, "RECOVERY_HANDOFF_INVALID", "handoffId");
    return this.#continuityRecoveryState(this.#database(), handoffId);
  }

  continuityRecoveryEvents(handoffId) {
    operationIdentifier(handoffId, "RECOVERY_HANDOFF_INVALID", "handoffId");
    return Object.freeze(this.#database().prepare("SELECT * FROM continuity_recovery_events WHERE failed_handoff_id=? ORDER BY sequence").all(handoffId)
      .map((row) => Object.freeze({ ...row, data: JSON.parse(row.data_json) })));
  }

  #dispatchReconciliation(dispatch) {
    if (!dispatch) return null;
    const evidenceClass = dispatch.state === "ACKNOWLEDGED" || dispatch.state === "DISPATCHED" ? "KNOWN_SUCCESS"
      : dispatch.state === "FAILED" ? "KNOWN_FAILURE" : "STILL_UNKNOWN";
    return Object.freeze({
      dispatch_attempt_id: dispatch.dispatch_attempt_id,
      handoff_id: dispatch.handoff_id,
      protected_state: dispatch.state,
      evidence_class: evidenceClass,
      evidence_authority: evidenceClass === "STILL_UNKNOWN"
        ? "PROTECTED_INTENT_WITHOUT_INDEPENDENT_EXTERNAL_EFFECT_EVIDENCE"
        : "PROTECTED_TRUSTED_WORKFLOW_OUTCOME",
      retry_permitted: false,
      requires_human_or_external_evidence: evidenceClass === "STILL_UNKNOWN",
      disposition: evidenceClass === "STILL_UNKNOWN" ? "FAIL_CLOSED_NO_REPLAY" : "TERMINAL_NO_REPLAY",
    });
  }

  inspectDispatchReconciliation(handoffId) {
    operationIdentifier(handoffId, "RECOVERY_HANDOFF_INVALID", "handoffId");
    const dispatch = this.#database().prepare("SELECT * FROM resume_dispatch_attempts WHERE handoff_id=?").get(handoffId) ?? null;
    return this.#dispatchReconciliation(dispatch);
  }

  #lifecycleBindingRow(db, handoffId) {
    return db.prepare("SELECT * FROM lifecycle_bindings WHERE handoff_id=?").get(handoffId) ?? null;
  }

  #detachedLifecycleBinding(db, row) {
    if (!row) return null;
    const event = db.prepare("SELECT event_type,reason AS event_reason,occurred_at FROM lifecycle_binding_events WHERE event_id=? AND handoff_id=?")
      .get(row.bind_event_id, row.handoff_id);
    invariant(event?.event_type === "RUNNER_SESSION_BOUND", "LIFECYCLE_BINDING_EVENT_MISMATCH");
    return detachedLifecycleBinding(row, { event_data: {
      handoff_id: row.handoff_id,
      replacement_session_id: row.replacement_session_id,
      runner_instance_id: row.runner_instance_id,
      session_binding_id: row.session_binding_id,
      lifecycle_incarnation: row.lifecycle_incarnation,
    } });
  }

  requestLifecycleBindingCreate(requestId, request) {
    operationIdentifier(requestId, "LIFECYCLE_REQUEST_ID_INVALID", "requestId");
    const value = validateLifecycleBindingCreate(request);
    const ledgerRequestId = `lifecycle-bind:${requestId}`;
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, ledgerRequestId, "LIFECYCLE_BIND", value.payload_digest, "LIFECYCLE_REQUEST_CONFLICT");
      if (recorded) return Object.freeze({ ...recorded, binding: this.getLifecycleBinding(value.binding.handoff_id) });
      const reservation = this.#reservationRow(db, value.binding.handoff_id);
      invariant(reservation, "LIFECYCLE_RESERVATION_NOT_FOUND", "A protected binding requires an existing canonical reservation");
      const projection = JSON.parse(reservation.projection_json);
      invariant(reservation.runner_instance_id === value.binding.runner_instance_id
        && projection.session_binding_id === value.binding.session_binding_id,
      "LIFECYCLE_RESERVATION_MISMATCH", "Binding identity does not match its protected reservation");
      const prior = this.#lifecycleBindingRow(db, value.binding.handoff_id);
      if (prior) {
        invariant(prior.status === "ACTIVE" && sameLifecycleBindingIdentity(prior, value.binding),
          "LIFECYCLE_BINDING_CONFLICT", "The protected handoff already binds a different lifecycle identity");
        const result = { binding: this.#detachedLifecycleBinding(db, prior), created: false, idempotent: true, request_code: "IDEMPOTENT_LIFECYCLE_BINDING" };
        this.#saveRequest(db, ledgerRequestId, "LIFECYCLE_BIND", value.payload_digest, result);
        return Object.freeze(result);
      }
      const sessionConflict = db.prepare("SELECT handoff_id FROM lifecycle_bindings WHERE replacement_session_id=? OR session_binding_id=? LIMIT 1")
        .get(value.binding.replacement_session_id, value.binding.session_binding_id);
      invariant(!sessionConflict, "LIFECYCLE_BINDING_CONFLICT", "Session or binding identity is already canonical for another handoff");
      const eventId = opaqueId("BEV");
      const occurredAt = utcNow();
      db.prepare(`INSERT INTO lifecycle_bindings(
        handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,status,bound_at,bind_event_id
      ) VALUES(?,?,?,?,?,'ACTIVE',?,?)`).run(
        value.binding.handoff_id, value.binding.replacement_session_id, value.binding.runner_instance_id,
        value.binding.session_binding_id, value.binding.lifecycle_incarnation, occurredAt, eventId,
      );
      db.prepare(`INSERT INTO lifecycle_binding_events(
        event_id,request_id,handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,event_type,from_status,status,reason,occurred_at
      ) VALUES(?,?,?,?,?,?,?,'RUNNER_SESSION_BOUND',NULL,'ACTIVE',NULL,?)`).run(
        eventId, ledgerRequestId, value.binding.handoff_id, value.binding.replacement_session_id,
        value.binding.runner_instance_id, value.binding.session_binding_id, value.binding.lifecycle_incarnation, occurredAt,
      );
      const result = { binding: this.#detachedLifecycleBinding(db, this.#lifecycleBindingRow(db, value.binding.handoff_id)), created: true, idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, ledgerRequestId, "LIFECYCLE_BIND", value.payload_digest, result);
      return Object.freeze(result);
    });
  }

  requestLifecycleBindingTransition(requestId, request) {
    operationIdentifier(requestId, "LIFECYCLE_REQUEST_ID_INVALID", "requestId");
    const value = validateLifecycleBindingTransition(request);
    const ledgerRequestId = `lifecycle-transition:${requestId}`;
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, ledgerRequestId, "LIFECYCLE_TRANSITION", value.payload_digest, "LIFECYCLE_REQUEST_CONFLICT");
      if (recorded) return Object.freeze({ ...recorded, binding: this.getLifecycleBinding(value.expected.handoff_id) });
      const prior = this.#lifecycleBindingRow(db, value.expected.handoff_id);
      invariant(prior && sameLifecycleBindingIdentity(prior, value.expected),
        "LIFECYCLE_BINDING_STALE", "Expected protected lifecycle identity is stale or absent");
      if (prior.status === "SUPERSEDED") {
        invariant(prior.superseded_reason === value.reason, "LIFECYCLE_TRANSITION_CONFLICT", "Protected lifecycle already has different terminal provenance");
        const result = { binding: this.#detachedLifecycleBinding(db, prior), transitioned: false, idempotent: true, request_code: "IDEMPOTENT_LIFECYCLE_TRANSITION" };
        this.#saveRequest(db, ledgerRequestId, "LIFECYCLE_TRANSITION", value.payload_digest, result);
        return Object.freeze(result);
      }
      invariant(prior.status === "ACTIVE", "LIFECYCLE_TRANSITION_INVALID");
      const eventId = opaqueId("BEV");
      const occurredAt = utcNow();
      const changed = db.prepare("UPDATE lifecycle_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=?,supersede_event_id=? WHERE handoff_id=? AND status='ACTIVE' AND lifecycle_incarnation=?")
        .run(occurredAt, value.reason, eventId, prior.handoff_id, prior.lifecycle_incarnation);
      invariant(changed.changes === 1, "LIFECYCLE_BINDING_STALE", "Protected lifecycle transition raced");
      db.prepare(`INSERT INTO lifecycle_binding_events(
        event_id,request_id,handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,event_type,from_status,status,reason,occurred_at
      ) VALUES(?,?,?,?,?,?,?,'RUNNER_SESSION_BINDING_SUPERSEDED','ACTIVE','SUPERSEDED',?,?)`).run(
        eventId, ledgerRequestId, prior.handoff_id, prior.replacement_session_id, prior.runner_instance_id,
        prior.session_binding_id, prior.lifecycle_incarnation, value.reason, occurredAt,
      );
      const result = { binding: this.#detachedLifecycleBinding(db, this.#lifecycleBindingRow(db, prior.handoff_id)), transitioned: true, idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, ledgerRequestId, "LIFECYCLE_TRANSITION", value.payload_digest, result);
      return Object.freeze(result);
    });
  }

  getLifecycleBinding(handoffId) {
    operationIdentifier(handoffId, "LIFECYCLE_HANDOFF_INVALID", "handoffId");
    return this.#detachedLifecycleBinding(this.#database(), this.#lifecycleBindingRow(this.#database(), handoffId));
  }

  getLifecycleBindingBySession(sessionId) {
    operationIdentifier(sessionId, "LIFECYCLE_SESSION_INVALID", "sessionId");
    const db = this.#database();
    return this.#detachedLifecycleBinding(db, db.prepare("SELECT * FROM lifecycle_bindings WHERE replacement_session_id=? ORDER BY bound_at DESC LIMIT 1").get(sessionId) ?? null);
  }

  lifecycleBindingEvents(handoffId) {
    operationIdentifier(handoffId, "LIFECYCLE_HANDOFF_INVALID", "handoffId");
    return Object.freeze(this.#database().prepare("SELECT * FROM lifecycle_binding_events WHERE handoff_id=? ORDER BY sequence").all(handoffId).map((row) => Object.freeze({ ...row })));
  }

  #resumeReadinessRow(db, handoffId) {
    return db.prepare("SELECT * FROM resume_readiness WHERE handoff_id=?").get(handoffId) ?? null;
  }

  #resumeState(db, handoffId) {
    return detachedResumeState({
      readiness: this.#resumeReadinessRow(db, handoffId),
      authorization: db.prepare("SELECT * FROM resume_authorizations WHERE handoff_id=?").get(handoffId) ?? null,
      admission: db.prepare("SELECT * FROM resume_admissions WHERE handoff_id=?").get(handoffId) ?? null,
      dispatch: db.prepare("SELECT * FROM resume_dispatch_attempts WHERE handoff_id=?").get(handoffId) ?? null,
    });
  }

  #resumeEvent(db, requestId, handoffId, eventType, occurredAt, data) {
    db.prepare("INSERT INTO resume_authority_events(event_id,request_id,handoff_id,event_type,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
      .run(opaqueId("REV"), requestId, handoffId, eventType, occurredAt, JSON.stringify(data));
  }

  requestResumeReadiness(requestId, request) {
    operationIdentifier(requestId, "RESUME_REQUEST_ID_INVALID", "requestId");
    const validated = validateResumeReadiness(request);
    const value = validated.value;
    const ledgerRequestId = `resume-ready:${requestId}`;
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, ledgerRequestId, "RESUME_READY", validated.payload_digest, "RESUME_REQUEST_CONFLICT");
      if (recorded) return Object.freeze({ ...recorded, readiness: detachedResumeReadiness(this.#resumeReadinessRow(db, value.handoff_id)) });
      const reservation = this.#reservationRow(db, value.handoff_id);
      invariant(reservation && reservation.reservation_digest === value.reservation_digest,
        "RESUME_RESERVATION_STALE", "Resume readiness does not match the protected reservation");
      const projection = JSON.parse(reservation.projection_json);
      invariant(reservation.task_id === value.latch.task_id
        && reservation.runner_instance_id === value.binding.runner_instance_id
        && projection.session_binding_id === value.binding.session_binding_id,
      "RESUME_RESERVATION_STALE", "Resume readiness identity conflicts with protected reservation provenance");
      const plan = this.#planAuthorityRow(db, value.handoff_id);
      const checkpoint = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='checkpoint' AND artifact_id=?").get(reservation.checkpoint_id);
      const manifest = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='manifest' AND artifact_id=?").get(reservation.resume_manifest_id);
      invariant(plan?.plan_semantic_digest === value.plan_semantic_digest
        && checkpoint?.handoff_id === value.handoff_id && checkpoint.artifact_digest === value.checkpoint_digest
        && manifest?.handoff_id === value.handoff_id && manifest.artifact_digest === value.resume_manifest_digest
        && checkpoint.snapshot_id === plan.snapshot_id && manifest.snapshot_id === plan.snapshot_id
        && manifest.checkpoint_id === checkpoint.artifact_id && manifest.checkpoint_digest === checkpoint.artifact_digest,
      "RESUME_RECOVERY_INPUT_STALE", "Resume readiness requires authentic protected plan/checkpoint/manifest relationships");
      const binding = this.#lifecycleBindingRow(db, value.handoff_id);
      invariant(binding?.status === "ACTIVE" && sameLifecycleBindingIdentity(binding, value.binding),
        "LIFECYCLE_BINDING_STALE", "Resume readiness requires the exact protected ACTIVE lifecycle binding");
      const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.latch.task_id);
      if (latch?.reason === "HUMAN_TAKEOVER") throw new GuardianError("HUMAN_TAKEOVER_ACTIVE");
      invariant(latch?.state === value.latch.state && latch.generation === value.latch.generation && latch.reason === value.latch.reason
        && latch.generation === reservation.latch_generation,
      "LATCH_GENERATION_MISMATCH", "Resume readiness used stale protected latch authority");
      const prior = this.#resumeReadinessRow(db, value.handoff_id);
      if (prior) {
        invariant(prior.readiness_digest === validated.payload_digest, "RESUME_READINESS_CONFLICT");
        const result = { readiness: detachedResumeReadiness(prior), created: false, idempotent: true, request_code: "IDEMPOTENT_RESUME_READY" };
        this.#saveRequest(db, ledgerRequestId, "RESUME_READY", validated.payload_digest, result);
        return Object.freeze(result);
      }
      const now = utcNow();
      db.prepare(`INSERT INTO resume_readiness(
        handoff_id,reservation_digest,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,
        latch_generation,latch_reason,checkpoint_digest,resume_manifest_digest,resume_prompt_id,resume_prompt_digest,
        resume_prompt,plan_semantic_digest,readiness_digest,ready_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.handoff_id, value.reservation_digest, value.binding.replacement_session_id, value.binding.runner_instance_id,
        value.binding.session_binding_id, value.binding.lifecycle_incarnation, value.latch.generation, value.latch.reason,
        value.checkpoint_digest, value.resume_manifest_digest, value.resume_prompt_id, value.resume_prompt_digest,
        value.resume_prompt, value.plan_semantic_digest, validated.payload_digest, now,
      );
      this.#resumeEvent(db, ledgerRequestId, value.handoff_id, "RESUME_READY", now, {
        resume_prompt_id: value.resume_prompt_id, readiness_digest: validated.payload_digest,
      });
      const result = { readiness: detachedResumeReadiness(this.#resumeReadinessRow(db, value.handoff_id)), created: true, idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, ledgerRequestId, "RESUME_READY", validated.payload_digest, result);
      return Object.freeze(result);
    });
  }

  requestResumeDecision(requestId, request) {
    operationIdentifier(requestId, "RESUME_REQUEST_ID_INVALID", "requestId");
    const validated = validateResumeDecision(request);
    const value = validated.value;
    const ledgerRequestId = `resume-decision:${requestId}`;
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, ledgerRequestId, "RESUME_DECISION", validated.payload_digest, "RESUME_DECISION_CONFLICT");
      if (recorded) return Object.freeze({ ...recorded, dispatch_permit: false, state: this.#resumeState(db, value.handoff_id) });
      const readiness = this.#resumeReadinessRow(db, value.handoff_id);
      invariant(readiness && readiness.readiness_digest === value.readiness_digest
        && readiness.resume_prompt_id === value.resume_prompt_id,
      "RESUME_READINESS_STALE", "The protected resume readiness identity changed");
      if (value.answer === "NO") {
        invariant(!db.prepare("SELECT 1 present FROM resume_authorizations WHERE handoff_id=?").get(value.handoff_id),
          "RESUME_ALREADY_ADMITTED_CONFLICT", "A later NO cannot revoke an already committed protected YES");
        const result = { answer: "NO", authorized: false, admitted: false, dispatch_permit: false, state: this.#resumeState(db, value.handoff_id), idempotent: false, request_code: "RESUME_DECLINED" };
        this.#saveRequest(db, ledgerRequestId, "RESUME_DECISION", validated.payload_digest, result);
        return Object.freeze(result);
      }

      const priorAuthorization = db.prepare("SELECT * FROM resume_authorizations WHERE handoff_id=? OR authorization_id=? OR resume_prompt_id=? LIMIT 1")
        .get(value.handoff_id, value.authorization_id, value.resume_prompt_id);
      const priorAdmission = db.prepare("SELECT * FROM resume_admissions WHERE handoff_id=? OR admission_id=? OR resume_prompt_id=? OR idempotency_key=? LIMIT 1")
        .get(value.handoff_id, value.admission_id, value.resume_prompt_id, value.idempotency_key);
      const priorDispatch = db.prepare("SELECT * FROM resume_dispatch_attempts WHERE handoff_id=? OR dispatch_attempt_id=? LIMIT 1")
        .get(value.handoff_id, value.dispatch_attempt_id);
      if (priorAuthorization || priorAdmission || priorDispatch) {
        invariant(priorAuthorization?.authorization_id === value.authorization_id
          && priorAuthorization.actor === value.actor
          && priorAuthorization.readiness_digest === value.readiness_digest
          && priorAdmission?.admission_id === value.admission_id
          && priorAdmission.authorization_id === value.authorization_id
          && priorAdmission.idempotency_key === value.idempotency_key
          && priorDispatch?.dispatch_attempt_id === value.dispatch_attempt_id
          && priorDispatch.admission_id === value.admission_id,
        "RESUME_ALREADY_ADMITTED_CONFLICT", "The protected handoff already binds a different resume decision");
        const result = { answer: "YES", authorized: true, admitted: true, dispatch_permit: false, state: this.#resumeState(db, value.handoff_id), idempotent: true, request_code: "IDEMPOTENT_RESUME_ADMISSION" };
        this.#saveRequest(db, ledgerRequestId, "RESUME_DECISION", validated.payload_digest, result);
        return Object.freeze(result);
      }

      const binding = this.#lifecycleBindingRow(db, value.handoff_id);
      invariant(binding?.status === "ACTIVE" && sameLifecycleBindingIdentity(binding, value.binding)
        && binding.lifecycle_incarnation === readiness.lifecycle_incarnation,
      "LIFECYCLE_BINDING_STALE", "Protected lifecycle changed before resume admission and dispatch intent");
      const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.latch.task_id);
      if (latch?.reason === "HUMAN_TAKEOVER") throw new GuardianError("HUMAN_TAKEOVER_ACTIVE");
      invariant(latch?.state === "ENGAGED" && latch.generation === value.latch.generation
        && latch.reason === value.latch.reason && latch.generation === readiness.latch_generation,
      "LATCH_GENERATION_MISMATCH", "Protected latch changed before resume admission and dispatch intent");

      const now = utcNow();
      const releasedGeneration = latch.generation + 1;
      const releaseEventId = opaqueId("REV");
      const changed = db.prepare(`UPDATE latches SET state='RELEASED',generation=?,reason=NULL,released_at=?,released_by=?,last_event_id=?
        WHERE task_id=? AND state='ENGAGED' AND generation=? AND reason=?`)
        .run(releasedGeneration, now, value.actor, releaseEventId, value.latch.task_id, latch.generation, latch.reason);
      invariant(changed.changes === 1, "LATCH_GENERATION_MISMATCH", "Protected latch release raced resume admission");
      db.prepare("INSERT INTO resume_authority_events(event_id,request_id,handoff_id,event_type,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
        .run(releaseEventId, ledgerRequestId, value.handoff_id, "LATCH_RELEASED", now, JSON.stringify({ task_id: value.latch.task_id, from_generation: latch.generation, generation: releasedGeneration, actor: value.actor }));
      db.prepare(`INSERT INTO resume_authorizations(
        authorization_id,handoff_id,resume_prompt_id,actor,readiness_digest,engaged_latch_generation,released_latch_generation,authorized_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        value.authorization_id, value.handoff_id, value.resume_prompt_id, value.actor, value.readiness_digest,
        latch.generation, releasedGeneration, now,
      );
      db.prepare(`INSERT INTO resume_admissions(
        admission_id,authorization_id,handoff_id,resume_prompt_id,idempotency_key,committed_at
      ) VALUES(?,?,?,?,?,?)`).run(
        value.admission_id, value.authorization_id, value.handoff_id, value.resume_prompt_id, value.idempotency_key, now,
      );
      db.prepare(`INSERT INTO resume_dispatch_attempts(
        dispatch_attempt_id,admission_id,handoff_id,attempt_no,state,intent_at
      ) VALUES(?,?,?,?,?,?)`).run(
        value.dispatch_attempt_id, value.admission_id, value.handoff_id, value.attempt_no, "DISPATCHING", now,
      );
      this.#resumeEvent(db, ledgerRequestId, value.handoff_id, "RESUME_AUTHORIZED", now, { authorization_id: value.authorization_id, resume_prompt_id: value.resume_prompt_id, actor: value.actor });
      this.#resumeEvent(db, ledgerRequestId, value.handoff_id, "RESUME_ADMISSION_COMMITTED", now, { authorization_id: value.authorization_id, admission_id: value.admission_id, idempotency_key: value.idempotency_key });
      this.#resumeEvent(db, ledgerRequestId, value.handoff_id, "RESUME_DISPATCH_INTENT", now, { admission_id: value.admission_id, dispatch_attempt_id: value.dispatch_attempt_id, attempt_no: 1 });
      const result = { answer: "YES", authorized: true, admitted: true, dispatch_permit: true, state: this.#resumeState(db, value.handoff_id), idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, ledgerRequestId, "RESUME_DECISION", validated.payload_digest, result);
      return Object.freeze(result);
    });
  }

  requestResumeDispatchOutcome(requestId, request) {
    operationIdentifier(requestId, "RESUME_REQUEST_ID_INVALID", "requestId");
    const validated = validateResumeDispatchOutcome(request);
    const value = validated.value;
    const ledgerRequestId = `resume-outcome:${requestId}`;
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, ledgerRequestId, "RESUME_DISPATCH_OUTCOME", validated.payload_digest, "RESUME_DISPATCH_OUTCOME_CONFLICT");
      if (recorded) return Object.freeze({ ...recorded, state: this.#resumeState(db, recorded.handoff_id) });
      const attempt = db.prepare("SELECT * FROM resume_dispatch_attempts WHERE dispatch_attempt_id=?").get(value.dispatch_attempt_id);
      invariant(attempt, "RESUME_DISPATCH_INTENT_REQUIRED");
      if (attempt.state !== "DISPATCHING") {
        invariant(attempt.state === value.outcome && (attempt.error ?? null) === value.error,
          "RESUME_DISPATCH_OUTCOME_CONFLICT", "Dispatch attempt already has a different terminal outcome");
        const result = { handoff_id: attempt.handoff_id, outcome: attempt.state, state: this.#resumeState(db, attempt.handoff_id), idempotent: true, request_code: "IDEMPOTENT_DISPATCH_OUTCOME" };
        this.#saveRequest(db, ledgerRequestId, "RESUME_DISPATCH_OUTCOME", validated.payload_digest, result);
        return Object.freeze(result);
      }
      const now = utcNow();
      const changed = db.prepare("UPDATE resume_dispatch_attempts SET state=?,outcome_at=?,error=? WHERE dispatch_attempt_id=? AND state='DISPATCHING'")
        .run(value.outcome, now, value.error, value.dispatch_attempt_id);
      invariant(changed.changes === 1, "RESUME_DISPATCH_OUTCOME_CONFLICT");
      if (value.outcome === "ACKNOWLEDGED") {
        this.#resumeEvent(db, ledgerRequestId, attempt.handoff_id, "RESUME_DISPATCHED", now, { dispatch_attempt_id: value.dispatch_attempt_id });
        this.#resumeEvent(db, ledgerRequestId, attempt.handoff_id, "RESUME_ACKNOWLEDGED", now, { dispatch_attempt_id: value.dispatch_attempt_id });
      } else {
        const eventType = value.outcome === "UNKNOWN" ? "RESUME_DISPATCH_UNKNOWN" : value.outcome === "FAILED" ? "RESUME_FAILED" : "RESUME_DISPATCHED";
        this.#resumeEvent(db, ledgerRequestId, attempt.handoff_id, eventType, now, { dispatch_attempt_id: value.dispatch_attempt_id, error: value.error });
      }
      const result = { handoff_id: attempt.handoff_id, outcome: value.outcome, state: this.#resumeState(db, attempt.handoff_id), idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, ledgerRequestId, "RESUME_DISPATCH_OUTCOME", validated.payload_digest, result);
      return Object.freeze(result);
    });
  }

  getResumeReadiness(handoffId) {
    operationIdentifier(handoffId, "RESUME_HANDOFF_INVALID", "handoffId");
    return detachedResumeReadiness(this.#resumeReadinessRow(this.#database(), handoffId));
  }

  getResumeState(handoffId) {
    operationIdentifier(handoffId, "RESUME_HANDOFF_INVALID", "handoffId");
    return this.#resumeState(this.#database(), handoffId);
  }

  resumeAuthorityEvents(handoffId) {
    operationIdentifier(handoffId, "RESUME_HANDOFF_INVALID", "handoffId");
    return Object.freeze(this.#database().prepare("SELECT * FROM resume_authority_events WHERE handoff_id=? ORDER BY sequence").all(handoffId).map((row) => Object.freeze({ ...row, data: JSON.parse(row.data_json) })));
  }

  admitOperation(request) {
    const value = validateOperationAdmission(request);
    const requestId = `admit:${value.operationId}`;
    const payloadDigest = sha256(Buffer.from(canonicalJson(value), "utf8"));
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, requestId, "OPERATION_ADMIT", payloadDigest);
      if (recorded) return recorded;
      const prior = db.prepare("SELECT * FROM operations WHERE operation_id=?").get(value.operationId);
      if (prior) {
        invariant(prior.admission_digest === payloadDigest, "OPERATION_ID_CONFLICT", "Operation identity already binds different admission payload");
        const result = { operation: prior, idempotent: true, request_code: "IDEMPOTENT_OPERATION" };
        this.#saveRequest(db, requestId, "OPERATION_ADMIT", payloadDigest, result);
        return Object.freeze(result);
      }
      const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.taskId);
      invariant(latch, "SECURE_LATCH_MISSING", "Protected operation admission requires an initialized canonical latch");
      if (latch.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
        throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover committed before operation admission");
      }
      invariant(latch.state === "RELEASED", "TOOL_ADMISSION_BLOCKED", "Canonical latch is engaged");
      invariant(latch.generation === value.generation, "LATCH_GENERATION_MISMATCH", "Operation admission used a stale canonical latch generation", { expected: value.generation, observed: latch.generation });
      const admittedAt = utcNow();
      db.prepare("INSERT INTO operations(operation_id,task_id,latch_generation,profile,state,admitted_at,admission_digest) VALUES(?,?,?,?,?,?,?)")
        .run(value.operationId, value.taskId, value.generation, value.profile, "ACTIVE", admittedAt, payloadDigest);
      const result = { operation: db.prepare("SELECT * FROM operations WHERE operation_id=?").get(value.operationId), idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, requestId, "OPERATION_ADMIT", payloadDigest, result);
      return Object.freeze(result);
    });
  }

  finishOperation(operationId, outcome, effectReference = null) {
    const value = validateOperationTerminal(operationId, outcome, effectReference);
    const requestId = `terminal:${value.operationId}`;
    const payloadDigest = sha256(Buffer.from(canonicalJson(value), "utf8"));
    return this.#transaction((db) => {
      const recorded = this.#recordedRequest(db, requestId, "OPERATION_TERMINAL", payloadDigest);
      if (recorded) return recorded;
      const prior = db.prepare("SELECT * FROM operations WHERE operation_id=?").get(value.operationId);
      invariant(prior, "OPERATION_NOT_FOUND", "A terminal outcome requires an admitted protected operation");
      if (prior.state === "TERMINAL") {
        invariant(prior.terminal_digest === payloadDigest, "OPERATION_TERMINAL_CONFLICT", "Terminal operation already binds a different outcome");
        const result = { operation: prior, idempotent: true, request_code: "IDEMPOTENT_OPERATION" };
        this.#saveRequest(db, requestId, "OPERATION_TERMINAL", payloadDigest, result);
        return Object.freeze(result);
      }
      const terminalAt = utcNow();
      const changed = db.prepare("UPDATE operations SET state='TERMINAL',outcome=?,effect_reference=?,terminal_at=?,terminal_digest=? WHERE operation_id=? AND state='ACTIVE'")
        .run(value.outcome, value.effectReference, terminalAt, payloadDigest, value.operationId);
      invariant(changed.changes === 1, "OPERATION_TERMINAL_CONFLICT");
      const result = { operation: db.prepare("SELECT * FROM operations WHERE operation_id=?").get(value.operationId), idempotent: false, request_code: "MUTATION_ACCEPTED" };
      this.#saveRequest(db, requestId, "OPERATION_TERMINAL", payloadDigest, result);
      return Object.freeze(result);
    });
  }

  getOperation(operationId) {
    operationIdentifier(operationId, "OPERATION_ID_INVALID", "operationId");
    return detachedOperation(this.#database().prepare("SELECT * FROM operations WHERE operation_id=?").get(operationId));
  }

  operationsForTask(taskId) {
    operationIdentifier(taskId, "OPERATION_TASK_INVALID", "taskId");
    return Object.freeze(this.#database().prepare("SELECT * FROM operations WHERE task_id=? ORDER BY admitted_at,operation_id").all(taskId).map(detachedOperation));
  }

  status() {
    const metadata = this.#database().prepare("SELECT * FROM authority_metadata WHERE singleton=1").get();
    const journal = this.#database().prepare("PRAGMA journal_mode").get();
    return Object.freeze({ ...this.security, latch_canonical: true, handoff_reservation_canonical: true, lifecycle_binding_canonical: true, resume_authority_canonical: true, recovery_input_canonical: true, recovery_authority_canonical: true, reconciliation_authority_canonical: true, schema: metadata.schema_version, journal_mode: String(journal.journal_mode).toUpperCase(), path: this.path });
  }

  crashContinuityRecoveryForPhysicalTest(requestId, request, seam) {
    invariant(["after_decision", "after_binding", "after_recovery_event", "after_child_reservation", "before_commit"].includes(seam), "RECOVERY_CRASH_SEAM_INVALID");
    operationIdentifier(requestId, "RECOVERY_REQUEST_ID_INVALID", "requestId");
    const validated = validateContinuityRecovery(request);
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    this.#recoverContinuityInTransaction(db, requestId, validated, { crashSeam: seam });
    process.exit(109);
  }

  crashBeforeArtifactCommitForPhysicalTest(requestId, request) {
    operationIdentifier(requestId, "ARTIFACT_AUTHORITY_REQUEST_INVALID", "requestId");
    const validated = validateArtifactRegistration(request);
    const value = validated.value;
    const db = this.#database(); db.exec("BEGIN IMMEDIATE");
    const reservation = this.#reservationRow(db, value.handoff_id);
    const plan = this.#planAuthorityRow(db, value.handoff_id);
    invariant(reservation && plan?.plan_semantic_digest === value.plan_semantic_digest, "ARTIFACT_AUTHORITY_PLAN_MISMATCH");
    if (value.kind === "manifest") {
      const checkpoint = db.prepare("SELECT * FROM artifact_authority WHERE artifact_kind='checkpoint' AND artifact_id=?").get(value.checkpoint_id);
      invariant(checkpoint?.handoff_id === value.handoff_id && checkpoint.artifact_digest === value.checkpoint_digest,
        "ARTIFACT_AUTHORITY_RELATIONSHIP_MISMATCH");
    }
    db.prepare(`INSERT INTO artifact_authority(
      artifact_kind,artifact_id,handoff_id,snapshot_id,artifact_digest,content_digest,checkpoint_id,checkpoint_digest,relationship_digest,registered_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      value.kind, value.artifact_id, value.handoff_id, plan.snapshot_id, value.artifact_digest,
      value.content_digest, value.checkpoint_id, value.checkpoint_digest, validated.payload_digest, utcNow(),
    );
    process.exit(103);
  }

  crashBeforeResumeAdmissionCommitForPhysicalTest(requestId, request) {
    operationIdentifier(requestId, "RESUME_REQUEST_ID_INVALID", "requestId");
    const value = validateResumeDecision(request).value;
    invariant(value.answer === "YES", "RESUME_CRASH_SEAM_INVALID");
    const db = this.#database(); db.exec("BEGIN IMMEDIATE");
    const readiness = this.#resumeReadinessRow(db, value.handoff_id);
    const binding = this.#lifecycleBindingRow(db, value.handoff_id);
    const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.latch.task_id);
    invariant(readiness?.readiness_digest === value.readiness_digest && binding?.status === "ACTIVE"
      && sameLifecycleBindingIdentity(binding, value.binding) && latch?.state === "ENGAGED"
      && latch.generation === value.latch.generation && latch.reason === value.latch.reason,
    "RESUME_CRASH_SEAM_INVALID");
    const now = utcNow(); const releasedGeneration = latch.generation + 1; const eventId = opaqueId("REV");
    db.prepare("UPDATE latches SET state='RELEASED',generation=?,reason=NULL,released_at=?,released_by=?,last_event_id=? WHERE task_id=?")
      .run(releasedGeneration, now, value.actor, eventId, value.latch.task_id);
    db.prepare("INSERT INTO resume_authorizations(authorization_id,handoff_id,resume_prompt_id,actor,readiness_digest,engaged_latch_generation,released_latch_generation,authorized_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(value.authorization_id, value.handoff_id, value.resume_prompt_id, value.actor, value.readiness_digest, latch.generation, releasedGeneration, now);
    db.prepare("INSERT INTO resume_admissions(admission_id,authorization_id,handoff_id,resume_prompt_id,idempotency_key,committed_at) VALUES(?,?,?,?,?,?)")
      .run(value.admission_id, value.authorization_id, value.handoff_id, value.resume_prompt_id, value.idempotency_key, now);
    db.prepare("INSERT INTO resume_dispatch_attempts(dispatch_attempt_id,admission_id,handoff_id,attempt_no,state,intent_at) VALUES(?,?,?,?,?,?)")
      .run(value.dispatch_attempt_id, value.admission_id, value.handoff_id, 1, "DISPATCHING", now);
    process.exit(101);
  }

  crashBeforeResumeOutcomeCommitForPhysicalTest(requestId, request) {
    operationIdentifier(requestId, "RESUME_REQUEST_ID_INVALID", "requestId");
    const value = validateResumeDispatchOutcome(request).value;
    const db = this.#database(); db.exec("BEGIN IMMEDIATE");
    const attempt = db.prepare("SELECT state FROM resume_dispatch_attempts WHERE dispatch_attempt_id=?").get(value.dispatch_attempt_id);
    invariant(attempt?.state === "DISPATCHING", "RESUME_CRASH_SEAM_INVALID");
    db.prepare("UPDATE resume_dispatch_attempts SET state=?,outcome_at=?,error=? WHERE dispatch_attempt_id=?")
      .run(value.outcome, utcNow(), value.error, value.dispatch_attempt_id);
    process.exit(102);
  }

  crashBeforeTerminalCommitForPhysicalTest(operationId, outcome, effectReference = null) {
    const value = validateOperationTerminal(operationId, outcome, effectReference);
    const payloadDigest = sha256(Buffer.from(canonicalJson(value), "utf8"));
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    const prior = db.prepare("SELECT state FROM operations WHERE operation_id=?").get(value.operationId);
    invariant(prior?.state === "ACTIVE", "OPERATION_CRASH_SEAM_INVALID");
    db.prepare("UPDATE operations SET state='TERMINAL',outcome=?,effect_reference=?,terminal_at=?,terminal_digest=? WHERE operation_id=?")
      .run(value.outcome, value.effectReference, utcNow(), payloadDigest, value.operationId);
    process.exit(97);
  }

  crashBeforeLatchCommitForPhysicalTest(requestId, request) {
    operationIdentifier(requestId, "LATCH_REQUEST_ID_INVALID", "requestId");
    const value = validateLatchClaim(request);
    const payloadDigest = sha256(Buffer.from(canonicalJson(value), "utf8"));
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    this.#claimLatchInTransaction(db, value, `latch:${requestId}`, payloadDigest);
    process.exit(98);
  }

  crashBeforeHandoffCommitForPhysicalTest(requestId, request) {
    operationIdentifier(requestId, "HANDOFF_REQUEST_ID_INVALID", "requestId");
    const value = validateHandoffReservationRequest(request);
    const payload = { projection: value.projection, expectedLatch: value.expectedLatch, expectedLatest: value.expectedLatest };
    const payloadDigest = sha256(Buffer.from(canonicalJson(payload), "utf8"));
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    this.#reserveHandoffInTransaction(db, value, `handoff:${requestId}`, payloadDigest, { crashBeforeEvent: true });
    process.exit(99);
  }

  crashBeforeLifecycleTransitionCommitForPhysicalTest(requestId, request) {
    operationIdentifier(requestId, "LIFECYCLE_REQUEST_ID_INVALID", "requestId");
    const value = validateLifecycleBindingTransition(request);
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    const prior = this.#lifecycleBindingRow(db, value.expected.handoff_id);
    invariant(prior?.status === "ACTIVE" && sameLifecycleBindingIdentity(prior, value.expected), "LIFECYCLE_BINDING_STALE");
    const eventId = opaqueId("BEV");
    const occurredAt = utcNow();
    db.prepare("UPDATE lifecycle_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=?,supersede_event_id=? WHERE handoff_id=? AND status='ACTIVE'")
      .run(occurredAt, value.reason, eventId, prior.handoff_id);
    db.prepare(`INSERT INTO lifecycle_binding_events(
      event_id,request_id,handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,event_type,from_status,status,reason,occurred_at
    ) VALUES(?,?,?,?,?,?,?,'RUNNER_SESSION_BINDING_SUPERSEDED','ACTIVE','SUPERSEDED',?,?)`).run(
      eventId, `lifecycle-transition:${requestId}`, prior.handoff_id, prior.replacement_session_id,
      prior.runner_instance_id, prior.session_binding_id, prior.lifecycle_incarnation, value.reason, occurredAt,
    );
    process.exit(100);
  }

  close() {
    const db = this.#database();
    this.#connection = null;
    db.close();
  }
}
