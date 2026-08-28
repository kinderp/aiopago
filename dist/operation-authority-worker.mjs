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
var OPERATION_AUTHORITY_SCHEMA = "aiopago.operation-authority/1.0.0";
var OPERATION_AUTHORITY_PROTOCOL = "aiopago.operation-authority-protocol/1";
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

// src/protected-operation-authority.mjs
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

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
function utcNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// src/protected-operation-authority.mjs
var require2 = createRequire(typeof __AIOPAGO_OPERATIONAL_ENTRY_URL__ === "string" ? __AIOPAGO_OPERATIONAL_ENTRY_URL__ : import.meta.url);
function secureUnavailable(error, path) {
  if (error instanceof GuardianError) return error;
  return new GuardianError("SECURE_OPERATION_AUTHORITY_UNAVAILABLE", "Protected operation authority is unavailable; portable storage was not consulted", {
    path,
    cause: error?.code ?? error?.message ?? String(error)
  });
}
var ProtectedSqliteOperationAuthority = class {
  #connection;
  constructor(path, { allowInitialize = false, expectedSchema = OPERATION_AUTHORITY_SCHEMA } = {}) {
    this.path = resolve(path);
    this.security = SECURE_OPERATION_AUTHORITY_LABEL;
    this.schema = expectedSchema;
    const existed = existsSync(this.path);
    invariant(existed || allowInitialize, "SECURE_OPERATION_AUTHORITY_MISSING", "Protected operation database is missing; portable storage was not consulted", { path: this.path });
    try {
      const { DatabaseSync } = require2("node:sqlite");
      this.#connection = new DatabaseSync(this.path);
      this.#connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000;");
      this.#migrate(allowInitialize, existed);
      const integrity = this.#connection.prepare("PRAGMA integrity_check").get();
      invariant(integrity?.integrity_check === "ok", "SECURE_OPERATION_AUTHORITY_INTEGRITY_FAILED");
      const metadata = this.#connection.prepare("SELECT schema_version FROM authority_metadata WHERE singleton=1").get();
      invariant(metadata?.schema_version === expectedSchema, "SECURE_OPERATION_AUTHORITY_VERSION_MISMATCH", `${metadata?.schema_version ?? "MISSING"} != ${expectedSchema}`);
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
      CREATE TABLE IF NOT EXISTS authority_requests(
        request_id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operation_task_state ON operations(task_id,state,admitted_at);
    `);
    const metadata = db.prepare("SELECT schema_version FROM authority_metadata WHERE singleton=1").get();
    if (!metadata) {
      invariant(allowInitialize && !existed, "SECURE_OPERATION_AUTHORITY_METADATA_MISSING");
      db.prepare("INSERT INTO authority_metadata(singleton,schema_version,created_at) VALUES(1,?,?)").run(this.schema, utcNow());
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
  #recordedRequest(db, requestId, operationType, payloadDigest) {
    const prior = db.prepare("SELECT operation_type,payload_digest,result_json FROM authority_requests WHERE request_id=?").get(requestId);
    if (!prior) return null;
    invariant(
      prior.operation_type === operationType && prior.payload_digest === payloadDigest,
      "OPERATION_REQUEST_CONFLICT",
      "The protected request identity already binds different operation payload"
    );
    return Object.freeze({ ...JSON.parse(prior.result_json), idempotent: true, request_code: "IDEMPOTENT_RECORDED_RESULT" });
  }
  #saveRequest(db, requestId, operationType, payloadDigest, result) {
    db.prepare("INSERT INTO authority_requests(request_id,operation_type,payload_digest,result_json,recorded_at) VALUES(?,?,?,?,?)").run(requestId, operationType, payloadDigest, JSON.stringify(result), utcNow());
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
    return Object.freeze({ ...this.security, schema: metadata.schema_version, journal_mode: String(journal.journal_mode).toUpperCase(), path: this.path });
  }
  // Test-only physical crash seam. The service worker permits it only for a
  // scoped test service. The update is made inside the real production SQLite
  // transaction and the process exits without COMMIT.
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
  constructor(storage, taskId, { operationAuthority = null } = {}) {
    this.storage = storage;
    this.operationAuthority = operationAuthority ?? portableOperationAuthority(storage);
    this.authoritySecurity = this.operationAuthority.security;
    this.taskId = taskId;
    this.admittedTools = /* @__PURE__ */ new Map();
    this.effectReferences = /* @__PURE__ */ new Map();
  }
  admit(toolCallId, toolName, input = {}) {
    const profile = TOOL_PROFILES[toolName];
    invariant(profile, "TOOL_PROFILE_REQUIRED", `Tool ${toolName} is outside the M1-H0 allowlist`);
    const latch = this.storage.ensureLatch(this.taskId);
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
  const MAX_FRAME_BYTES = 65536;
  const MAX_REQUESTS = 128;
  const SERVICE_NAME = /^AiopagoOperationAuthority(?:Test-[A-Za-z0-9-]{1,64})?$/;
  const SERVICE_SID = /^S-1-5-80-(?:\d+-){4}\d+$/;
  const CAPABILITY = /^[a-f0-9]{64}$/;
  const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let capability = null;
  let authority = null;
  let requestCount = 0;
  const generations = /* @__PURE__ */ new Map();
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
  function tracker(taskId, generation = null) {
    if (generation !== null) {
      if (!Number.isSafeInteger(generation) || generation < 0) fail2("OPERATION_GENERATION_INVALID");
      generations.set(taskId, generation);
    }
    let value = trackers.get(taskId);
    if (!value) {
      const latch = { ensureLatch(requestedTask) {
        if (requestedTask !== taskId || !generations.has(taskId)) fail2("PRIVATE_LATCH_BINDING_MISSING");
        return { task_id: taskId, state: "RELEASED", generation: generations.get(taskId), reason: null };
      } };
      value = new ToolOperationTracker(latch, taskId, { operationAuthority: requireSecureOperationAuthority(authority) });
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
        tracker(taskId, payload.generation).admit(operationId, payload.toolName, payload.input ?? {});
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
