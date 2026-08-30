import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sha256 } from "../src/canonical.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { requireSecureRecoveryAuthority } from "../src/recovery-authority.mjs";
import { planSemanticDigest } from "../src/plan-semantics-internal.mjs";

function exactLatch(value) { return { task_id: value.task_id, state: value.state, generation: value.generation, reason: value.reason }; }
function plan() {
  const content = `sha256:${"a".repeat(64)}`;
  return { task_id: "TASK-RECOVERY", objective: "Protected continuity recovery", current_item: "ITEM-1", next_item: "ITEM-2", next_step: "Continue", plan_revision_id: "PLAN-1", content_digest: content, requirements_version: "REQ-1", completion_criteria: ["bounded"], relevant_decisions: ["decision"], relevant_tests: ["test"], evidence_references: ["evidence"], minimal_reads: ["TASK_PLAN.md"], required_local_paths: ["TASK_PLAN.md"], model_policy: "offline/fake", reasoning_policy: "off" };
}
function projection(overrides = {}) {
  const p = plan();
  return { handoff_id: "HO-FAILED", source_session_id: "SESSION-OLD-SOURCE", source_session_file: "sessions/old-source.jsonl", target_session_id: null, target_session_file: null, runner_instance_id: "RUNNER-OLD", session_binding_id: "BIND-FAILED", parent_session_id: "SESSION-OLD-SOURCE", parent_session_file: "sessions/old-source.jsonl", parent_checkpoint_id: null, recovery_of_handoff_id: null, task_id: p.task_id, current_item: p.current_item, next_item: p.next_item, next_step: p.next_step, task_plan_revision: p.plan_revision_id, task_plan_digest: p.content_digest, requirements_version: p.requirements_version, latch_generation: 1, checkpoint_id: "CP-FAILED", checkpoint_digest: null, resume_manifest_id: "RM-FAILED", resume_manifest_digest: null, resume_prompt_id: null, resume_prompt_digest: null, resume_prompt: null, authorization_state: "NOT_AUTHORIZED", admission_state: "NOT_COMMITTED", admission_id: null, dispatch_state: "NOT_STARTED", dispatch_attempt_id: null, dispatch_attempt_no: 0, expected_git_state: { repository_id: "repo", workdir: "project", branch: "test", head_sha: "1".repeat(40), base_sha: "1".repeat(40), index_digest: `sha256:${"2".repeat(64)}`, worktree_digest: `sha256:${"3".repeat(64)}`, status_entries: [] }, model_policy: p.model_policy, reasoning_policy: p.reasoning_policy, reserved_plan_snapshot: p, state: "SAFE_TO_HANDOFF", created_at: "2026-08-30T12:00:00.000Z", updated_at: "2026-08-30T12:00:00.000Z", ...overrides };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-recovery-authority-")); const canonical = join(root, "canonical"); mkdirSync(canonical);
  const path = join(canonical, "operations.sqlite"); const authority = new ProtectedSqliteOperationAuthority(path, { allowInitialize: true });
  const initial = projection(); const clear = authority.ensureLatch(initial.task_id); const latch = authority.claimLatch({ taskId: initial.task_id, reason: "INTEGRITY", actor: "human:handoff", expected: exactLatch(clear), requestId: "LATCH-FAILED" });
  initial.latch_generation = latch.generation;
  const reservation = authority.requestHandoffReservation(initial.handoff_id, { projection: initial, expectedLatch: exactLatch(latch), expectedLatest: null }).reservation;
  const binding = authority.requestLifecycleBindingCreate("BIND-FAILED", { binding: { handoff_id: initial.handoff_id, replacement_session_id: "SESSION-FAILED-TARGET", runner_instance_id: initial.runner_instance_id, session_binding_id: initial.session_binding_id, lifecycle_incarnation: 3 } }).binding;
  const semantic = planSemanticDigest(initial.reserved_plan_snapshot, { requireAll: true });
  const checkpoint = { id: initial.checkpoint_id, digest: `sha256:${"4".repeat(64)}`, content_digest: `sha256:${"5".repeat(64)}` };
  const manifest = { id: initial.resume_manifest_id, digest: `sha256:${"6".repeat(64)}`, content_digest: `sha256:${"7".repeat(64)}` };
  authority.requestArtifactRegistration("CP-FAILED", { kind: "checkpoint", artifact_id: checkpoint.id, handoff_id: initial.handoff_id, artifact_digest: checkpoint.digest, content_digest: checkpoint.content_digest, plan_semantic_digest: semantic });
  authority.requestArtifactRegistration("RM-FAILED", { kind: "manifest", artifact_id: manifest.id, handoff_id: initial.handoff_id, artifact_digest: manifest.digest, content_digest: manifest.content_digest, plan_semantic_digest: semantic, checkpoint_id: checkpoint.id, checkpoint_digest: checkpoint.digest });
  const failed = { ...structuredClone(initial), target_session_id: binding.replacement_session_id, target_session_file: "sessions/failed-target.jsonl", checkpoint_digest: checkpoint.digest, resume_manifest_digest: manifest.digest, resume_prompt_id: "RP-FAILED", state: "CONTINUITY_FAILED", failure: { code: "REQUIRED_LOCAL_PATH_MISSING", message: "required local path unavailable" }, updated_at: "2026-08-30T12:01:00.000Z" };
  const failure = authority.requestContinuityFailure("FAILURE-FAILED", { failed_handoff: failed, reservation_digest: reservation.reservation_digest, binding, latch: exactLatch(latch), plan_semantic_digest: semantic, checkpoint, manifest }).recovery.failure;
  return { root, path, authority, initial, reservation, binding, latch, semantic, checkpoint, manifest, failed, failure };
}
function recoveryRequest(x, overrides = {}) {
  const child = projection({ handoff_id: "HO-RECOVERY-CHILD", source_session_id: "SESSION-RECOVERY-SOURCE", source_session_file: "sessions/recovery-source.jsonl", runner_instance_id: "RUNNER-RECOVERY", session_binding_id: "BIND-RECOVERY-CHILD", parent_session_id: "SESSION-RECOVERY-SOURCE", parent_session_file: "sessions/recovery-source.jsonl", parent_checkpoint_id: x.failed.checkpoint_id, recovery_of_handoff_id: x.failed.handoff_id, checkpoint_id: "CP-RECOVERY-CHILD", resume_manifest_id: "RM-RECOVERY-CHILD", expected_git_state: structuredClone(x.failed.expected_git_state), created_at: "2026-08-30T12:02:00.000Z", updated_at: "2026-08-30T12:02:00.000Z" });
  child.latch_generation = x.latch.generation;
  return { decision_id: "RCD-FAILED", failed_handoff_id: x.failed.handoff_id, failure_digest: x.failure.failure_digest, actor: "human:/aio-handoff-recover", source: { session_id: child.source_session_id, runner_instance_id: child.runner_instance_id, lifecycle_incarnation: 9, active: true, history_length: 0, idle: true }, binding: x.binding, latch: exactLatch(x.latch), plan_semantic_digest: x.semantic, model_policy: x.failed.model_policy, reasoning_policy: x.failed.reasoning_policy, git: structuredClone(x.failed.expected_git_state), checkpoint: x.checkpoint, manifest: x.manifest, child_projection: child, expected_latest: { handoff_id: x.failed.handoff_id, reservation_digest: x.reservation.reservation_digest }, ...overrides };
}
function counts(path) { const db = new DatabaseSync(path, { readOnly: true }); const names = ["continuity_failures", "continuity_recovery_decisions", "continuity_recovery_events", "handoff_reservations", "active_sources", "lifecycle_binding_events", "authority_requests"]; const result = Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT COUNT(*) count FROM ${name}`).get().count])); db.close(); return result; }

test("protected continuity failure and recovery use schema 1.6 in the shared canonical store", () => {
  const x = fixture();
  try {
    assert.equal(requireSecureRecoveryAuthority(x.authority), x.authority);
    assert.equal(x.authority.status().schema, "aiopago.operation-authority/1.6.0");
    assert.equal(x.authority.status().recovery_authority_canonical, true);
    assert.equal(x.authority.getContinuityRecovery(x.failed.handoff_id).failure.failed_handoff.state, "CONTINUITY_FAILED");
  } finally { x.authority.close(); }
});

test("bounded 1.5 recovery-input store upgrade adds recovery schema and damaged current schema fails closed", () => {
  const x = fixture(); x.authority.close();
  const legacy = new DatabaseSync(x.path);
  legacy.exec("DROP TABLE continuity_recovery_events; DROP TABLE continuity_recovery_decisions; DROP TABLE continuity_failures; UPDATE authority_metadata SET schema_version='aiopago.operation-authority/1.5.0' WHERE singleton=1;"); legacy.close();
  const upgraded = new ProtectedSqliteOperationAuthority(x.path); assert.equal(upgraded.status().schema, "aiopago.operation-authority/1.6.0"); upgraded.close();
  const damaged = new DatabaseSync(x.path); damaged.exec("ALTER TABLE continuity_recovery_events RENAME TO continuity_recovery_events_missing"); damaged.close();
  assert.throws(() => new ProtectedSqliteOperationAuthority(x.path), (error) => error.code === "SECURE_OPERATION_AUTHORITY_SCHEMA_INVALID");
});

test("one protected transaction supersedes exact binding, journals recovery, and reserves one child", () => {
  const x = fixture();
  try {
    const result = x.authority.requestContinuityRecovery("RECOVER-FAILED", recoveryRequest(x));
    assert.equal(result.created, true); assert.equal(result.recovery.decision.decision_id, "RCD-FAILED");
    assert.equal(result.recovery.binding.status, "SUPERSEDED");
    assert.equal(result.recovery.event.event_type, "CONTINUITY_RECOVERY_STARTED");
    assert.equal(result.recovery.child.recovery_of_handoff_id, x.failed.handoff_id);
    assert.equal(x.authority.getActiveSource("SESSION-RECOVERY-SOURCE").handoff_id, "HO-RECOVERY-CHILD");
    assert.equal(x.authority.continuityRecoveryEvents(x.failed.handoff_id).length, 2);
  } finally { x.authority.close(); }
});

test("exact retry is idempotent while changed request or second recovery identity conflicts", () => {
  const x = fixture();
  try {
    const request = recoveryRequest(x); x.authority.requestContinuityRecovery("RECOVER-FAILED", request);
    assert.equal(x.authority.requestContinuityRecovery("RECOVER-FAILED", structuredClone(request)).idempotent, true);
    assert.throws(() => x.authority.requestContinuityRecovery("RECOVER-FAILED", { ...request, actor: "human:other" }), (error) => error.code === "RECOVERY_REQUEST_CONFLICT");
    assert.throws(() => x.authority.requestContinuityRecovery("RECOVER-OTHER", { ...request, decision_id: "RCD-OTHER" }), (error) => error.code === "CONTINUITY_RECOVERY_CONFLICT");
    assert.equal(counts(x.path).continuity_recovery_decisions, 1);
  } finally { x.authority.close(); }
});

test("takeover first or stale lifecycle/latch/plan/artifact subject yields zero recovery mutation", async (t) => {
  for (const attack of ["takeover", "lifecycle", "plan", "artifact"]) await t.test(attack, () => {
    const x = fixture();
    try {
      const request = recoveryRequest(x); const before = counts(x.path);
      if (attack === "takeover") x.authority.claimHumanTakeover({ taskId: x.failed.task_id, actor: "human:/aio-takeover", expected: exactLatch(x.latch), requestId: "TAKEOVER-FIRST" });
      if (attack === "lifecycle") x.authority.requestLifecycleBindingTransition("SHUTDOWN-FIRST", { expected: x.binding, nextStatus: "SUPERSEDED", reason: "session_shutdown" });
      if (attack === "plan") request.plan_semantic_digest = `sha256:${"8".repeat(64)}`;
      if (attack === "artifact") request.manifest = { ...request.manifest, digest: `sha256:${"9".repeat(64)}` };
      assert.throws(() => x.authority.requestContinuityRecovery(`RECOVER-${attack}`, request));
      const after = counts(x.path);
      assert.equal(after.continuity_recovery_decisions, before.continuity_recovery_decisions);
      assert.equal(after.handoff_reservations, before.handoff_reservations);
      assert.equal(after.active_sources, before.active_sources);
    } finally { x.authority.close(); }
  });
});

test("recovery-first retains its exact decision and a later takeover blocks future progress", () => {
  const x = fixture();
  try {
    x.authority.requestContinuityRecovery("RECOVERY-FIRST", recoveryRequest(x));
    const latch = x.authority.getLatch(x.failed.task_id);
    x.authority.claimHumanTakeover({ taskId: x.failed.task_id, actor: "human:/aio-takeover", expected: exactLatch(latch), requestId: "TAKEOVER-LATER" });
    const recovery = x.authority.getContinuityRecovery(x.failed.handoff_id);
    assert.equal(recovery.decision.decision_id, "RCD-FAILED"); assert.equal(recovery.child.handoff_id, "HO-RECOVERY-CHILD");
    assert.equal(x.authority.getLatch(x.failed.task_id).reason, "HUMAN_TAKEOVER");
  } finally { x.authority.close(); }
});

test("simultaneous protected takeover/recovery has one valid SQLite serialization", async () => {
  const x = fixture(); const request = recoveryRequest(x); const expected = exactLatch(x.latch); x.authority.close();
  const gate = join(x.root, "race-takeover"); const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const launch = (script) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore","pipe","pipe"] }); let out="",err=""; child.stdout.on("data",c=>out+=c); child.stderr.on("data",c=>err+=c); child.on("error",reject); child.on("exit",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));
  });
  const prefix = `import { existsSync } from 'node:fs'; import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)}; while(!existsSync(${JSON.stringify(gate)})) await new Promise(r=>setTimeout(r,2)); const a=new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)}); let r; try {`;
  const recovery = launch(`${prefix} r=a.requestContinuityRecovery('RACE-RECOVERY',${JSON.stringify(request)}); r={kind:'recovery',created:r.created}; } catch(e){r={kind:'recovery',code:e.code};} finally{a.close();} process.stdout.write(JSON.stringify(r));`);
  const takeover = launch(`${prefix} const v=a.claimHumanTakeover({taskId:'TASK-RECOVERY',actor:'human:/aio-takeover',expected:${JSON.stringify(expected)},requestId:'RACE-TAKEOVER'}); r={kind:'takeover',reason:v.reason}; } catch(e){r={kind:'takeover',code:e.code};} finally{a.close();} process.stdout.write(JSON.stringify(r));`);
  writeFileSync(gate, "go\n"); const results = await Promise.all([recovery, takeover]);
  const reopened = new ProtectedSqliteOperationAuthority(x.path);
  try {
    const decision = reopened.getContinuityRecovery(x.failed.handoff_id).decision;
    const takeoverState = reopened.getLatch(x.failed.task_id).reason === "HUMAN_TAKEOVER";
    assert.equal(takeoverState, true);
    assert.equal(decision === null || decision.decision_id === "RCD-FAILED", true);
    assert.equal(results.some((r) => r.created === true) || results.some((r) => r.code === "HUMAN_TAKEOVER_ACTIVE"), true);
  } finally { reopened.close(); }
});

test("forced failure after decision, binding, event, or child insertion rolls back the exact old state", async (t) => {
  for (const table of ["continuity_recovery_decisions", "lifecycle_binding_events", "continuity_recovery_events", "handoff_reservation_events"]) await t.test(table, () => {
    const x = fixture(); const db = new DatabaseSync(x.path);
    try {
      db.exec(`CREATE TRIGGER fail_recovery BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'forced recovery seam'); END;`);
      assert.throws(() => x.authority.requestContinuityRecovery(`RECOVER-FAIL-${table}`, recoveryRequest(x)), /forced recovery seam/);
      assert.equal(x.authority.getLifecycleBinding(x.failed.handoff_id).status, "ACTIVE");
      assert.equal(x.authority.getHandoffReservation("HO-RECOVERY-CHILD"), null);
      assert.equal(x.authority.getContinuityRecovery(x.failed.handoff_id).decision, null);
    } finally { db.exec("DROP TRIGGER IF EXISTS fail_recovery"); db.close(); x.authority.close(); }
  });
});

test("five real pre-COMMIT process crashes restore exact failure; committed recovery survives restart", async (t) => {
  for (const [seam, status] of [["after_decision",104],["after_binding",105],["after_recovery_event",106],["after_child_reservation",107],["before_commit",108]]) await t.test(seam, () => {
    const x = fixture(); const request = recoveryRequest(x); x.authority.close(); const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)}; const a=new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)}); a.crashContinuityRecoveryForPhysicalTest("CRASH-${seam}",${JSON.stringify(request)},${JSON.stringify(seam)});`], { encoding: "utf8" });
    assert.equal(child.status, status, child.stderr);
    const reopened = new ProtectedSqliteOperationAuthority(x.path);
    try { assert.equal(reopened.getContinuityRecovery(x.failed.handoff_id).decision, null); assert.equal(reopened.getLifecycleBinding(x.failed.handoff_id).status, "ACTIVE"); assert.equal(reopened.getHandoffReservation("HO-RECOVERY-CHILD"), null); }
    finally { reopened.close(); }
  });
  const x = fixture(); x.authority.requestContinuityRecovery("COMMITTED", recoveryRequest(x)); x.authority.close(); const reopened = new ProtectedSqliteOperationAuthority(x.path);
  try { assert.equal(reopened.getContinuityRecovery(x.failed.handoff_id).decision.decision_id, "RCD-FAILED"); assert.equal(reopened.getHandoffReservation("HO-RECOVERY-CHILD").recovery_of_handoff_id, x.failed.handoff_id); }
  finally { reopened.close(); }
});

test("six independent exact attempts serialize to one canonical child", async () => {
  const x = fixture(); const request = recoveryRequest(x); x.authority.close(); const gate = join(x.root, "go"); const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const children = Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const script = `import { existsSync } from 'node:fs'; import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)}; while(!existsSync(${JSON.stringify(gate)})) await new Promise(r=>setTimeout(r,2)); const a=new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)}); try { const r=a.requestContinuityRecovery('RACE-${index}',${JSON.stringify(request)}); process.stdout.write(JSON.stringify({created:r.created,idempotent:r.idempotent})); } catch(e){process.stdout.write(JSON.stringify({code:e.code}));} finally{a.close();}`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore","pipe","pipe"] }); let out="",err=""; child.stdout.on("data",c=>out+=c); child.stderr.on("data",c=>err+=c); child.on("error",reject); child.on("exit",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));
  }));
  writeFileSync(gate, "go\n"); const results = await Promise.all(children);
  assert.equal(results.filter((r) => r.created).length, 1); assert.equal(results.filter((r) => r.idempotent).length, 5);
  const reopened = new ProtectedSqliteOperationAuthority(x.path); try { assert.equal(counts(x.path).continuity_recovery_decisions, 1); assert.equal(reopened.getHandoffReservation("HO-RECOVERY-CHILD").handoff_id, "HO-RECOVERY-CHILD"); } finally { reopened.close(); }
});

test("project recovery forgery and false-negative deletion have zero canonical effect", () => {
  const x = fixture();
  try {
    const project = new DatabaseSync(join(x.root, "project.sqlite")); project.exec("CREATE TABLE recovery(id TEXT,state TEXT); INSERT INTO recovery VALUES('FORGED','CONTINUITY_RECOVERY_STARTED');");
    assert.equal(x.authority.getContinuityRecovery(x.failed.handoff_id).decision, null);
    x.authority.requestContinuityRecovery("LEGIT", recoveryRequest(x)); const canonical = x.authority.getContinuityRecovery(x.failed.handoff_id);
    project.exec("DELETE FROM recovery; INSERT INTO recovery VALUES('OLD','CONTINUITY_FAILED');"); project.close();
    assert.deepEqual(x.authority.getContinuityRecovery(x.failed.handoff_id), canonical);
  } finally { x.authority.close(); }
});

test("DISPATCHING and UNKNOWN reconciliation remain STILL_UNKNOWN with no replay permit", () => {
  const x = fixture();
  try {
    // The recovery domain deliberately exposes no MARK_SUCCESS or replay operation.
    assert.equal(x.authority.inspectDispatchReconciliation(x.failed.handoff_id), null);
    const api = Object.getOwnPropertyNames(Object.getPrototypeOf(x.authority));
    assert.equal(api.some((name) => /mark.*success|replay.*dispatch/i.test(name)), false);
  } finally { x.authority.close(); }
});
