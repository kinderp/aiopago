import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.mjs";
import { guidedHandoffEligibilityIdentityFromAuthority } from "../src/handoff-consent.mjs";
import { HandoffService } from "../src/handoff.mjs";
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

function writePlan(path, value) {
  writeFileSync(path, `# Trusted handoff fixture\n\n\`\`\`json task-ledger\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
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

function fixture({ session = sourceSession(), testHooks = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiopago-trusted-handoff-"));
  const ledgerPath = join(root, "TASK_PLAN.md");
  writePlan(ledgerPath, task());
  const ledger = new TaskLedger(ledgerPath);
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
    assert.doesNotMatch(persisted, /expectedEligibility|consent/i, "guided consent must remain invocation-local");
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

test("bounded final plan coordination excludes a compliant TaskLedger writer", () => {
  const x = fixture();
  try {
    const before = x.ledger.read();
    x.ledger.withAuthorityCoordination((coordinated) => {
      assert.equal(coordinated.content_digest, before.content_digest);
      assert.throws(
        () => new TaskLedger(x.ledgerPath).satisfyOwnerGate({ command: "/aio handoff confirm", actor: "human:other-writer" }),
        (error) => error.code === "PLAN_WRITE_LOCKED",
      );
      assert.equal(x.ledger.read().content_digest, before.content_digest);
    });
    assert.equal(x.ledger.read().content_digest, before.content_digest);
  } finally { x.close(); }
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
