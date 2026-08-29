const __AIOPAGO_OPERATIONAL_ENTRY_URL__ = import.meta.url;

// src/operation-authority-worker.mjs
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

// src/errors.mjs
var GuardianError = class extends Error {
  constructor(code, message = code, details = void 0) {
    super(message);
    this.name = "GuardianError";
    this.code = code;
    this.details = details;
  }
};
function fail(code, message = code, details) {
  throw new GuardianError(code, message, details);
}
function invariant(condition, code, message = code, details) {
  if (!condition) fail(code, message, details);
}

// src/operation-authority.mjs
var OPERATION_AUTHORITY_MODES = Object.freeze({
  SECURE: "SECURE",
  PORTABLE: "PORTABLE"
});
var PREVIOUS_OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.0.0";
var LATCH_OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.1.0";
var HANDOFF_OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.2.0";
var OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.3.0";
var OPERATION_AUTHORITY_PROTOCOL = "aiopago.operation-authority-protocol/4";
var PROFILES = /* @__PURE__ */ new Set(["READ_ONLY", "LOCAL_ATOMIC_MUTATION", "SHELL_ATOMIC_OPERATION"]);
var OUTCOMES = /* @__PURE__ */ new Set(["KNOWN_SUCCESS", "KNOWN_FAILURE", "UNKNOWN"]);
var IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
var EFFECT_REFERENCE = /^(?:file|shell):[^\r\n]{1,2048}$/;
var SECURE_OPERATION_AUTHORITY_LABEL = Object.freeze({
  mode: OPERATION_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_operation_isolation: true
});
var PORTABLE_LABEL = Object.freeze({
  mode: OPERATION_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_operation_isolation: false
});
function operationIdentifier(value, code, field) {
  invariant(typeof value === "string" && IDENTIFIER.test(value), code, `${field} is invalid`);
  return value;
}
function validateOperationAdmission(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "OPERATION_ADMISSION_INVALID");
  const operationId = operationIdentifier(request.operationId, "OPERATION_ID_INVALID", "operationId");
  const taskId = operationIdentifier(request.taskId, "OPERATION_TASK_INVALID", "taskId");
  invariant(Number.isSafeInteger(request.generation) && request.generation >= 0, "OPERATION_GENERATION_INVALID");
  invariant(PROFILES.has(request.profile), "OPERATION_PROFILE_INVALID");
  return Object.freeze({ operationId, taskId, generation: request.generation, profile: request.profile });
}
function validateOperationTerminal(operationId, outcome, effectReference) {
  operationIdentifier(operationId, "OPERATION_ID_INVALID", "operationId");
  invariant(OUTCOMES.has(outcome), "OPERATION_OUTCOME_INVALID");
  invariant(effectReference === null || typeof effectReference === "string" && EFFECT_REFERENCE.test(effectReference), "OPERATION_EFFECT_REFERENCE_INVALID");
  if (outcome !== "KNOWN_SUCCESS") invariant(effectReference === null, "OPERATION_EFFECT_REFERENCE_INVALID", "Only known success may carry effect evidence");
  return Object.freeze({ operationId, outcome, effectReference });
}
function detachedOperation(row) {
  return row ? Object.freeze({ ...row }) : null;
}
var PortableOperationAuthority = class {
  constructor(storage) {
    invariant(storage && typeof storage.admitOperation === "function" && typeof storage.finishOperation === "function" && typeof storage.operationsForTask === "function", "PORTABLE_OPERATION_AUTHORITY_INVALID");
    this.storage = storage;
    this.security = PORTABLE_LABEL;
  }
  admitOperation(request) {
    const value = validateOperationAdmission(request);
    this.storage.admitOperation(value);
    return detachedOperation(this.storage.operationsForTask(value.taskId).find((row) => row.operation_id === value.operationId));
  }
  finishOperation(operationId, outcome, effectReference = null) {
    const value = validateOperationTerminal(operationId, outcome, effectReference);
    this.storage.finishOperation(value.operationId, value.outcome, value.effectReference);
    return null;
  }
  operationsForTask(taskId) {
    operationIdentifier(taskId, "OPERATION_TASK_INVALID", "taskId");
    return Object.freeze(this.storage.operationsForTask(taskId).map(detachedOperation));
  }
  getOperation(operationId) {
    operationIdentifier(operationId, "OPERATION_ID_INVALID", "operationId");
    return null;
  }
  close() {
  }
};
function portableOperationAuthority(storage) {
  return new PortableOperationAuthority(storage);
}
function requireSecureOperationAuthority(authority) {
  invariant(
    authority?.security?.mode === OPERATION_AUTHORITY_MODES.SECURE && authority.security.canonical === true && authority.security.r1_m_13_operation_isolation === true,
    "SECURE_OPERATION_AUTHORITY_REQUIRED",
    "Secure execution cannot use or fall back to portable operation state"
  );
  return authority;
}

// src/latch-authority.mjs
var LATCH_AUTHORITY_MODES = Object.freeze({
  SECURE: "SECURE",
  PORTABLE: "PORTABLE"
});
var SECURE_LATCH_AUTHORITY_LABEL = Object.freeze({
  mode: LATCH_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_latch_isolation: true
});
var PORTABLE_LATCH_AUTHORITY_LABEL = Object.freeze({
  mode: LATCH_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_latch_isolation: false
});
var LATCH_STATES = /* @__PURE__ */ new Set(["ENGAGED", "RELEASED"]);
var BOUNDED_TEXT = /^[^\r\n]{1,256}$/;
function detachedLatch(row) {
  return row ? Object.freeze({ ...row }) : null;
}
function validateLatchExpected(taskId, expected) {
  if (expected === null || expected === void 0) return null;
  invariant(expected && typeof expected === "object" && !Array.isArray(expected), "LATCH_CLAIM_INVALID");
  invariant(
    expected.task_id === taskId && LATCH_STATES.has(expected.state) && Number.isSafeInteger(expected.generation) && expected.generation >= 0 && (expected.reason === null || typeof expected.reason === "string" && BOUNDED_TEXT.test(expected.reason)),
    "LATCH_CLAIM_INVALID"
  );
  invariant(expected.state === "RELEASED" && expected.reason === null || expected.state === "ENGAGED" && typeof expected.reason === "string", "LATCH_CLAIM_INVALID");
  return Object.freeze({ task_id: taskId, state: expected.state, generation: expected.generation, reason: expected.reason });
}
function validateLatchClaim(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "LATCH_CLAIM_INVALID");
  const taskId = operationIdentifier(request.taskId, "LATCH_TASK_INVALID", "taskId");
  invariant(typeof request.reason === "string" && BOUNDED_TEXT.test(request.reason), "LATCH_REASON_INVALID");
  invariant(typeof request.actor === "string" && BOUNDED_TEXT.test(request.actor), "LATCH_ACTOR_INVALID");
  const expected = validateLatchExpected(taskId, request.expected ?? null);
  return Object.freeze({ taskId, reason: request.reason, actor: request.actor, expected });
}
var PortableLatchAuthority = class {
  constructor(storage) {
    invariant(
      storage && typeof storage.ensureLatch === "function" && typeof storage.getLatch === "function" && typeof storage.assertLatchIdentity === "function" && typeof storage.isAdmissionOpen === "function",
      "PORTABLE_LATCH_AUTHORITY_INVALID"
    );
    this.storage = storage;
    this.security = PORTABLE_LATCH_AUTHORITY_LABEL;
  }
  ensureLatch(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.storage.ensureLatch(taskId));
  }
  getLatch(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.storage.getLatch(taskId));
  }
  assertLatchIdentity(taskId, expected, options = {}) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.storage.assertLatchIdentity(taskId, expected, options));
  }
  isAdmissionOpen(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return this.storage.isAdmissionOpen(taskId);
  }
};
function portableLatchAuthority(storage) {
  return new PortableLatchAuthority(storage);
}
function requireSecureLatchAuthority(authority) {
  invariant(
    authority?.latchSecurity?.mode === LATCH_AUTHORITY_MODES.SECURE && authority.latchSecurity.canonical === true && authority.latchSecurity.r1_m_13_latch_isolation === true,
    "SECURE_LATCH_AUTHORITY_REQUIRED",
    "Secure execution cannot use or fall back to portable latch state"
  );
  return authority;
}
function assertLatchIdentityValue(current, expected, { allowHumanTakeover = false } = {}) {
  if (!allowHumanTakeover && current?.state === "ENGAGED" && current.reason === "HUMAN_TAKEOVER") {
    throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover has priority");
  }
  invariant(current?.state === expected?.state && current.generation === expected?.generation && (current.reason ?? null) === (expected?.reason ?? null), "LATCH_GENERATION_MISMATCH", "Canonical latch identity changed");
  return current;
}

// src/canonical.mjs
import { createHash, randomUUID } from "node:crypto";
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (value === void 0) throw new TypeError("undefined is not canonical JSON");
  return JSON.stringify(value);
}
function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function opaqueId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
function utcNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// src/handoff-reservation-authority.mjs
var HANDOFF_AUTHORITY_MODES = Object.freeze({ SECURE: "SECURE", PORTABLE: "PORTABLE" });
var SECURE_HANDOFF_AUTHORITY_LABEL = Object.freeze({
  mode: HANDOFF_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_handoff_reservation_isolation: true
});
var PORTABLE_HANDOFF_AUTHORITY_LABEL = Object.freeze({
  mode: HANDOFF_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_handoff_reservation_isolation: false
});
var HANDOFF_RESERVATION_IDENTITY_FIELDS = Object.freeze([
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
  "reasoning_policy"
]);
var DIGEST = /^sha256:[a-f0-9]{64}$/;
var BOUNDED_PATH = /^[^\r\n]{1,4096}$/;
var BOUNDED_TEXT2 = /^[^\r\n]{1,8192}$/;
var MAX_PROJECTION_BYTES = 196608;
function optionalIdentifier(value, code, field) {
  if (value === null || value === void 0) return null;
  return operationIdentifier(value, code, field);
}
function boundedNullable(value, code, field, expression = BOUNDED_TEXT2) {
  invariant(value === null || value === void 0 || typeof value === "string" && expression.test(value), code, `${field} is invalid`);
  return value ?? null;
}
function sameHandoffReservationIdentity(left, right) {
  return HANDOFF_RESERVATION_IDENTITY_FIELDS.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}
function validateHandoffProjection(projection) {
  invariant(projection && typeof projection === "object" && !Array.isArray(projection), "HANDOFF_RESERVATION_INVALID");
  operationIdentifier(projection.handoff_id, "HANDOFF_ID_INVALID", "handoff_id");
  operationIdentifier(projection.source_session_id, "HANDOFF_SOURCE_INVALID", "source_session_id");
  invariant(typeof projection.source_session_file === "string" && BOUNDED_PATH.test(projection.source_session_file), "HANDOFF_SOURCE_INVALID", "source_session_file is invalid");
  operationIdentifier(projection.task_id, "HANDOFF_TASK_INVALID", "task_id");
  operationIdentifier(projection.task_plan_revision, "HANDOFF_PLAN_INVALID", "task_plan_revision");
  invariant(DIGEST.test(projection.task_plan_digest ?? ""), "HANDOFF_PLAN_INVALID", "task_plan_digest is invalid");
  operationIdentifier(projection.requirements_version, "HANDOFF_PLAN_INVALID", "requirements_version");
  operationIdentifier(projection.runner_instance_id, "HANDOFF_RUNNER_INVALID", "runner_instance_id");
  operationIdentifier(projection.session_binding_id, "HANDOFF_BINDING_INVALID", "session_binding_id");
  operationIdentifier(projection.parent_session_id, "HANDOFF_PARENT_INVALID", "parent_session_id");
  invariant(typeof projection.parent_session_file === "string" && BOUNDED_PATH.test(projection.parent_session_file), "HANDOFF_PARENT_INVALID", "parent_session_file is invalid");
  operationIdentifier(projection.checkpoint_id, "HANDOFF_CHECKPOINT_INVALID", "checkpoint_id");
  operationIdentifier(projection.resume_manifest_id, "HANDOFF_MANIFEST_INVALID", "resume_manifest_id");
  optionalIdentifier(projection.current_item, "HANDOFF_PLAN_INVALID", "current_item");
  optionalIdentifier(projection.next_item, "HANDOFF_PLAN_INVALID", "next_item");
  boundedNullable(projection.next_step, "HANDOFF_PLAN_INVALID", "next_step");
  optionalIdentifier(projection.parent_checkpoint_id, "HANDOFF_PARENT_INVALID", "parent_checkpoint_id");
  optionalIdentifier(projection.recovery_of_handoff_id, "HANDOFF_RECOVERY_INVALID", "recovery_of_handoff_id");
  boundedNullable(projection.model_policy, "HANDOFF_POLICY_INVALID", "model_policy");
  boundedNullable(projection.reasoning_policy, "HANDOFF_POLICY_INVALID", "reasoning_policy");
  invariant(Number.isSafeInteger(projection.latch_generation) && projection.latch_generation >= 0, "HANDOFF_LATCH_INVALID");
  invariant(
    projection.state === "SAFE_TO_HANDOFF" && projection.target_session_id === null && projection.authorization_state === "NOT_AUTHORIZED" && projection.admission_state === "NOT_COMMITTED" && projection.dispatch_state === "NOT_STARTED",
    "HANDOFF_RESERVATION_STATE_INVALID",
    "A canonical reservation begins paused with empty resume authority"
  );
  invariant(
    projection.reserved_plan_snapshot?.task_id === projection.task_id && projection.reserved_plan_snapshot?.plan_revision_id === projection.task_plan_revision && projection.reserved_plan_snapshot?.content_digest === projection.task_plan_digest,
    "HANDOFF_PLAN_PROVENANCE_MISMATCH",
    "Reserved plan snapshot does not match handoff plan identity"
  );
  const bytes = Buffer.from(canonicalJson(projection), "utf8");
  invariant(bytes.length <= MAX_PROJECTION_BYTES, "HANDOFF_RESERVATION_TOO_LARGE");
  return Object.freeze({ projection: structuredClone(projection), projectionDigest: sha256(bytes) });
}
function validateHandoffReservationRequest(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "HANDOFF_RESERVATION_INVALID");
  const validated = validateHandoffProjection(request.projection);
  const taskId = validated.projection.task_id;
  const expectedLatch = request.expectedLatch;
  invariant(
    expectedLatch?.task_id === taskId && expectedLatch.state === "ENGAGED" && Number.isSafeInteger(expectedLatch.generation) && expectedLatch.generation >= 0 && typeof expectedLatch.reason === "string" && expectedLatch.reason.length > 0 && expectedLatch.reason !== "HUMAN_TAKEOVER" && validated.projection.latch_generation === expectedLatch.generation,
    "HANDOFF_LATCH_INVALID",
    "Reservation requires the exact acquired non-takeover latch"
  );
  let expectedLatest = null;
  if (request.expectedLatest !== null && request.expectedLatest !== void 0) {
    invariant(request.expectedLatest && typeof request.expectedLatest === "object" && !Array.isArray(request.expectedLatest), "HANDOFF_LATEST_INVALID");
    expectedLatest = Object.freeze({
      handoff_id: operationIdentifier(request.expectedLatest.handoff_id, "HANDOFF_LATEST_INVALID", "handoff_id"),
      reservation_digest: operationIdentifier(request.expectedLatest.reservation_digest, "HANDOFF_LATEST_INVALID", "reservation_digest")
    });
  }
  invariant(
    validated.projection.recovery_of_handoff_id === null,
    "SECURE_RECOVERY_AUTHORITY_UNAVAILABLE",
    "Continuity recovery remains unavailable until its authority domain is migrated"
  );
  return Object.freeze({
    projection: validated.projection,
    projectionDigest: validated.projectionDigest,
    expectedLatch: Object.freeze({ task_id: taskId, state: "ENGAGED", generation: expectedLatch.generation, reason: expectedLatch.reason }),
    expectedLatest
  });
}
function detachedReservation(row) {
  if (!row) return null;
  const projection = typeof row.projection_json === "string" ? JSON.parse(row.projection_json) : row.projection ?? row;
  return Object.freeze({
    ...structuredClone(projection),
    reservation_digest: row.reservation_digest ?? projection.reservation_digest ?? null,
    latch_reason: row.latch_reason ?? projection.latch_reason ?? null,
    reservation_event_id: row.reservation_event_id ?? projection.reservation_event_id ?? null
  });
}
function requireSecureHandoffAuthority(authority) {
  invariant(
    authority?.handoffSecurity?.mode === HANDOFF_AUTHORITY_MODES.SECURE && authority.handoffSecurity.canonical === true && authority.handoffSecurity.r1_m_13_handoff_reservation_isolation === true,
    "SECURE_HANDOFF_AUTHORITY_REQUIRED",
    "Secure handoff cannot use or fall back to portable reservation state"
  );
  return authority;
}

// src/lifecycle-binding-authority.mjs
var LIFECYCLE_AUTHORITY_MODES = Object.freeze({ SECURE: "SECURE", PORTABLE: "PORTABLE" });
var SECURE_LIFECYCLE_AUTHORITY_LABEL = Object.freeze({
  mode: LIFECYCLE_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_lifecycle_binding_isolation: true
});
var PORTABLE_LIFECYCLE_AUTHORITY_LABEL = Object.freeze({
  mode: LIFECYCLE_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_lifecycle_binding_isolation: false
});
var LIFECYCLE_BINDING_STATES = Object.freeze(["ACTIVE", "SUPERSEDED"]);
var LIFECYCLE_BINDING_IDENTITY_FIELDS = Object.freeze([
  "handoff_id",
  "replacement_session_id",
  "runner_instance_id",
  "session_binding_id",
  "lifecycle_incarnation"
]);
var BOUNDED_REASON = /^[^\r\n]{1,2048}$/;
function lifecycleIncarnation(value) {
  invariant(Number.isSafeInteger(value) && value > 0, "LIFECYCLE_INCARNATION_INVALID");
  return value;
}
function sameLifecycleBindingIdentity(left, right) {
  return LIFECYCLE_BINDING_IDENTITY_FIELDS.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}
function validateLifecycleBindingCreate(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "LIFECYCLE_BINDING_INVALID");
  const binding = request.binding;
  invariant(binding && typeof binding === "object" && !Array.isArray(binding), "LIFECYCLE_BINDING_INVALID");
  const value = Object.freeze({
    handoff_id: operationIdentifier(binding.handoff_id, "LIFECYCLE_HANDOFF_INVALID", "handoff_id"),
    replacement_session_id: operationIdentifier(binding.replacement_session_id, "LIFECYCLE_SESSION_INVALID", "replacement_session_id"),
    runner_instance_id: operationIdentifier(binding.runner_instance_id, "LIFECYCLE_RUNNER_INVALID", "runner_instance_id"),
    session_binding_id: operationIdentifier(binding.session_binding_id, "LIFECYCLE_BINDING_ID_INVALID", "session_binding_id"),
    lifecycle_incarnation: lifecycleIncarnation(binding.lifecycle_incarnation)
  });
  return Object.freeze({ binding: value, payload_digest: sha256(Buffer.from(canonicalJson(value), "utf8")) });
}
function validateLifecycleBindingTransition(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "LIFECYCLE_TRANSITION_INVALID");
  const expected = validateLifecycleBindingCreate({ binding: request.expected }).binding;
  invariant(request.expected.status === "ACTIVE" && request.nextStatus === "SUPERSEDED", "LIFECYCLE_TRANSITION_INVALID", "Only ACTIVE to SUPERSEDED is supported");
  invariant(typeof request.reason === "string" && BOUNDED_REASON.test(request.reason), "LIFECYCLE_REASON_INVALID");
  const value = Object.freeze({ expected: Object.freeze({ ...expected, status: "ACTIVE" }), nextStatus: "SUPERSEDED", reason: request.reason });
  return Object.freeze({ ...value, payload_digest: sha256(Buffer.from(canonicalJson(value), "utf8")) });
}
function detachedLifecycleBinding(row, event = null) {
  if (!row) return null;
  return Object.freeze({
    schema_version: "1.0.0",
    ...structuredClone(row),
    event_data: event?.data_json ? JSON.parse(event.data_json) : event?.event_data ? structuredClone(event.event_data) : void 0
  });
}
function requireSecureLifecycleAuthority(authority) {
  invariant(
    authority?.lifecycleSecurity?.mode === LIFECYCLE_AUTHORITY_MODES.SECURE && authority.lifecycleSecurity.canonical === true && authority.lifecycleSecurity.r1_m_13_lifecycle_binding_isolation === true,
    "SECURE_LIFECYCLE_AUTHORITY_REQUIRED",
    "Secure lifecycle cannot use or fall back to portable Runner/session bindings"
  );
  return authority;
}

// src/protected-operation-authority.mjs
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
var require2 = createRequire(typeof __AIOPAGO_OPERATIONAL_ENTRY_URL__ === "string" ? __AIOPAGO_OPERATIONAL_ENTRY_URL__ : import.meta.url);
function secureUnavailable(error, path) {
  if (error instanceof GuardianError) return error;
  return new GuardianError("SECURE_OPERATION_AUTHORITY_UNAVAILABLE", "Protected operation/latch authority is unavailable; portable storage was not consulted", {
    path,
    cause: error?.code ?? error?.message ?? String(error)
  });
}
var ProtectedSqliteOperationAuthority = class {
  #connection;
  constructor(path, { allowInitialize = false, expectedSchema = OPERATION_AUTHORITY_SCHEMA } = {}) {
    this.path = resolve(path);
    this.security = SECURE_OPERATION_AUTHORITY_LABEL;
    this.latchSecurity = SECURE_LATCH_AUTHORITY_LABEL;
    this.handoffSecurity = SECURE_HANDOFF_AUTHORITY_LABEL;
    this.lifecycleSecurity = SECURE_LIFECYCLE_AUTHORITY_LABEL;
    this.schema = expectedSchema;
    const existed = existsSync(this.path);
    invariant(existed || allowInitialize, "SECURE_OPERATION_AUTHORITY_MISSING", "Protected operation/latch database is missing; portable storage was not consulted", { path: this.path });
    try {
      const { DatabaseSync } = require2("node:sqlite");
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
      try {
        this.#connection?.close();
      } catch {
      }
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
      if (!([PREVIOUS_OPERATION_AUTHORITY_SCHEMA, LATCH_OPERATION_AUTHORITY_SCHEMA, HANDOFF_OPERATION_AUTHORITY_SCHEMA].includes(existingMetadata.schema_version) && this.schema === OPERATION_AUTHORITY_SCHEMA)) return;
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
      CREATE INDEX IF NOT EXISTS lifecycle_binding_session_status ON lifecycle_bindings(replacement_session_id,status);
      CREATE INDEX IF NOT EXISTS lifecycle_binding_event_handoff_sequence ON lifecycle_binding_events(handoff_id,sequence);
    `);
    const metadata = db.prepare("SELECT schema_version FROM authority_metadata WHERE singleton=1").get();
    if (!metadata) {
      invariant(allowInitialize && !existed, "SECURE_OPERATION_AUTHORITY_METADATA_MISSING");
      db.prepare("INSERT INTO authority_metadata(singleton,schema_version,created_at) VALUES(1,?,?)").run(this.schema, utcNow());
    } else if ([PREVIOUS_OPERATION_AUTHORITY_SCHEMA, LATCH_OPERATION_AUTHORITY_SCHEMA, HANDOFF_OPERATION_AUTHORITY_SCHEMA].includes(metadata.schema_version) && this.schema === OPERATION_AUTHORITY_SCHEMA) {
      db.prepare("UPDATE authority_metadata SET schema_version=? WHERE singleton=1 AND schema_version=?").run(OPERATION_AUTHORITY_SCHEMA, metadata.schema_version);
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
      lifecycle_bindings: ["handoff_id", "replacement_session_id", "runner_instance_id", "session_binding_id", "lifecycle_incarnation", "status", "bound_at", "bind_event_id", "superseded_at", "superseded_reason", "supersede_event_id"],
      lifecycle_binding_events: ["sequence", "event_id", "request_id", "handoff_id", "replacement_session_id", "runner_instance_id", "session_binding_id", "lifecycle_incarnation", "event_type", "from_status", "status", "reason", "occurred_at"],
      authority_requests: ["request_id", "operation_type", "payload_digest", "result_json", "recorded_at"]
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
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  #recordedRequest(db, requestId, operationType, payloadDigest, conflictCode = "OPERATION_REQUEST_CONFLICT") {
    const prior = db.prepare("SELECT operation_type,payload_digest,result_json FROM authority_requests WHERE request_id=?").get(requestId);
    if (!prior) return null;
    invariant(
      prior.operation_type === operationType && prior.payload_digest === payloadDigest,
      conflictCode,
      "The protected request identity already binds different authority payload"
    );
    return Object.freeze({ ...JSON.parse(prior.result_json), idempotent: true, request_code: "IDEMPOTENT_RECORDED_RESULT" });
  }
  #saveRequest(db, requestId, operationType, payloadDigest, result) {
    db.prepare("INSERT INTO authority_requests(request_id,operation_type,payload_digest,result_json,recorded_at) VALUES(?,?,?,?,?)").run(requestId, operationType, payloadDigest, JSON.stringify(result), utcNow());
  }
  #ensureLatchInTransaction(db, taskId) {
    const prior = db.prepare("SELECT * FROM latches WHERE task_id=?").get(taskId);
    if (prior) return prior;
    const occurredAt = utcNow();
    const eventId = opaqueId("LEV");
    db.prepare("INSERT INTO latch_events(event_id,task_id,event_type,generation,reason,actor,occurred_at) VALUES(?,?,?,?,?,?,?)").run(eventId, taskId, "LATCH_BOOTSTRAPPED", 0, null, "human:bootstrap", occurredAt);
    db.prepare("INSERT INTO latches(task_id,state,generation,released_at,released_by,last_event_id) VALUES(?,?,?,?,?,?)").run(taskId, "RELEASED", 0, occurredAt, "human:bootstrap", eventId);
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
    if (value.expected && (latch.state !== value.expected.state || latch.generation !== value.expected.generation || (latch.reason ?? null) !== value.expected.reason)) {
      throw new GuardianError("LATCH_GENERATION_MISMATCH", "Canonical latch no longer matches the expected safe-point precondition", { expected: value.expected, observed: latch });
    }
    let changedLatch = latch;
    let idempotent = true;
    let requestCode = "IDEMPOTENT_LATCH";
    if (latch.state === "ENGAGED") {
      if (value.reason === "HUMAN_TAKEOVER" && latch.reason !== value.reason) {
        const eventId = opaqueId("LEV");
        const occurredAt = utcNow();
        db.prepare("INSERT INTO latch_events(event_id,request_id,task_id,event_type,generation,from_reason,reason,actor,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)").run(eventId, requestId, value.taskId, "LATCH_ESCALATED", latch.generation, latch.reason, value.reason, value.actor, occurredAt);
        const changed = db.prepare("UPDATE latches SET reason=?,engaged_by=?,last_event_id=? WHERE task_id=? AND state='ENGAGED' AND generation=? AND reason IS ?").run(value.reason, value.actor, eventId, value.taskId, latch.generation, latch.reason);
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
      db.prepare("INSERT INTO latch_events(event_id,request_id,task_id,event_type,generation,reason,actor,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(eventId, requestId, value.taskId, "LATCH_ENGAGED", generation, value.reason, value.actor, occurredAt);
      const changed = db.prepare("UPDATE latches SET state='ENGAGED',generation=?,reason=?,engaged_at=?,engaged_by=?,released_at=NULL,released_by=NULL,last_event_id=? WHERE task_id=? AND state='RELEASED' AND generation=? AND reason IS NULL").run(generation, value.reason, occurredAt, value.actor, eventId, value.taskId, latch.generation);
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
  claimHumanTakeover({ taskId, actor, requestId = void 0, expected = null }) {
    return this.claimLatch({ taskId, reason: "HUMAN_TAKEOVER", actor, requestId, expected });
  }
  assertLatchIdentity(taskId, expected, options = {}) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(assertLatchIdentityValue(this.getLatch(taskId), expected, options));
  }
  isAdmissionOpen(taskId) {
    try {
      return this.getLatch(taskId)?.state === "RELEASED";
    } catch {
      return false;
    }
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
      invariant(
        exact.reservation_digest === payloadDigest && exact.latch_reason === value.expectedLatch.reason && sameHandoffReservationIdentity(existingProjection, projection) && canonicalJson(existingProjection) === canonicalJson(projection),
        "HANDOFF_RESERVATION_CONFLICT",
        "The handoff identity already binds different canonical reservation provenance"
      );
      const result2 = this.#reservationResult(db, projection.handoff_id, false, "IDEMPOTENT_HANDOFF_RESERVATION");
      this.#saveRequest(db, ledgerRequestId, "HANDOFF_RESERVE", payloadDigest, result2);
      return result2;
    }
    const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(projection.task_id);
    if (latch?.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
      throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover committed before protected handoff reservation");
    }
    invariant(
      latch?.state === value.expectedLatch.state && latch.generation === value.expectedLatch.generation && latch.reason === value.expectedLatch.reason,
      "LATCH_GENERATION_MISMATCH",
      "Protected handoff reservation used stale canonical latch identity"
    );
    const active = db.prepare("SELECT handoff_id FROM active_sources WHERE source_session_id=?").get(projection.source_session_id);
    if (active) {
      const existing = this.#reservationRow(db, active.handoff_id);
      throw new GuardianError("HANDOFF_ACTIVE_SOURCE_CONFLICT", "The canonical source session is already reserved by a different handoff operation", {
        source_session_id: projection.source_session_id,
        existing_handoff_id: existing?.handoff_id ?? active.handoff_id,
        requested_handoff_id: projection.handoff_id
      });
    }
    const latest = db.prepare("SELECT handoff_id,reservation_digest FROM handoff_reservations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(projection.task_id) ?? null;
    const expectedLatest = value.expectedLatest;
    invariant(
      latest === null && expectedLatest === null || latest !== null && expectedLatest !== null && latest.handoff_id === expectedLatest.handoff_id && latest.reservation_digest === expectedLatest.reservation_digest,
      "HANDOFF_LATEST_RESERVATION_STALE",
      "Canonical latest handoff reservation changed"
    );
    if (latest) {
      const priorBinding = this.#lifecycleBindingRow(db, latest.handoff_id);
      invariant(
        priorBinding?.status === "ACTIVE" && priorBinding.replacement_session_id === projection.source_session_id && priorBinding.runner_instance_id === projection.runner_instance_id,
        "HANDOFF_TASK_RESERVATION_CONFLICT",
        "The latest protected lifecycle does not authorize this exact active target as the next source",
        {
          task_id: projection.task_id,
          existing_handoff_id: latest.handoff_id
        }
      );
    }
    const eventId = opaqueId("HEV");
    const occurredAt = utcNow();
    db.prepare(`INSERT INTO handoff_reservations(
      handoff_id,source_session_id,task_id,task_plan_revision,task_plan_digest,latch_generation,latch_reason,
      runner_instance_id,recovery_of_handoff_id,checkpoint_id,resume_manifest_id,reservation_digest,reservation_event_id,projection_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      projection.handoff_id,
      projection.source_session_id,
      projection.task_id,
      projection.task_plan_revision,
      projection.task_plan_digest,
      projection.latch_generation,
      value.expectedLatch.reason,
      projection.runner_instance_id,
      projection.recovery_of_handoff_id ?? null,
      projection.checkpoint_id,
      projection.resume_manifest_id,
      payloadDigest,
      eventId,
      JSON.stringify(projection),
      occurredAt
    );
    db.prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)").run(projection.source_session_id, projection.handoff_id);
    if (crashBeforeEvent) process.exit(99);
    db.prepare(`INSERT INTO handoff_reservation_events(
      event_id,request_id,handoff_id,task_id,source_session_id,event_type,latch_generation,latch_reason,occurred_at
    ) VALUES(?,?,?,?,?,'HANDOFF_RESERVED',?,?,?)`).run(
      eventId,
      ledgerRequestId,
      projection.handoff_id,
      projection.task_id,
      projection.source_session_id,
      projection.latch_generation,
      value.expectedLatch.reason,
      occurredAt
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
      invariant(
        latch?.state === expectedLatch?.state && latch.generation === expectedLatch?.generation && (latch.reason ?? null) === (expectedLatch?.reason ?? null),
        "LATCH_GENERATION_MISMATCH",
        "Protected latch changed before owner-gate mutation"
      );
      const latest = db.prepare("SELECT handoff_id,reservation_digest FROM handoff_reservations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId) ?? null;
      invariant(
        latest === null && expectedLatest === null || latest !== null && expectedLatest?.handoff_id === latest.handoff_id && expectedLatest?.reservation_digest === latest.reservation_digest,
        "HANDOFF_LATEST_RESERVATION_STALE",
        "Protected handoff lifecycle changed before owner-gate mutation"
      );
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
  #lifecycleBindingRow(db, handoffId) {
    return db.prepare("SELECT * FROM lifecycle_bindings WHERE handoff_id=?").get(handoffId) ?? null;
  }
  #detachedLifecycleBinding(db, row) {
    if (!row) return null;
    const event = db.prepare("SELECT event_type,reason AS event_reason,occurred_at FROM lifecycle_binding_events WHERE event_id=? AND handoff_id=?").get(row.bind_event_id, row.handoff_id);
    invariant(event?.event_type === "RUNNER_SESSION_BOUND", "LIFECYCLE_BINDING_EVENT_MISMATCH");
    return detachedLifecycleBinding(row, { event_data: {
      handoff_id: row.handoff_id,
      replacement_session_id: row.replacement_session_id,
      runner_instance_id: row.runner_instance_id,
      session_binding_id: row.session_binding_id,
      lifecycle_incarnation: row.lifecycle_incarnation
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
      invariant(
        reservation.runner_instance_id === value.binding.runner_instance_id && projection.session_binding_id === value.binding.session_binding_id,
        "LIFECYCLE_RESERVATION_MISMATCH",
        "Binding identity does not match its protected reservation"
      );
      const prior = this.#lifecycleBindingRow(db, value.binding.handoff_id);
      if (prior) {
        invariant(
          prior.status === "ACTIVE" && sameLifecycleBindingIdentity(prior, value.binding),
          "LIFECYCLE_BINDING_CONFLICT",
          "The protected handoff already binds a different lifecycle identity"
        );
        const result2 = { binding: this.#detachedLifecycleBinding(db, prior), created: false, idempotent: true, request_code: "IDEMPOTENT_LIFECYCLE_BINDING" };
        this.#saveRequest(db, ledgerRequestId, "LIFECYCLE_BIND", value.payload_digest, result2);
        return Object.freeze(result2);
      }
      const sessionConflict = db.prepare("SELECT handoff_id FROM lifecycle_bindings WHERE replacement_session_id=? OR session_binding_id=? LIMIT 1").get(value.binding.replacement_session_id, value.binding.session_binding_id);
      invariant(!sessionConflict, "LIFECYCLE_BINDING_CONFLICT", "Session or binding identity is already canonical for another handoff");
      const eventId = opaqueId("BEV");
      const occurredAt = utcNow();
      db.prepare(`INSERT INTO lifecycle_bindings(
        handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,status,bound_at,bind_event_id
      ) VALUES(?,?,?,?,?,'ACTIVE',?,?)`).run(
        value.binding.handoff_id,
        value.binding.replacement_session_id,
        value.binding.runner_instance_id,
        value.binding.session_binding_id,
        value.binding.lifecycle_incarnation,
        occurredAt,
        eventId
      );
      db.prepare(`INSERT INTO lifecycle_binding_events(
        event_id,request_id,handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,event_type,from_status,status,reason,occurred_at
      ) VALUES(?,?,?,?,?,?,?,'RUNNER_SESSION_BOUND',NULL,'ACTIVE',NULL,?)`).run(
        eventId,
        ledgerRequestId,
        value.binding.handoff_id,
        value.binding.replacement_session_id,
        value.binding.runner_instance_id,
        value.binding.session_binding_id,
        value.binding.lifecycle_incarnation,
        occurredAt
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
      invariant(
        prior && sameLifecycleBindingIdentity(prior, value.expected),
        "LIFECYCLE_BINDING_STALE",
        "Expected protected lifecycle identity is stale or absent"
      );
      if (prior.status === "SUPERSEDED") {
        invariant(prior.superseded_reason === value.reason, "LIFECYCLE_TRANSITION_CONFLICT", "Protected lifecycle already has different terminal provenance");
        const result2 = { binding: this.#detachedLifecycleBinding(db, prior), transitioned: false, idempotent: true, request_code: "IDEMPOTENT_LIFECYCLE_TRANSITION" };
        this.#saveRequest(db, ledgerRequestId, "LIFECYCLE_TRANSITION", value.payload_digest, result2);
        return Object.freeze(result2);
      }
      invariant(prior.status === "ACTIVE", "LIFECYCLE_TRANSITION_INVALID");
      const eventId = opaqueId("BEV");
      const occurredAt = utcNow();
      const changed = db.prepare("UPDATE lifecycle_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=?,supersede_event_id=? WHERE handoff_id=? AND status='ACTIVE' AND lifecycle_incarnation=?").run(occurredAt, value.reason, eventId, prior.handoff_id, prior.lifecycle_incarnation);
      invariant(changed.changes === 1, "LIFECYCLE_BINDING_STALE", "Protected lifecycle transition raced");
      db.prepare(`INSERT INTO lifecycle_binding_events(
        event_id,request_id,handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,event_type,from_status,status,reason,occurred_at
      ) VALUES(?,?,?,?,?,?,?,'RUNNER_SESSION_BINDING_SUPERSEDED','ACTIVE','SUPERSEDED',?,?)`).run(
        eventId,
        ledgerRequestId,
        prior.handoff_id,
        prior.replacement_session_id,
        prior.runner_instance_id,
        prior.session_binding_id,
        prior.lifecycle_incarnation,
        value.reason,
        occurredAt
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
        const result2 = { operation: prior, idempotent: true, request_code: "IDEMPOTENT_OPERATION" };
        this.#saveRequest(db, requestId, "OPERATION_ADMIT", payloadDigest, result2);
        return Object.freeze(result2);
      }
      const latch = db.prepare("SELECT * FROM latches WHERE task_id=?").get(value.taskId);
      invariant(latch, "SECURE_LATCH_MISSING", "Protected operation admission requires an initialized canonical latch");
      if (latch.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER") {
        throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover committed before operation admission");
      }
      invariant(latch.state === "RELEASED", "TOOL_ADMISSION_BLOCKED", "Canonical latch is engaged");
      invariant(latch.generation === value.generation, "LATCH_GENERATION_MISMATCH", "Operation admission used a stale canonical latch generation", { expected: value.generation, observed: latch.generation });
      const admittedAt = utcNow();
      db.prepare("INSERT INTO operations(operation_id,task_id,latch_generation,profile,state,admitted_at,admission_digest) VALUES(?,?,?,?,?,?,?)").run(value.operationId, value.taskId, value.generation, value.profile, "ACTIVE", admittedAt, payloadDigest);
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
        const result2 = { operation: prior, idempotent: true, request_code: "IDEMPOTENT_OPERATION" };
        this.#saveRequest(db, requestId, "OPERATION_TERMINAL", payloadDigest, result2);
        return Object.freeze(result2);
      }
      const terminalAt = utcNow();
      const changed = db.prepare("UPDATE operations SET state='TERMINAL',outcome=?,effect_reference=?,terminal_at=?,terminal_digest=? WHERE operation_id=? AND state='ACTIVE'").run(value.outcome, value.effectReference, terminalAt, payloadDigest, value.operationId);
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
    return Object.freeze({ ...this.security, latch_canonical: true, handoff_reservation_canonical: true, lifecycle_binding_canonical: true, schema: metadata.schema_version, journal_mode: String(journal.journal_mode).toUpperCase(), path: this.path });
  }
  crashBeforeTerminalCommitForPhysicalTest(operationId, outcome, effectReference = null) {
    const value = validateOperationTerminal(operationId, outcome, effectReference);
    const payloadDigest = sha256(Buffer.from(canonicalJson(value), "utf8"));
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    const prior = db.prepare("SELECT state FROM operations WHERE operation_id=?").get(value.operationId);
    invariant(prior?.state === "ACTIVE", "OPERATION_CRASH_SEAM_INVALID");
    db.prepare("UPDATE operations SET state='TERMINAL',outcome=?,effect_reference=?,terminal_at=?,terminal_digest=? WHERE operation_id=?").run(value.outcome, value.effectReference, utcNow(), payloadDigest, value.operationId);
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
    db.prepare("UPDATE lifecycle_bindings SET status='SUPERSEDED',superseded_at=?,superseded_reason=?,supersede_event_id=? WHERE handoff_id=? AND status='ACTIVE'").run(occurredAt, value.reason, eventId, prior.handoff_id);
    db.prepare(`INSERT INTO lifecycle_binding_events(
      event_id,request_id,handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,event_type,from_status,status,reason,occurred_at
    ) VALUES(?,?,?,?,?,?,?,'RUNNER_SESSION_BINDING_SUPERSEDED','ACTIVE','SUPERSEDED',?,?)`).run(
      eventId,
      `lifecycle-transition:${requestId}`,
      prior.handoff_id,
      prior.replacement_session_id,
      prior.runner_instance_id,
      prior.session_binding_id,
      prior.lifecycle_incarnation,
      value.reason,
      occurredAt
    );
    process.exit(100);
  }
  close() {
    const db = this.#database();
    this.#connection = null;
    db.close();
  }
};

// src/safety.mjs
var TOOL_PROFILES = Object.freeze({
  read: "READ_ONLY",
  grep: "READ_ONLY",
  find: "READ_ONLY",
  ls: "READ_ONLY",
  edit: "LOCAL_ATOMIC_MUTATION",
  write: "LOCAL_ATOMIC_MUTATION",
  bash: "SHELL_ATOMIC_OPERATION"
});
function shellEffectReference(toolCallId) {
  return `shell:${sha256(Buffer.from(toolCallId, "utf8"))}`;
}
function bashTerminalOutcome(isError, result, interrupted) {
  if (interrupted) return "UNKNOWN";
  if (typeof isError !== "boolean" || !result || !Array.isArray(result.content)) return "UNKNOWN";
  if (!isError) return "KNOWN_SUCCESS";
  const text = result.content.filter((entry) => entry?.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("\n");
  if (text === "Command aborted" || text.endsWith("\n\nCommand aborted")) return "UNKNOWN";
  return "KNOWN_FAILURE";
}
var ToolOperationTracker = class {
  constructor(storage, taskId, { operationAuthority = null, latchAuthority = null } = {}) {
    this.storage = storage;
    this.operationAuthority = operationAuthority ?? portableOperationAuthority(storage);
    this.latchAuthority = latchAuthority ?? portableLatchAuthority(storage);
    if (this.operationAuthority.security?.mode === "SECURE") {
      requireSecureLatchAuthority(this.latchAuthority);
      invariant(
        this.operationAuthority === this.latchAuthority,
        "SECURE_ADMISSION_TRANSACTION_REQUIRED",
        "Secure operation admission and latch arbitration must share one protected transaction"
      );
    }
    this.authoritySecurity = this.operationAuthority.security;
    this.taskId = taskId;
    this.admittedTools = /* @__PURE__ */ new Map();
    this.effectReferences = /* @__PURE__ */ new Map();
  }
  admit(toolCallId, toolName, input = {}) {
    const profile = TOOL_PROFILES[toolName];
    invariant(profile, "TOOL_PROFILE_REQUIRED", `Tool ${toolName} is outside the M1-H0 allowlist`);
    const latch = this.latchAuthority.ensureLatch(this.taskId);
    this.operationAuthority.admitOperation({ operationId: toolCallId, taskId: this.taskId, generation: latch.generation, profile });
    this.admittedTools.set(toolCallId, toolName);
    if (toolName === "bash") {
      this.effectReferences.set(toolCallId, shellEffectReference(toolCallId));
    } else if (profile !== "READ_ONLY" && typeof input.path === "string" && input.path.length > 0) {
      this.effectReferences.set(toolCallId, `file:${input.path.replaceAll("\\", "/")}`);
    }
  }
  finish(toolCallId, isError, result = void 0, interrupted = false) {
    const toolName = this.admittedTools.get(toolCallId);
    const outcome = toolName === "bash" ? bashTerminalOutcome(isError, result, interrupted) : isError ? "KNOWN_FAILURE" : "KNOWN_SUCCESS";
    const effectReference = outcome === "KNOWN_SUCCESS" ? this.effectReferences.get(toolCallId) ?? null : null;
    this.admittedTools.delete(toolCallId);
    this.effectReferences.delete(toolCallId);
    this.operationAuthority.finishOperation(toolCallId, outcome, effectReference);
  }
  unknown(toolCallId) {
    this.admittedTools.delete(toolCallId);
    this.effectReferences.delete(toolCallId);
    this.operationAuthority.finishOperation(toolCallId, "UNKNOWN");
  }
};

// src/operation-authority-worker.mjs
async function operationAuthorityWorkerEntrypoint() {
  const MAX_FRAME_BYTES = 262144;
  const MAX_REQUESTS = 128;
  const SERVICE_NAME = /^AiopagoOperationAuthority(?:Test-[A-Za-z0-9-]{1,64})?$/;
  const SERVICE_SID = /^S-1-5-80-(?:\d+-){4}\d+$/;
  const CAPABILITY = /^[a-f0-9]{64}$/;
  const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let capability = null;
  let authority = null;
  let requestCount = 0;
  const trackers = /* @__PURE__ */ new Map();
  function output(value) {
    process.stdout.write(`${JSON.stringify(value)}
`);
  }
  async function readFrame() {
    const item = await iterator.next();
    if (item.done) throw Object.assign(new Error("PRIVATE_CHANNEL_CLOSED"), { code: "PRIVATE_CHANNEL_CLOSED" });
    if (Buffer.byteLength(item.value, "utf8") > MAX_FRAME_BYTES) throw Object.assign(new Error("FRAME_TOO_LARGE"), { code: "FRAME_TOO_LARGE" });
    let value;
    try {
      value = JSON.parse(item.value);
    } catch {
      throw Object.assign(new Error("FRAME_JSON_INVALID"), { code: "FRAME_JSON_INVALID" });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("FRAME_INVALID"), { code: "FRAME_INVALID" });
    return value;
  }
  function fail2(code, message = code) {
    throw Object.assign(new Error(message), { code });
  }
  function identifier(value, code) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value)) fail2(code);
    return value;
  }
  function tracker(taskId) {
    let value = trackers.get(taskId);
    if (!value) {
      authority.ensureLatch(taskId);
      value = new ToolOperationTracker(authority, taskId, {
        operationAuthority: requireSecureOperationAuthority(authority),
        latchAuthority: requireSecureLatchAuthority(authority)
      });
      trackers.set(taskId, value);
    }
    return value;
  }
  function requireServiceSid(systemDirectory, expectedSid) {
    if (process.platform !== "win32" || typeof systemDirectory !== "string" || !/^[A-Za-z]:\\Windows\\System32$/i.test(systemDirectory)) fail2("WINDOWS_SERVICE_IDENTITY_REQUIRED");
    let groups;
    try {
      groups = execFileSync(join(systemDirectory, "whoami.exe"), ["/groups", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5e3
      });
    } catch {
      fail2("WINDOWS_SERVICE_IDENTITY_UNAVAILABLE");
    }
    if (!groups.includes(`"${expectedSid}"`)) fail2("WINDOWS_SERVICE_IDENTITY_MISMATCH");
  }
  function operationResult(operation) {
    return operation ? {
      operation_id: operation.operation_id,
      task_id: operation.task_id,
      latch_generation: operation.latch_generation,
      profile: operation.profile,
      state: operation.state,
      outcome: operation.outcome,
      effect_reference: operation.effect_reference,
      admitted_at: operation.admitted_at,
      terminal_at: operation.terminal_at
    } : null;
  }
  function latchResult(latch) {
    return latch ? {
      task_id: latch.task_id,
      state: latch.state,
      generation: latch.generation,
      reason: latch.reason,
      engaged_at: latch.engaged_at,
      engaged_by: latch.engaged_by,
      released_at: latch.released_at,
      released_by: latch.released_by,
      last_event_id: latch.last_event_id
    } : null;
  }
  function handoffResult(reservation) {
    return reservation ? {
      ...reservation,
      reserved_plan_snapshot: reservation.reserved_plan_snapshot ?? null,
      expected_git_state: reservation.expected_git_state ?? null
    } : null;
  }
  function lifecycleBindingResult(binding) {
    return binding ? {
      handoff_id: binding.handoff_id,
      replacement_session_id: binding.replacement_session_id,
      runner_instance_id: binding.runner_instance_id,
      session_binding_id: binding.session_binding_id,
      lifecycle_incarnation: binding.lifecycle_incarnation,
      status: binding.status,
      bound_at: binding.bound_at,
      bind_event_id: binding.bind_event_id,
      superseded_at: binding.superseded_at,
      superseded_reason: binding.superseded_reason,
      supersede_event_id: binding.supersede_event_id,
      event_data: binding.event_data,
      schema_version: binding.schema_version
    } : null;
  }
  async function dispatch(frame, hello) {
    if (frame.version !== 1 || frame.protocol !== OPERATION_AUTHORITY_PROTOCOL || frame.capability !== capability) fail2("PRIVATE_FRAME_BINDING_REJECTED");
    const requestId = identifier(frame.requestId, "REQUEST_ID_INVALID");
    const payload = frame.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail2("REQUEST_PAYLOAD_INVALID");
    requestCount += 1;
    if (requestCount > MAX_REQUESTS) fail2("SESSION_REQUEST_LIMIT_EXCEEDED");
    let result;
    switch (frame.operationType) {
      case "OPERATION_ADMIT_TOOL": {
        const taskId = identifier(payload.taskId, "OPERATION_TASK_INVALID");
        const operationId = identifier(payload.operationId, "OPERATION_ID_INVALID");
        identifier(payload.toolName, "TOOL_NAME_INVALID");
        const expectedGeneration = payload.generation;
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) fail2("OPERATION_GENERATION_INVALID");
        const latch = authority.getLatch(taskId) ?? authority.ensureLatch(taskId);
        if (latch.generation !== expectedGeneration) fail2("LATCH_GENERATION_MISMATCH");
        tracker(taskId).admit(operationId, payload.toolName, payload.input ?? {});
        result = operationResult(authority.getOperation(operationId));
        break;
      }
      case "OPERATION_FINISH_TOOL": {
        const taskId = identifier(payload.taskId, "OPERATION_TASK_INVALID");
        const operationId = identifier(payload.operationId, "OPERATION_ID_INVALID");
        tracker(taskId).finish(operationId, payload.isError, payload.result, payload.interrupted === true);
        result = operationResult(authority.getOperation(operationId));
        break;
      }
      case "OPERATION_MARK_UNKNOWN": {
        const taskId = identifier(payload.taskId, "OPERATION_TASK_INVALID");
        const operationId = identifier(payload.operationId, "OPERATION_ID_INVALID");
        tracker(taskId).unknown(operationId);
        result = operationResult(authority.getOperation(operationId));
        break;
      }
      case "LATCH_ENSURE":
        result = latchResult(authority.ensureLatch(identifier(payload.taskId, "LATCH_TASK_INVALID")));
        break;
      case "LATCH_GET":
        result = latchResult(authority.getLatch(identifier(payload.taskId, "LATCH_TASK_INVALID")));
        break;
      case "LATCH_CLAIM_HUMAN_TAKEOVER": {
        const request = authority.requestLatchClaim(requestId, {
          taskId: payload.taskId,
          reason: "HUMAN_TAKEOVER",
          actor: payload.actor,
          expected: payload.expected ?? null
        });
        result = { ...request, latch: latchResult(request.latch) };
        break;
      }
      case "LATCH_CLAIM_SAFEPOINT": {
        if (payload.reason === "HUMAN_TAKEOVER") fail2("LATCH_SAFEPOINT_REASON_INVALID");
        const request = authority.requestLatchClaim(requestId, {
          taskId: payload.taskId,
          reason: payload.reason,
          actor: payload.actor,
          expected: payload.expected ?? null
        });
        result = { ...request, latch: latchResult(request.latch) };
        break;
      }
      case "LATCH_ASSERT":
        result = latchResult(authority.assertLatchIdentity(payload.taskId, payload.expected, { allowHumanTakeover: payload.allowHumanTakeover === true }));
        break;
      case "HANDOFF_RESERVE": {
        const reserved = authority.requestHandoffReservation(requestId, {
          projection: payload.projection,
          expectedLatch: payload.expectedLatch,
          expectedLatest: payload.expectedLatest ?? null
        });
        result = {
          ...reserved,
          reservation: handoffResult(authority.getHandoffReservation(payload.projection?.handoff_id))
        };
        break;
      }
      case "HANDOFF_GET":
        result = handoffResult(authority.getHandoffReservation(payload.handoffId));
        break;
      case "HANDOFF_LATEST_TASK":
        result = handoffResult(authority.latestHandoffReservationForTask(payload.taskId));
        break;
      case "ACTIVE_SOURCE_GET":
        result = authority.getActiveSource(payload.sourceSessionId);
        break;
      case "LIFECYCLE_BIND_CREATE": {
        const created = authority.requestLifecycleBindingCreate(requestId, { binding: payload.binding });
        result = { ...created, binding: lifecycleBindingResult(created.binding) };
        break;
      }
      case "LIFECYCLE_BIND_GET":
        result = lifecycleBindingResult(authority.getLifecycleBinding(payload.handoffId));
        break;
      case "LIFECYCLE_BIND_GET_SESSION":
        result = lifecycleBindingResult(authority.getLifecycleBindingBySession(payload.sessionId));
        break;
      case "LIFECYCLE_BIND_TRANSITION": {
        const transitioned = authority.requestLifecycleBindingTransition(requestId, {
          expected: payload.expected,
          nextStatus: payload.nextStatus,
          reason: payload.reason
        });
        result = { ...transitioned, binding: lifecycleBindingResult(transitioned.binding) };
        break;
      }
      case "LIFECYCLE_BIND_EVENTS":
        result = authority.lifecycleBindingEvents(payload.handoffId);
        break;
      case "OPERATION_RETRY_ADMISSION": {
        result = authority.admitOperation({
          operationId: payload.operationId,
          taskId: payload.taskId,
          generation: payload.generation,
          profile: payload.profile
        });
        result = { ...result, operation: operationResult(result.operation) };
        break;
      }
      case "OPERATION_RETRY_TERMINAL": {
        result = authority.finishOperation(payload.operationId, payload.outcome, payload.effectReference ?? null);
        result = { ...result, operation: operationResult(result.operation) };
        break;
      }
      case "OPERATION_GET":
        result = operationResult(authority.getOperation(payload.operationId));
        break;
      case "OPERATION_LIST_TASK":
        result = authority.operationsForTask(payload.taskId).map(operationResult);
        break;
      case "TEST_CRASH_BEFORE_TERMINAL_COMMIT":
        if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail2("TEST_OPERATION_FORBIDDEN");
        authority.crashBeforeTerminalCommitForPhysicalTest(payload.operationId, payload.outcome, payload.effectReference ?? null);
        fail2("CRASH_SEAM_RETURNED");
        break;
      case "TEST_CRASH_BEFORE_LATCH_COMMIT":
        if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail2("TEST_OPERATION_FORBIDDEN");
        authority.crashBeforeLatchCommitForPhysicalTest(requestId, {
          taskId: payload.taskId,
          reason: payload.reason,
          actor: payload.actor,
          expected: payload.expected ?? null
        });
        fail2("CRASH_SEAM_RETURNED");
        break;
      case "TEST_CRASH_BEFORE_HANDOFF_COMMIT":
        if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail2("TEST_OPERATION_FORBIDDEN");
        authority.crashBeforeHandoffCommitForPhysicalTest(requestId, {
          projection: payload.projection,
          expectedLatch: payload.expectedLatch,
          expectedLatest: payload.expectedLatest ?? null
        });
        fail2("CRASH_SEAM_RETURNED");
        break;
      case "TEST_CRASH_BEFORE_LIFECYCLE_COMMIT":
        if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail2("TEST_OPERATION_FORBIDDEN");
        authority.crashBeforeLifecycleTransitionCommitForPhysicalTest(requestId, {
          expected: payload.expected,
          nextStatus: payload.nextStatus,
          reason: payload.reason
        });
        fail2("CRASH_SEAM_RETURNED");
        break;
      case "TEST_AUTHORITY_TIMEOUT":
        if (hello.testScope !== true || !hello.serviceName.startsWith("AiopagoOperationAuthorityTest-")) fail2("TEST_OPERATION_FORBIDDEN");
        await new Promise(() => {
        });
        break;
      default:
        fail2("OPERATION_TYPE_INVALID");
    }
    return { version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, requestId, operationType: "OPERATION_RESULT", ok: true, result };
  }
  try {
    const hello = await readFrame();
    if (hello.version !== 1 || hello.protocol !== OPERATION_AUTHORITY_PROTOCOL || hello.operationType !== "SESSION_BIND" || !CAPABILITY.test(hello.capability ?? "") || hello.p1Pid !== process.ppid || hello.p2Pid !== process.pid || !SERVICE_NAME.test(hello.serviceName ?? "") || !SERVICE_SID.test(hello.serviceSid ?? "") || !/^[a-f0-9]{64}$/.test(hello.identityFingerprint ?? "") || typeof hello.canonicalPath !== "string" || typeof hello.allowInitialize !== "boolean") fail2("SESSION_BIND_REJECTED");
    requireServiceSid(hello.systemDirectory, hello.serviceSid);
    capability = hello.capability;
    authority = new ProtectedSqliteOperationAuthority(hello.canonicalPath, { allowInitialize: hello.allowInitialize });
    requireSecureOperationAuthority(authority);
    requireSecureLatchAuthority(authority);
    requireSecureHandoffAuthority(authority);
    requireSecureLifecycleAuthority(authority);
    output({ version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, operationType: "SESSION_READY", capability, p2Pid: process.pid, authority: authority.status() });
    while (true) {
      const frame = await readFrame();
      if (frame.operationType === "SESSION_END") {
        if (frame.version !== 1 || frame.protocol !== OPERATION_AUTHORITY_PROTOCOL || frame.capability !== capability) fail2("PRIVATE_FRAME_BINDING_REJECTED");
        output({ version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, operationType: "SESSION_COMPLETE", requestCount, authority: authority.status() });
        break;
      }
      try {
        output(await dispatch(frame, hello));
      } catch (error) {
        output({ version: 1, protocol: OPERATION_AUTHORITY_PROTOCOL, requestId: frame.requestId ?? null, operationType: "OPERATION_RESULT", ok: false, error: { code: error?.code ?? "OPERATION_AUTHORITY_FAILED", message: error?.message ?? String(error) } });
      }
    }
    authority.close();
    lines.close();
  } catch (error) {
    try {
      authority?.close();
    } catch {
    }
    process.stderr.write(`operation-authority-worker: ${error?.code ?? "FAILED"}: ${error?.message ?? String(error)}
`);
    process.exitCode = 2;
  }
}
if (process.env.AIOPAGO_PROTECTED_OPERATION_WORKER === "1") await operationAuthorityWorkerEntrypoint();
