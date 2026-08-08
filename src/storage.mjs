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
      CREATE INDEX IF NOT EXISTS journal_handoff_seq ON journal(handoff_id, seq);
      CREATE INDEX IF NOT EXISTS operation_task_state ON operations(task_id, state);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO authorities(name,authority,schema_version) VALUES
        ('journal','Guardian SQLite append-only','1.0.0'),
        ('latches','Guardian SQLite canonical runtime','1.0.0'),
        ('handoffs','Guardian SQLite canonical runtime','1.0.0'),
        ('operations','Guardian SQLite canonical runtime','1.0.0'),
        ('artifacts','sealed JSON authoritative; SQLite index derived','1.0.0'),
        ('ledger_index','TASK_PLAN.md authoritative; no reverse write','0.1.0');
    `);
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
      this.appendEvent("HANDOFF_STARTED", { source_session_id: projection.source_session_id, latch_generation: projection.latch_generation }, { handoffId: projection.handoff_id, eventKey: `handoff:${projection.handoff_id}` });
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
