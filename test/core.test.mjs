import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.mjs";
import { GuardianError } from "../src/errors.mjs";
import { observeGitState, sameGitState } from "../src/git-state.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { AdmissionGate, SafePointCoordinator, ToolOperationTracker } from "../src/safety.mjs";
import { GuardianStorage } from "../src/storage.mjs";

function temp() { return mkdtempSync(join(tmpdir(), "eiopago-core-")); }

function minimalLedger(path, overrides = {}) {
  const task = {
    schema_version: "0.1.0", task_id: "TASK-T", title: "t", objective: "o",
    requirements_version: "REQ-1", plan_revision_id: "PLAN-1", status: "IN_PROGRESS",
    completion_criteria: ["tested"], risk: "HIGH", created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z", current_item: "ITEM-1", next_item: null, next_step: "next",
    task_items: [{ task_item_id: "ITEM-1", task_id: "TASK-T", title: "i", description: "d", status: "IN_PROGRESS", depends_on: [], completion_criteria: ["x"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "M1-H0", last_updated_at: "2026-08-08T00:00:00Z", last_updated_by: "human" }],
    ...overrides,
  };
  writeFileSync(path, `# Ledger\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

test("Ledger computes a byte digest and rejects DONE without evidence", () => {
  const root = temp(); const path = join(root, "TASK_PLAN.md");
  minimalLedger(path);
  const first = new TaskLedger(path).read();
  assert.equal(first.current_item, "ITEM-1");
  assert.equal(first.next_item, null);
  assert.match(first.content_digest, /^sha256:[a-f0-9]{64}$/);
  const invalid = { task_items: [{ task_item_id: "ITEM-1", task_id: "TASK-T", title: "i", description: "d", status: "DONE", depends_on: [], completion_criteria: ["x"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "M1-H0", last_updated_at: "2026-08-08T00:00:00Z", last_updated_by: "human" }] };
  minimalLedger(path, invalid);
  assert.throws(() => new TaskLedger(path).read(), (error) => error.code === "DONE_WITHOUT_EVIDENCE");
});

test("Git continuity digests detect byte changes with unchanged porcelain status", () => {
  const root = temp();
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "core@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Eiopago Core"], { cwd: root });
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });

  writeFileSync(join(root, "tracked.txt"), "dirty version one\n");
  const dirtyOne = observeGitState(root);
  writeFileSync(join(root, "tracked.txt"), "dirty version two\n");
  const dirtyTwo = observeGitState(root);
  assert.deepEqual(dirtyOne.status_entries, dirtyTwo.status_entries);
  assert.equal(dirtyOne.index_digest, dirtyTwo.index_digest);
  assert.notEqual(dirtyOne.worktree_digest, dirtyTwo.worktree_digest);
  assert.equal(sameGitState(dirtyOne, dirtyTwo), false);

  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  const stagedTwo = observeGitState(root);
  writeFileSync(join(root, "tracked.txt"), "dirty version three\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  const stagedThree = observeGitState(root);
  assert.deepEqual(stagedTwo.status_entries, stagedThree.status_entries);
  assert.notEqual(stagedTwo.index_digest, stagedThree.index_digest);
  assert.equal(sameGitState(stagedTwo, stagedThree), false);
});

test("sealed artifacts are immutable, indexed, and detect byte tampering", () => {
  const root = temp(); const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  const artifacts = new ArtifactStore(join(root, ".guardian"), storage);
  const payload = { checkpoint_id: "CP-one", created_at: "2026-08-08T00:00:00Z", status: "PARTIAL" };
  const first = artifacts.persist("checkpoint", "CP-one", payload);
  const retry = artifacts.persist("checkpoint", "CP-one", payload);
  assert.equal(first.digest, retry.digest);
  assert.equal(artifacts.verify("checkpoint", "CP-one", first.digest).payload.status, "PARTIAL");
  writeFileSync(first.path, `${readFileSync(first.path, "utf8")}tampered`);
  assert.throws(() => artifacts.verify("checkpoint", "CP-one", first.digest), (error) => error.code === "CHECKPOINT_MISMATCH");
  storage.close();
});

test("SQLite linearizes latch release and one resume admission", () => {
  const root = temp(); const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  storage.ensureLatch("TASK-T");
  const latch = storage.engageLatch("TASK-T", "INTEGRITY", "human:test");
  const h = {
    handoff_id: "HO-one", source_session_id: "SES-source", target_session_id: "SES-target",
    task_id: "TASK-T", state: "RESUME_READY", latch_generation: latch.generation,
    resume_prompt_id: "RP-one", admission_state: "NOT_COMMITTED", dispatch_state: "NOT_STARTED",
  };
  storage.reserveHandoff(h);
  const first = storage.authorizeAndAdmit("HO-one", "human:test", "resume:RP-one", "ADM-one");
  const second = storage.authorizeAndAdmit("HO-one", "human:test", "resume:RP-one", "ADM-one");
  assert.equal(first.admission_id, second.admission_id);
  assert.equal(second.idempotent, true);
  assert.equal(storage.events("HO-one").filter((event) => event.event_type === "RESUME_ADMISSION_COMMITTED").length, 1);
  assert.equal(storage.getLatch("TASK-T").state, "RELEASED");
  const intent = storage.beginDispatch("HO-one", "DSP-one", 1);
  assert.equal(intent.idempotent, false);
  storage.finishDispatch("HO-one", "UNKNOWN", "ambiguous transport");
  assert.throws(() => storage.beginDispatch("HO-one", "DSP-two", 2), (error) => error.code === "RESUME_DISPATCH_UNKNOWN");
  storage.close();
});

test("a pending handoff confirmation cannot release HUMAN_TAKEOVER", () => {
  const root = temp(); const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  storage.ensureLatch("TASK-T");
  const latch = storage.engageLatch("TASK-T", "HANDOFF", "human:test");
  storage.reserveHandoff({
    handoff_id: "HO-stale-confirm", source_session_id: "SES-source", target_session_id: "SES-target",
    task_id: "TASK-T", state: "RESUME_READY", latch_generation: latch.generation,
    resume_prompt_id: "RP-stale-confirm", admission_state: "NOT_COMMITTED", dispatch_state: "NOT_STARTED",
  });
  storage.engageLatch("TASK-T", "HUMAN_TAKEOVER", "human:/eio-takeover");
  assert.throws(
    () => storage.authorizeAndAdmit("HO-stale-confirm", "human:stale-confirm", "resume:RP-stale-confirm", "ADM-stale-confirm"),
    (error) => error.code === "HUMAN_TAKEOVER_ACTIVE",
  );
  const blocked = storage.getHandoff("HO-stale-confirm");
  const takeover = storage.getLatch("TASK-T");
  assert.equal(blocked.admission_state, "NOT_COMMITTED");
  assert.equal(blocked.state, "RESUME_READY");
  assert.equal(takeover.state, "ENGAGED");
  assert.equal(takeover.reason, "HUMAN_TAKEOVER");
  assert.equal(storage.events("HO-stale-confirm").some((event) => event.event_type === "LATCH_RELEASED" || event.event_type === "RESUME_ADMISSION_COMMITTED"), false);
  storage.close();
});

test("safe point closes transport, clears queue, and fails closed on unknown mutation", async () => {
  const root = temp(); const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  storage.ensureLatch("TASK-T");
  const gate = new AdmissionGate(storage, "TASK-T");
  const safe = new SafePointCoordinator({ storage, taskId: "TASK-T", gate });
  const session = {
    isIdle: true, isStreaming: false, pendingMessageCount: 1, isRetrying: false, isCompacting: false,
    clearQueue() { this.pendingMessageCount = 0; }, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {},
    async abort() { this.isIdle = true; }, async waitForIdle() {},
  };
  const result = await safe.request(session);
  assert.equal(result.state, "SAFE_TO_HANDOFF");
  assert.throws(() => gate.admit(() => null), (error) => error.code === "LLM_ADMISSION_BLOCKED");
  const escalated = storage.engageLatch("TASK-T", "HUMAN_TAKEOVER", "human:/eio-takeover");
  assert.equal(escalated.generation, result.latch_generation);
  assert.equal(escalated.reason, "HUMAN_TAKEOVER");
  const drainTask = "TASK-V"; storage.ensureLatch(drainTask);
  storage.admitOperation({ operationId: "OP-drain", taskId: drainTask, generation: 0, profile: "LOCAL_ATOMIC_MUTATION" });
  let aborts = 0;
  const drainingSession = {
    isIdle: false, isStreaming: false, pendingMessageCount: 0, isRetrying: false, isCompacting: false,
    clearQueue() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {},
    async abort() { aborts += 1; },
    async waitForIdle() { storage.finishOperation("OP-drain", "KNOWN_SUCCESS", "file:atomic.txt"); this.isIdle = true; },
  };
  const drained = await new SafePointCoordinator({ storage, taskId: drainTask, gate: new AdmissionGate(storage, drainTask) }).request(drainingSession);
  assert.equal(drained.state, "SAFE_TO_HANDOFF");
  assert.equal(aborts, 0, "an admitted atomic operation must not be aborted");
  const trackedTask = "TASK-W"; storage.ensureLatch(trackedTask);
  const tracker = new ToolOperationTracker(storage, trackedTask);
  tracker.admit("OP-write", "write", { path: "src\\atomic.txt" });
  tracker.finish("OP-write", false);
  const tracked = storage.operationsForTask(trackedTask)[0];
  assert.equal(tracked.effect_reference, "file:src/atomic.txt");
  const trackedSafe = await new SafePointCoordinator({ storage, taskId: trackedTask, gate: new AdmissionGate(storage, trackedTask) }).request({ ...session, pendingMessageCount: 0 });
  assert.equal(trackedSafe.state, "SAFE_TO_HANDOFF");
  const releaseTask = "TASK-U"; storage.ensureLatch(releaseTask);
  storage.admitOperation({ operationId: "OP-1", taskId: releaseTask, generation: 0, profile: "LOCAL_ATOMIC_MUTATION" });
  storage.finishOperation("OP-1", "UNKNOWN");
  const other = new SafePointCoordinator({ storage, taskId: releaseTask, gate: new AdmissionGate(storage, releaseTask) });
  await assert.rejects(() => other.request({ ...session, pendingMessageCount: 0 }), (error) => error.code === "HUMAN_DECISION_REQUIRED");
  storage.close();
});
