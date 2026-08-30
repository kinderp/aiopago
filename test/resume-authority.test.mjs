import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sha256 } from "../src/canonical.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { planSemanticDigest } from "../src/plan-semantics-internal.mjs";
import { requireSecureResumeAuthority } from "../src/resume-authority.mjs";

function projection() {
  const digest = `sha256:${"a".repeat(64)}`;
  const plan = { task_id: "TASK-RESUME", objective: "Protected resume", current_item: "ITEM-1", next_item: "ITEM-2", next_step: "Continue", plan_revision_id: "PLAN-1", content_digest: digest, requirements_version: "REQ-1", completion_criteria: ["bounded"], relevant_decisions: [], relevant_tests: [], evidence_references: [], minimal_reads: ["TASK_PLAN.md"], required_local_paths: ["TASK_PLAN.md"], model_policy: "offline/fake", reasoning_policy: "off" };
  return { handoff_id: "HO-RESUME", source_session_id: "SESSION-SOURCE", source_session_file: "sessions/source.jsonl", target_session_id: null, target_session_file: null, runner_instance_id: "RUNNER-1", session_binding_id: "BIND-RESUME", parent_session_id: "SESSION-SOURCE", parent_session_file: "sessions/source.jsonl", parent_checkpoint_id: null, recovery_of_handoff_id: null, task_id: plan.task_id, current_item: plan.current_item, next_item: plan.next_item, next_step: plan.next_step, task_plan_revision: plan.plan_revision_id, task_plan_digest: digest, requirements_version: plan.requirements_version, latch_generation: 1, checkpoint_id: "CP-RESUME", checkpoint_digest: null, resume_manifest_id: "RM-RESUME", resume_manifest_digest: null, resume_prompt_id: null, resume_prompt_digest: null, resume_prompt: null, authorization_state: "NOT_AUTHORIZED", admission_state: "NOT_COMMITTED", admission_id: null, dispatch_state: "NOT_STARTED", dispatch_attempt_id: null, dispatch_attempt_no: 0, expected_git_state: { repository_id: "repo", workdir: "project", branch: "test", head_sha: "a".repeat(40), base_sha: "a".repeat(40), index_digest: `sha256:${"b".repeat(64)}`, worktree_digest: `sha256:${"c".repeat(64)}`, status_entries: [] }, model_policy: plan.model_policy, reasoning_policy: plan.reasoning_policy, reserved_plan_snapshot: plan, state: "SAFE_TO_HANDOFF", created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z" };
}
function latch(l) { return { task_id: l.task_id, state: l.state, generation: l.generation, reason: l.reason }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-resume-authority-")); const canonical = join(root, "canonical"); mkdirSync(canonical);
  const path = join(canonical, "operations.sqlite"); const authority = new ProtectedSqliteOperationAuthority(path, { allowInitialize: true });
  const p = projection(); const clear = authority.ensureLatch(p.task_id); const engaged = authority.claimLatch({ taskId: p.task_id, reason: "INTEGRITY", actor: "human:handoff", expected: latch(clear), requestId: "LATCH-RESUME" });
  const reservation = authority.requestHandoffReservation(p.handoff_id, { projection: p, expectedLatch: latch(engaged), expectedLatest: null }).reservation;
  const binding = { handoff_id: p.handoff_id, replacement_session_id: "SESSION-TARGET", runner_instance_id: p.runner_instance_id, session_binding_id: p.session_binding_id, lifecycle_incarnation: 3 };
  authority.requestLifecycleBindingCreate("BIND-RESUME", { binding });
  const semanticDigest = planSemanticDigest(p.reserved_plan_snapshot, { requireAll: true });
  const checkpointDigest = `sha256:${"d".repeat(64)}`;
  const manifestDigest = `sha256:${"e".repeat(64)}`;
  authority.requestArtifactRegistration("CP-RESUME", {
    kind: "checkpoint", artifact_id: p.checkpoint_id, handoff_id: p.handoff_id,
    artifact_digest: checkpointDigest, content_digest: `sha256:${"1".repeat(64)}`,
    plan_semantic_digest: semanticDigest,
  });
  authority.requestArtifactRegistration("RM-RESUME", {
    kind: "manifest", artifact_id: p.resume_manifest_id, handoff_id: p.handoff_id,
    artifact_digest: manifestDigest, content_digest: `sha256:${"2".repeat(64)}`,
    plan_semantic_digest: semanticDigest, checkpoint_id: p.checkpoint_id, checkpoint_digest: checkpointDigest,
  });
  const prompt = "AIOPAGO_RESUME_V1\ntask_id=TASK-RESUME";
  const ready = authority.requestResumeReadiness("READY-RESUME", {
    handoff_id: p.handoff_id, reservation_digest: reservation.reservation_digest,
    binding: { ...binding, status: "ACTIVE" }, latch: latch(engaged),
    checkpoint_digest: checkpointDigest, resume_manifest_digest: manifestDigest,
    resume_prompt_id: "RP-RESUME", resume_prompt_digest: sha256(Buffer.from(prompt)), resume_prompt: prompt,
    plan_semantic_digest: semanticDigest,
  }).readiness;
  return { root, path, authority, p, engaged, binding, ready };
}
function yes(x, overrides = {}) {
  return { answer: "YES", actor: "human:/aio-resume", handoff_id: x.p.handoff_id, readiness_digest: x.ready.readiness_digest,
    resume_prompt_id: x.ready.resume_prompt_id, authorization_id: "AUTH-RESUME", admission_id: "ADM-RESUME",
    idempotency_key: "resume:RP-RESUME", dispatch_attempt_id: "DSP-RESUME", attempt_no: 1,
    binding: { ...x.binding, status: "ACTIVE" }, latch: latch(x.engaged), ...overrides };
}
function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const result = Object.fromEntries(["resume_readiness", "resume_authorizations", "resume_admissions", "resume_dispatch_attempts", "resume_authority_events"].map((table) => [table, db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));
  db.close(); return result;
}

test("protected resume schema extends the same canonical store and is selected explicitly", () => {
  const x = fixture();
  try {
    assert.equal(requireSecureResumeAuthority(x.authority), x.authority);
    assert.equal(x.authority.status().schema, "aiopago.operation-authority/1.5.0");
    assert.equal(x.authority.status().resume_authority_canonical, true);
    assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 0, resume_admissions: 0, resume_dispatch_attempts: 0, resume_authority_events: 1 });
  } finally { x.authority.close(); }
});

test("bounded 1.3 lifecycle store upgrade adds resume schema and damaged current schema fails closed", () => {
  const x = fixture(); x.authority.close();
  const legacy = new DatabaseSync(x.path);
  legacy.exec("DROP TABLE resume_authority_events; DROP TABLE resume_dispatch_attempts; DROP TABLE resume_admissions; DROP TABLE resume_authorizations; DROP TABLE resume_readiness; UPDATE authority_metadata SET schema_version='aiopago.operation-authority/1.3.0' WHERE singleton=1;"); legacy.close();
  const upgraded = new ProtectedSqliteOperationAuthority(x.path); assert.equal(upgraded.status().schema, "aiopago.operation-authority/1.5.0"); upgraded.close();
  const damaged = new DatabaseSync(x.path); damaged.exec("ALTER TABLE resume_admissions RENAME TO resume_admissions_missing"); damaged.close();
  assert.throws(() => new ProtectedSqliteOperationAuthority(x.path), (error) => error.code === "SECURE_OPERATION_AUTHORITY_SCHEMA_INVALID");
});

test("NO is invocation-bound, creates no authorization/admission/dispatch, and changed same request conflicts", () => {
  const x = fixture();
  try {
    const no = { answer: "NO", actor: "human:/aio-resume", handoff_id: x.p.handoff_id, readiness_digest: x.ready.readiness_digest, resume_prompt_id: x.ready.resume_prompt_id };
    const first = x.authority.requestResumeDecision("DECISION-NO", no);
    assert.equal(first.authorized, false); assert.equal(first.dispatch_permit, false);
    assert.equal(x.authority.requestResumeDecision("DECISION-NO", structuredClone(no)).idempotent, true);
    assert.throws(() => x.authority.requestResumeDecision("DECISION-NO", yes(x)), (error) => error.code === "RESUME_DECISION_CONFLICT");
    assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 0, resume_admissions: 0, resume_dispatch_attempts: 0, resume_authority_events: 1 });
  } finally { x.authority.close(); }
});

test("NO then a fresh YES is allowed; authorization, admission, latch release, and one dispatch intent commit atomically", () => {
  const x = fixture();
  try {
    x.authority.requestResumeDecision("DECISION-NO", { answer: "NO", actor: "human:/aio-resume", handoff_id: x.p.handoff_id, readiness_digest: x.ready.readiness_digest, resume_prompt_id: x.ready.resume_prompt_id });
    const accepted = x.authority.requestResumeDecision("DECISION-YES", yes(x));
    assert.equal(accepted.dispatch_permit, true); assert.equal(accepted.state.authorization.authorization_id, "AUTH-RESUME");
    assert.equal(accepted.state.admission.admission_id, "ADM-RESUME"); assert.equal(accepted.state.dispatch.state, "DISPATCHING");
    assert.equal(x.authority.getLatch(x.p.task_id).state, "RELEASED"); assert.equal(x.authority.getLatch(x.p.task_id).generation, 2);
    assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 1, resume_admissions: 1, resume_dispatch_attempts: 1, resume_authority_events: 5 });
  } finally { x.authority.close(); }
});

test("duplicate and concurrent-shaped YES identities produce one admission and one non-replayable dispatch permit", () => {
  const x = fixture();
  try {
    const first = x.authority.requestResumeDecision("YES-1", yes(x)); assert.equal(first.dispatch_permit, true);
    const exact = x.authority.requestResumeDecision("YES-1", yes(x)); assert.equal(exact.dispatch_permit, false); assert.equal(exact.idempotent, true);
    const secondRequest = x.authority.requestResumeDecision("YES-2", yes(x)); assert.equal(secondRequest.dispatch_permit, false); assert.equal(secondRequest.idempotent, true);
    assert.throws(() => x.authority.requestResumeDecision("NO-AFTER-YES", { answer: "NO", actor: "human:/aio-resume", handoff_id: x.p.handoff_id, readiness_digest: x.ready.readiness_digest, resume_prompt_id: x.ready.resume_prompt_id }), (error) => error.code === "RESUME_ALREADY_ADMITTED_CONFLICT");
    assert.throws(() => x.authority.requestResumeDecision("YES-3", yes(x, { actor: "human:other" })), (error) => error.code === "RESUME_ALREADY_ADMITTED_CONFLICT");
    assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 1, resume_admissions: 1, resume_dispatch_attempts: 1, resume_authority_events: 5 });
  } finally { x.authority.close(); }
});

test("independent protected clients competing on one YES produce one canonical admission and one dispatch permit", async () => {
  const x = fixture(); const decision = yes(x); x.authority.close();
  const gate = join(x.root, "race.go"); const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const children = Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const script = `
      import { existsSync } from "node:fs";
      import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
      while (!existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 2));
      const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)});
      try { const result = authority.requestResumeDecision("RACE-${index}", ${JSON.stringify(decision)}); process.stdout.write(JSON.stringify({ permit: result.dispatch_permit, idempotent: result.idempotent })); }
      catch (error) { process.stdout.write(JSON.stringify({ code: error.code ?? null })); }
      finally { authority.close(); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`child ${code}: ${stderr}`)));
  }));
  writeFileSync(gate, "go\n");
  const results = await Promise.all(children);
  assert.equal(results.filter((result) => result.permit === true).length, 1);
  assert.equal(results.filter((result) => result.permit === false && result.idempotent === true).length, 5);
  const recovered = new ProtectedSqliteOperationAuthority(x.path);
  try { assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 1, resume_admissions: 1, resume_dispatch_attempts: 1, resume_authority_events: 5 }); }
  finally { recovered.close(); }
});

test("forced admission or dispatch-intent failure rolls back authorization, latch release, and every resume row", async (t) => {
  for (const table of ["resume_admissions", "resume_dispatch_attempts"]) await t.test(table, () => {
    const x = fixture(); const db = new DatabaseSync(x.path);
    try {
      db.exec(`CREATE TRIGGER fail_resume BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'forced resume seam'); END;`);
      assert.throws(() => x.authority.requestResumeDecision(`YES-FAIL-${table}`, yes(x)), /forced resume seam/);
      assert.equal(x.authority.getLatch(x.p.task_id).state, "ENGAGED");
      assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 0, resume_admissions: 0, resume_dispatch_attempts: 0, resume_authority_events: 1 });
    } finally { db.exec("DROP TRIGGER IF EXISTS fail_resume"); db.close(); x.authority.close(); }
  });
});

test("takeover or lifecycle supersession before YES refuses all resume authority", async (t) => {
  await t.test("takeover", () => {
    const x = fixture();
    try {
      x.authority.claimHumanTakeover({ taskId: x.p.task_id, actor: "human:/aio-takeover", expected: latch(x.engaged), requestId: "TAKEOVER" });
      assert.throws(() => x.authority.requestResumeDecision("YES-TAKEOVER", yes(x)), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
      assert.equal(x.authority.getResumeState(x.p.handoff_id).authorization, null);
    } finally { x.authority.close(); }
  });
  await t.test("shutdown and same-ID ABA", () => {
    const x = fixture();
    try {
      x.authority.requestLifecycleBindingTransition("SHUTDOWN", { expected: { ...x.binding, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "session_shutdown" });
      assert.throws(() => x.authority.requestResumeDecision("YES-DEAD", yes(x)), (error) => error.code === "LIFECYCLE_BINDING_STALE");
      assert.throws(() => x.authority.requestResumeDecision("YES-ABA", yes(x, { binding: { ...x.binding, lifecycle_incarnation: 4, status: "ACTIVE" } })), (error) => error.code === "LIFECYCLE_BINDING_STALE");
      assert.equal(x.authority.getResumeState(x.p.handoff_id).authorization, null);
    } finally { x.authority.close(); }
  });
});

test("admission/intent first then takeover is the opposite valid serial order and does not erase the admitted dispatch", () => {
  const x = fixture();
  try {
    x.authority.requestResumeDecision("YES-FIRST", yes(x));
    const released = x.authority.getLatch(x.p.task_id);
    const takeover = x.authority.claimHumanTakeover({ taskId: x.p.task_id, actor: "human:/aio-takeover", expected: latch(released), requestId: "TAKEOVER-AFTER-INTENT" });
    assert.equal(takeover.reason, "HUMAN_TAKEOVER"); assert.equal(takeover.generation, 3);
    const state = x.authority.getResumeState(x.p.handoff_id);
    assert.equal(state.admission.admission_id, "ADM-RESUME"); assert.equal(state.dispatch.state, "DISPATCHING");
    assert.equal(x.authority.requestResumeDispatchOutcome("ACK-AFTER-TAKEOVER", { dispatch_attempt_id: "DSP-RESUME", outcome: "ACKNOWLEDGED", error: null }).outcome, "ACKNOWLEDGED");
  } finally { x.authority.close(); }
});

test("dispatch outcome is one-way; success, duplicate, contradiction, and ambiguity remain exact", async (t) => {
  for (const outcome of ["ACKNOWLEDGED", "UNKNOWN"]) await t.test(outcome, () => {
    const x = fixture();
    try {
      x.authority.requestResumeDecision("YES", yes(x));
      const request = { dispatch_attempt_id: "DSP-RESUME", outcome, error: outcome === "UNKNOWN" ? "timeout after request" : null };
      const first = x.authority.requestResumeDispatchOutcome(`OUTCOME-${outcome}`, request);
      assert.equal(first.state.dispatch.state, outcome);
      assert.equal(x.authority.requestResumeDispatchOutcome(`OUTCOME-${outcome}`, structuredClone(request)).idempotent, true);
      assert.throws(() => x.authority.requestResumeDispatchOutcome("OUTCOME-CONFLICT", { dispatch_attempt_id: "DSP-RESUME", outcome: outcome === "UNKNOWN" ? "ACKNOWLEDGED" : "UNKNOWN", error: outcome === "UNKNOWN" ? null : "ambiguous" }), (error) => error.code === "RESUME_DISPATCH_OUTCOME_CONFLICT");
    } finally { x.authority.close(); }
  });
});

test("crash before the atomic authorization/admission/intent COMMIT restores readiness and the engaged latch", () => {
  const x = fixture(); const decision = yes(x); x.authority.close();
  const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
    const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)});
    authority.crashBeforeResumeAdmissionCommitForPhysicalTest("CRASH-ADMISSION", ${JSON.stringify(decision)});
  `], { encoding: "utf8" });
  assert.equal(child.status, 101, child.stderr);
  const recovered = new ProtectedSqliteOperationAuthority(x.path);
  try {
    assert.equal(recovered.getLatch(x.p.task_id).state, "ENGAGED");
    assert.equal(recovered.getResumeState(x.p.handoff_id).authorization, null);
    assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 0, resume_admissions: 0, resume_dispatch_attempts: 0, resume_authority_events: 1 });
  } finally { recovered.close(); }
});

test("crash after external-success outcome UPDATE before COMMIT leaves DISPATCHING and forbids replay", () => {
  const x = fixture(); x.authority.requestResumeDecision("YES", yes(x)); x.authority.close();
  const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
    const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(x.path)});
    authority.crashBeforeResumeOutcomeCommitForPhysicalTest("CRASH-OUTCOME", { dispatch_attempt_id: "DSP-RESUME", outcome: "ACKNOWLEDGED", error: null });
  `], { encoding: "utf8" });
  assert.equal(child.status, 102, child.stderr);
  const recovered = new ProtectedSqliteOperationAuthority(x.path);
  try {
    assert.equal(recovered.getResumeState(x.p.handoff_id).dispatch.state, "DISPATCHING");
    assert.equal(recovered.requestResumeDecision("YES-RESTART", yes(x)).dispatch_permit, false);
  } finally { recovered.close(); }
});

test("restart after admission/intent never grants a second external dispatch permit and ambiguity remains for recovery", () => {
  const x = fixture();
  const admitted = x.authority.requestResumeDecision("YES-BEFORE-RESTART", yes(x));
  assert.equal(admitted.dispatch_permit, true); x.authority.close();
  const restarted = new ProtectedSqliteOperationAuthority(x.path);
  try {
    const state = restarted.getResumeState(x.p.handoff_id);
    assert.equal(state.dispatch.state, "DISPATCHING");
    const retry = restarted.requestResumeDecision("YES-AFTER-RESTART", yes(x));
    assert.equal(retry.dispatch_permit, false); assert.equal(retry.state.dispatch.state, "DISPATCHING");
    assert.deepEqual(counts(x.path), { resume_readiness: 1, resume_authorizations: 1, resume_admissions: 1, resume_dispatch_attempts: 1, resume_authority_events: 5 });
  } finally { restarted.close(); }
});

test("project fake YES/admission/success and later project deletion or NO have zero canonical effect", () => {
  const x = fixture();
  try {
    const project = new DatabaseSync(join(x.root, "project.sqlite"));
    project.exec("CREATE TABLE authorizations(id TEXT); CREATE TABLE admissions(id TEXT); CREATE TABLE dispatch_attempts(id TEXT,state TEXT);");
    project.exec("INSERT INTO authorizations VALUES('YES'); INSERT INTO admissions VALUES('ADM'); INSERT INTO dispatch_attempts VALUES('DSP','SUCCESS');");
    assert.equal(x.authority.getResumeState(x.p.handoff_id).authorization, null);
    x.authority.requestResumeDecision("YES", yes(x));
    const canonical = x.authority.getResumeState(x.p.handoff_id);
    project.exec("DELETE FROM authorizations; DELETE FROM admissions; DELETE FROM dispatch_attempts; INSERT INTO authorizations VALUES('NO'); INSERT INTO dispatch_attempts VALUES('DSP','FAILED');"); project.close();
    assert.deepEqual(x.authority.getResumeState(x.p.handoff_id), canonical);
  } finally { x.authority.close(); }
});
