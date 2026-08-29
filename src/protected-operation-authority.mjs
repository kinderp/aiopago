import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { canonicalJson, opaqueId, sha256, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import {
  LATCH_OPERATION_AUTHORITY_SCHEMA,
  OPERATION_AUTHORITY_SCHEMA,
  PREVIOUS_OPERATION_AUTHORITY_SCHEMA,
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

const require = createRequire(typeof __AIOPAGO_OPERATIONAL_ENTRY_URL__ === "string"
  ? __AIOPAGO_OPERATIONAL_ENTRY_URL__
  : import.meta.url);

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
      if (!([PREVIOUS_OPERATION_AUTHORITY_SCHEMA, LATCH_OPERATION_AUTHORITY_SCHEMA].includes(existingMetadata.schema_version)
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
    `);
    const metadata = db.prepare("SELECT schema_version FROM authority_metadata WHERE singleton=1").get();
    if (!metadata) {
      invariant(allowInitialize && !existed, "SECURE_OPERATION_AUTHORITY_METADATA_MISSING");
      db.prepare("INSERT INTO authority_metadata(singleton,schema_version,created_at) VALUES(1,?,?)").run(this.schema, utcNow());
    } else if ([PREVIOUS_OPERATION_AUTHORITY_SCHEMA, LATCH_OPERATION_AUTHORITY_SCHEMA].includes(metadata.schema_version)
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

  #reservationResult(db, handoffId, created, requestCode) {
    const reservation = this.#reservationRow(db, handoffId);
    const activeSource = db.prepare("SELECT source_session_id,handoff_id FROM active_sources WHERE handoff_id=?").get(handoffId) ?? null;
    const event = db.prepare("SELECT * FROM handoff_reservation_events WHERE handoff_id=?").get(handoffId) ?? null;
    return Object.freeze({ reservation, active_source: activeSource, event, created, idempotent: !created, request_code: requestCode });
  }

  #reserveHandoffInTransaction(db, value, ledgerRequestId, payloadDigest, { crashBeforeEvent = false } = {}) {
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
      throw new GuardianError("HANDOFF_TASK_RESERVATION_CONFLICT", "A protected reservation already owns this task; secure lifecycle/recovery authority is not yet available to transfer it", {
        task_id: projection.task_id,
        existing_handoff_id: latest.handoff_id,
      });
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
    db.prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)")
      .run(projection.source_session_id, projection.handoff_id);
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
      invariant(latest === null, "HANDOFF_TASK_RESERVATION_CONFLICT", "Secure lifecycle authority is unavailable to transfer an existing reservation");
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
    return Object.freeze({ ...this.security, latch_canonical: true, handoff_reservation_canonical: true, schema: metadata.schema_version, journal_mode: String(journal.journal_mode).toUpperCase(), path: this.path });
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

  close() {
    const db = this.#database();
    this.#connection = null;
    db.close();
  }
}
