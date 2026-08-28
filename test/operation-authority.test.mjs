import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  OPERATION_AUTHORITY_MODES,
  portableOperationAuthority,
  requireSecureOperationAuthority,
} from "../src/operation-authority.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { SafePointCoordinator, ToolOperationTracker } from "../src/safety.mjs";
import { GuardianStorage, claimLatchForInternalTest, storageDatabaseForInternalTest } from "../src/storage.mjs";

function root() { return mkdtempSync(join(tmpdir(), "aiopago-operation-authority-")); }
function releasedLatch(generation = 0) {
  return { ensureLatch(taskId) { return { task_id: taskId, state: "RELEASED", generation, reason: null }; } };
}

test("Windows provisioning hardens the empty root before protected bytes, service registration, or first secret", () => {
  const provision = readFileSync(new URL("../service/windows-operation-authority/provision-test-service.ps1", import.meta.url), "utf8");
  const harden = provision.indexOf("ProtectDirectory $Root");
  const negative = provision.indexOf("$probe=Get-Content");
  const copy = provision.indexOf("Copy-Item -LiteralPath $BrokerSource");
  const create = provision.indexOf("Native $sc @('create'");
  assert.ok(harden >= 0 && harden < negative && negative < copy && copy < create);
  assert.equal(/identity\.bin|operations\.sqlite/.test(provision), false, "installer must not create private key/canonical DB bytes");
  assert.match(provision, /OWNER RIGHTS deny removes the owner's implicit WRITE_DAC/);

  const service = readFileSync(new URL("../service/windows-operation-authority/OperationAuthorityService.cs", import.meta.url), "utf8");
  assert.ok(service.indexOf("SERVICE_IDENTITY_MISMATCH") < service.indexOf("RandomNumberGenerator random"), "P1S identity must be checked before first key material");
});

test("operation authority modes are explicit and secure mode cannot accept portable storage", () => {
  const area = root();
  const storage = new GuardianStorage(join(area, "project", "guardian.sqlite"));
  const portable = portableOperationAuthority(storage);
  assert.deepEqual(portable.security, {
    mode: "PORTABLE", canonical: false, isolation: "ORDINARY_USER_OWNED", r1_m_13_operation_isolation: false,
  });
  assert.equal(portable.security.mode, OPERATION_AUTHORITY_MODES.PORTABLE);
  assert.throws(() => requireSecureOperationAuthority(portable), (error) => error.code === "SECURE_OPERATION_AUTHORITY_REQUIRED");
  storage.close();

  const missing = join(area, "protected", "operations.sqlite");
  assert.throws(
    () => new ProtectedSqliteOperationAuthority(missing),
    (error) => error.code === "SECURE_OPERATION_AUTHORITY_MISSING" && /portable storage was not consulted/.test(error.message),
  );
  assert.equal(existsSync(missing), false, "fail-closed startup must not create or consult portable state");
});

test("protected operation authority preserves Tracker profiles, outcomes, idempotency, and conflicts", () => {
  const area = root();
  const canonical = join(area, "canonical");
  mkdirSync(canonical);
  const authority = new ProtectedSqliteOperationAuthority(join(canonical, "operations.sqlite"), { allowInitialize: true });
  assert.equal(requireSecureOperationAuthority(authority), authority);
  assert.deepEqual(authority.status(), {
    mode: "SECURE", canonical: true, isolation: "OS_PROTECTED_DISTINCT_IDENTITY", r1_m_13_operation_isolation: true,
    schema: "aiopago.operation-authority/1.0.0", journal_mode: "WAL", path: join(canonical, "operations.sqlite"),
  });

  const tracker = new ToolOperationTracker(releasedLatch(7), "TASK-SECURE", { operationAuthority: authority });
  assert.equal(tracker.authoritySecurity.mode, "SECURE");
  tracker.admit("OP-READ", "read", { path: "attacker-readable.txt" });
  tracker.finish("OP-READ", false, { content: [{ type: "text", text: "ok" }] });
  const read = authority.getOperation("OP-READ");
  assert.equal(read.state, "TERMINAL");
  assert.equal(read.outcome, "KNOWN_SUCCESS");
  assert.equal(read.profile, "READ_ONLY");
  assert.equal(read.effect_reference, null);
  assert.equal(read.latch_generation, 7);

  const exactAdmission = authority.admitOperation({ operationId: "OP-READ", taskId: "TASK-SECURE", generation: 7, profile: "READ_ONLY" });
  assert.equal(exactAdmission.idempotent, true);
  assert.equal(exactAdmission.request_code, "IDEMPOTENT_RECORDED_RESULT");
  assert.throws(
    () => authority.admitOperation({ operationId: "OP-READ", taskId: "TASK-OTHER", generation: 7, profile: "READ_ONLY" }),
    (error) => error.code === "OPERATION_REQUEST_CONFLICT",
  );
  const exactTerminal = authority.finishOperation("OP-READ", "KNOWN_SUCCESS", null);
  assert.equal(exactTerminal.idempotent, true);
  assert.equal(exactTerminal.request_code, "IDEMPOTENT_RECORDED_RESULT");
  assert.throws(() => authority.finishOperation("OP-READ", "KNOWN_FAILURE", null), (error) => error.code === "OPERATION_REQUEST_CONFLICT");

  tracker.admit("OP-EDIT", "edit", { path: "src\\exact.txt" });
  tracker.finish("OP-EDIT", false);
  assert.equal(authority.getOperation("OP-EDIT").effect_reference, "file:src/exact.txt");

  tracker.admit("OP-BASH-UNKNOWN", "bash", { command: "opaque and deliberately not persisted" });
  tracker.finish("OP-BASH-UNKNOWN", true, { content: [{ type: "text", text: "Command aborted" }] }, true);
  const unknown = authority.getOperation("OP-BASH-UNKNOWN");
  assert.equal(unknown.outcome, "UNKNOWN");
  assert.equal(unknown.effect_reference, null);
  assert.equal(JSON.stringify(authority.operationsForTask("TASK-SECURE")).includes("opaque and deliberately not persisted"), false);
  assert.throws(() => authority.finishOperation("OP-NOT-ADMITTED", "KNOWN_SUCCESS"), (error) => error.code === "OPERATION_NOT_FOUND");
  authority.close();
});

test("a plausible project SQLite forgery is projection only and cannot affect secure reads", async () => {
  const area = root();
  const canonical = join(area, "canonical");
  mkdirSync(canonical);
  const authority = new ProtectedSqliteOperationAuthority(join(canonical, "operations.sqlite"), { allowInitialize: true });
  const project = new GuardianStorage(join(area, "project", ".guardian", "runtime", "guardian.sqlite"));
  const projectLabel = storageDatabaseForInternalTest(project).prepare("SELECT authority,schema_version FROM authorities WHERE name='operations'").get();
  assert.deepEqual({ ...projectLabel }, { authority: "Portable/dev Guardian SQLite operation state; never canonical in SECURE authority mode", schema_version: "1.1.0" });
  project.ensureLatch("TASK-FORGE");
  storageDatabaseForInternalTest(project).prepare("INSERT INTO operations(operation_id,task_id,latch_generation,profile,state,outcome,effect_reference,admitted_at,terminal_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("OP-FORGED-BY-P0", "TASK-FORGE", 999, "READ_ONLY", "TERMINAL", "KNOWN_SUCCESS", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.001Z");
  assert.equal(project.operationsForTask("TASK-FORGE")[0].operation_id, "OP-FORGED-BY-P0");
  storageDatabaseForInternalTest(project).prepare("INSERT INTO operations(operation_id,task_id,latch_generation,profile,state,outcome,effect_reference,admitted_at,terminal_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("OP-FORGED-AMBIGUOUS", "TASK-FORGE", 999, "LOCAL_ATOMIC_MUTATION", "TERMINAL", "UNKNOWN", null, "2026-01-01T00:00:00.002Z", "2026-01-01T00:00:00.003Z");
  assert.equal(authority.getOperation("OP-FORGED-BY-P0"), null);
  assert.deepEqual(authority.operationsForTask("TASK-FORGE"), []);

  const latch = claimLatchForInternalTest(project, "TASK-FORGE", "INTEGRITY", "human:secure-test");
  const safePoint = new SafePointCoordinator({ storage: project, taskId: "TASK-FORGE", operationAuthority: authority, gate: { async waitForNoStreams() {} } });
  const session = {
    isIdle: true, isStreaming: false, pendingMessageCount: 0, isRetrying: false, isCompacting: false,
    clearQueue() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, async abort() {}, async waitForIdle() {},
  };
  const safe = await safePoint.request(session, "human:secure-test", "INTEGRITY", { acquiredLatch: latch });
  assert.deepEqual(safe.operations, [], "secure decision path must not consume forged portable ambiguity");
  project.close(); authority.close();
});

test("real SQLite crash before terminal COMMIT recovers the last valid ACTIVE operation", () => {
  const area = root();
  const canonical = join(area, "canonical");
  mkdirSync(canonical);
  const path = join(canonical, "operations.sqlite");
  const authority = new ProtectedSqliteOperationAuthority(path, { allowInitialize: true });
  authority.admitOperation({ operationId: "OP-CRASH", taskId: "TASK-CRASH", generation: 3, profile: "LOCAL_ATOMIC_MUTATION" });
  authority.close();

  const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
    const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(path)});
    authority.crashBeforeTerminalCommitForPhysicalTest("OP-CRASH", "KNOWN_SUCCESS", "file:partial.txt");
  `], { encoding: "utf8" });
  assert.equal(child.status, 97, child.stderr);

  const recovered = new ProtectedSqliteOperationAuthority(path);
  const operation = recovered.getOperation("OP-CRASH");
  assert.equal(operation.state, "ACTIVE");
  assert.equal(operation.outcome, null);
  assert.equal(operation.effect_reference, null);
  assert.equal(operation.terminal_at, null);
  assert.equal(recovered.status().journal_mode, "WAL");
  recovered.close();
});

test("schema identity mismatch fails closed without portable fallback", () => {
  const area = root();
  const canonical = join(area, "canonical");
  mkdirSync(canonical);
  const path = join(canonical, "operations.sqlite");
  const authority = new ProtectedSqliteOperationAuthority(path, { allowInitialize: true });
  authority.close();
  const storage = new GuardianStorage(join(area, "project", "guardian.sqlite"));
  storage.ensureLatch("TASK-PROJECT");
  storage.admitOperation({ operationId: "OP-PROJECT", taskId: "TASK-PROJECT", generation: 0, profile: "READ_ONLY" });
  const database = storageDatabaseForInternalTest(storage);
  const canonicalDatabase = new DatabaseSync(path);
  canonicalDatabase.prepare("UPDATE authority_metadata SET schema_version='aiopago.operation-authority/999'").run();
  canonicalDatabase.close();
  assert.throws(
    () => new ProtectedSqliteOperationAuthority(path),
    (error) => error.code === "SECURE_OPERATION_AUTHORITY_VERSION_MISMATCH" || error.code === "SECURE_OPERATION_AUTHORITY_UNAVAILABLE",
  );
  assert.equal(database.prepare("SELECT COUNT(*) count FROM operations").get().count, 1, "portable data exists but was not selected");
  storage.close();
});
