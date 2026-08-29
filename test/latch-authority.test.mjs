import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AdmissionGate, SafePointCoordinator, ToolOperationTracker } from "../src/safety.mjs";
import { portableLatchAuthority, requireSecureLatchAuthority } from "../src/latch-authority.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { GuardianStorage, storageDatabaseForInternalTest } from "../src/storage.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-latch-authority-"));
  const canonical = join(root, "canonical");
  mkdirSync(canonical);
  const path = join(canonical, "operations.sqlite");
  const authority = new ProtectedSqliteOperationAuthority(path, { allowInitialize: true });
  return { root, path, authority };
}

function expected(latch) {
  return { task_id: latch.task_id, state: latch.state, generation: latch.generation, reason: latch.reason };
}

function idleSession(overrides = {}) {
  return {
    isIdle: true, isStreaming: false, pendingMessageCount: 0, isRetrying: false, isCompacting: false,
    clearQueue() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, async abort() {}, async waitForIdle() {},
    ...overrides,
  };
}

test("secure and portable latch authority are explicit and never interchangeable", () => {
  const x = fixture();
  const storage = new GuardianStorage(join(x.root, "project", "guardian.sqlite"));
  const portable = portableLatchAuthority(storage);
  assert.deepEqual(portable.security, {
    mode: "PORTABLE", canonical: false, isolation: "ORDINARY_USER_OWNED", r1_m_13_latch_isolation: false,
  });
  assert.throws(() => requireSecureLatchAuthority(portable), (error) => error.code === "SECURE_LATCH_AUTHORITY_REQUIRED");
  assert.equal(requireSecureLatchAuthority(x.authority), x.authority);
  storage.close(); x.authority.close();
});

test("protected latch preserves generation, exact-state CAS, takeover priority, and request conflicts", () => {
  const x = fixture();
  try {
    const clear = x.authority.ensureLatch("TASK-LATCH");
    assert.equal(clear.state, "RELEASED"); assert.equal(clear.generation, 0); assert.equal(clear.reason, null);

    const ordinaryRequest = x.authority.requestLatchClaim("REQ-ORDINARY", {
      taskId: "TASK-LATCH", reason: "INTEGRITY", actor: "human:handoff", expected: expected(clear),
    });
    assert.equal(ordinaryRequest.idempotent, false);
    assert.equal(ordinaryRequest.latch.state, "ENGAGED");
    assert.equal(ordinaryRequest.latch.generation, 1);
    assert.equal(ordinaryRequest.latch.reason, "INTEGRITY");

    const takeover = x.authority.requestLatchClaim("REQ-TAKEOVER", {
      taskId: "TASK-LATCH", reason: "HUMAN_TAKEOVER", actor: "human:/aio-takeover", expected: expected(ordinaryRequest.latch),
    });
    assert.equal(takeover.idempotent, false);
    assert.equal(takeover.latch.state, "ENGAGED");
    assert.equal(takeover.latch.generation, 1, "historical escalation changes reason without inventing a generation increment");
    assert.equal(takeover.latch.reason, "HUMAN_TAKEOVER");

    const duplicate = x.authority.requestLatchClaim("REQ-TAKEOVER-DUPLICATE", {
      taskId: "TASK-LATCH", reason: "HUMAN_TAKEOVER", actor: "human:/aio-takeover", expected: expected(takeover.latch),
    });
    assert.equal(duplicate.idempotent, true);
    assert.deepEqual(expected(duplicate.latch), expected(takeover.latch));

    assert.throws(() => x.authority.requestLatchClaim("REQ-DOWNGRADE", {
      taskId: "TASK-LATCH", reason: "INTEGRITY", actor: "human:handoff", expected: expected(takeover.latch),
    }), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    assert.throws(() => x.authority.requestLatchClaim("REQ-STALE", {
      taskId: "TASK-LATCH", reason: "HUMAN_TAKEOVER", actor: "human:/aio-takeover", expected: expected(clear),
    }), (error) => error.code === "LATCH_GENERATION_MISMATCH");
    assert.throws(() => x.authority.requestLatchClaim("REQ-TAKEOVER", {
      taskId: "TASK-LATCH", reason: "HUMAN_TAKEOVER", actor: "human:conflicting-source", expected: expected(ordinaryRequest.latch),
    }), (error) => error.code === "LATCH_REQUEST_CONFLICT");
    assert.equal(typeof x.authority.releaseLatch, "undefined", "takeover release remains coupled to resume authorization and is not exposed as a generic mutation");
    assert.equal(x.authority.getLatch("TASK-LATCH").reason, "HUMAN_TAKEOVER");
  } finally { x.authority.close(); }
});

test("operation admission and HUMAN_TAKEOVER linearize in one protected SQLite transaction", () => {
  const x = fixture();
  try {
    const first = x.authority.ensureLatch("TASK-TAKEOVER-FIRST");
    x.authority.claimHumanTakeover({ taskId: first.task_id, actor: "human:/aio-takeover", requestId: "REQ-FIRST-TAKEOVER" });
    assert.throws(() => x.authority.admitOperation({
      operationId: "OP-AFTER-TAKEOVER", taskId: first.task_id, generation: first.generation, profile: "READ_ONLY",
    }), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    assert.equal(x.authority.getOperation("OP-AFTER-TAKEOVER"), null);

    const second = x.authority.ensureLatch("TASK-ADMISSION-FIRST");
    const admitted = x.authority.admitOperation({
      operationId: "OP-BEFORE-TAKEOVER", taskId: second.task_id, generation: second.generation, profile: "READ_ONLY",
    });
    assert.equal(admitted.operation.state, "ACTIVE");
    const takeover = x.authority.claimHumanTakeover({ taskId: second.task_id, actor: "human:/aio-takeover", requestId: "REQ-SECOND-TAKEOVER" });
    assert.equal(takeover.reason, "HUMAN_TAKEOVER");
    assert.equal(x.authority.getOperation("OP-BEFORE-TAKEOVER").state, "ACTIVE");
    assert.equal(x.authority.admitOperation({
      operationId: "OP-BEFORE-TAKEOVER", taskId: second.task_id, generation: second.generation, profile: "READ_ONLY",
    }).idempotent, true, "retry preserves the already-linearized admission");
    assert.throws(() => x.authority.admitOperation({
      operationId: "OP-NEW-AFTER-TAKEOVER", taskId: second.task_id, generation: second.generation, profile: "READ_ONLY",
    }), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
  } finally { x.authority.close(); }
});

test("simultaneous cross-process takeover/admission race has one exact protected ordering", async () => {
  const x = fixture();
  const script = join(x.root, "race-child.mjs");
  writeFileSync(script, `
    import { existsSync, writeFileSync } from "node:fs";
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(new URL("../src/protected-operation-authority.mjs", import.meta.url).href)};
    const [path, start, output, action, task, operation, request] = process.argv.slice(2);
    while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    const authority = new ProtectedSqliteOperationAuthority(path);
    let result;
    try {
      if (action === "admit") result = { ok: true, value: authority.admitOperation({ operationId: operation, taskId: task, generation: 0, profile: "READ_ONLY" }) };
      else result = { ok: true, value: authority.claimHumanTakeover({ taskId: task, actor: "human:/aio-takeover", requestId: request }) };
    } catch (error) { result = { ok: false, code: error.code ?? null }; }
    authority.close(); writeFileSync(output, JSON.stringify(result));
  `);
  const races = [];
  try {
    for (let index = 0; index < 12; index += 1) {
      const task = `TASK-RACE-${index}`;
      const operation = `OP-RACE-${index}`;
      const start = join(x.root, `start-${index}`);
      const admissionOutput = join(x.root, `admission-${index}.json`);
      const takeoverOutput = join(x.root, `takeover-${index}.json`);
      x.authority.ensureLatch(task);
      const admission = spawn(process.execPath, [script, x.path, start, admissionOutput, "admit", task, operation, `REQ-RACE-${index}`], { stdio: "ignore" });
      const takeover = spawn(process.execPath, [script, x.path, start, takeoverOutput, "takeover", task, operation, `REQ-RACE-${index}`], { stdio: "ignore" });
      writeFileSync(start, "go");
      await Promise.all([admission, takeover].map((child) => new Promise((resolveExit, reject) => {
        child.once("error", reject); child.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`race child ${code}`)));
      })));
      assert.equal(existsSync(admissionOutput) && existsSync(takeoverOutput), true);
      const admitted = JSON.parse(readFileSync(admissionOutput, "utf8"));
      const claimed = JSON.parse(readFileSync(takeoverOutput, "utf8"));
      assert.equal(claimed.ok, true);
      const durableOperation = x.authority.getOperation(operation);
      const durableLatch = x.authority.getLatch(task);
      assert.equal(durableLatch.reason, "HUMAN_TAKEOVER");
      if (admitted.ok) assert.equal(durableOperation?.state, "ACTIVE");
      else {
        assert.equal(admitted.code, "HUMAN_TAKEOVER_ACTIVE");
        assert.equal(durableOperation, null);
      }
      races.push({ admission: admitted.ok ? "COMMITTED_FIRST" : "BLOCKED_AFTER_TAKEOVER", operation: durableOperation?.state ?? null, latch: durableLatch.reason });
    }
    assert.equal(races.length, 12);
  } finally { x.authority.close(); }
});

test("secure SafePoint rereads canonical latch after abort, idle, streams, and final arbitration", async () => {
  for (const seam of ["abort", "idle", "streams"]) {
    const x = fixture();
    try {
      const clear = x.authority.ensureLatch(`TASK-SAFE-${seam}`);
      const latch = x.authority.claimLatch({
        taskId: clear.task_id, reason: "INTEGRITY", actor: "human:handoff", expected: expected(clear), requestId: `REQ-SAFE-${seam}`,
      });
      let fired = false;
      const takeover = () => {
        if (fired) return; fired = true;
        x.authority.claimHumanTakeover({ taskId: clear.task_id, actor: "human:/aio-takeover", requestId: `REQ-SAFE-TAKEOVER-${seam}` });
      };
      const session = idleSession({
        isIdle: seam !== "abort", isStreaming: seam === "abort",
        async abort() { if (seam === "abort") takeover(); },
        async waitForIdle() { if (seam === "idle") takeover(); this.isIdle = true; this.isStreaming = false; },
      });
      const gate = { async waitForNoStreams() { if (seam === "streams") takeover(); } };
      const safePoint = new SafePointCoordinator({
        storage: null, taskId: clear.task_id, gate, operationAuthority: x.authority, latchAuthority: x.authority,
      });
      await assert.rejects(
        () => safePoint.request(session, "human:handoff", "INTEGRITY", { expectedLatch: expected(clear), acquiredLatch: latch }),
        (error) => error.code === "HUMAN_TAKEOVER_ACTIVE",
        seam,
      );
      assert.equal(x.authority.getLatch(clear.task_id).reason, "HUMAN_TAKEOVER");
    } finally { x.authority.close(); }
  }
});

test("plausible user-writable HUMAN_TAKEOVER and clear forgeries have no canonical or admission effect", () => {
  const x = fixture();
  const project = new GuardianStorage(join(x.root, "project", ".guardian", "runtime", "guardian.sqlite"));
  try {
    const canonicalClear = x.authority.ensureLatch("TASK-FORGE");
    project.ensureLatch("TASK-FORGE");
    const db = storageDatabaseForInternalTest(project);
    db.prepare("UPDATE latches SET state='ENGAGED',generation=987654,reason='HUMAN_TAKEOVER',engaged_at=?,engaged_by=?,released_at=NULL,released_by=NULL WHERE task_id=?")
      .run("2026-08-28T12:00:00.000Z", "human:/aio-takeover", "TASK-FORGE");
    assert.equal(project.getLatch("TASK-FORGE").reason, "HUMAN_TAKEOVER");
    assert.deepEqual(expected(x.authority.getLatch("TASK-FORGE")), expected(canonicalClear));

    const tracker = new ToolOperationTracker(x.authority, "TASK-FORGE", { operationAuthority: x.authority, latchAuthority: x.authority });
    tracker.admit("OP-LEGACY-TAKEOVER-IGNORED", "read");
    assert.equal(x.authority.getOperation("OP-LEGACY-TAKEOVER-IGNORED").state, "ACTIVE");

    const canonicalTakeover = x.authority.claimHumanTakeover({ taskId: "TASK-FORGE", actor: "human:/aio-takeover", requestId: "REQ-REAL-TAKEOVER" });
    db.prepare("UPDATE latches SET state='RELEASED',generation=2147483647,reason=NULL,engaged_at=NULL,engaged_by=NULL,released_at=?,released_by=? WHERE task_id=?")
      .run("2026-08-28T12:01:00.000Z", "attacker:P0", "TASK-FORGE");
    assert.equal(x.authority.getLatch("TASK-FORGE").reason, "HUMAN_TAKEOVER");
    assert.equal(x.authority.getLatch("TASK-FORGE").generation, canonicalTakeover.generation);
    assert.throws(() => tracker.admit("OP-FORGED-CLEAR-IGNORED", "read"), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");

    const admissionGate = new AdmissionGate(project, "TASK-FORGE", { latchAuthority: x.authority });
    let opened = 0;
    assert.throws(() => admissionGate.admit(() => { opened += 1; }), (error) => error.code === "LLM_ADMISSION_BLOCKED");
    assert.equal(opened, 0);
  } finally { project.close(); x.authority.close(); }
});

test("schema upgrade is bounded and missing current latch schema fails closed", () => {
  const x = fixture();
  x.authority.close();
  const legacy = new DatabaseSync(x.path);
  legacy.exec("DROP TABLE latch_events; DROP TABLE latches; UPDATE authority_metadata SET schema_version='aiopago.operation-authority/1.0.0' WHERE singleton=1;");
  legacy.close();
  const upgraded = new ProtectedSqliteOperationAuthority(x.path);
  assert.equal(upgraded.status().schema, "aiopago.operation-authority/1.2.0");
  assert.equal(upgraded.ensureLatch("TASK-UPGRADED").state, "RELEASED");
  upgraded.close();
  const damaged = new DatabaseSync(x.path);
  damaged.exec("ALTER TABLE latches RENAME TO latches_missing");
  damaged.close();
  assert.throws(() => new ProtectedSqliteOperationAuthority(x.path), (error) => error.code === "SECURE_OPERATION_AUTHORITY_SCHEMA_INVALID");
});

test("crash after protected latch update and before COMMIT preserves the previous exact latch", () => {
  const x = fixture();
  const before = x.authority.ensureLatch("TASK-CRASH-LATCH");
  x.authority.close();
  const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
    const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)});
    authority.crashBeforeLatchCommitForPhysicalTest("REQ-CRASH-LATCH", {
      taskId: "TASK-CRASH-LATCH", reason: "HUMAN_TAKEOVER", actor: "human:/aio-takeover", expected: ${JSON.stringify(expected(before))}
    });
  `], { encoding: "utf8" });
  assert.equal(child.status, 98, child.stderr);
  const recovered = new ProtectedSqliteOperationAuthority(x.path);
  assert.deepEqual(expected(recovered.getLatch("TASK-CRASH-LATCH")), expected(before));
  assert.equal(recovered.latchEventsForTask("TASK-CRASH-LATCH").length, 1);
  recovered.close();
});
