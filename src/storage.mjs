import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { opaqueId, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";

const TERMINAL_HANDOFF = new Set(["RESUMED", "RESUME_DISPATCH_UNKNOWN", "HUMAN_DECISION_REQUIRED", "HANDOFF_FAILED", "CONTINUITY_FAILED"]);

export class GuardianStorage {
  constructor(path = ".guardian/runtime/guardian.sqlite") {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
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
    return this.db.prepare("SELECT run_id,runtime_store_id,attestation_sha256,created_at FROM calibration_runtime_identity WHERE singleton=1").get() ?? null;
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
      const contaminated = domainTables.filter((table) => this.db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get());
      invariant(contaminated.length === 0, "STALE_RUNTIME_STORE", this.path, contaminated);
      this.db.prepare("INSERT INTO calibration_runtime_identity(singleton,run_id,runtime_store_id,attestation_sha256,created_at) VALUES(1,?,?,?,?)")
        .run(identity.run_id, identity.runtime_store_id, identity.attestation_sha256, utcNow());
      return this.getCalibrationRuntimeIdentity();
    });
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  appendEvent(eventType, data = {}, { handoffId = null, eventKey = null } = {}) {
    const eventId = opaqueId("EVT");
    const occurredAt = utcNow();
    try {
      this.db.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
        .run(eventId, handoffId, eventType, eventKey, occurredAt, JSON.stringify(data));
      return { inserted: true, event_id: eventId, event_type: eventType, data, occurred_at: occurredAt };
    } catch (error) {
      if (!eventKey || !String(error.message).includes("UNIQUE")) throw error;
      const prior = this.db.prepare("SELECT * FROM journal WHERE event_key=?").get(eventKey);
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
      this.db.prepare("INSERT INTO latches(task_id,state,generation,released_at,released_by,last_event_id) VALUES(?,?,?,?,?,?)")
        .run(taskId, "RELEASED", 0, event.occurred_at, "human:bootstrap", event.event_id);
      return this.getLatch(taskId);
    });
  }

  getLatch(taskId) { return this.db.prepare("SELECT * FROM latches WHERE task_id=?").get(taskId) ?? null; }

  engageLatch(taskId, reason, actor) {
    this.ensureLatch(taskId);
    return this.transaction(() => {
      const latch = this.getLatch(taskId);
      if (latch.state === "ENGAGED") {
        if (reason === "HUMAN_TAKEOVER" && latch.reason !== reason) {
          const event = this.appendEvent("LATCH_ESCALATED", { task_id: taskId, generation: latch.generation, from: latch.reason, reason, actor }, { eventKey: `latch-escalated:${taskId}:${latch.generation}` });
          this.db.prepare("UPDATE latches SET reason=?,engaged_by=?,last_event_id=? WHERE task_id=? AND state='ENGAGED' AND generation=?")
            .run(reason, actor, event.event_id, taskId, latch.generation);
          return this.getLatch(taskId);
        }
        return latch;
      }
      const generation = latch.generation + 1;
      const event = this.appendEvent("LATCH_ENGAGED", { task_id: taskId, generation, reason, actor }, { eventKey: `latch-engaged:${taskId}:${generation}` });
      this.db.prepare("UPDATE latches SET state='ENGAGED',generation=?,reason=?,engaged_at=?,engaged_by=?,released_at=NULL,released_by=NULL,last_event_id=? WHERE task_id=? AND generation=?")
        .run(generation, reason, event.occurred_at, actor, event.event_id, taskId, latch.generation);
      return this.getLatch(taskId);
    });
  }

  isAdmissionOpen(taskId) {
    try { return this.getLatch(taskId)?.state === "RELEASED"; }
    catch { return false; }
  }

  reserveHandoff(projection) {
    return this.transaction(() => {
      const active = this.db.prepare("SELECT handoff_id FROM active_sources WHERE source_session_id=?").get(projection.source_session_id);
      if (active) return { created: false, handoff: this.getHandoff(active.handoff_id) };
      const now = utcNow();
      this.db.prepare("INSERT INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(projection.handoff_id, projection.source_session_id, null, projection.task_id, projection.state, projection.latch_generation, JSON.stringify(projection), now, now);
      this.db.prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)").run(projection.source_session_id, projection.handoff_id);
      this.appendEvent("HANDOFF_STARTED", { source_session_id: projection.source_session_id, latch_generation: projection.latch_generation, recovery_of_handoff_id: projection.recovery_of_handoff_id ?? null }, { handoffId: projection.handoff_id, eventKey: `handoff:${projection.handoff_id}` });
      return { created: true, handoff: this.getHandoff(projection.handoff_id) };
    });
  }

  getHandoff(id) {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE handoff_id=?").get(id);
    return row ? { ...JSON.parse(row.projection_json), state: row.state, target_session_id: row.target_session_id } : null;
  }

  findHandoffByTarget(targetSessionId) {
    const row = this.db.prepare("SELECT handoff_id FROM handoffs WHERE target_session_id=? ORDER BY created_at DESC LIMIT 1").get(targetSessionId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  findHandoffBySource(sourceSessionId) {
    const row = this.db.prepare("SELECT handoff_id FROM handoffs WHERE source_session_id=? ORDER BY created_at DESC LIMIT 1").get(sourceSessionId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  pendingContinuityFailureForTask(taskId) {
    const row = this.db.prepare("SELECT h.handoff_id FROM handoffs h JOIN runner_session_bindings b ON b.handoff_id=h.handoff_id WHERE h.task_id=? AND h.state='CONTINUITY_FAILED' AND b.status='ACTIVE' ORDER BY h.created_at DESC LIMIT 1").get(taskId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  assertContinuityRecoveryPrepared(handoffId, { sourceSessionId, runnerInstanceId }) {
    const binding = this.getRunnerSessionBinding(handoffId);
    invariant(binding?.status === "SUPERSEDED", "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed target binding was not superseded");
    const event = this.db.prepare("SELECT data_json FROM journal WHERE handoff_id=? AND event_key=? AND event_type='CONTINUITY_RECOVERY_STARTED'").get(handoffId, `continuity-recovery:${handoffId}`);
    const data = event ? JSON.parse(event.data_json) : null;
    invariant(data?.current_source_session_id === sourceSessionId && data?.current_runner_instance_id === runnerInstanceId, "CONTINUITY_RECOVERY_SOURCE_INVALID", "recovery preparation does not belong to the current Runner source");
    return data;
  }

  bindRunnerSession(handoffId, binding) {
    return this.transaction(() => {
      const handoff = this.getHandoff(handoffId);
      invariant(handoff?.state === "REPLACEMENT_SESSION_CREATED_PAUSED" && handoff.target_session_id === binding.replacement_session_id, "RUNNER_BINDING_STATE_INVALID");
      const prior = this.db.prepare("SELECT * FROM runner_session_bindings WHERE handoff_id=?").get(handoffId);
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
      this.db.prepare("INSERT INTO runner_session_bindings(handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,bind_event_id) VALUES(?,?,?,?,?,?,?)")
        .run(handoffId, data.replacement_session_id, data.runner_instance_id, data.session_binding_id, "ACTIVE", event.occurred_at, event.event_id);
      return this.getRunnerSessionBinding(handoffId);
    });
  }

  getRunnerSessionBinding(handoffId) {
    const row = this.db.prepare("SELECT * FROM runner_session_bindings WHERE handoff_id=?").get(handoffId);
    if (!row) return null;
    const event = this.db.prepare("SELECT event_type,data_json FROM journal WHERE event_id=? AND handoff_id=?").get(row.bind_event_id, handoffId);
    invariant(event?.event_type === "RUNNER_SESSION_BOUND", "RUNNER_BINDING_JOURNAL_MISMATCH");
    return { schema_version: "1.0.0", ...row, event_data: JSON.parse(event.data_json) };
  }

  supersedeRunnerSessionBinding(handoffId, reason) {
    return this.transaction(() => {
      const binding = this.getRunnerSessionBinding(handoffId);
      if (!binding || binding.status === "SUPERSEDED") return binding;
      const now = utcNow();
      this.db.prepare("UPDATE runner_session_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=? WHERE handoff_id=? AND status='ACTIVE'")
        .run(now, reason, handoffId);
      this.appendEvent("RUNNER_SESSION_BINDING_SUPERSEDED", { reason }, { handoffId, eventKey: `runner-binding-superseded:${handoffId}` });
      return this.getRunnerSessionBinding(handoffId);
    });
  }

  prepareContinuityRecovery(handoffId, { sourceSessionId, runnerInstanceId, actor }) {
    invariant(typeof sourceSessionId === "string" && typeof runnerInstanceId === "string" && actor?.startsWith("human:"), "CONTINUITY_RECOVERY_AUTHORITY_INVALID");
    return this.transaction(() => {
      const handoff = this.getHandoff(handoffId);
      invariant(handoff?.state === "CONTINUITY_FAILED", "CONTINUITY_RECOVERY_NOT_ALLOWED", handoff?.state ?? "HANDOFF_NOT_FOUND");
      invariant(sourceSessionId !== handoff.source_session_id && sourceSessionId !== handoff.target_session_id, "CONTINUITY_RECOVERY_SOURCE_INVALID", "recovery requires a distinct fresh source session");
      invariant(handoff.authorization_state === "NOT_AUTHORIZED" && handoff.admission_state === "NOT_COMMITTED" && handoff.dispatch_state === "NOT_STARTED", "CONTINUITY_RECOVERY_UNSAFE", "authorization/admission/dispatch state is not provably empty");
      const authorization = this.db.prepare("SELECT 1 AS present FROM authorizations WHERE handoff_id=? LIMIT 1").get(handoffId);
      const admission = this.db.prepare("SELECT 1 AS present FROM admissions WHERE handoff_id=? LIMIT 1").get(handoffId);
      const dispatch = this.db.prepare("SELECT 1 AS present FROM dispatch_attempts WHERE handoff_id=? LIMIT 1").get(handoffId);
      invariant(!authorization && !admission && !dispatch, "CONTINUITY_RECOVERY_UNSAFE", "durable authorization/admission/dispatch evidence exists");
      const continuityFailure = this.db.prepare("SELECT 1 AS present FROM journal WHERE handoff_id=? AND event_type='CONTINUITY_FAILED' LIMIT 1").get(handoffId);
      invariant(continuityFailure, "CONTINUITY_RECOVERY_UNSAFE", "terminal continuity failure journal evidence is missing");
      const latch = this.getLatch(handoff.task_id);
      invariant(latch?.state === "ENGAGED" && latch.generation === handoff.latch_generation, "LATCH_GENERATION_MISMATCH");
      const binding = this.getRunnerSessionBinding(handoffId);
      invariant(binding?.status === "ACTIVE" && binding.replacement_session_id === handoff.target_session_id && binding.runner_instance_id === handoff.runner_instance_id && binding.session_binding_id === handoff.session_binding_id, "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed target binding is not active and coherent");
      const currentUse = this.db.prepare("SELECT handoff_id,state FROM handoffs WHERE source_session_id=? OR target_session_id=? LIMIT 1").get(sourceSessionId, sourceSessionId);
      const activeSource = this.db.prepare("SELECT handoff_id FROM active_sources WHERE source_session_id=? LIMIT 1").get(sourceSessionId);
      invariant(!currentUse && !activeSource, "CONTINUITY_RECOVERY_SOURCE_INVALID", "current recovery source already participates in a handoff");
      const reason = `explicit continuity recovery by ${actor}`;
      const now = utcNow();
      const changed = this.db.prepare("UPDATE runner_session_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=? WHERE handoff_id=? AND status='ACTIVE'")
        .run(now, reason, handoffId);
      invariant(changed.changes === 1, "CONTINUITY_RECOVERY_UNSAFE", "failed target binding reconciliation raced");
      this.appendEvent("RUNNER_SESSION_BINDING_SUPERSEDED", { reason }, { handoffId, eventKey: `runner-binding-superseded:${handoffId}` });
      this.appendEvent("CONTINUITY_RECOVERY_STARTED", {
        failed_target_session_id: handoff.target_session_id,
        failed_runner_instance_id: handoff.runner_instance_id,
        current_source_session_id: sourceSessionId,
        current_runner_instance_id: runnerInstanceId,
        actor,
      }, { handoffId, eventKey: `continuity-recovery:${handoffId}` });
      return { handoff: this.getHandoff(handoffId), binding: this.getRunnerSessionBinding(handoffId), latch: this.getLatch(handoff.task_id) };
    });
  }

  latestHandoffForTask(taskId) {
    const row = this.db.prepare("SELECT handoff_id FROM handoffs WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(taskId);
    return row ? this.getHandoff(row.handoff_id) : null;
  }

  saveHandoff(handoff, eventType = null, eventData = {}) {
    return this.transaction(() => {
      const now = utcNow();
      handoff.updated_at = now;
      this.db.prepare("UPDATE handoffs SET target_session_id=?,state=?,projection_json=?,updated_at=? WHERE handoff_id=?")
        .run(handoff.target_session_id ?? null, handoff.state, JSON.stringify(handoff), now, handoff.handoff_id);
      if (eventType) this.appendEvent(eventType, eventData, { handoffId: handoff.handoff_id, eventKey: eventData.event_key ?? null });
      return this.getHandoff(handoff.handoff_id);
    });
  }

  transition(id, expectedStates, next, data = {}) {
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h, "HANDOFF_NOT_FOUND", id);
      const expected = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
      invariant(expected.includes(h.state), "ILLEGAL_TRANSITION", `${h.state}->${next}`);
      const previous = h.state;
      h.state = next;
      const now = utcNow(); h.updated_at = now;
      this.db.prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=? AND state=?")
        .run(next, JSON.stringify(h), now, id, previous);
      this.appendEvent("STATE_TRANSITION", { from: previous, to: next, ...data }, { handoffId: id });
      return this.getHandoff(id);
    });
  }

  authorizeAndAdmit(id, actor, idempotencyKey, admissionId) {
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h, "HANDOFF_NOT_FOUND");
      const prior = h.resume_prompt_id ? this.db.prepare("SELECT * FROM admissions WHERE resume_prompt_id=?").get(h.resume_prompt_id) : null;
      if (prior) return { idempotent: true, admission_id: prior.admission_id, handoff: h };
      invariant(h.state === "RESUME_READY", "RESUME_NOT_READY", h.state);
      invariant(actor.startsWith("human:"), "HUMAN_AUTHORIZATION_REQUIRED");
      const latch = this.getLatch(h.task_id);
      invariant(latch?.state === "ENGAGED" && latch.generation === h.latch_generation, "LATCH_GENERATION_MISMATCH");
      invariant(latch.reason !== "HUMAN_TAKEOVER", "HUMAN_TAKEOVER_ACTIVE", "A pending handoff confirmation cannot release a human takeover");
      const releaseGeneration = latch.generation + 1;
      const release = this.appendEvent("LATCH_RELEASED", { task_id: h.task_id, generation: releaseGeneration, actor }, { handoffId: id, eventKey: `latch-release:${h.task_id}:${releaseGeneration}` });
      this.db.prepare("UPDATE latches SET state='RELEASED',generation=?,released_at=?,released_by=?,last_event_id=? WHERE task_id=? AND state='ENGAGED' AND generation=?")
        .run(releaseGeneration, release.occurred_at, actor, release.event_id, h.task_id, latch.generation);
      const now = utcNow();
      this.db.prepare("INSERT INTO authorizations(resume_prompt_id,handoff_id,actor,latch_generation,authorized_at) VALUES(?,?,?,?,?)")
        .run(h.resume_prompt_id, id, actor, releaseGeneration, now);
      try {
        this.db.prepare("INSERT INTO admissions(admission_id,resume_prompt_id,idempotency_key,handoff_id,committed_at) VALUES(?,?,?,?,?)")
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
      this.db.prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=?")
        .run(h.state, JSON.stringify(h), now, id);
      this.appendEvent("RESUME_AUTHORIZED", { resume_prompt_id: h.resume_prompt_id, actor }, { handoffId: id, eventKey: `authorization:${h.resume_prompt_id}` });
      this.appendEvent("RESUME_ADMISSION_COMMITTED", { resume_prompt_id: h.resume_prompt_id, admission_id: admissionId, idempotency_key: idempotencyKey }, { handoffId: id, eventKey: `admission:${h.resume_prompt_id}` });
      return { idempotent: false, admission_id: admissionId, handoff: this.getHandoff(id) };
    });
  }

  beginDispatch(id, attemptId, attemptNo = 1) {
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h?.admission_state === "COMMITTED", "ADMISSION_REQUIRED");
      if (h.dispatch_state === "UNKNOWN") throw new GuardianError("RESUME_DISPATCH_UNKNOWN");
      const prior = this.db.prepare("SELECT * FROM dispatch_attempts WHERE admission_id=? AND attempt_no=?").get(h.admission_id, attemptNo);
      if (prior) return { idempotent: true, attempt: prior, handoff: h };
      const now = utcNow();
      this.db.prepare("INSERT INTO dispatch_attempts(dispatch_attempt_id,admission_id,handoff_id,attempt_no,state,intent_at) VALUES(?,?,?,?,?,?)")
        .run(attemptId, h.admission_id, id, attemptNo, "DISPATCHING", now);
      h.dispatch_state = "DISPATCHING"; h.dispatch_attempt_id = attemptId; h.dispatch_attempt_no = attemptNo; h.state = "RESUME_DISPATCHING"; h.updated_at = now;
      this.db.prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=?").run(h.state, JSON.stringify(h), now, id);
      this.appendEvent("RESUME_DISPATCH_INTENT", { dispatch_attempt_id: attemptId, admission_id: h.admission_id }, { handoffId: id, eventKey: `dispatch-intent:${attemptId}` });
      return { idempotent: false, attempt: this.db.prepare("SELECT * FROM dispatch_attempts WHERE dispatch_attempt_id=?").get(attemptId), handoff: this.getHandoff(id) };
    });
  }

  finishDispatch(id, state, error = null) {
    invariant(["ACKNOWLEDGED", "DISPATCHED", "UNKNOWN", "FAILED"].includes(state), "DISPATCH_STATE_INVALID");
    return this.transaction(() => {
      const h = this.getHandoff(id);
      invariant(h?.dispatch_attempt_id, "DISPATCH_INTENT_REQUIRED");
      const now = utcNow();
      this.db.prepare("UPDATE dispatch_attempts SET state=?,outcome_at=?,error=? WHERE dispatch_attempt_id=?").run(state, now, error, h.dispatch_attempt_id);
      h.dispatch_state = state;
      h.state = state === "ACKNOWLEDGED" ? "RESUMED" : state === "UNKNOWN" ? "RESUME_DISPATCH_UNKNOWN" : state === "FAILED" ? "RESUME_DISPATCH_FAILED" : "RESUME_DISPATCHED";
      h.updated_at = now;
      this.db.prepare("UPDATE handoffs SET state=?,projection_json=?,updated_at=? WHERE handoff_id=?").run(h.state, JSON.stringify(h), now, id);
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
    this.db.prepare("INSERT INTO operations(operation_id,task_id,latch_generation,profile,state,admitted_at) VALUES(?,?,?,?,?,?)")
      .run(operationId, taskId, generation, profile, "ACTIVE", utcNow());
  }

  finishOperation(operationId, outcome, effectReference = null) {
    invariant(["KNOWN_SUCCESS", "KNOWN_FAILURE", "UNKNOWN"].includes(outcome), "OPERATION_OUTCOME_INVALID");
    this.db.prepare("UPDATE operations SET state='TERMINAL',outcome=?,effect_reference=?,terminal_at=? WHERE operation_id=? AND state='ACTIVE'")
      .run(outcome, effectReference, utcNow(), operationId);
  }

  operationsForTask(taskId) { return this.db.prepare("SELECT * FROM operations WHERE task_id=? ORDER BY admitted_at").all(taskId); }

  metricLimit(value) {
    invariant(Number.isInteger(value) && value > 0, "METRICS_RETENTION_INVALID");
    return value;
  }

  upsertMetricSession(record, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO metric_sessions(session_id,started_at,ended_at,updated_at,record_json) VALUES(?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET started_at=excluded.started_at,ended_at=excluded.ended_at,updated_at=excluded.updated_at,record_json=excluded.record_json`)
        .run(record.session_id, record.started_at, record.ended_at, record.updated_at, JSON.stringify(record));
      this.db.prepare("DELETE FROM metric_sessions WHERE session_id NOT IN (SELECT session_id FROM metric_sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(limit);
    });
    return this.getMetricSession(record.session_id);
  }

  getMetricSession(sessionId) {
    const row = this.db.prepare("SELECT record_json FROM metric_sessions WHERE session_id=?").get(sessionId);
    return row ? JSON.parse(row.record_json) : null;
  }

  metricSessions() {
    return this.db.prepare("SELECT record_json FROM metric_sessions ORDER BY updated_at, rowid").all().map((row) => JSON.parse(row.record_json));
  }

  appendMetricSample(record, sessionSummary, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    return this.transaction(() => {
      this.db.prepare("INSERT INTO metric_samples(sample_id,session_id,call_index,captured_at,record_json) VALUES(?,?,?,?,?)")
        .run(record.sample_id, record.session_id, record.call_index, record.captured_at, JSON.stringify(record));
      this.db.prepare("UPDATE metric_sessions SET started_at=?,ended_at=?,updated_at=?,record_json=? WHERE session_id=?")
        .run(sessionSummary.started_at, sessionSummary.ended_at, sessionSummary.updated_at, JSON.stringify(sessionSummary), record.session_id);
      this.db.prepare("DELETE FROM metric_samples WHERE seq NOT IN (SELECT seq FROM metric_samples ORDER BY seq DESC LIMIT ?)").run(limit);
      return record;
    });
  }

  metricSamples(sessionId = null) {
    const rows = sessionId
      ? this.db.prepare("SELECT record_json FROM metric_samples WHERE session_id=? ORDER BY seq").all(sessionId)
      : this.db.prepare("SELECT record_json FROM metric_samples ORDER BY seq").all();
    return rows.map((row) => JSON.parse(row.record_json));
  }

  appendHandoffMetricEvent(record, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    this.transaction(() => {
      this.db.prepare("INSERT INTO metric_handoff_events(metric_event_id,session_id,handoff_id,lifecycle_state,occurred_at,record_json) VALUES(?,?,?,?,?,?)")
        .run(record.metric_event_id, record.session_id, record.handoff_id, record.lifecycle_state, record.timestamp, JSON.stringify(record));
      this.db.prepare("DELETE FROM metric_handoff_events WHERE seq NOT IN (SELECT seq FROM metric_handoff_events ORDER BY seq DESC LIMIT ?)").run(limit);
    });
    return record;
  }

  handoffMetricEvents(handoffId = null) {
    const rows = handoffId
      ? this.db.prepare("SELECT record_json FROM metric_handoff_events WHERE handoff_id=? ORDER BY seq").all(handoffId)
      : this.db.prepare("SELECT record_json FROM metric_handoff_events ORDER BY seq").all();
    return rows.map((row) => JSON.parse(row.record_json));
  }

  appendMetricDiagnostic(record, retentionLimit) {
    const limit = this.metricLimit(retentionLimit);
    this.transaction(() => {
      this.db.prepare("INSERT INTO metric_diagnostics(diagnostic_id,occurred_at,record_json) VALUES(?,?,?)")
        .run(record.diagnostic_id, record.timestamp, JSON.stringify(record));
      this.db.prepare("DELETE FROM metric_diagnostics WHERE seq NOT IN (SELECT seq FROM metric_diagnostics ORDER BY seq DESC LIMIT ?)").run(limit);
    });
    return record;
  }

  metricDiagnostics() {
    return this.db.prepare("SELECT record_json FROM metric_diagnostics ORDER BY seq").all().map((row) => JSON.parse(row.record_json));
  }

  indexArtifact({ kind, id, path, digest, contentDigest }) {
    const prior = this.getArtifact(kind, id);
    if (prior) {
      invariant(prior.path === path && prior.digest === digest && prior.content_digest === contentDigest, "ARTIFACT_INDEX_CONFLICT");
      return prior;
    }
    this.db.prepare("INSERT INTO artifacts(kind,artifact_id,path,digest,content_digest,created_at) VALUES(?,?,?,?,?,?)")
      .run(kind, id, path, digest, contentDigest, utcNow());
    return this.getArtifact(kind, id);
  }
  getArtifact(kind, id) { return this.db.prepare("SELECT * FROM artifacts WHERE kind=? AND artifact_id=?").get(kind, id) ?? null; }
  events(id) { return this.db.prepare("SELECT * FROM journal WHERE handoff_id=? ORDER BY seq").all(id).map((row) => ({ ...row, data: JSON.parse(row.data_json) })); }
  close() { this.db.close(); }
}

export { TERMINAL_HANDOFF };
