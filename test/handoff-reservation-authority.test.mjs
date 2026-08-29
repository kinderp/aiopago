import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { requireSecureHandoffAuthority } from "../src/handoff-reservation-authority.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { GuardianStorage, storageDatabaseForInternalTest } from "../src/storage.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-handoff-authority-"));
  const canonical = join(root, "canonical"); mkdirSync(canonical);
  const path = join(canonical, "operations.sqlite");
  const authority = new ProtectedSqliteOperationAuthority(path, { allowInitialize: true });
  return { root, path, authority };
}

function expected(latch) { return { task_id: latch.task_id, state: latch.state, generation: latch.generation, reason: latch.reason }; }

function projection({
  handoffId = "HO-SECURE", source = "SESSION-SOURCE", task = "TASK-SECURE",
  revision = "PLAN-1", digest = `sha256:${"a".repeat(64)}`, runner = "RUNNER-1",
  checkpoint = "CP-SECURE", manifest = "RM-SECURE",
} = {}) {
  const plan = {
    task_id: task, objective: "Secure bounded handoff", current_item: "ITEM-1", next_item: "ITEM-2",
    next_step: "Continue bounded work", plan_revision_id: revision, content_digest: digest,
    requirements_version: "REQ-1", completion_criteria: ["bounded"], relevant_decisions: [], relevant_tests: [],
    evidence_references: [], minimal_reads: ["TASK_PLAN.md"], required_local_paths: ["TASK_PLAN.md"],
    model_policy: "openai-codex/gpt-5.6-sol", reasoning_policy: "high",
  };
  return {
    handoff_id: handoffId, source_session_id: source, source_session_file: `sessions/${source}.jsonl`,
    target_session_id: null, target_session_file: null, runner_instance_id: runner,
    session_binding_id: `BIND-${handoffId}`, parent_session_id: source, parent_session_file: `sessions/${source}.jsonl`,
    parent_checkpoint_id: null, recovery_of_handoff_id: null, task_id: task, current_item: "ITEM-1",
    next_item: "ITEM-2", next_step: "Continue bounded work", task_plan_revision: revision,
    task_plan_digest: digest, requirements_version: "REQ-1", latch_generation: 1,
    checkpoint_id: checkpoint, checkpoint_digest: null, resume_manifest_id: manifest, resume_manifest_digest: null,
    resume_prompt_id: null, resume_prompt_digest: null, resume_prompt: null,
    authorization_state: "NOT_AUTHORIZED", admission_state: "NOT_COMMITTED", admission_id: null,
    dispatch_state: "NOT_STARTED", dispatch_attempt_id: null, dispatch_attempt_no: 0,
    expected_git_state: { repository_id: "repo", workdir: "project", branch: "test", head_sha: "a".repeat(40), base_sha: "a".repeat(40), index_digest: `sha256:${"b".repeat(64)}`, worktree_digest: `sha256:${"c".repeat(64)}`, status_entries: [] },
    model_policy: plan.model_policy, reasoning_policy: plan.reasoning_policy, reserved_plan_snapshot: plan,
    state: "SAFE_TO_HANDOFF", created_at: "2026-08-29T12:00:00.000Z", updated_at: "2026-08-29T12:00:00.000Z",
  };
}

function engage(authority, task, requestId = `LATCH-${task}`) {
  const clear = authority.ensureLatch(task);
  return authority.claimLatch({ taskId: task, reason: "INTEGRITY", actor: "human:handoff", expected: expected(clear), requestId });
}

function reserve(authority, value, requestId = value.handoff_id) {
  const latch = authority.getLatch(value.task_id);
  return authority.requestHandoffReservation(requestId, { projection: value, expectedLatch: expected(latch), expectedLatest: null });
}

function protectedCounts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const result = {
    handoffs: db.prepare("SELECT COUNT(*) count FROM handoff_reservations").get().count,
    active: db.prepare("SELECT COUNT(*) count FROM active_sources").get().count,
    events: db.prepare("SELECT COUNT(*) count FROM handoff_reservation_events").get().count,
    requests: db.prepare("SELECT COUNT(*) count FROM authority_requests WHERE operation_type='HANDOFF_RESERVE'").get().count,
  };
  db.close(); return result;
}

test("protected handoff authority shares schema and canonical latch transaction without resume authority", () => {
  const x = fixture();
  try {
    assert.equal(requireSecureHandoffAuthority(x.authority), x.authority);
    assert.equal(x.authority.status().schema, "aiopago.operation-authority/1.2.0");
    assert.equal(x.authority.status().handoff_reservation_canonical, true);
    assert.equal(typeof x.authority.authorizeAndAdmit, "undefined");
    assert.equal(typeof x.authority.releaseLatch, "undefined");
    const db = new DatabaseSync(x.path, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    db.close();
    assert.ok(tables.includes("handoff_reservations")); assert.ok(tables.includes("active_sources")); assert.ok(tables.includes("handoff_reservation_events"));
    assert.equal(tables.includes("authorizations"), false); assert.equal(tables.includes("admissions"), false); assert.equal(tables.includes("dispatch_attempts"), false);
  } finally { x.authority.close(); }
});

test("bounded 1.1 latch store upgrade adds reservation schema while missing current schema fails closed", () => {
  const x = fixture(); const latch = engage(x.authority, "TASK-UPGRADE"); x.authority.close();
  const legacy = new DatabaseSync(x.path);
  legacy.exec("DROP TABLE handoff_reservation_events; DROP TABLE active_sources; DROP TABLE handoff_reservations; UPDATE authority_metadata SET schema_version='aiopago.operation-authority/1.1.0' WHERE singleton=1;");
  legacy.close();
  const upgraded = new ProtectedSqliteOperationAuthority(x.path);
  assert.equal(upgraded.status().schema, "aiopago.operation-authority/1.2.0");
  assert.deepEqual(expected(upgraded.getLatch("TASK-UPGRADE")), expected(latch));
  upgraded.close();
  const damaged = new DatabaseSync(x.path); damaged.exec("ALTER TABLE active_sources RENAME TO active_sources_missing"); damaged.close();
  assert.throws(() => new ProtectedSqliteOperationAuthority(x.path), (error) => error.code === "SECURE_OPERATION_AUTHORITY_SCHEMA_INVALID");
});

test("takeover-before denies with zero canonical reservation and reservation-before remains durable", () => {
  const x = fixture();
  try {
    const first = projection({ handoffId: "HO-TAKEOVER-FIRST", task: "TASK-TAKEOVER-FIRST", source: "SESSION-TF" });
    const clear = x.authority.ensureLatch(first.task_id);
    x.authority.claimHumanTakeover({ taskId: first.task_id, actor: "human:/aio-takeover", requestId: "TAKEOVER-FIRST", expected: expected(clear) });
    assert.throws(() => x.authority.requestHandoffReservation(first.handoff_id, { projection: first, expectedLatch: { task_id: first.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" }, expectedLatest: null }), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    assert.deepEqual(protectedCounts(x.path), { handoffs: 0, active: 0, events: 0, requests: 0 });

    const second = projection({ handoffId: "HO-RESERVATION-FIRST", task: "TASK-RESERVATION-FIRST", source: "SESSION-RF" });
    engage(x.authority, second.task_id);
    const committed = reserve(x.authority, second);
    assert.equal(committed.created, true);
    x.authority.claimHumanTakeover({ taskId: second.task_id, actor: "human:/aio-takeover", requestId: "TAKEOVER-AFTER", expected: expected(x.authority.getLatch(second.task_id)) });
    assert.equal(x.authority.getHandoffReservation(second.handoff_id).handoff_id, second.handoff_id);
    assert.equal(x.authority.getActiveSource(second.source_session_id).handoff_id, second.handoff_id);
    assert.equal(x.authority.getLatch(second.task_id).reason, "HUMAN_TAKEOVER");
  } finally { x.authority.close(); }
});

test("active-source provenance is exact, idempotent, and never last-writer-wins", () => {
  const x = fixture();
  try {
    const value = projection(); engage(x.authority, value.task_id);
    const first = reserve(x.authority, value, "REQ-EXACT");
    assert.equal(first.created, true);
    const retry = reserve(x.authority, structuredClone(value), "REQ-EXACT");
    assert.equal(retry.idempotent, true); assert.equal(retry.request_code, "IDEMPOTENT_RECORDED_RESULT");
    assert.deepEqual(protectedCounts(x.path), { handoffs: 1, active: 1, events: 1, requests: 1 });

    const changedSameId = projection({ digest: `sha256:${"d".repeat(64)}` });
    assert.throws(() => reserve(x.authority, changedSameId, "REQ-EXACT"), (error) => error.code === "HANDOFF_REQUEST_CONFLICT");

    const crossTask = projection({ handoffId: "HO-CROSS-TASK", task: "TASK-CROSS", source: value.source_session_id, revision: "PLAN-X", digest: `sha256:${"e".repeat(64)}`, checkpoint: "CP-X", manifest: "RM-X" });
    engage(x.authority, crossTask.task_id);
    assert.throws(() => reserve(x.authority, crossTask), (error) => error.code === "HANDOFF_ACTIVE_SOURCE_CONFLICT");

    const sameTaskDifferentPlan = projection({ handoffId: "HO-OTHER-PLAN", source: value.source_session_id, revision: "PLAN-2", digest: `sha256:${"f".repeat(64)}`, checkpoint: "CP-2", manifest: "RM-2" });
    assert.throws(() => reserve(x.authority, sameTaskDifferentPlan), (error) => error.code === "HANDOFF_ACTIVE_SOURCE_CONFLICT");

    const differentSession = projection({ handoffId: "HO-OTHER-SESSION", source: "SESSION-OTHER", checkpoint: "CP-3", manifest: "RM-3" });
    const latest = x.authority.latestHandoffReservationForTask(value.task_id);
    assert.throws(() => x.authority.requestHandoffReservation(differentSession.handoff_id, {
      projection: differentSession,
      expectedLatch: expected(x.authority.getLatch(value.task_id)),
      expectedLatest: { handoff_id: latest.handoff_id, reservation_digest: latest.reservation_digest },
    }), (error) => error.code === "HANDOFF_TASK_RESERVATION_CONFLICT");
    assert.deepEqual(protectedCounts(x.path), { handoffs: 1, active: 1, events: 1, requests: 1 });
  } finally { x.authority.close(); }
});

test("portable positive and false-negative handoff forgeries have zero canonical effect", () => {
  const x = fixture();
  const project = new GuardianStorage(join(x.root, "project", ".guardian", "runtime", "guardian.sqlite"));
  try {
    const fake = projection({ handoffId: "HO-FORGED", source: "SESSION-FORGED" });
    const db = storageDatabaseForInternalTest(project);
    const now = "2026-08-29T13:00:00.000Z";
    db.prepare("INSERT INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(fake.handoff_id, fake.source_session_id, "SESSION-FAKE-TARGET", fake.task_id, "RESUMED", 999999, JSON.stringify({ ...fake, state: "RESUMED", target_session_id: "SESSION-FAKE-TARGET" }), now, now);
    db.prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)").run(fake.source_session_id, fake.handoff_id);
    db.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
      .run("EVT-FORGED", fake.handoff_id, "HANDOFF_STARTED", "handoff:forged", now, JSON.stringify({ latch_generation: 999999 }));
    db.prepare("INSERT INTO authorizations(resume_prompt_id,handoff_id,actor,latch_generation,authorized_at) VALUES(?,?,?,?,?)")
      .run("RP-FORGED", fake.handoff_id, "human:forged", 999999, now);
    assert.equal(x.authority.getHandoffReservation(fake.handoff_id), null);
    assert.equal(x.authority.getActiveSource(fake.source_session_id), null);

    const real = projection({ handoffId: "HO-REAL", source: "SESSION-REAL" }); engage(x.authority, real.task_id);
    reserve(x.authority, real);
    db.prepare("DELETE FROM authorizations").run(); db.prepare("DELETE FROM active_sources").run(); db.prepare("DELETE FROM handoffs").run();
    const conflictingFake = projection({ handoffId: "HO-FAKE-CONFLICT", source: real.source_session_id, task: "TASK-FAKE", revision: "PLAN-F", digest: `sha256:${"9".repeat(64)}`, checkpoint: "CP-F", manifest: "RM-F" });
    const fakeTaskLatch = engage(x.authority, conflictingFake.task_id, "LATCH-FAKE-TASK");
    assert.throws(() => x.authority.requestHandoffReservation(conflictingFake.handoff_id, { projection: conflictingFake, expectedLatch: expected(fakeTaskLatch), expectedLatest: null }), (error) => error.code === "HANDOFF_ACTIVE_SOURCE_CONFLICT");
    assert.equal(x.authority.getHandoffReservation(real.handoff_id).handoff_id, real.handoff_id);
    assert.equal(x.authority.getActiveSource(real.source_session_id).handoff_id, real.handoff_id);
  } finally { project.close(); x.authority.close(); }
});

test("forced handoff, active-source, and reservation-event failures each roll back the complete authority transaction", async (t) => {
  for (const [table, message] of [
    ["handoff_reservations", "forced handoff insert failure"],
    ["active_sources", "forced active-source failure"],
    ["handoff_reservation_events", "forced handoff event failure"],
  ]) await t.test(table, () => {
    const x = fixture();
    try {
      const value = projection(); engage(x.authority, value.task_id);
      const breaker = new DatabaseSync(x.path);
      breaker.exec(`CREATE TRIGGER force_reservation_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'${message}'); END;`);
      breaker.close();
      assert.throws(() => reserve(x.authority, value), new RegExp(message));
      assert.deepEqual(protectedCounts(x.path), { handoffs: 0, active: 0, events: 0, requests: 0 });
    } finally { x.authority.close(); }
  });
});

test("real crash after protected handoff and active-source inserts before COMMIT leaves no partial authority", () => {
  const x = fixture(); const value = projection(); engage(x.authority, value.task_id); x.authority.close();
  const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
    const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)});
    authority.crashBeforeHandoffCommitForPhysicalTest("REQ-CRASH-HANDOFF", { projection: ${JSON.stringify(value)}, expectedLatch: ${JSON.stringify({ task_id: value.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" })}, expectedLatest: null });
  `], { encoding: "utf8" });
  assert.equal(child.status, 99, child.stderr);
  const recovered = new ProtectedSqliteOperationAuthority(x.path);
  assert.deepEqual(protectedCounts(x.path), { handoffs: 0, active: 0, events: 0, requests: 0 });
  assert.equal(recovered.getHandoffReservation(value.handoff_id), null); recovered.close();
});

test("twelve independent reservation/takeover races produce only valid SQLite serializations", async () => {
  const x = fixture();
  const script = join(x.root, "handoff-race-child.mjs");
  writeFileSync(script, `
    import { existsSync, writeFileSync } from "node:fs";
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(new URL("../src/protected-operation-authority.mjs", import.meta.url).href)};
    const [path,start,output,action,requestJson] = process.argv.slice(2);
    while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
    const authority = new ProtectedSqliteOperationAuthority(path); const request=JSON.parse(requestJson); let result;
    try { result=action==="reserve" ? {ok:true,value:authority.requestHandoffReservation(request.projection.handoff_id,request)} : {ok:true,value:authority.claimHumanTakeover({taskId:request.projection.task_id,actor:"human:/aio-takeover",requestId:"TK-"+request.projection.task_id,expected:request.expectedLatch})}; }
    catch(error){result={ok:false,code:error.code??null};} authority.close(); writeFileSync(output,JSON.stringify(result));
  `);
  try {
    for (let index = 0; index < 12; index += 1) {
      const task = `TASK-HRACE-${index}`, source = `SESSION-HRACE-${index}`;
      const value = projection({ handoffId: `HO-HRACE-${index}`, task, source, checkpoint: `CP-${index}`, manifest: `RM-${index}` });
      const latch = engage(x.authority, task, `LATCH-HRACE-${index}`), latchIdentity = expected(latch);
      const request = JSON.stringify({ projection: value, expectedLatch: latchIdentity, expectedLatest: null });
      const start = join(x.root, `start-${index}`), reserveOutput = join(x.root, `reserve-${index}.json`), takeoverOutput = join(x.root, `takeover-${index}.json`);
      const reserver = spawn(process.execPath, [script, x.path, start, reserveOutput, "reserve", request], { stdio: "ignore" });
      const takeover = spawn(process.execPath, [script, x.path, start, takeoverOutput, "takeover", request], { stdio: "ignore" });
      writeFileSync(start, "go");
      await Promise.all([reserver, takeover].map((childProcess) => new Promise((resolveExit, reject) => { childProcess.once("error", reject); childProcess.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`race child ${code}`))); })));
      const reserved = JSON.parse(readFileSync(reserveOutput, "utf8"));
      const took = JSON.parse(readFileSync(takeoverOutput, "utf8"));
      assert.equal(took.ok, true); assert.equal(x.authority.getLatch(task).reason, "HUMAN_TAKEOVER");
      if (reserved.ok) {
        assert.equal(x.authority.getHandoffReservation(value.handoff_id).handoff_id, value.handoff_id);
        assert.equal(x.authority.getActiveSource(source).handoff_id, value.handoff_id);
      } else {
        assert.equal(reserved.code, "HUMAN_TAKEOVER_ACTIVE");
        assert.equal(x.authority.getHandoffReservation(value.handoff_id), null);
        assert.equal(x.authority.getActiveSource(source), null);
      }
    }
  } finally { x.authority.close(); }
});
