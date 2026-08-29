import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.mjs";
import { createGuardianExtension } from "../src/extension.mjs";
import { guidedHandoffEligibilityIdentityFromAuthority, handoffConsentIdentity } from "../src/handoff-consent.mjs";
import { HandoffService } from "../src/handoff.mjs";
import { createPlanAdapter, PLAN_INTENT_SCHEMA } from "../src/intent-adapter.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { satisfyOwnerGateForTest } from "./trusted-owner-gate-helper.mjs";
import { GuardianRunner, runnerForInternalTest } from "../src/runner.mjs";
import { AdmissionGate, SafePointCoordinator } from "../src/safety.mjs";
import { GuardianStorage, beginDispatchForInternalTest, bindRunnerSessionForInternalTest, claimLatchForInternalTest, claimTakeoverForInternalTest, finishDispatchForInternalTest, reserveHandoffForInternalTest, saveHandoffForInternalTest, storageDatabaseForInternalTest, supersedeRunnerSessionBindingForInternalTest } from "../src/storage.mjs";

function expectedLatch(latch) {
  return { task_id: latch.task_id, state: latch.state, generation: latch.generation, reason: latch.reason ?? null };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function task(overrides = {}) {
  return {
    schema_version: "0.1.0", task_id: "TASK-TRUSTED", title: "Trusted handoff", objective: "Bind exact consent",
    requirements_version: "REQ-1", plan_revision_id: "PLAN-R1-1", status: "IN_PROGRESS",
    completion_criteria: ["trusted boundary tested"], risk: "HIGH", created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z", current_item: "ITEM-1", next_item: null, next_step: "Continue safely",
    task_items: [{
      task_item_id: "ITEM-1", task_id: "TASK-TRUSTED", title: "Trusted boundary", description: "test", status: "IN_PROGRESS",
      depends_on: [], completion_criteria: ["tested"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "0.2-E",
      last_updated_at: "2026-08-22T00:00:00.000Z", last_updated_by: "human:test",
    }],
    ...overrides,
  };
}

function blockedTask(overrides = {}) {
  const value = task({
    plan_revision_id: "PLAN-GATE-P1",
    status: "BLOCKED",
    current_item: null,
    next_item: "ITEM-1",
    next_step: "Authorize the owner gate.",
    owner_gate: {
      kind: "HANDOFF_CONFIRM", status: "BLOCKED", command: "/aio handoff confirm", item_id: "ITEM-1",
      satisfied_plan_revision_id: "PLAN-GATE-P1-SATISFIED", satisfied_task_status: "IN_PROGRESS",
      satisfied_next_item: null, satisfied_next_step: "Continue the authorized item.",
    },
    ...overrides,
  });
  value.task_items[0].status = "BLOCKED";
  return value;
}

function writePlan(path, value) {
  writeFileSync(path, `# Trusted handoff fixture\n\n**Schema:** \`aiopago.task-ledger/0.1.0\`\n\n\`\`\`json task-ledger\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
}

function prepareCompliantPlanChange(path, mutate, suffix) {
  const adapter = createPlanAdapter(path);
  const observation = adapter.observe();
  const candidate = structuredClone(observation.plan);
  mutate(candidate);
  candidate.plan_revision_id = `PLAN-EXTERNAL-${suffix}`;
  candidate.updated_at = `2026-08-22T00:${String(Number(suffix) % 60).padStart(2, "0")}:00.000Z`;
  const proposal = adapter.propose({
    schema: PLAN_INTENT_SCHEMA,
    proposal_id: `PPR-TRUSTED-${suffix}`,
    producer: "aiopago:test-compliant-plan-writer",
    change_reason: "Exercise a real PlanPort CAS interleaving.",
    base: {
      task_id: observation.task_id,
      plan_revision_id: observation.plan_revision_id,
      content_digest: observation.content_digest,
    },
    candidate_plan: candidate,
  });
  return { adapter, observation, proposal, apply: () => adapter.apply(proposal) };
}

function sourceSession(id = "SESSION-S1", overrides = {}) {
  return {
    sessionId: id,
    sessionFile: `/sessions/${id}.jsonl`,
    model: { provider: "offline", id: "fake" },
    thinkingLevel: "off",
    isIdle: true,
    isStreaming: false,
    pendingMessageCount: 0,
    isRetrying: false,
    isCompacting: false,
    clearQueue() { this.pendingMessageCount = 0; },
    abortRetry() {},
    abortCompaction() {},
    abortBranchSummary() {},
    async abort() { this.isIdle = true; this.isStreaming = false; },
    async waitForIdle() {},
    ...overrides,
  };
}

function gitState(root) {
  return {
    repository_id: "trusted-fixture", workdir: root, branch: "test", base_sha: "1".repeat(40), head_sha: "1".repeat(40),
    index_digest: `sha256:${"2".repeat(64)}`, worktree_digest: `sha256:${"3".repeat(64)}`, status_entries: [],
  };
}

function fixture({ session = sourceSession(), testHooks = null, planValue = task(), ledgerOptions = {}, secureReservation = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiopago-trusted-handoff-"));
  const ledgerPath = join(root, "TASK_PLAN.md");
  writePlan(ledgerPath, planValue);
  const ledger = new TaskLedger(ledgerPath, ledgerOptions);
  const storagePath = join(root, ".guardian", "runtime", "guardian.sqlite");
  const storage = new GuardianStorage(storagePath);
  const plan = ledger.read();
  storage.ensureLatch(plan.task_id);
  let reservationAuthority = null;
  if (secureReservation) {
    const canonical = join(root, "protected"); mkdirSync(canonical);
    reservationAuthority = new ProtectedSqliteOperationAuthority(join(canonical, "operations.sqlite"), { allowInitialize: true });
    reservationAuthority.ensureLatch(plan.task_id);
  }
  const artifacts = new ArtifactStore(join(root, ".guardian"), storage);
  const latchAuthority = reservationAuthority ?? undefined;
  const gate = new AdmissionGate(storage, plan.task_id, { latchAuthority });
  const safePoint = new SafePointCoordinator({
    storage, taskId: plan.task_id, gate,
    operationAuthority: reservationAuthority ?? undefined,
    latchAuthority,
  });
  const runnerInstanceId = "RUNNER-TRUSTED";
  const service = new HandoffService({
    storage, artifacts, ledger, safePoint, runnerInstanceId,
    observeGit: () => gitState(root), modelPolicy: "offline/fake", reasoningPolicy: "off", testHooks, reservationAuthority,
  });
  const publicRunner = new GuardianRunner({
    cwd: root, roots: { targetRoot: root, runtimeRoot: join(root, ".guardian", "runtime"), artifactRoot: join(root, ".guardian") },
    ledger, storage, latchAuthority: reservationAuthority ?? storage, reservationAuthority, artifacts, gate, safePoint, handoffService: service, runnerInstanceId, confirmMode: "confirm-or-manual",
  });
  const runner = runnerForInternalTest(publicRunner);
  runner.runtime = { session };
  runner.recoverySourceSession = session;
  runner.contextAdvisor = { reset() {} };
  const expected = guidedHandoffEligibilityIdentityFromAuthority({
    plan, sessionId: session.sessionId, runnerInstanceId, latch: (reservationAuthority ?? storage).getLatch(plan.task_id), handoff: null,
  });
  const counters = () => storageDatabaseForInternalTest(storage).prepare(`SELECT
    (SELECT COUNT(*) FROM handoffs) AS handoffs,
    (SELECT COUNT(*) FROM active_sources) AS active_sources,
    (SELECT COUNT(*) FROM artifacts) AS artifacts`).get();
  let newSessions = 0;
  const ctx = {
    async newSession() { newSessions += 1; throw new Error("replacement must not be attempted"); },
    ui: { async confirm() { return false; }, notify() {}, setEditorText() {} },
  };
  return {
    root, ledgerPath, ledger, storagePath, storage, reservationAuthority, artifacts, gate, safePoint, service, publicRunner, runner, session, expected, ctx, counters,
    newSessions: () => newSessions,
    close() { storage.close(); reservationAuthority?.close(); },
  };
}

function assertNoPreparation(x) {
  const counters = x.counters();
  assert.equal(counters.handoffs, 0);
  assert.equal(counters.active_sources, 0);
  assert.equal(counters.artifacts, 0);
  assert.equal(x.newSessions(), 0);
  const checkpointRoot = join(x.root, ".guardian", "checkpoints");
  try { assert.equal(readdirSync(checkpointRoot).length, 0); } catch (error) { assert.equal(error.code, "ENOENT"); }
}

function planMutationSnapshot(x) {
  const bytes = readFileSync(x.ledgerPath);
  const historyRoot = join(x.root, ".guardian", "plan-history");
  let history = [];
  try {
    history = readdirSync(historyRoot).sort().map((name) => ({ name, bytes: readFileSync(join(historyRoot, name)) }));
  } catch (error) { assert.equal(error.code, "ENOENT"); }
  return {
    bytes,
    digest: x.ledger.read().content_digest,
    revision: x.ledger.read().plan_revision_id,
    gate: x.ledger.read().owner_gate?.status ?? null,
    mtimeNs: statSync(x.ledgerPath, { bigint: true }).mtimeNs,
    history,
  };
}

function assertPlanMutationSnapshotEqual(actual, expected) {
  assert.deepEqual(actual.bytes, expected.bytes);
  assert.equal(actual.digest, expected.digest);
  assert.equal(actual.revision, expected.revision);
  assert.equal(actual.gate, expected.gate);
  assert.equal(actual.mtimeNs, expected.mtimeNs);
  assert.deepEqual(actual.history, expected.history);
}

function seedBlockingTaskOperation(x, state, suffix = state) {
  const latch = claimLatchForInternalTest(x.storage, "TASK-TRUSTED", "INTEGRITY", "human:first-operation");
  const projection = {
    handoff_id: `HO-C1-${suffix}`, source_session_id: `SESSION-C1-${suffix}`, target_session_id: null,
    task_id: "TASK-TRUSTED", state, latch_generation: latch.generation,
  };
  reserveHandoffForInternalTest(x.storage, projection, { latch, expectedHandoff: null });
  return x.storage.getHandoff(projection.handoff_id);
}

function runTrustedReservationProcess(x, { suffix, expectedHandoff = null }) {
  const childPath = join(x.root, `trusted-reservation-${suffix}.mjs`);
  const ledgerModule = new URL("../src/ledger.mjs", import.meta.url).href;
  const storageModule = new URL("../src/storage.mjs", import.meta.url).href;
  const internalModule = new URL("../src/handoff-plan-internal.mjs", import.meta.url).href;
  writeFileSync(childPath, `
    import { TaskLedger } from ${JSON.stringify(ledgerModule)};
    import { GuardianStorage } from ${JSON.stringify(storageModule)};
    import { reserveTrustedHandoffPlan } from ${JSON.stringify(internalModule)};
    const ledger = new TaskLedger(${JSON.stringify(x.ledgerPath)});
    const storage = new GuardianStorage(${JSON.stringify(x.storagePath)});
    try {
      const plan = ledger.read();
      const latch = storage.getLatch(plan.task_id);
      const projection = {
        handoff_id: ${JSON.stringify(`HO-PROCESS-${suffix}`)},
        source_session_id: ${JSON.stringify(`SESSION-PROCESS-${suffix}`)},
        target_session_id: null,
        task_id: plan.task_id,
        task_plan_revision: plan.plan_revision_id,
        task_plan_digest: plan.content_digest,
        state: "SAFE_TO_HANDOFF",
        latch_generation: latch.generation,
      };
      const result = reserveTrustedHandoffPlan(ledger, {
        expected: { taskId: plan.task_id, planRevisionId: plan.plan_revision_id, contentDigest: plan.content_digest },
        storage,
        projection,
        precondition: { latch, expectedHandoff: ${JSON.stringify(expectedHandoff)} },
      });
      process.stdout.write(JSON.stringify({ ok: true, created: result.created, handoffId: result.handoff.handoff_id }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message }));
    } finally { storage.close(); }
  `);
  return JSON.parse(execFileSync(process.execPath, [childPath], { encoding: "utf8" }));
}

function runTrustedTakeoverProcess(x, suffix) {
  const childPath = join(x.root, `trusted-takeover-${suffix}.mjs`);
  const ledgerModule = new URL("../src/ledger.mjs", import.meta.url).href;
  const storageModule = new URL("../src/storage.mjs", import.meta.url).href;
  const internalModule = new URL("../src/handoff-plan-internal.mjs", import.meta.url).href;
  writeFileSync(childPath, `
    import { TaskLedger } from ${JSON.stringify(ledgerModule)};
    import { GuardianStorage } from ${JSON.stringify(storageModule)};
    import { claimTrustedHumanTakeoverCurrentPlan } from ${JSON.stringify(internalModule)};
    const ledger = new TaskLedger(${JSON.stringify(x.ledgerPath)});
    const storage = new GuardianStorage(${JSON.stringify(x.storagePath)});
    try {
      const plan = ledger.read();
      const authority = claimTrustedHumanTakeoverCurrentPlan(ledger, {
        storage,
        taskId: plan.task_id,
        actor: ${JSON.stringify(`human:process-${suffix}`)},
      });
      process.stdout.write(JSON.stringify({ ok: true, reason: authority.latch.reason, generation: authority.latch.generation }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message }));
    } finally { storage.close(); }
  `);
  return JSON.parse(execFileSync(process.execPath, [childPath], { encoding: "utf8" }));
}

function installPausedReplacement(x, { targetId = "SESSION-TARGET" } = {}) {
  let replacements = 0;
  x.ctx.newSession = async ({ parentSession, setup, withSession }) => {
    replacements += 1;
    const entries = [];
    const sessionManager = {
      getSessionId: () => targetId,
      getEntries: () => entries,
      appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      getHeader: () => ({ parentSession }),
    };
    await setup(sessionManager);
    const target = {
      ...sourceSession(targetId),
      sessionFile: `/sessions/${targetId}.jsonl`,
      sessionManager,
    };
    x.runner.runtime.session = target;
    await withSession({
      ui: { async confirm() { return false; }, notify() {}, setEditorText() {} },
      async sendUserMessage() {},
    });
    return { cancelled: false };
  };
  return () => replacements;
}

test("H-01 real trusted Runner boundary rejects HUMAN_TAKEOVER engaged after UI revalidation", async () => {
  const x = fixture();
  const takeover = new GuardianStorage(x.storagePath);
  try {
    claimTakeoverForInternalTest(takeover, "TASK-TRUSTED", "human:/aio-takeover");
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "HUMAN_TAKEOVER_ACTIVE",
    );
    assertNoPreparation(x);
    assert.equal(x.storage.getLatch("TASK-TRUSTED").reason, "HUMAN_TAKEOVER");
  } finally { takeover.close(); x.close(); }
});

test("SafePoint itself refuses an already active HUMAN_TAKEOVER without downgrading it", async () => {
  const x = fixture();
  try {
    claimTakeoverForInternalTest(x.storage, "TASK-TRUSTED", "human:/aio-takeover");
    await assert.rejects(async () => {
      const observed = x.storage.getLatch("TASK-TRUSTED");
      const expectedLatch = { task_id: "TASK-TRUSTED", state: observed.state, generation: observed.generation, reason: observed.reason };
      const acquiredLatch = claimLatchForInternalTest(x.storage, "TASK-TRUSTED", "INTEGRITY", "human:handoff", expectedLatch);
      return x.safePoint.request(x.session, "human:handoff", "INTEGRITY", { expectedLatch, acquiredLatch });
    }, (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    assert.equal(x.storage.getLatch("TASK-TRUSTED").reason, "HUMAN_TAKEOVER");
    assertNoPreparation(x);
  } finally { x.close(); }
});

test("H-01 SafePoint re-reads the latch after waitForIdle and refuses takeover escalation", async () => {
  const entered = deferred();
  const release = deferred();
  const session = sourceSession("SESSION-S1", {
    isIdle: true,
    async waitForIdle() { entered.resolve(); await release.promise; this.isIdle = true; },
  });
  const x = fixture({ session });
  const takeover = new GuardianStorage(x.storagePath);
  try {
    const pending = x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected });
    const rejected = assert.rejects(pending, (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    await entered.promise;
    claimTakeoverForInternalTest(takeover, "TASK-TRUSTED", "human:/aio-takeover");
    assert.equal(x.storage.getLatch("TASK-TRUSTED").reason, "HUMAN_TAKEOVER");
    release.resolve();
    await rejected;
    assertNoPreparation(x);
  } finally { takeover.close(); x.close(); }
});

test("H-01 SafePoint re-reads the latch after waitForNoStreams", async () => {
  const x = fixture();
  const takeover = new GuardianStorage(x.storagePath);
  x.gate.activeStreams = 1;
  try {
    const pending = x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected });
    await new Promise((resolve) => setImmediate(resolve));
    claimTakeoverForInternalTest(takeover, "TASK-TRUSTED", "human:/aio-takeover");
    x.gate.streamDone();
    await assert.rejects(() => pending, (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    assertNoPreparation(x);
  } finally { takeover.close(); x.close(); }
});

test("H-01 reservation transaction refuses takeover after SafePoint and before reserve", async () => {
  let takeover;
  const x = fixture({ testHooks: { afterSafePoint() { claimTakeoverForInternalTest(takeover, "TASK-TRUSTED", "human:/aio-takeover"); } } });
  takeover = new GuardianStorage(x.storagePath);
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "HUMAN_TAKEOVER_ACTIVE",
    );
    assertNoPreparation(x);
  } finally { takeover.close(); x.close(); }
});

test("M-01-R plan/session identity cannot move from approved P1/S1 before trusted entry", async () => {
  const x = fixture();
  try {
    writePlan(x.ledgerPath, task({ plan_revision_id: "PLAN-R1-2", updated_at: "2026-08-22T00:01:00.000Z" }));
    x.runner.runtime.session = sourceSession("SESSION-S2");
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "HANDOFF_SOURCE_CHANGED",
    );
    assertNoPreparation(x);
  } finally { x.close(); }
});

test("M-01-R session-only movement before trusted entry rejects S1 consent", async () => {
  const x = fixture();
  try {
    x.runner.runtime.session = sourceSession("SESSION-S2");
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "HANDOFF_SOURCE_CHANGED",
    );
    assertNoPreparation(x);
  } finally { x.close(); }
});

test("guided consent is not reusable across Runner identity movement or malformed tokens", async (t) => {
  await t.test("Runner movement", async () => {
    const x = fixture();
    try {
      x.runner.runnerInstanceId = "RUNNER-OTHER";
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
        (error) => error.code === "HANDOFF_RUNNER_CHANGED",
      );
      assertNoPreparation(x);
    } finally { x.close(); }
  });
  await t.test("missing required identity field", async () => {
    const x = fixture();
    try {
      const malformed = { ...x.expected };
      delete malformed.contentDigest;
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: malformed }),
        (error) => error.code === "HANDOFF_CONSENT_INVALID",
      );
      assertNoPreparation(x);
    } finally { x.close(); }
  });
});

test("M-01-R plan-only and digest-only movement reject before reservation", async (t) => {
  for (const [name, changed] of [
    ["revision", task({ plan_revision_id: "PLAN-R1-2", updated_at: "2026-08-22T00:01:00.000Z" })],
    ["digest", task({ objective: "Different authoritative content with the same visible revision" })],
  ]) {
    await t.test(name, async () => {
      const x = fixture();
      try {
        writePlan(x.ledgerPath, changed);
        await assert.rejects(
          () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
          (error) => error.code === "HANDOFF_CONSENT_STALE",
        );
        assertNoPreparation(x);
      } finally { x.close(); }
    });
  }
});

test("M-01-R plan and current Runner source movement during SafePoint reject before reservation", async (t) => {
  for (const movement of ["plan", "session"]) {
    await t.test(movement, async () => {
      const entered = deferred();
      const release = deferred();
      const session = sourceSession("SESSION-S1", {
        isIdle: true,
        async waitForIdle() { entered.resolve(); await release.promise; this.isIdle = true; },
      });
      const x = fixture({ session });
      try {
        const pending = x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected });
        const rejected = assert.rejects(pending, (error) => error.code === (movement === "plan" ? "HANDOFF_CONSENT_STALE" : "HANDOFF_SOURCE_CHANGED"));
        await entered.promise;
        if (movement === "plan") writePlan(x.ledgerPath, task({ plan_revision_id: "PLAN-R1-2", updated_at: "2026-08-22T00:01:00.000Z" }));
        else x.runner.runtime.session = sourceSession("SESSION-S2");
        release.resolve();
        await rejected;
        assertNoPreparation(x);
      } finally { x.close(); }
    });
  }
});

test("M-01 owner-gate CAS rejects stale guided P1 when a real PlanPort P2 writer wins", async () => {
  let x;
  const hooks = {
    beforeOwnerGate() {
      prepareCompliantPlanChange(x.ledgerPath, (candidate) => { candidate.objective = "External P2 won before owner authorization."; }, "11").apply();
    },
  };
  x = fixture({ planValue: blockedTask(), testHooks: hooks });
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "PLAN_CAS_CONFLICT",
    );
    const current = x.ledger.read();
    assert.equal(current.plan_revision_id, "PLAN-EXTERNAL-11");
    assert.equal(current.owner_gate.status, "BLOCKED");
    assert.equal(current.current_item, null);
    assertNoPreparation(x);
  } finally { x.close(); }
});

test("M-01 owner-gate P1 CAS wins and a stale real P2 proposal cannot replace reserved P1-prime", async () => {
  let x;
  let staleWriter;
  let staleCode = null;
  let reserved = null;
  const stop = new Error("stop after observing reservation");
  const hooks = {
    afterOwnerGate() {
      try { staleWriter.apply(); } catch (error) { staleCode = error.code; }
    },
    afterReservation({ handoff }) { reserved = structuredClone(handoff); throw stop; },
  };
  x = fixture({ planValue: blockedTask(), testHooks: hooks });
  staleWriter = prepareCompliantPlanChange(x.ledgerPath, (candidate) => { candidate.objective = "External stale P2 must rebase."; }, "12");
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error === stop,
    );
    assert.equal(staleCode, "PLAN_CAS_CONFLICT");
    const current = x.ledger.read();
    assert.equal(current.plan_revision_id, "PLAN-GATE-P1-SATISFIED");
    assert.equal(current.owner_gate.status, "SATISFIED");
    assert.equal(reserved.task_plan_revision, "PLAN-GATE-P1-SATISFIED");
    assert.equal(reserved.task_plan_digest, current.content_digest);
    assert.equal(reserved.reserved_plan_snapshot.plan_revision_id, "PLAN-GATE-P1-SATISFIED");
    assert.notEqual(reserved.task_plan_revision, "PLAN-EXTERNAL-12");
    assert.equal(x.counters().handoffs, 1);
  } finally { x.close(); }
});

test("R1-M-01 unresolved task ownership rejects confirm before owner-gate bytes, revision, mtime, or history mutate", async (t) => {
  for (const state of [
    "REPLACEMENT_SESSION_CREATING", "MANIFEST_PERSISTING", "RESUME_READY", "RESUME_DISPATCH_UNKNOWN", "HANDOFF_FAILED",
  ]) {
    await t.test(state, async () => {
      const x = fixture({ planValue: blockedTask() });
      try {
        const c1 = seedBlockingTaskOperation(x, state);
        const before = planMutationSnapshot(x);
        await assert.rejects(
          () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
          (error) => error.code === "TASK_OPERATION_CONFLICT",
        );
        assertPlanMutationSnapshotEqual(planMutationSnapshot(x), before);
        assert.equal(x.storage.getHandoff(c1.handoff_id).state, state);
        assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs WHERE task_id='TASK-TRUSTED'").get().count, 1);
        assert.equal(x.newSessions(), 0);
      } finally { x.close(); }
    });
  }

  await t.test("CONTINUITY_FAILED requires explicit recovery without owner mutation", async () => {
    const x = fixture({ planValue: blockedTask() });
    try {
      const c1 = seedBlockingTaskOperation(x, "CONTINUITY_FAILED", "continuity");
      const before = planMutationSnapshot(x);
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
        (error) => error.code === "CONTINUITY_RECOVERY_REQUIRED",
      );
      assertPlanMutationSnapshotEqual(planMutationSnapshot(x), before);
      assert.equal(x.storage.getHandoff(c1.handoff_id).state, "CONTINUITY_FAILED");
    } finally { x.close(); }
  });

  await t.test("already-satisfied owner gate still enforces task ownership", async () => {
    const x = fixture({ planValue: blockedTask() });
    try {
      satisfyOwnerGateForTest(x.ledger, { command: "/aio handoff confirm", actor: "human:fixture" });
      const c1 = seedBlockingTaskOperation(x, "RESUME_READY", "satisfied");
      const before = planMutationSnapshot(x);
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
        (error) => error.code === "TASK_OPERATION_CONFLICT",
      );
      assertPlanMutationSnapshotEqual(planMutationSnapshot(x), before);
      assert.equal(x.storage.getHandoff(c1.handoff_id).state, "RESUME_READY");
    } finally { x.close(); }
  });
});

test("R1-M-01 cross-process task-operation and owner-gate critical-section orderings are serialized by exact plan coordination", async (t) => {
  await t.test("task operation wins first", async () => {
    const x = fixture({ planValue: blockedTask() });
    try {
      claimLatchForInternalTest(x.storage, "TASK-TRUSTED", "INTEGRITY", "human:race");
      const child = runTrustedReservationProcess(x, { suffix: "FIRST" });
      assert.deepEqual(child, { ok: true, created: true, handoffId: "HO-PROCESS-FIRST" });
      const before = planMutationSnapshot(x);
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
        (error) => error.code === "TASK_OPERATION_CONFLICT",
      );
      assertPlanMutationSnapshotEqual(planMutationSnapshot(x), before);
      assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
    } finally { x.close(); }
  });

  await t.test("task operation wins after service preflight but before owner critical section", async () => {
    let x;
    let child = null;
    const hooks = {
      beforeOwnerGate() {
        claimLatchForInternalTest(x.storage, "TASK-TRUSTED", "INTEGRITY", "human:race");
        child = runTrustedReservationProcess(x, { suffix: "BEFORE-CRITICAL" });
      },
    };
    x = fixture({ planValue: blockedTask(), testHooks: hooks });
    try {
      const before = planMutationSnapshot(x);
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
        (error) => ["TASK_OPERATION_CONFLICT", "LATCH_GENERATION_MISMATCH"].includes(error.code),
      );
      assert.deepEqual(child, { ok: true, created: true, handoffId: "HO-PROCESS-BEFORE-CRITICAL" });
      assertPlanMutationSnapshotEqual(planMutationSnapshot(x), before);
      assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
    } finally { x.close(); }
  });

  await t.test("owner critical section wins first", async () => {
    const stop = new Error("stop after owner transition");
    let x;
    let child = null;
    const serviceHooks = { afterOwnerGate() { throw stop; } };
    const writerHooks = {
      afterPreparation() {
        child = runTrustedReservationProcess(x, { suffix: "LOCKED" });
      },
    };
    x = fixture({
      planValue: blockedTask(),
      testHooks: serviceHooks,
      ledgerOptions: { writerOptions: { testHooks: writerHooks } },
    });
    try {
      claimLatchForInternalTest(x.storage, "TASK-TRUSTED", "INTEGRITY", "human:race");
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
        (error) => error === stop,
      );
      assert.equal(child.ok, false);
      assert.equal(child.code, "PLAN_WRITE_LOCKED");
      assert.equal(x.ledger.read().owner_gate.status, "SATISFIED");
      assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
    } finally { x.close(); }
  });

  await t.test("post-owner pre-reservation operation wins one lifecycle only", async () => {
    let x;
    let child = null;
    const hooks = {
      afterSafePoint() {
        child = runTrustedReservationProcess(x, { suffix: "POST-OWNER" });
      },
    };
    x = fixture({ planValue: blockedTask(), testHooks: hooks });
    try {
      await assert.rejects(
        () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
        (error) => error.code === "HANDOFF_CONSENT_STALE",
      );
      assert.deepEqual(child, { ok: true, created: true, handoffId: "HO-PROCESS-POST-OWNER" });
      assert.equal(x.ledger.read().owner_gate.status, "SATISFIED");
      assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
      assert.equal(x.storage.latestHandoffForTask("TASK-TRUSTED").handoff_id, "HO-PROCESS-POST-OWNER");
      assert.equal(x.newSessions(), 0);
    } finally { x.close(); }
  });
});

test("R1-M-02 owner critical section excludes a separate-process takeover until P1-prime wins", async () => {
  const stop = new Error("stop after owner winner");
  let x;
  let during = null;
  x = fixture({
    planValue: blockedTask(),
    testHooks: { afterOwnerGate() { throw stop; } },
    ledgerOptions: { writerOptions: { testHooks: { afterPreparation() { during = runTrustedTakeoverProcess(x, "DURING-OWNER"); } } } },
  });
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "explicit-command" }),
      (error) => error === stop,
    );
    assert.equal(during.ok, false);
    assert.equal(during.code, "PLAN_WRITE_LOCKED");
    assert.equal(x.ledger.read().owner_gate.status, "SATISFIED");
    assert.equal(x.storage.getLatch("TASK-TRUSTED").reason, null);
    assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);

    const after = runTrustedTakeoverProcess(x, "AFTER-OWNER");
    assert.equal(after.ok, true);
    assert.equal(after.reason, "HUMAN_TAKEOVER");
    assert.equal(x.ledger.read().owner_gate.status, "SATISFIED");
  } finally { x.close(); }
});

test("R1-M-03 direct HandoffService confirm without exact current-source verifier fails before owner mutation", async () => {
  const x = fixture({ planValue: blockedTask() });
  try {
    const before = planMutationSnapshot(x);
    await assert.rejects(
      () => x.service.handoff({ sourceSession: x.session, mode: "confirm", replacePaused: async () => { throw new Error("unreachable"); } }),
      (error) => error.code === "HANDOFF_SOURCE_ATTESTATION_REQUIRED",
    );
    await assert.rejects(
      () => x.service.handoff({
        sourceSession: x.session,
        currentSourceVerifier: () => ({ sessionId: x.session.sessionId, runnerInstanceId: x.runner.runnerInstanceId, lifecycleEpoch: 1, active: true }),
        mode: "confirm",
        replacePaused: async () => { throw new Error("unreachable"); },
      }),
      (error) => error.code === "HANDOFF_SOURCE_ATTESTATION_REQUIRED",
    );
    assertPlanMutationSnapshotEqual(planMutationSnapshot(x), before);
    assertNoPreparation(x);
  } finally { x.close(); }
});

test("R1-M-05 raw public reservation fails closed before every lifecycle row", () => {
  const x = fixture();
  try {
    const latch = claimLatchForInternalTest(x.storage, "TASK-TRUSTED", "INTEGRITY", "human:test");
    assert.throws(
      () => x.storage.reserveHandoff({ handoff_id: "HO-PUBLIC", source_session_id: "SESSION-PUBLIC", task_id: "TASK-TRUSTED", state: "SAFE_TO_HANDOFF", latch_generation: latch.generation }, { latch, expectedHandoff: null }),
      (error) => error.code === "HANDOFF_RESERVATION_TRUSTED_PATH_REQUIRED",
    );
    assert.throws(
      () => x.storage.engageLatch("TASK-TRUSTED", "HUMAN_TAKEOVER", "human:external"),
      (error) => error.code === "LATCH_TRUSTED_PATH_REQUIRED",
    );
    assert.equal(Object.hasOwn(x.storage, "db"), false, "no root-reachable raw SQLite writer is exposed");
    for (const [method, args, code] of [
      ["prepareContinuityRecovery", ["HO-PUBLIC", {}], "CONTINUITY_RECOVERY_TRUSTED_PATH_REQUIRED"],
      ["saveHandoff", [{ handoff_id: "HO-PUBLIC", state: "RESUMED" }], "HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED"],
      ["transition", ["HO-PUBLIC", "SAFE_TO_HANDOFF", "RESUMED"], "HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED"],
      ["bindRunnerSession", ["HO-PUBLIC", {}], "HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED"],
      ["supersedeRunnerSessionBinding", ["HO-PUBLIC", "external"], "HANDOFF_LIFECYCLE_TRUSTED_PATH_REQUIRED"],
      ["beginDispatch", ["HO-PUBLIC", "DSP-PUBLIC"], "RESUME_DISPATCH_TRUSTED_PATH_REQUIRED"],
      ["finishDispatch", ["HO-PUBLIC", "ACKNOWLEDGED"], "RESUME_DISPATCH_TRUSTED_PATH_REQUIRED"],
    ]) assert.throws(() => x.storage[method](...args), (error) => error.code === code, method);
    assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
    assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM active_sources").get().count, 0);
    assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM journal WHERE event_type='HANDOFF_STARTED'").get().count, 0);
  } finally { x.close(); }
});

test("M-01 owner-gate commit failure is atomic and creates no handoff artifacts or replacement", async () => {
  const x = fixture({
    planValue: blockedTask(),
    ledgerOptions: { writerOptions: { testHooks: { afterPreparation() { throw new Error("forced owner-gate commit failure"); } } } },
  });
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      /forced owner-gate commit failure/,
    );
    const current = x.ledger.read();
    assert.equal(current.plan_revision_id, "PLAN-GATE-P1");
    assert.equal(current.owner_gate.status, "BLOCKED");
    assertNoPreparation(x);
  } finally { x.close(); }
});

test("M-03 registered Pi lifecycle shutdown invalidates trusted S1 during SafePoint and lifecycle ABA stays closed", async (t) => {
  for (const [name, waitKind, restart] of [
    ["waitForIdle", "idle", false],
    ["waitForNoStreams", "streams", false],
    ["same-ID shutdown/start ABA", "idle", true],
  ]) {
    await t.test(name, async () => {
      const entered = deferred();
      const release = deferred();
      const session = sourceSession("SESSION-S1", waitKind === "idle" ? {
        async waitForIdle() { entered.resolve(); await release.promise; },
      } : {});
      const x = fixture({ session });
      if (waitKind === "streams") x.gate.activeStreams = 1;
      const handlers = new Map();
      createGuardianExtension(x.runner)({ registerCommand() {}, on(event, handler) { handlers.set(event, handler); } });
      const lifecycleCtx = { sessionManager: { getSessionId: () => "SESSION-S1" } };
      try {
        const pending = x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected });
        if (waitKind === "idle") await entered.promise;
        else await new Promise((resolve) => setImmediate(resolve));
        handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, lifecycleCtx);
        if (restart) handlers.get("session_start")({ type: "session_start", reason: "reload" }, lifecycleCtx);
        if (waitKind === "streams") x.gate.streamDone();
        else release.resolve();
        await assert.rejects(() => pending, (error) => error.code === "HANDOFF_SOURCE_CHANGED");
        assertNoPreparation(x);
      } finally { x.close(); }
    });
  }
  const unrelated = fixture();
  try {
    const trusted = unrelated.runner.captureTrustedSource(unrelated.expected);
    assert.equal(unrelated.runner.noteSessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      { sessionManager: { getSessionId: () => "SESSION-UNRELATED" } },
    ), false);
    assert.doesNotThrow(() => trusted.verifyCurrentSource());
  } finally { unrelated.close(); }
});

test("M-02 manifest and checkpoint remain purely reserved P1 after real post-reservation P2 drift", async () => {
  let x;
  const p1 = task({
    objective: "P1",
    minimal_reads: ["P1-read"],
    relevant_decisions: ["P1-decision"],
    relevant_tests: ["P1-test"],
    evidence_references: ["P1-evidence"],
  });
  const hooks = {
    beforeManifest() {
      prepareCompliantPlanChange(x.ledgerPath, (candidate) => {
        candidate.objective = "P2";
        candidate.minimal_reads = ["P2-read"];
        candidate.relevant_decisions = ["P2-decision"];
        candidate.relevant_tests = ["P2-test"];
        candidate.evidence_references = ["P2-evidence"];
      }, "22").apply();
    },
  };
  x = fixture({ planValue: p1, testHooks: hooks });
  const replacements = installPausedReplacement(x);
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "PLAN_REVISION_MISMATCH",
    );
    const handoff = x.storage.latestHandoffForTask("TASK-TRUSTED");
    const checkpoint = x.artifacts.verify("checkpoint", handoff.checkpoint_id, handoff.checkpoint_digest).payload;
    const manifest = x.artifacts.verify("manifest", handoff.resume_manifest_id, handoff.resume_manifest_digest).payload;
    assert.equal(replacements(), 1);
    assert.equal(checkpoint.plan_revision_id, "PLAN-R1-1");
    assert.equal(checkpoint.plan_content_digest, x.expected.contentDigest);
    assert.equal(manifest.objective, "P1");
    assert.deepEqual(manifest.minimal_reads, ["P1-read"]);
    assert.deepEqual(manifest.relevant_decisions, ["P1-decision"]);
    assert.deepEqual(manifest.relevant_tests, ["P1-test"]);
    assert.deepEqual(manifest.evidence_references, ["P1-evidence"]);
    assert.equal(manifest.task_plan_revision, handoff.task_plan_revision);
    assert.equal(manifest.task_plan_digest, handoff.task_plan_digest);
    assert.equal(x.ledger.read().objective, "P2");
    assert.deepEqual(x.ledger.read().minimal_reads, ["P2-read"]);
  } finally { x.close(); }
});

test("M-02 P2 drift immediately after reservation cannot contaminate the later P1 checkpoint or manifest", async () => {
  let x;
  const p1 = task({
    objective: "P1-before-checkpoint",
    completion_criteria: ["P1-criterion"],
    minimal_reads: ["P1-read-before-checkpoint"],
    relevant_decisions: ["P1-decision-before-checkpoint"],
    relevant_tests: ["P1-test-before-checkpoint"],
    evidence_references: ["P1-evidence-before-checkpoint"],
  });
  const hooks = {
    afterReservation() {
      prepareCompliantPlanChange(x.ledgerPath, (candidate) => {
        candidate.objective = "P2-after-reservation";
        candidate.completion_criteria = ["P2-criterion"];
        candidate.minimal_reads = ["P2-read-after-reservation"];
        candidate.relevant_decisions = ["P2-decision-after-reservation"];
        candidate.relevant_tests = ["P2-test-after-reservation"];
        candidate.evidence_references = ["P2-evidence-after-reservation"];
      }, "23").apply();
    },
  };
  x = fixture({ planValue: p1, testHooks: hooks });
  installPausedReplacement(x);
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "PLAN_REVISION_MISMATCH",
    );
    const handoff = x.storage.latestHandoffForTask("TASK-TRUSTED");
    const checkpoint = x.artifacts.verify("checkpoint", handoff.checkpoint_id, handoff.checkpoint_digest).payload;
    const manifest = x.artifacts.verify("manifest", handoff.resume_manifest_id, handoff.resume_manifest_digest).payload;
    assert.deepEqual(checkpoint.completion_criteria, [{ criterion: "P1-criterion", status: "IN_PROGRESS" }]);
    assert.deepEqual(checkpoint.tests, ["P1-test-before-checkpoint"]);
    assert.deepEqual(checkpoint.decisions, ["P1-decision-before-checkpoint"]);
    assert.equal(checkpoint.plan_content_digest, handoff.task_plan_digest);
    assert.equal(manifest.objective, "P1-before-checkpoint");
    assert.deepEqual(manifest.minimal_reads, ["P1-read-before-checkpoint"]);
    assert.deepEqual(manifest.evidence_references, ["P1-evidence-before-checkpoint"]);
    assert.equal(x.ledger.read().objective, "P2-after-reservation");
  } finally { x.close(); }
});

test("exact-current guided consent reserves P1/S1 once and leaves the replacement paused for separate resume", async () => {
  const x = fixture();
  let replacements = 0;
  let resumeDispatches = 0;
  try {
    x.ctx.newSession = async ({ parentSession, setup, withSession }) => {
      replacements += 1;
      assert.equal(parentSession, x.session.sessionFile);
      const entries = [];
      const sessionManager = {
        getSessionId: () => "SESSION-TARGET",
        getEntries: () => entries,
        appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
        getHeader: () => ({ parentSession }),
      };
      await setup(sessionManager);
      const target = {
        ...sourceSession("SESSION-TARGET"),
        sessionFile: "/sessions/SESSION-TARGET.jsonl",
        sessionManager,
        async sendUserMessage() { resumeDispatches += 1; },
      };
      x.runner.runtime.session = target;
      let pausedResult;
      await withSession({
        ui: { async confirm() { return false; }, notify() {}, setEditorText() {} },
        async sendUserMessage() { resumeDispatches += 1; },
      });
      return { cancelled: false, pausedResult };
    };
    const result = await x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected });
    assert.equal(result.state, "RESUME_READY");
    assert.equal(result.source_session_id, "SESSION-S1");
    assert.equal(result.task_plan_revision, "PLAN-R1-1");
    assert.equal(result.task_plan_digest, x.expected.contentDigest);
    assert.equal(replacements, 1);
    assert.equal(resumeDispatches, 0);
    assert.equal(x.counters().handoffs, 1);
    assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM authorizations").get().count, 0);
    const persisted = storageDatabaseForInternalTest(x.storage).prepare("SELECT projection_json FROM handoffs").get().projection_json;
    assert.doesNotMatch(persisted, /expectedEligibility|guidedEligibility/i, "guided consent must remain invocation-local");
    assert.equal(x.storage.getLatch("TASK-TRUSTED").state, "ENGAGED");
  } finally { x.close(); }
});

test("secure production workflow reserves canonically, projects compatibly, pauses replacement, and rejects portable resume forgery", async () => {
  const x = fixture({ secureReservation: true });
  let replacements = 0;
  try {
    const db = storageDatabaseForInternalTest(x.storage);
    const forged = {
      handoff_id: "HO-PROJECT-FORGED", source_session_id: x.session.sessionId, target_session_id: "SESSION-FORGED-TARGET",
      task_id: "TASK-TRUSTED", state: "RESUMED", latch_generation: 999999, runner_instance_id: "RUNNER-FORGED",
      task_plan_revision: "PLAN-FORGED", task_plan_digest: `sha256:${"f".repeat(64)}`,
    };
    db.prepare("INSERT INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(forged.handoff_id, forged.source_session_id, forged.target_session_id, forged.task_id, forged.state, forged.latch_generation, JSON.stringify(forged), "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)").run(forged.source_session_id, forged.handoff_id);
    db.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
      .run("EVT-PROJECT-FORGED", forged.handoff_id, "HANDOFF_STARTED", "handoff:project-forged", "2099-01-01T00:00:00.000Z", JSON.stringify({ forged: true }));

    x.ctx.newSession = async ({ parentSession, setup, withSession }) => {
      replacements += 1;
      const entries = [];
      const sessionManager = {
        getSessionId: () => "SESSION-SECURE-TARGET",
        getEntries: () => entries,
        appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
        getHeader: () => ({ parentSession }),
      };
      await setup(sessionManager);
      const target = {
        ...sourceSession("SESSION-SECURE-TARGET"), sessionFile: "/sessions/SESSION-SECURE-TARGET.jsonl", sessionManager,
        async sendUserMessage() { throw new Error("secure resume must remain unavailable"); },
      };
      const projected = x.storage.latestHandoffForTask("TASK-TRUSTED");
      db.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
        .run("EVT-PROJECT-FORGED-BINDING", projected.handoff_id, "RUNNER_SESSION_BOUND", `runner-binding:${projected.handoff_id}`, "2099-01-01T00:00:02.000Z", JSON.stringify({ handoff_id: projected.handoff_id, replacement_session_id: target.sessionId, runner_instance_id: "RUNNER-FORGED", session_binding_id: "BIND-FORGED" }));
      db.prepare("INSERT INTO runner_session_bindings(handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,bind_event_id,superseded_at,superseded_reason) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(projected.handoff_id, target.sessionId, "RUNNER-FORGED", "BIND-FORGED", "SUPERSEDED", "2099-01-01T00:00:02.000Z", "EVT-PROJECT-FORGED-BINDING", "2099-01-01T00:00:03.000Z", "forged");
      x.runner.runtime.session = target;
      await withSession({ ui: { async confirm() { return true; }, notify() {}, setEditorText() {} }, async sendUserMessage() { throw new Error("unexpected resume"); } });
      return { cancelled: false };
    };

    const result = await x.runner.handoffFromCommand(x.ctx, "manual", { intent: "explicit-command" });
    assert.equal(result.state, "RESUME_READY"); assert.equal(replacements, 1);
    const canonical = x.reservationAuthority.getHandoffReservation(result.handoff_id);
    assert.equal(canonical.handoff_id, result.handoff_id);
    assert.equal(canonical.state, "SAFE_TO_HANDOFF");
    assert.equal(canonical.authorization_state, "NOT_AUTHORIZED");
    assert.equal(x.reservationAuthority.getActiveSource(x.session.sessionId).handoff_id, result.handoff_id);
    assert.equal(x.reservationAuthority.handoffReservationEvents(result.handoff_id).length, 1);
    const protectedBinding = x.reservationAuthority.getLifecycleBinding(result.handoff_id);
    assert.equal(protectedBinding.status, "ACTIVE"); assert.equal(protectedBinding.runner_instance_id, result.runner_instance_id);
    assert.equal(x.publicRunner.storage.getRunnerSessionBinding(result.handoff_id).session_binding_id, result.session_binding_id);
    assert.equal(x.publicRunner.storage.latestHandoffForTask("TASK-TRUSTED").handoff_id, result.handoff_id, "secure status must ignore later-looking portable forgery");

    db.prepare("INSERT INTO authorizations(resume_prompt_id,handoff_id,actor,latch_generation,authorized_at) VALUES(?,?,?,?,?)")
      .run(result.resume_prompt_id, result.handoff_id, "human:forged-portable-yes", 999999, "2099-01-01T00:00:01.000Z");
    await assert.rejects(() => x.service.resume(result.handoff_id, {
      actor: "human:forged-portable-yes", sendResume: async () => { throw new Error("must not dispatch"); },
    }), (error) => error.code === "SECURE_RESUME_AUTHORITY_UNAVAILABLE");
    assert.equal(x.storage.getHandoff(result.handoff_id).state, "RESUME_READY");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM admissions WHERE handoff_id=?").get(result.handoff_id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM dispatch_attempts WHERE handoff_id=?").get(result.handoff_id).count, 0);
  } finally { x.close(); }
});

test("shutdown linearized before final binding attestation rejects a dead target with no canonical binding", async () => {
  const x = fixture({ secureReservation: true });
  let replacements = 0; let shutdownInjected = false; let bindingInstalled = false;
  x.ctx.newSession = async ({ parentSession, setup, withSession }) => {
    replacements += 1;
    const entries = [];
    const sessionManager = {
      getSessionId: () => "SESSION-SHUTDOWN-BEFORE-BIND",
      getEntries() {
        if (bindingInstalled && !shutdownInjected) {
          shutdownInjected = true;
          x.runner.noteSessionShutdown({ type: "session_shutdown", reason: "binding race" }, { sessionManager: { getSessionId: () => "SESSION-SHUTDOWN-BEFORE-BIND" } });
        }
        return entries;
      },
      appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); bindingInstalled = true; },
      getHeader: () => ({ parentSession }),
    };
    await setup(sessionManager);
    const target = { ...sourceSession("SESSION-SHUTDOWN-BEFORE-BIND"), sessionFile: "/sessions/SESSION-SHUTDOWN-BEFORE-BIND.jsonl", sessionManager };
    x.runner.runtime.session = target;
    await withSession({ ui: { async confirm() { return false; }, notify() {}, setEditorText() {} }, async sendUserMessage() {} });
    return { cancelled: false };
  };
  try {
    await assert.rejects(() => x.runner.handoffFromCommand(x.ctx, "manual", { intent: "explicit-command" }), (error) => error.code === "RESUME_EXPECTATION_STALE");
    const reservation = x.reservationAuthority.latestHandoffReservationForTask("TASK-TRUSTED");
    assert.ok(reservation); assert.equal(replacements, 1); assert.equal(shutdownInjected, true);
    assert.equal(x.reservationAuthority.getLifecycleBinding(reservation.handoff_id), null);
    assert.equal(x.storage.getHandoff(reservation.handoff_id).state, "RUNNER_OWNERSHIP_ATTESTATION_FAILED");
  } finally { x.close(); }
});

test("external paused replacement plus protected binding commit failure remains paused with exact canonical evidence", async () => {
  let x;
  x = fixture({ secureReservation: true, testHooks: {
    beforeReplacement() {
      const breaker = new DatabaseSync(x.reservationAuthority.path);
      breaker.exec("CREATE TRIGGER force_lifecycle_binding_failure BEFORE INSERT ON lifecycle_bindings BEGIN SELECT RAISE(ABORT,'forced lifecycle binding failure'); END;");
      breaker.close();
    },
  } });
  const replacements = installPausedReplacement(x, { targetId: "SESSION-BINDING-COMMIT-FAIL" });
  try {
    await assert.rejects(() => x.runner.handoffFromCommand(x.ctx, "manual", { intent: "explicit-command" }), /forced lifecycle binding failure/);
    const reservation = x.reservationAuthority.latestHandoffReservationForTask("TASK-TRUSTED");
    assert.ok(reservation); assert.equal(replacements(), 1);
    assert.equal(x.reservationAuthority.getLifecycleBinding(reservation.handoff_id), null);
    const projected = x.storage.getHandoff(reservation.handoff_id);
    assert.equal(projected.target_session_id, "SESSION-BINDING-COMMIT-FAIL");
    assert.equal(projected.state, "RUNNER_OWNERSHIP_ATTESTATION_FAILED");
    assert.equal(projected.failure.code, "ERR_SQLITE_ERROR");
  } finally { x.close(); }
});

test("secure canonical commit survives forced compatibility-projection failure", async () => {
  const x = fixture({ secureReservation: true });
  try {
    storageDatabaseForInternalTest(x.storage).exec("CREATE TRIGGER force_projection_failure BEFORE INSERT ON handoffs BEGIN SELECT RAISE(ABORT,'forced projection failure'); END;");
    await assert.rejects(() => x.runner.handoffFromCommand(x.ctx, "manual", { intent: "explicit-command" }), /forced projection failure/);
    const canonical = x.reservationAuthority.latestHandoffReservationForTask("TASK-TRUSTED");
    assert.ok(canonical); assert.equal(x.reservationAuthority.getActiveSource("SESSION-S1").handoff_id, canonical.handoff_id);
    assert.equal(x.reservationAuthority.handoffReservationEvents(canonical.handoff_id).length, 1);
    assert.equal(x.storage.getHandoff(canonical.handoff_id), null);
    assert.equal(x.newSessions(), 0);
  } finally { x.close(); }
});

test("secure post-reservation takeover preserves canonical arbitration and prevents replacement", async () => {
  let x;
  x = fixture({ secureReservation: true, testHooks: {
    beforeReplacement() {
      const latch = x.reservationAuthority.getLatch("TASK-TRUSTED");
      x.reservationAuthority.claimHumanTakeover({ taskId: "TASK-TRUSTED", actor: "human:/aio-takeover", requestId: "SECURE-POST-RESERVATION", expected: expectedLatch(latch) });
    },
  } });
  try {
    await assert.rejects(() => x.runner.handoffFromCommand(x.ctx, "manual", { intent: "explicit-command" }), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    const canonical = x.reservationAuthority.latestHandoffReservationForTask("TASK-TRUSTED");
    assert.ok(canonical); assert.equal(x.reservationAuthority.getActiveSource("SESSION-S1").handoff_id, canonical.handoff_id);
    assert.equal(x.reservationAuthority.getLatch("TASK-TRUSTED").reason, "HUMAN_TAKEOVER");
    assert.equal(x.newSessions(), 0);
    assert.equal(x.storage.getHandoff(canonical.handoff_id).failure.code, "HUMAN_TAKEOVER_ACTIVE");
  } finally { x.close(); }
});

test("takeover after reservation but before replacement creates no replacement session", async () => {
  let takeover;
  const x = fixture({ testHooks: { beforeReplacement() { claimTakeoverForInternalTest(takeover, "TASK-TRUSTED", "human:/aio-takeover"); } } });
  takeover = new GuardianStorage(x.storagePath);
  try {
    await assert.rejects(
      () => x.runner.handoffFromCommand(x.ctx, "confirm", { intent: "guided-advisor", expectedEligibility: x.expected }),
      (error) => error.code === "HUMAN_TAKEOVER_ACTIVE",
    );
    assert.equal(x.counters().handoffs, 1, "reservation is the documented durable arbitration point");
    assert.equal(x.newSessions(), 0);
    assert.equal(x.storage.latestHandoffForTask("TASK-TRUSTED").failure.code, "HUMAN_TAKEOVER_ACTIVE");
  } finally { takeover.close(); x.close(); }
});

test("two SQLite connections linearize takeover versus conditional reservation", () => {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const root = mkdtempSync(join(tmpdir(), "aiopago-latch-race-"));
    const path = join(root, "guardian.sqlite");
    const handoffActor = new GuardianStorage(path);
    const takeoverActor = new GuardianStorage(path);
    const taskId = `TASK-RACE-${iteration}`;
    try {
      handoffActor.ensureLatch(taskId);
      const acquired = claimLatchForInternalTest(handoffActor, taskId, "INTEGRITY", "human:handoff", { task_id: taskId, state: "RELEASED", generation: 0, reason: null });
      const projection = { handoff_id: `HO-${iteration}`, source_session_id: `SESSION-${iteration}`, task_id: taskId, state: "SAFE_TO_HANDOFF", latch_generation: acquired.generation };
      if (iteration % 2 === 0) {
        claimTakeoverForInternalTest(takeoverActor, taskId, "human:takeover");
        assert.throws(() => reserveHandoffForInternalTest(handoffActor, projection, { latch: acquired, expectedHandoff: null }), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
        assert.equal(storageDatabaseForInternalTest(handoffActor).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
      } else {
        assert.equal(reserveHandoffForInternalTest(handoffActor, projection, { latch: acquired, expectedHandoff: null }).created, true);
        claimTakeoverForInternalTest(takeoverActor, taskId, "human:takeover");
        assert.equal(storageDatabaseForInternalTest(handoffActor).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
      }
    } finally { takeoverActor.close(); handoffActor.close(); }
  }
});

test("M-04 active-source reservation reuse requires exact idempotent identity and rolls back atomically", async (t) => {
  function projection({ handoffId, taskId, source = "SESSION-SAME", revision = "PLAN-1", digest = `sha256:${"a".repeat(64)}` }) {
    return {
      handoff_id: handoffId,
      source_session_id: source,
      task_id: taskId,
      task_plan_revision: revision,
      task_plan_digest: digest,
      latch_generation: 1,
      runner_instance_id: "RUNNER-ONE",
      recovery_of_handoff_id: null,
      checkpoint_id: `CP-${handoffId}`,
      resume_manifest_id: `RM-${handoffId}`,
      state: "SAFE_TO_HANDOFF",
    };
  }

  await t.test("cross-task same source conflicts across two SQLite connections", () => {
    const root = mkdtempSync(join(tmpdir(), "aiopago-active-source-cross-task-"));
    const path = join(root, "guardian.sqlite");
    const a = new GuardianStorage(path);
    const b = new GuardianStorage(path);
    try {
      a.ensureLatch("TASK-A");
      b.ensureLatch("TASK-B");
      const latchA = claimLatchForInternalTest(a, "TASK-A", "INTEGRITY", "human:a");
      const latchB = claimLatchForInternalTest(b, "TASK-B", "INTEGRITY", "human:b");
      reserveHandoffForInternalTest(a, projection({ handoffId: "HO-A", taskId: "TASK-A" }), { latch: latchA, expectedHandoff: null });
      assert.throws(
        () => reserveHandoffForInternalTest(b, projection({ handoffId: "HO-B", taskId: "TASK-B" }), { latch: latchB, expectedHandoff: null }),
        (error) => error.code === "HANDOFF_ACTIVE_SOURCE_CONFLICT",
      );
      assert.equal(storageDatabaseForInternalTest(b).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
      assert.equal(b.getHandoff("HO-B"), null);
    } finally { b.close(); a.close(); }
  });

  await t.test("same task with different revision, digest, and handoff ID conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "aiopago-active-source-provenance-"));
    const path = join(root, "guardian.sqlite");
    const a = new GuardianStorage(path);
    const b = new GuardianStorage(path);
    try {
      a.ensureLatch("TASK-A");
      const latch = claimLatchForInternalTest(a, "TASK-A", "INTEGRITY", "human:a");
      reserveHandoffForInternalTest(a, projection({ handoffId: "HO-A", taskId: "TASK-A" }), { latch, expectedHandoff: null });
      assert.throws(
        () => reserveHandoffForInternalTest(b, projection({ handoffId: "HO-B", taskId: "TASK-A", revision: "PLAN-2", digest: `sha256:${"b".repeat(64)}` }), { latch, expectedHandoff: null }),
        (error) => error.code === "HANDOFF_ACTIVE_SOURCE_CONFLICT",
      );
      assert.equal(storageDatabaseForInternalTest(b).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
    } finally { b.close(); a.close(); }
  });

  await t.test("exact retry returns the exact existing operation without a duplicate", () => {
    const root = mkdtempSync(join(tmpdir(), "aiopago-active-source-retry-"));
    const storage = new GuardianStorage(join(root, "guardian.sqlite"));
    try {
      storage.ensureLatch("TASK-A");
      const latch = claimLatchForInternalTest(storage, "TASK-A", "INTEGRITY", "human:a");
      const value = projection({ handoffId: "HO-A", taskId: "TASK-A" });
      assert.equal(reserveHandoffForInternalTest(storage, value, { latch, expectedHandoff: null }).created, true);
      const retry = reserveHandoffForInternalTest(storage, structuredClone(value), { latch, expectedHandoff: null });
      assert.equal(retry.created, false);
      assert.equal(retry.handoff.handoff_id, "HO-A");
      assert.equal(storageDatabaseForInternalTest(storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
      assert.equal(storage.events("HO-A").filter((event) => event.event_type === "HANDOFF_STARTED").length, 1);
    } finally { storage.close(); }
  });

  await t.test("reservation failure rolls back handoff, active source, and journal", () => {
    const root = mkdtempSync(join(tmpdir(), "aiopago-active-source-rollback-"));
    const storage = new GuardianStorage(join(root, "guardian.sqlite"));
    try {
      storage.ensureLatch("TASK-A");
      const latch = claimLatchForInternalTest(storage, "TASK-A", "INTEGRITY", "human:a");
      const append = storage.appendEvent.bind(storage);
      storage.appendEvent = (type, ...args) => {
        if (type === "HANDOFF_STARTED") throw new Error("forced journal failure");
        return append(type, ...args);
      };
      assert.throws(
        () => reserveHandoffForInternalTest(storage, projection({ handoffId: "HO-ROLLBACK", taskId: "TASK-A" }), { latch, expectedHandoff: null }),
        /forced journal failure/,
      );
      assert.equal(storageDatabaseForInternalTest(storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
      assert.equal(storageDatabaseForInternalTest(storage).prepare("SELECT COUNT(*) AS count FROM active_sources").get().count, 0);
      assert.equal(storageDatabaseForInternalTest(storage).prepare("SELECT COUNT(*) AS count FROM journal WHERE handoff_id IS NOT NULL").get().count, 0);
    } finally { storage.close(); }
  });
});

test("R2-L-01 post-arbitration failures persist bounded identity and reconciliation guidance", async (t) => {
  await t.test("checkpoint persistence", async () => {
    const x = fixture();
    try {
      x.artifacts.persist = () => { throw Object.assign(new Error("checkpoint disk unavailable"), { code: "DISK_UNAVAILABLE" }); };
      await assert.rejects(() => x.runner.handoffFromCommand(x.ctx, "manual"), /checkpoint disk unavailable/);
      const failed = x.storage.latestHandoffForTask("TASK-TRUSTED");
      assert.equal(failed.state, "CHECKPOINT_PERSIST_FAILED");
      assert.deepEqual(failed.failure, { code: "DISK_UNAVAILABLE", message: "checkpoint disk unavailable" });
      assert.match(failed.manual_recovery.join("\n"), /reconcile.*before any new handoff|Do not.*retry/i);
    } finally { x.close(); }
  });

  await t.test("manifest persistence", async () => {
    const x = fixture();
    installPausedReplacement(x);
    try {
      const persist = x.artifacts.persist.bind(x.artifacts);
      x.artifacts.persist = (kind, ...args) => {
        if (kind === "manifest") throw Object.assign(new Error("manifest disk unavailable"), { code: "MANIFEST_IO" });
        return persist(kind, ...args);
      };
      await assert.rejects(() => x.runner.handoffFromCommand(x.ctx, "manual"), /manifest disk unavailable/);
      const failed = x.storage.latestHandoffForTask("TASK-TRUSTED");
      assert.equal(failed.state, "MANIFEST_PERSIST_FAILED");
      assert.deepEqual(failed.failure, { code: "MANIFEST_IO", message: "manifest disk unavailable" });
      assert.match(failed.manual_recovery.join("\n"), /Keep target.*paused|Do not.*retry/i);
    } finally { x.close(); }
  });
});

test("R2-M-01 task-operation arbitration blocks representative unresolved and ambiguous states across connections", async (t) => {
  const states = [
    "CHECKPOINT_PERSISTING", "CHECKPOINT_PERSISTED", "REPLACEMENT_SESSION_CREATING",
    "REPLACEMENT_SESSION_CREATED_PAUSED", "MANIFEST_PERSISTING", "MANIFEST_PERSISTED",
    "RESUME_READY", "RESUME_ADMISSION_COMMITTED", "RESUME_DISPATCHING",
    "RESUME_DISPATCH_UNKNOWN", "HANDOFF_FAILED", "HUMAN_DECISION_REQUIRED",
  ];
  for (const [index, state] of states.entries()) {
    await t.test(state, () => {
      const root = mkdtempSync(join(tmpdir(), "aiopago-task-operation-state-"));
      const path = join(root, "guardian.sqlite");
      const a = new GuardianStorage(path);
      const b = new GuardianStorage(path);
      const taskId = `TASK-STATE-${index}`;
      try {
        a.ensureLatch(taskId);
        const latch = claimLatchForInternalTest(a, taskId, "INTEGRITY", "human:first");
        reserveHandoffForInternalTest(a, { handoff_id: `HO-C1-${index}`, source_session_id: `SESSION-C1-${index}`, task_id: taskId, state, latch_generation: latch.generation }, { latch, expectedHandoff: null });
        const latest = a.latestHandoffForTask(taskId);
        assert.throws(
          () => reserveHandoffForInternalTest(b, { handoff_id: `HO-C2-${index}`, source_session_id: `SESSION-S2-${index}`, task_id: taskId, state: "SAFE_TO_HANDOFF", latch_generation: latch.generation }, {
            latch,
            expectedHandoff: handoffConsentIdentity(latest),
          }),
          (error) => error.code === "TASK_OPERATION_CONFLICT",
        );
        assert.equal(storageDatabaseForInternalTest(b).prepare("SELECT COUNT(*) AS count FROM handoffs WHERE task_id=?").get(taskId).count, 1);
      } finally { b.close(); a.close(); }
    });
  }
});

test("R2-M-01 guided and explicit command paths cannot fork an unresolved task operation", async (t) => {
  for (const intent of ["guided", "explicit"]) {
    await t.test(intent, async () => {
      const x = fixture();
      try {
        const latch = claimLatchForInternalTest(x.storage, "TASK-TRUSTED", "INTEGRITY", "human:first");
        reserveHandoffForInternalTest(x.storage, {
          handoff_id: "HO-C1", source_session_id: "SESSION-OTHER", task_id: "TASK-TRUSTED",
          state: "REPLACEMENT_SESSION_CREATING", latch_generation: latch.generation,
        }, { latch, expectedHandoff: null });
        if (intent === "guided") {
          const handlers = new Map();
          createGuardianExtension(x.runner)({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
          x.runner.contextAdvisor = { thresholdPercent: 50, reset() {}, observe: () => ({ percent: 60, thresholdPercent: 50 }) };
          let prompts = 0;
          await handlers.get("turn_end")({}, {
            hasUI: true,
            getContextUsage: () => ({ percent: 60, tokens: 60, contextWindow: 100 }),
            ui: { async confirm() { prompts += 1; return true; }, notify() {} },
          });
          assert.equal(prompts, 0, "guided advice must not offer consent while an unresolved task operation owns the latch");
        } else {
          await assert.rejects(
            () => x.runner.handoffFromCommand(x.ctx, "manual", { intent: "explicit-command" }),
            (error) => error.code === "TASK_OPERATION_CONFLICT",
          );
        }
        assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
        assert.equal(x.newSessions(), 0);
      } finally { x.close(); }
    });
  }
});

test("M-05 real tarball keeps TaskLedger public but exposes no plan coordination capability", () => {
  const packRoot = mkdtempSync(join(tmpdir(), "aiopago-package-boundary-"));
  const consumer = join(packRoot, "consumer");
  mkdirSync(consumer);
  const npmOptions = { shell: process.platform === "win32" };
  const packedName = execFileSync("npm", ["pack", "--silent", "--pack-destination", packRoot], { cwd: process.cwd(), encoding: "utf8", ...npmOptions }).trim().split(/\r?\n/).at(-1);
  const tarball = join(packRoot, packedName);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "aiopago-boundary-consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--omit=peer", "--no-package-lock", tarball], { cwd: consumer, stdio: "pipe", ...npmOptions });
  const externalPlanPath = join(consumer, "TASK_PLAN.md");
  writePlan(externalPlanPath, blockedTask());
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { TaskLedger } from "aiopago";
    assert.equal(typeof TaskLedger, "function");
    assert.equal(typeof TaskLedger.prototype.withAuthorityCoordination, "undefined");
    assert.equal(typeof TaskLedger.prototype.satisfyOwnerGate, "undefined");
    const ledger = new TaskLedger(${JSON.stringify(externalPlanPath)});
    const before = readFileSync(${JSON.stringify(externalPlanPath)});
    assert.throws(() => ledger.satisfyOwnerGate({ command: "/aio handoff confirm", actor: "human:external" }), TypeError);
    assert.deepEqual(readFileSync(${JSON.stringify(externalPlanPath)}), before);
    assert.equal(ledger.read().owner_gate.status, "BLOCKED");
    assert.equal(Object.hasOwn(ledger, "writer"), false);
    const names = Object.getOwnPropertyNames(TaskLedger.prototype);
    assert.deepEqual(names.sort(), ["constructor", "read", "validate"].sort());
    await assert.rejects(import("aiopago/src/handoff-plan-internal.mjs"), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
    await assert.rejects(import("aiopago/src/plan-semantics-internal.mjs"), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
    await assert.rejects(import("aiopago/src/task-operation-internal.mjs"), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
    const root = await import("aiopago");
    assert.equal(Object.hasOwn(root, "GuardianStorage"), false);
    assert.equal(Object.hasOwn(root, "reserveHandoffForInternalTest"), false);
    assert.equal(Object.hasOwn(root, "claimTakeoverForInternalTest"), false);
    assert.equal(Object.hasOwn(root, "PlanRevisionWriter"), false);
    assert.equal(Object.hasOwn(root, "canonicalPlanSemantics"), false);
    assert.equal(Object.hasOwn(root, "planSemanticDigest"), false);
    assert.equal(Object.hasOwn(root, "authorizeTrustedResume"), false);
    assert.equal(Object.hasOwn(root, "taskOperationDisposition"), false);
    assert.equal(Object.keys(root).some((name) => /coordinate|plan.*lock|reserve.*handoff|trusted.*takeover/i.test(name)), false);
  `;
  writeFileSync(join(consumer, "verify.mjs"), script);
  execFileSync(process.execPath, ["verify.mjs"], { cwd: consumer, stdio: "pipe" });
  assert.ok(readFileSync(tarball).length > 0);
});
