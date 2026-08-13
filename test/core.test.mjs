import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.mjs";
import { ContextHandoffAdvisor, contextHandoffThreshold } from "../src/context-advisor.mjs";
import { GuardianError } from "../src/errors.mjs";
import { createGuardianExtension } from "../src/extension.mjs";
import { observeGitState, sameGitState } from "../src/git-state.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { readRuntimeRunnerBinding, verifyRunnerOwnership } from "../src/runner-ownership.mjs";
import { AdmissionGate, SafePointCoordinator, ToolOperationTracker } from "../src/safety.mjs";
import { GuardianStorage } from "../src/storage.mjs";

function temp() { return mkdtempSync(join(tmpdir(), "eiopago-core-")); }

test("Context Handoff Advisor validates configuration and deduplicates above-threshold events", () => {
  assert.equal(contextHandoffThreshold(), 50);
  assert.equal(contextHandoffThreshold("62.5"), 62.5);
  assert.throws(() => contextHandoffThreshold(0), (error) => error.code === "CONTEXT_HANDOFF_THRESHOLD_INVALID");
  assert.throws(() => contextHandoffThreshold(101), (error) => error.code === "CONTEXT_HANDOFF_THRESHOLD_INVALID");

  const advisor = new ContextHandoffAdvisor({ thresholdPercent: 50 });
  assert.equal(advisor.observe(undefined), null);
  assert.equal(advisor.observe({ percent: null }), null);
  assert.equal(advisor.observe({ percent: 49, tokens: 49, contextWindow: 100 }), null);
  assert.equal(advisor.observe({ percent: 52, tokens: 52, contextWindow: 100 }).percent, 52);
  assert.equal(advisor.observe({ percent: 75, tokens: 75, contextWindow: 100 }), null);
  assert.equal(advisor.observe({ percent: 40, tokens: 40, contextWindow: 100 }), null);
  assert.equal(advisor.observe({ percent: 51, tokens: 51, contextWindow: 100 }).percent, 51);
});

test("Context Handoff Advisor prepares the canonical command only after user consent", async () => {
  const handlers = new Map();
  const pi = {
    registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
  };
  let percent = 49;
  let confirmations = 0;
  let prepared = null;
  let automaticHandoffs = 0;
  const decisions = [false, true];
  const runner = {
    ledger: { read: () => ({ task_id: "TASK-T" }) },
    storage: { isAdmissionOpen: () => true },
    contextAdvisor: new ContextHandoffAdvisor({ thresholdPercent: 50 }),
    metrics: {
      captureModelCall() { throw new Error("telemetry must not alter advisor behavior"); },
      recordHandoffEvent() { throw new Error("telemetry must not alter advisor behavior"); },
    },
    toolTracker: { admit() {}, finish() {} },
    async handoffFromCommand() { automaticHandoffs += 1; },
  };
  createGuardianExtension(runner)(pi);
  const ctx = {
    hasUI: true,
    getContextUsage: () => ({ percent, tokens: percent, contextWindow: 100 }),
    ui: {
      async confirm(_title, proposal) { confirmations += 1; assert.match(proposal, /Context: 52%/); return decisions.shift(); },
      setEditorText(value) { prepared = value; },
      notify() {},
    },
  };
  await handlers.get("turn_end")({}, ctx);
  percent = 52;
  await handlers.get("turn_end")({}, ctx);
  assert.equal(prepared, null, "declining must not prepare or execute a handoff");
  percent = 70;
  await handlers.get("turn_end")({}, ctx);
  assert.equal(confirmations, 1, "events above threshold must be deduplicated");
  percent = 40;
  await handlers.get("turn_end")({}, ctx);
  percent = 52;
  await handlers.get("turn_end")({}, ctx);
  assert.equal(confirmations, 2);
  assert.equal(prepared, "/eio handoff confirm");
  assert.equal(automaticHandoffs, 0);
});

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

test("invalid Ledger event hooks fail closed with bounded diagnostics and recover after next_item is repaired", async () => {
  const root = temp();
  const path = join(root, "TASK_PLAN.md");
  minimalLedger(path, { next_item: "ITEM-1" });

  const handlers = new Map();
  const commands = new Map();
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
  };
  const notifications = [];
  let admissionChecks = 0;
  let advisorObservations = 0;
  let contextReads = 0;
  let confirmations = 0;
  let handoffStarts = 0;
  let replacementPermitConsumes = 0;
  const runner = {
    calibration: null,
    ledger: new TaskLedger(path),
    storage: {
      isAdmissionOpen() { admissionChecks += 1; return true; },
      latestHandoffForTask() { throw new Error("invalid status must not inspect handoffs"); },
    },
    contextAdvisor: {
      thresholdPercent: 50,
      reset() {},
      observe(usage) {
        advisorObservations += 1;
        return { percent: usage.percent, thresholdPercent: 50 };
      },
    },
    metrics: { captureModelCall() {} },
    toolTracker: { admit() {}, finish() {} },
    consumeReplacementPermit() { replacementPermitConsumes += 1; return true; },
    async handoffFromCommand() {
      runner.ledger.read();
      handoffStarts += 1;
    },
  };
  createGuardianExtension(runner)(pi);
  const ctx = {
    hasUI: true,
    getContextUsage() { contextReads += 1; return { percent: 60, tokens: 60, contextWindow: 100 }; },
    ui: {
      notify(text, type) { notifications.push({ text, type }); },
      async confirm() { confirmations += 1; return false; },
      setEditorText() {},
    },
  };

  await assert.doesNotReject(() => handlers.get("turn_end")({}, ctx));
  assert.equal(advisorObservations, 0);
  assert.equal(contextReads, 0);
  assert.deepEqual(handlers.get("input")({}, ctx), { action: "handled" });
  assert.equal(admissionChecks, 0);
  for (const hook of ["session_before_compact", "session_before_tree", "session_before_switch", "session_before_fork"]) {
    assert.deepEqual(handlers.get(hook)({}, ctx), { cancel: true });
  }
  assert.equal(replacementPermitConsumes, 0);
  await assert.doesNotReject(() => commands.get("eio").handler("status", ctx));
  await assert.doesNotReject(() => commands.get("eio").handler("handoff confirm", ctx));
  assert.equal(handoffStarts, 0);
  assert.equal(notifications.length, 8);
  for (const notification of notifications) {
    assert.match(notification.text, /^Eiopago Ledger invalid:\nLEDGER_LIFECYCLE_INVALID — current_item and next_item must differ\.\nRepair TASK_PLAN\.md before continuing\.$/);
    assert.doesNotMatch(notification.text, /\n\s+at |Extension \"inline:eiopago\" error/);
    assert.ok(notification.text.length < 500);
  }

  const item2 = {
    task_item_id: "ITEM-2", task_id: "TASK-T", title: "i2", description: "d2", status: "IN_PROGRESS",
    depends_on: [], completion_criteria: ["x"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "M1-H0",
    last_updated_at: "2026-08-08T00:01:00Z", last_updated_by: "human",
  };
  minimalLedger(path, {
    plan_revision_id: "PLAN-2", updated_at: "2026-08-08T00:01:00Z", current_item: "ITEM-2", next_item: null,
    next_step: "Create acceptance.txt for ITEM-2; do not repeat ITEM-1.", task_items: [item2],
  });
  const repaired = runner.ledger.read();
  assert.equal(repaired.current_item, "ITEM-2");
  assert.equal(repaired.next_item, null);
  assert.equal(repaired.task_items[0].status, "IN_PROGRESS");
  assert.deepEqual(handlers.get("input")({}, ctx), { action: "continue" });
  await handlers.get("turn_end")({}, ctx);
  assert.equal(admissionChecks, 2);
  assert.equal(advisorObservations, 1);
  assert.equal(contextReads, 1);
  assert.equal(confirmations, 1);
});

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

test("Runner ownership attestation passes only when runtime, journal, manifest, and current Runner match", async (t) => {
  const expected = {
    schema_version: "1.0.0", handoff_id: "HO-owned", replacement_session_id: "SES-owned",
    runner_instance_id: "RUNNER-one", session_binding_id: "BIND-one",
  };
  const runtimeBinding = { ...expected };
  const manifestBinding = { ...expected };
  const journalBinding = { ...expected, status: "ACTIVE", event_data: { handoff_id: expected.handoff_id, replacement_session_id: expected.replacement_session_id, runner_instance_id: expected.runner_instance_id, session_binding_id: expected.session_binding_id } };
  assert.equal(verifyRunnerOwnership({ runtimeBinding, journalBinding, manifestBinding, expected }).status, "ATTESTED");

  await t.test("a Pi session not created by the Runner has no runtime binding", () => {
    const session = { sessionId: "SES-unowned", sessionManager: { getSessionId: () => "SES-unowned", getEntries: () => [] } };
    assert.throws(() => readRuntimeRunnerBinding(session), (error) => error.code === "RUNNER_OWNERSHIP_ATTESTATION_FAILED");
  });
  for (const [name, source, field, value] of [
    ["runner_instance_id mismatch", "runtime", "runner_instance_id", "RUNNER-other"],
    ["replacement_session_id mismatch", "manifest", "replacement_session_id", "SES-other"],
    ["session binding mismatch", "journal", "session_binding_id", "BIND-other"],
    ["handoff mismatch", "runtime", "handoff_id", "HO-stale"],
  ]) {
    await t.test(name, () => {
      const values = {
        runtimeBinding: { ...runtimeBinding },
        journalBinding: { ...journalBinding, event_data: { ...journalBinding.event_data } },
        manifestBinding: { ...manifestBinding },
        expected,
      };
      values[`${source}Binding`][field] = value;
      assert.throws(() => verifyRunnerOwnership(values), (error) => error.code === "RUNNER_OWNERSHIP_ATTESTATION_FAILED");
    });
  }
  await t.test("a superseded handoff binding fails closed", () => {
    assert.throws(
      () => verifyRunnerOwnership({ runtimeBinding, journalBinding: { ...journalBinding, status: "SUPERSEDED" }, manifestBinding, expected }),
      (error) => error.code === "RUNNER_OWNERSHIP_ATTESTATION_FAILED",
    );
  });
  await t.test("SQLite persists and supersedes the authoritative Runner relation", () => {
    const root = temp(); const storage = new GuardianStorage(join(root, "guardian.sqlite"));
    storage.reserveHandoff({ handoff_id: expected.handoff_id, source_session_id: "SES-source", target_session_id: null, task_id: "TASK-T", state: "REPLACEMENT_SESSION_CREATING", latch_generation: 1 });
    const handoff = storage.getHandoff(expected.handoff_id);
    handoff.target_session_id = expected.replacement_session_id;
    handoff.state = "REPLACEMENT_SESSION_CREATED_PAUSED";
    storage.saveHandoff(handoff);
    const active = storage.bindRunnerSession(expected.handoff_id, expected);
    assert.equal(active.status, "ACTIVE");
    assert.deepEqual(active.event_data, journalBinding.event_data);
    assert.equal(storage.events(expected.handoff_id).filter((event) => event.event_type === "RUNNER_SESSION_BOUND").length, 1);
    const superseded = storage.supersedeRunnerSessionBinding(expected.handoff_id, "newer handoff");
    assert.equal(superseded.status, "SUPERSEDED");
    assert.throws(() => verifyRunnerOwnership({ runtimeBinding, journalBinding: superseded, manifestBinding, expected }), (error) => error.code === "RUNNER_OWNERSHIP_ATTESTATION_FAILED");
    storage.close();
  });
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
