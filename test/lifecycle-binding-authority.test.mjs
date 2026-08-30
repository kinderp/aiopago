import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { requireSecureLifecycleAuthority } from "../src/lifecycle-binding-authority.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { GuardianStorage, storageDatabaseForInternalTest } from "../src/storage.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-lifecycle-authority-"));
  const canonical = join(root, "canonical"); mkdirSync(canonical);
  const path = join(canonical, "operations.sqlite");
  return { root, path, authority: new ProtectedSqliteOperationAuthority(path, { allowInitialize: true }) };
}

function latchIdentity(latch) {
  return { task_id: latch.task_id, state: latch.state, generation: latch.generation, reason: latch.reason };
}

function projection({ handoffId = "HO-LIFECYCLE", source = "SESSION-SOURCE", task = "TASK-LIFECYCLE", runner = "RUNNER-1", bindingId = `BIND-${handoffId}`, checkpoint = `CP-${handoffId}`, manifest = `RM-${handoffId}` } = {}) {
  const digest = `sha256:${"a".repeat(64)}`;
  const plan = { task_id: task, objective: "Protected lifecycle", current_item: "ITEM-1", next_item: "ITEM-2", next_step: "Continue", plan_revision_id: "PLAN-1", content_digest: digest, requirements_version: "REQ-1", completion_criteria: ["bounded"], relevant_decisions: [], relevant_tests: [], evidence_references: [], minimal_reads: ["TASK_PLAN.md"], required_local_paths: ["TASK_PLAN.md"], model_policy: "offline/fake", reasoning_policy: "off" };
  return { handoff_id: handoffId, source_session_id: source, source_session_file: `sessions/${source}.jsonl`, target_session_id: null, target_session_file: null, runner_instance_id: runner, session_binding_id: bindingId, parent_session_id: source, parent_session_file: `sessions/${source}.jsonl`, parent_checkpoint_id: null, recovery_of_handoff_id: null, task_id: task, current_item: "ITEM-1", next_item: "ITEM-2", next_step: "Continue", task_plan_revision: "PLAN-1", task_plan_digest: digest, requirements_version: "REQ-1", latch_generation: 1, checkpoint_id: checkpoint, checkpoint_digest: null, resume_manifest_id: manifest, resume_manifest_digest: null, resume_prompt_id: null, resume_prompt_digest: null, resume_prompt: null, authorization_state: "NOT_AUTHORIZED", admission_state: "NOT_COMMITTED", admission_id: null, dispatch_state: "NOT_STARTED", dispatch_attempt_id: null, dispatch_attempt_no: 0, expected_git_state: { repository_id: "repo", workdir: "project", branch: "test", head_sha: "a".repeat(40), base_sha: "a".repeat(40), index_digest: `sha256:${"b".repeat(64)}`, worktree_digest: `sha256:${"c".repeat(64)}`, status_entries: [] }, model_policy: "offline/fake", reasoning_policy: "off", reserved_plan_snapshot: plan, state: "SAFE_TO_HANDOFF", created_at: "2026-08-29T12:00:00.000Z", updated_at: "2026-08-29T12:00:00.000Z" };
}

function reserve(authority, value, expectedLatest = null) {
  const clear = authority.ensureLatch(value.task_id);
  const latch = clear.state === "RELEASED"
    ? authority.claimLatch({ taskId: value.task_id, reason: "INTEGRITY", actor: "human:handoff", expected: latchIdentity(clear), requestId: `LATCH-${value.handoff_id}` })
    : clear;
  return authority.requestHandoffReservation(value.handoff_id, { projection: value, expectedLatch: latchIdentity(latch), expectedLatest });
}

function binding(value, { session = `TARGET-${value.handoff_id}`, runner = value.runner_instance_id, bindingId = value.session_binding_id, incarnation = 2 } = {}) {
  return { handoff_id: value.handoff_id, replacement_session_id: session, runner_instance_id: runner, session_binding_id: bindingId, lifecycle_incarnation: incarnation };
}

function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const result = { bindings: db.prepare("SELECT COUNT(*) count FROM lifecycle_bindings").get().count, events: db.prepare("SELECT COUNT(*) count FROM lifecycle_binding_events").get().count, requests: db.prepare("SELECT COUNT(*) count FROM authority_requests WHERE operation_type LIKE 'LIFECYCLE_%'").get().count };
  db.close(); return result;
}

test("protected lifecycle authority remains in the same canonical store with the later resume schema", () => {
  const x = fixture();
  try {
    assert.equal(requireSecureLifecycleAuthority(x.authority), x.authority);
    assert.equal(x.authority.status().schema, "aiopago.operation-authority/1.6.0");
    assert.equal(x.authority.status().lifecycle_binding_canonical, true);
    const db = new DatabaseSync(x.path, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)); db.close();
    assert.equal(tables.has("lifecycle_bindings"), true); assert.equal(tables.has("lifecycle_binding_events"), true);
    assert.equal(tables.has("resume_authorizations"), true); assert.equal(tables.has("resume_admissions"), true); assert.equal(tables.has("resume_dispatch_attempts"), true);
  } finally { x.authority.close(); }
});

test("bounded 1.2 protected store upgrade adds lifecycle schema and damaged current schema fails closed", () => {
  const x = fixture(); x.authority.close();
  const legacy = new DatabaseSync(x.path);
  legacy.exec("DROP TABLE lifecycle_binding_events; DROP TABLE lifecycle_bindings; UPDATE authority_metadata SET schema_version='aiopago.operation-authority/1.2.0' WHERE singleton=1;"); legacy.close();
  const upgraded = new ProtectedSqliteOperationAuthority(x.path);
  assert.equal(upgraded.status().schema, "aiopago.operation-authority/1.6.0"); upgraded.close();
  const damaged = new DatabaseSync(x.path); damaged.exec("ALTER TABLE lifecycle_bindings RENAME TO lifecycle_bindings_missing"); damaged.close();
  assert.throws(() => new ProtectedSqliteOperationAuthority(x.path), (error) => error.code === "SECURE_OPERATION_AUTHORITY_SCHEMA_INVALID");
});

test("binding creation is reservation-bound, exact, and idempotent without last-writer-wins", () => {
  const x = fixture();
  try {
    const handoff = projection(); reserve(x.authority, handoff); const expected = binding(handoff);
    const first = x.authority.requestLifecycleBindingCreate("REQ-BIND", { binding: expected });
    assert.equal(first.created, true); assert.equal(first.binding.status, "ACTIVE"); assert.equal(first.binding.lifecycle_incarnation, 2);
    assert.deepEqual(x.authority.getLifecycleBinding(handoff.handoff_id), first.binding);
    assert.deepEqual(x.authority.getLifecycleBindingBySession(expected.replacement_session_id), first.binding);
    assert.equal(x.authority.lifecycleBindingEvents(handoff.handoff_id)[0].event_type, "RUNNER_SESSION_BOUND");
    const retry = x.authority.requestLifecycleBindingCreate("REQ-BIND", { binding: structuredClone(expected) });
    assert.equal(retry.idempotent, true); assert.deepEqual(counts(x.path), { bindings: 1, events: 1, requests: 1 });
    assert.throws(() => x.authority.requestLifecycleBindingCreate("REQ-BIND", { binding: { ...expected, runner_instance_id: "RUNNER-OTHER" } }), (error) => error.code === "LIFECYCLE_REQUEST_CONFLICT");
    assert.throws(() => x.authority.requestLifecycleBindingCreate("REQ-OTHER", { binding: { ...expected, session_binding_id: "BIND-OTHER" } }), (error) => error.code === "LIFECYCLE_RESERVATION_MISMATCH");
  } finally { x.authority.close(); }
});

test("ACTIVE to SUPERSEDED requires exact identity and makes same-ID ABA fail closed", () => {
  const x = fixture();
  try {
    const handoff = projection(); reserve(x.authority, handoff); const expected = binding(handoff, { session: "SESSION-SAME", incarnation: 7 });
    x.authority.requestLifecycleBindingCreate("REQ-BIND-ABA", { binding: expected });
    const transitioned = x.authority.requestLifecycleBindingTransition("REQ-SHUTDOWN-E1", { expected: { ...expected, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "session_shutdown" });
    assert.equal(transitioned.binding.status, "SUPERSEDED"); assert.equal(transitioned.binding.lifecycle_incarnation, 7);
    assert.equal(x.authority.lifecycleBindingEvents(handoff.handoff_id).length, 2);
    const retry = x.authority.requestLifecycleBindingTransition("REQ-SHUTDOWN-E1", { expected: { ...expected, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "session_shutdown" });
    assert.equal(retry.idempotent, true);
    assert.throws(() => x.authority.requestLifecycleBindingCreate("REQ-ABA-E2", { binding: { ...expected, lifecycle_incarnation: 8 } }), (error) => error.code === "LIFECYCLE_BINDING_CONFLICT");
    assert.throws(() => x.authority.requestLifecycleBindingTransition("REQ-STALE", { expected: { ...expected, lifecycle_incarnation: 6, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "session_shutdown" }), (error) => error.code === "LIFECYCLE_BINDING_STALE");
    assert.throws(() => x.authority.requestLifecycleBindingTransition("REQ-CONFLICT", { expected: { ...expected, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "different reason" }), (error) => error.code === "LIFECYCLE_TRANSITION_CONFLICT");
  } finally { x.authority.close(); }
});

test("project ACTIVE/SUPERSEDED/Runner/session/binding forgery and deletion never change canonical lifecycle", () => {
  const x = fixture(); const project = new GuardianStorage(join(x.root, "project", ".guardian", "runtime", "guardian.sqlite"));
  try {
    const handoff = projection(); reserve(x.authority, handoff); const expected = binding(handoff); const canonical = x.authority.requestLifecycleBindingCreate("REQ-REAL", { binding: expected }).binding;
    const db = storageDatabaseForInternalTest(project); const now = "2099-01-01T00:00:00.000Z";
    db.prepare("INSERT INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(handoff.handoff_id, handoff.source_session_id, expected.replacement_session_id, handoff.task_id, "RESUME_READY", 999999, JSON.stringify({ ...handoff, target_session_id: expected.replacement_session_id, state: "RESUME_READY" }), now, now);
    db.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)").run("EVT-FORGED-BIND", handoff.handoff_id, "RUNNER_SESSION_BOUND", `runner-binding:${handoff.handoff_id}`, now, JSON.stringify({ handoff_id: handoff.handoff_id, replacement_session_id: "SESSION-FORGED", runner_instance_id: "RUNNER-FORGED", session_binding_id: "BIND-FORGED" }));
    db.prepare("INSERT INTO runner_session_bindings(handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,bind_event_id,superseded_at,superseded_reason) VALUES(?,?,?,?,?,?,?,?,?)").run(handoff.handoff_id, "SESSION-FORGED", "RUNNER-FORGED", "BIND-FORGED", "SUPERSEDED", now, "EVT-FORGED-BIND", now, "forged newer timestamp");
    assert.deepEqual(x.authority.getLifecycleBinding(handoff.handoff_id), canonical);
    db.prepare("DELETE FROM runner_session_bindings").run(); db.prepare("DELETE FROM journal").run();
    assert.deepEqual(x.authority.getLifecycleBinding(handoff.handoff_id), canonical);
  } finally { project.close(); x.authority.close(); }
});

test("crash after lifecycle row and event mutation before COMMIT restores the exact ACTIVE binding", () => {
  const x = fixture(); const handoff = projection(); reserve(x.authority, handoff); const expected = binding(handoff, { incarnation: 4 });
  const before = x.authority.requestLifecycleBindingCreate("REQ-CRASH-BIND", { binding: expected }).binding; x.authority.close();
  const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
    const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)});
    authority.crashBeforeLifecycleTransitionCommitForPhysicalTest("REQ-CRASH-TRANSITION", {
      expected: ${JSON.stringify({ ...expected, status: "ACTIVE" })}, nextStatus: "SUPERSEDED", reason: "session_shutdown"
    });
  `], { encoding: "utf8" });
  assert.equal(child.status, 100, child.stderr);
  const recovered = new ProtectedSqliteOperationAuthority(x.path);
  assert.deepEqual(recovered.getLifecycleBinding(handoff.handoff_id), before);
  assert.equal(recovered.lifecycleBindingEvents(handoff.handoff_id).length, 1);
  assert.deepEqual(counts(x.path), { bindings: 1, events: 1, requests: 1 });
  recovered.close();
});

test("an exact ACTIVE protected target authorizes the next task reservation and superseded/ABA source does not", () => {
  const x = fixture();
  try {
    const first = projection({ handoffId: "HO-FIRST", source: "SESSION-S1", checkpoint: "CP-FIRST", manifest: "RM-FIRST" }); reserve(x.authority, first);
    const firstBinding = binding(first, { session: "SESSION-S2", incarnation: 2 }); x.authority.requestLifecycleBindingCreate("REQ-FIRST-BIND", { binding: firstBinding });
    const latest = x.authority.latestHandoffReservationForTask(first.task_id);
    const second = projection({ handoffId: "HO-SECOND", source: "SESSION-S2", checkpoint: "CP-SECOND", manifest: "RM-SECOND" });
    const reserved = x.authority.requestHandoffReservation(second.handoff_id, { projection: second, expectedLatch: latchIdentity(x.authority.getLatch(second.task_id)), expectedLatest: { handoff_id: latest.handoff_id, reservation_digest: latest.reservation_digest } });
    assert.equal(reserved.created, true);

    const thirdSource = binding(second, { session: "SESSION-S3", incarnation: 3 }); x.authority.requestLifecycleBindingCreate("REQ-SECOND-BIND", { binding: thirdSource });
    x.authority.requestLifecycleBindingTransition("REQ-SECOND-SHUTDOWN", { expected: { ...thirdSource, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "session_shutdown" });
    const third = projection({ handoffId: "HO-THIRD", source: "SESSION-S3", checkpoint: "CP-THIRD", manifest: "RM-THIRD" });
    const latestSecond = x.authority.latestHandoffReservationForTask(first.task_id);
    assert.throws(() => x.authority.requestHandoffReservation(third.handoff_id, { projection: third, expectedLatch: latchIdentity(x.authority.getLatch(third.task_id)), expectedLatest: { handoff_id: latestSecond.handoff_id, reservation_digest: latestSecond.reservation_digest } }), (error) => error.code === "HANDOFF_TASK_RESERVATION_CONFLICT");
  } finally { x.authority.close(); }
});
