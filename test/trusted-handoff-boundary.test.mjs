import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.mjs";
import { createGuardianExtension } from "../src/extension.mjs";
import { guidedHandoffEligibilityIdentityFromAuthority } from "../src/handoff-consent.mjs";
import { HandoffService } from "../src/handoff.mjs";
import { createPlanAdapter, PLAN_INTENT_SCHEMA } from "../src/intent-adapter.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { GuardianRunner } from "../src/runner.mjs";
import { AdmissionGate, SafePointCoordinator } from "../src/safety.mjs";
import { GuardianStorage } from "../src/storage.mjs";

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

function fixture({ session = sourceSession(), testHooks = null, planValue = task(), ledgerOptions = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiopago-trusted-handoff-"));
  const ledgerPath = join(root, "TASK_PLAN.md");
  writePlan(ledgerPath, planValue);
  const ledger = new TaskLedger(ledgerPath, ledgerOptions);
  const storagePath = join(root, ".guardian", "runtime", "guardian.sqlite");
  const storage = new GuardianStorage(storagePath);
  const plan = ledger.read();
  storage.ensureLatch(plan.task_id);
  const artifacts = new ArtifactStore(join(root, ".guardian"), storage);
  const gate = new AdmissionGate(storage, plan.task_id);
  const safePoint = new SafePointCoordinator({ storage, taskId: plan.task_id, gate });
  const runnerInstanceId = "RUNNER-TRUSTED";
  const service = new HandoffService({
    storage, artifacts, ledger, safePoint, runnerInstanceId,
    observeGit: () => gitState(root), modelPolicy: "offline/fake", reasoningPolicy: "off", testHooks,
  });
  const runner = new GuardianRunner({
    cwd: root, roots: { targetRoot: root, runtimeRoot: join(root, ".guardian", "runtime"), artifactRoot: join(root, ".guardian") },
    ledger, storage, artifacts, gate, safePoint, handoffService: service, runnerInstanceId, confirmMode: "confirm-or-manual",
  });
  runner.runtime = { session };
  runner.recoverySourceSession = session;
  runner.contextAdvisor = { reset() {} };
  const expected = guidedHandoffEligibilityIdentityFromAuthority({
    plan, sessionId: session.sessionId, runnerInstanceId, latch: storage.getLatch(plan.task_id), handoff: null,
  });
  const counters = () => storage.db.prepare(`SELECT
    (SELECT COUNT(*) FROM handoffs) AS handoffs,
    (SELECT COUNT(*) FROM active_sources) AS active_sources,
    (SELECT COUNT(*) FROM artifacts) AS artifacts`).get();
  let newSessions = 0;
  const ctx = {
    async newSession() { newSessions += 1; throw new Error("replacement must not be attempted"); },
    ui: { async confirm() { return false; }, notify() {}, setEditorText() {} },
  };
  return {
    root, ledgerPath, ledger, storagePath, storage, artifacts, gate, safePoint, service, runner, session, expected, ctx, counters,
    newSessions: () => newSessions,
    close() { storage.close(); },
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
    takeover.engageLatch("TASK-TRUSTED", "HUMAN_TAKEOVER", "human:/aio-takeover");
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
    x.storage.engageLatch("TASK-TRUSTED", "HUMAN_TAKEOVER", "human:/aio-takeover");
    await assert.rejects(() => x.safePoint.request(x.session, "human:handoff"), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
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
    takeover.engageLatch("TASK-TRUSTED", "HUMAN_TAKEOVER", "human:/aio-takeover");
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
    takeover.engageLatch("TASK-TRUSTED", "HUMAN_TAKEOVER", "human:/aio-takeover");
    x.gate.streamDone();
    await assert.rejects(() => pending, (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    assertNoPreparation(x);
  } finally { takeover.close(); x.close(); }
});

test("H-01 reservation transaction refuses takeover after SafePoint and before reserve", async () => {
  let takeover;
  const x = fixture({ testHooks: { afterSafePoint() { takeover.engageLatch("TASK-TRUSTED", "HUMAN_TAKEOVER", "human:/aio-takeover"); } } });
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
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM authorizations").get().count, 0);
    const persisted = x.storage.db.prepare("SELECT projection_json FROM handoffs").get().projection_json;
    assert.doesNotMatch(persisted, /expectedEligibility|guidedEligibility/i, "guided consent must remain invocation-local");
    assert.equal(x.storage.getLatch("TASK-TRUSTED").state, "ENGAGED");
  } finally { x.close(); }
});

test("takeover after reservation but before replacement creates no replacement session", async () => {
  let takeover;
  const x = fixture({ testHooks: { beforeReplacement() { takeover.engageLatch("TASK-TRUSTED", "HUMAN_TAKEOVER", "human:/aio-takeover"); } } });
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
      const acquired = handoffActor.claimLatch(taskId, "INTEGRITY", "human:handoff", { task_id: taskId, state: "RELEASED", generation: 0, reason: null });
      const projection = { handoff_id: `HO-${iteration}`, source_session_id: `SESSION-${iteration}`, task_id: taskId, state: "SAFE_TO_HANDOFF", latch_generation: acquired.generation };
      if (iteration % 2 === 0) {
        takeoverActor.engageLatch(taskId, "HUMAN_TAKEOVER", "human:takeover");
        assert.throws(() => handoffActor.reserveHandoff(projection, { latch: acquired, expectedHandoff: null }), (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
        assert.equal(handoffActor.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
      } else {
        assert.equal(handoffActor.reserveHandoff(projection, { latch: acquired, expectedHandoff: null }).created, true);
        takeoverActor.engageLatch(taskId, "HUMAN_TAKEOVER", "human:takeover");
        assert.equal(handoffActor.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
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
      const latchA = a.engageLatch("TASK-A", "INTEGRITY", "human:a");
      const latchB = b.engageLatch("TASK-B", "INTEGRITY", "human:b");
      a.reserveHandoff(projection({ handoffId: "HO-A", taskId: "TASK-A" }), { latch: latchA, expectedHandoff: null });
      assert.throws(
        () => b.reserveHandoff(projection({ handoffId: "HO-B", taskId: "TASK-B" }), { latch: latchB, expectedHandoff: null }),
        (error) => error.code === "HANDOFF_ACTIVE_SOURCE_CONFLICT",
      );
      assert.equal(b.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
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
      const latch = a.engageLatch("TASK-A", "INTEGRITY", "human:a");
      a.reserveHandoff(projection({ handoffId: "HO-A", taskId: "TASK-A" }), { latch, expectedHandoff: null });
      assert.throws(
        () => b.reserveHandoff(projection({ handoffId: "HO-B", taskId: "TASK-A", revision: "PLAN-2", digest: `sha256:${"b".repeat(64)}` }), { latch, expectedHandoff: null }),
        (error) => error.code === "HANDOFF_ACTIVE_SOURCE_CONFLICT",
      );
      assert.equal(b.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
    } finally { b.close(); a.close(); }
  });

  await t.test("exact retry returns the exact existing operation without a duplicate", () => {
    const root = mkdtempSync(join(tmpdir(), "aiopago-active-source-retry-"));
    const storage = new GuardianStorage(join(root, "guardian.sqlite"));
    try {
      storage.ensureLatch("TASK-A");
      const latch = storage.engageLatch("TASK-A", "INTEGRITY", "human:a");
      const value = projection({ handoffId: "HO-A", taskId: "TASK-A" });
      assert.equal(storage.reserveHandoff(value, { latch, expectedHandoff: null }).created, true);
      const retry = storage.reserveHandoff(structuredClone(value), { latch, expectedHandoff: null });
      assert.equal(retry.created, false);
      assert.equal(retry.handoff.handoff_id, "HO-A");
      assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 1);
      assert.equal(storage.events("HO-A").filter((event) => event.event_type === "HANDOFF_STARTED").length, 1);
    } finally { storage.close(); }
  });

  await t.test("reservation failure rolls back handoff, active source, and journal", () => {
    const root = mkdtempSync(join(tmpdir(), "aiopago-active-source-rollback-"));
    const storage = new GuardianStorage(join(root, "guardian.sqlite"));
    try {
      storage.ensureLatch("TASK-A");
      const latch = storage.engageLatch("TASK-A", "INTEGRITY", "human:a");
      const append = storage.appendEvent.bind(storage);
      storage.appendEvent = (type, ...args) => {
        if (type === "HANDOFF_STARTED") throw new Error("forced journal failure");
        return append(type, ...args);
      };
      assert.throws(
        () => storage.reserveHandoff(projection({ handoffId: "HO-ROLLBACK", taskId: "TASK-A" }), { latch, expectedHandoff: null }),
        /forced journal failure/,
      );
      assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
      assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM active_sources").get().count, 0);
      assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM journal WHERE handoff_id IS NOT NULL").get().count, 0);
    } finally { storage.close(); }
  });
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
  const script = `
    import assert from "node:assert/strict";
    import { TaskLedger } from "aiopago";
    assert.equal(typeof TaskLedger, "function");
    assert.equal(typeof TaskLedger.prototype.withAuthorityCoordination, "undefined");
    const names = Object.getOwnPropertyNames(TaskLedger.prototype);
    assert.deepEqual(names.sort(), ["constructor", "read", "satisfyOwnerGate", "validate"].sort());
    await assert.rejects(import("aiopago/src/handoff-plan-internal.mjs"), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
    const root = await import("aiopago");
    assert.equal(Object.hasOwn(root, "PlanRevisionWriter"), false);
    assert.equal(Object.keys(root).some((name) => /coordinate|plan.*lock/i.test(name)), false);
  `;
  writeFileSync(join(consumer, "verify.mjs"), script);
  execFileSync(process.execPath, ["verify.mjs"], { cwd: consumer, stdio: "pipe" });
  assert.ok(readFileSync(tarball).length > 0);
});
