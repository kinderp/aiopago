import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, digestObject, sha256 } from "../src/canonical.mjs";
import { createGuardianExtension } from "../src/extension.mjs";
import { observeGitState } from "../src/git-state.mjs";
import { guidedHandoffEligibilityIdentityFromAuthority } from "../src/handoff-consent.mjs";
import { HandoffService } from "../src/handoff.mjs";
import { observeRunnerHumanWorkflow, projectHumanWorkflow } from "../src/human-workflow.mjs";
import { createPlanAdapter, PLAN_INTENT_SCHEMA } from "../src/intent-adapter.mjs";
import { loadPi } from "../src/pi-loader.mjs";
import { GuardianRunner, runnerForInternalTest } from "../src/runner.mjs";
import { readRuntimeRunnerBinding, RUNNER_BINDING_CUSTOM_TYPE } from "../src/runner-ownership.mjs";
import { GuardianStorage, beginDispatchForInternalTest, bindRunnerSessionForInternalTest, claimLatchForInternalTest, claimTakeoverForInternalTest, finishDispatchForInternalTest, reserveHandoffForInternalTest, saveHandoffForInternalTest, storageDatabaseForInternalTest, supersedeRunnerSessionBindingForInternalTest } from "../src/storage.mjs";

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

const REAL_MINIMAL_READS = [
  "AGENTS.md section 18",
  "CHECKPOINT.md",
  "TASK_PLAN.md",
  "Complete PR #679 diff against its current base",
  "Current PR #679 status, checks, reviews, and discussions",
];

function writeFixtureLedger(root, advanced = false, modelPolicy = "offline-fake/offline-fake", requiredLocalPaths = undefined) {
  const minimalReads = REAL_MINIMAL_READS;
  const setup = {
    task_item_id: "ITEM-E2E-SETUP", task_id: "TASK-E2E", title: "Prepare source", description: "fixture setup",
    status: advanced ? "DONE" : "IN_PROGRESS", depends_on: [], completion_criteria: ["source response observed"],
    evidence: advanced ? ["provider fake source response"] : [], requirements_refs: ["M1-H0"], risk: "HIGH", milestone: "M1-H0",
    last_updated_at: advanced ? "2026-08-08T00:01:00Z" : "2026-08-08T00:00:00Z", last_updated_by: "test",
  };
  const handoff = {
    task_item_id: "ITEM-E2E-HANDOFF", task_id: "TASK-E2E", title: "Run handoff", description: "fixture handoff",
    status: advanced ? "IN_PROGRESS" : "PLANNED", depends_on: ["ITEM-E2E-SETUP"], completion_criteria: ["handoff resumed"],
    evidence: [], requirements_refs: ["M1-H0"], risk: "HIGH", milestone: "M1-H0",
    last_updated_at: advanced ? "2026-08-08T00:01:00Z" : "2026-08-08T00:00:00Z", last_updated_by: "test",
  };
  const task = {
    schema_version: "0.1.0", task_id: "TASK-E2E", title: "E2E", objective: "Pi real runtime handoff",
    requirements_version: "REQ-E2E-1", plan_revision_id: advanced ? "PLAN-E2E-2" : "PLAN-E2E-1", status: "IN_PROGRESS",
    completion_criteria: ["E2E pass"], risk: "HIGH", created_at: "2026-08-08T00:00:00Z",
    updated_at: advanced ? "2026-08-08T00:01:00Z" : "2026-08-08T00:00:00Z",
    current_item: advanced ? "ITEM-E2E-HANDOFF" : "ITEM-E2E-SETUP",
    next_item: advanced ? null : "ITEM-E2E-HANDOFF",
    next_step: advanced ? "Resume the updated handoff item" : "Complete source setup and advance the Ledger",
    model_policy: modelPolicy, reasoning_policy: "off", minimal_reads: minimalReads,
    ...(requiredLocalPaths ? { required_local_paths: requiredLocalPaths } : {}),
    task_items: [setup, handoff],
  };
  writeFileSync(join(root, "TASK_PLAN.md"), `# E2E Ledger\n\n**Schema:** \`aiopago.task-ledger/0.1.0\`\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

function fixtureLedger(root, modelPolicy = "offline-fake/offline-fake", requiredLocalPaths = undefined) {
  writeFixtureLedger(root, false, modelPolicy, requiredLocalPaths);
  writeFileSync(join(root, "CHECKPOINT.md"), "# Project checkpoint\n");
  mkdirSync(join(root, "docs"));
  for (const name of ["adr.md", "safe.md", "resume.md"]) writeFileSync(join(root, "docs", name), `# ${name}\n`);
  writeFileSync(join(root, ".gitignore"), ".guardian/\n");
}

function writeOwnerGateLedger(root) {
  const blockedStep = "Owner gate: execute /aio handoff confirm";
  const resumedStep = "Validate replacement continuity and finish H1-02 metrics";
  const task = {
    schema_version: "0.1.0", task_id: "TASK-E2E", title: "E2E owner gate", objective: "Advance a blocked handoff gate before sealing",
    requirements_version: "REQ-E2E-1", plan_revision_id: "PLAN-E2E-GATE-1", status: "BLOCKED",
    completion_criteria: ["owner gate handoff resumes"], risk: "HIGH", created_at: "2026-08-08T00:00:00Z", updated_at: "2026-08-08T00:00:00Z",
    current_item: null, next_item: "ITEM-H1-02", next_step: blockedStep,
    model_policy: "offline-fake/offline-fake", reasoning_policy: "off", minimal_reads: ["TASK_PLAN.md", "docs/adr.md", "docs/safe.md", "docs/resume.md"],
    owner_gate: {
      kind: "HANDOFF_CONFIRM", status: "BLOCKED", command: "/aio handoff confirm", item_id: "ITEM-H1-02",
      satisfied_plan_revision_id: "PLAN-E2E-GATE-2", satisfied_task_status: "IN_PROGRESS", satisfied_next_item: "ITEM-H1-03", satisfied_next_step: resumedStep,
    },
    task_items: [
      { task_item_id: "ITEM-H1-01", task_id: "TASK-E2E", title: "Advisor", description: "done", status: "DONE", depends_on: [], completion_criteria: ["done"], evidence: ["verified"], requirements_refs: [], risk: "MEDIUM", milestone: "M1-H1", last_updated_at: "2026-08-08T00:00:00Z", last_updated_by: "test" },
      { task_item_id: "ITEM-H1-02", task_id: "TASK-E2E", title: "Resume", description: "replacement work", status: "BLOCKED", depends_on: ["ITEM-H1-01"], completion_criteria: ["resumed"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "M1-H1", last_updated_at: "2026-08-08T00:00:00Z", last_updated_by: "test" },
      { task_item_id: "ITEM-H1-03", task_id: "TASK-E2E", title: "Acceptance", description: "accept", status: "PLANNED", depends_on: ["ITEM-H1-02"], completion_criteria: ["accepted"], evidence: [], requirements_refs: [], risk: "MEDIUM", milestone: "M1-H1", last_updated_at: "2026-08-08T00:00:00Z", last_updated_by: "test" },
    ],
  };
  writeFileSync(join(root, "TASK_PLAN.md"), `# E2E owner gate Ledger\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

async function makeRunner({ ownerGate = false, portableModelPolicy = false, requiredLocalPaths = undefined, existingRoot = null, modelReasoning = false, reasoningPolicy = "off" } = {}) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "aiopago-pi-e2e-"));
  if (!existingRoot) {
    fixtureLedger(root, portableModelPolicy ? null : "offline-fake/offline-fake", requiredLocalPaths);
    if (ownerGate) writeOwnerGateLedger(root);
    git(root, ["init"]); git(root, ["config", "user.email", "e2e@example.invalid"]); git(root, ["config", "user.name", "Aiopago E2E"]);
    git(root, ["add", "."]); git(root, ["commit", "-m", "fixture"]);
  }
  const pi = await loadPi();
  const credentials = new pi.ai.InMemoryCredentialStore();
  const modelRuntime = await pi.coding.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = { id: "offline-fake", name: "Offline fake", api: "openai-completions", provider: "offline-fake", baseUrl: "offline://local", reasoning: modelReasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let calls = 0;
  let networkAttempts = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkAttempts += 1; throw new Error("network forbidden in E2E"); };
  modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl, apiKey: "offline-placeholder", api: model.api, models: [model],
    streamSimple() {
      calls += 1;
      const stream = pi.ai.createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: `offline response ${calls}` }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, stopReason: "pending" } }); stream.push({ type: "done", reason: "stop", message }); });
      return stream;
    },
  });
  await modelRuntime.setRuntimeApiKey(model.provider, "offline-placeholder");
  const settings = pi.coding.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const sessions = mkdtempSync(join(tmpdir(), "aiopago-pi-sessions-"));
  const runner = runnerForInternalTest(await GuardianRunner.create({ cwd: root, pi, modelRuntime, model, ...(portableModelPolicy ? {} : { modelPolicy: "offline-fake/offline-fake" }), reasoningPolicy, contextHandoffThresholdPercent: 50, settingsManager: settings, sessionDir: sessions, noTools: "all" }));
  await runner.runtime.session.bindExtensions({
    mode: "print",
    commandContextActions: {
      waitForIdle: () => runner.runtime.session.waitForIdle(),
      newSession: (options) => runner.runtime.newSession(options),
      fork: (entryId, options) => runner.runtime.fork(entryId, options),
      navigateTree: (targetId, options) => runner.runtime.session.navigateTree(targetId, options),
      switchSession: (path, options) => runner.runtime.switchSession(path, options),
      reload: async () => {},
    },
  });
  return { root, runner, get calls() { return calls; }, get networkAttempts() { return networkAttempts; }, restoreFetch() { globalThis.fetch = previousFetch; } };
}

async function makeContinuityRecoveryFixture(options = {}) {
  let previous = await makeRunner(options);
  try {
    previous.runner.handoffService.continuity = () => {
      const error = new Error("forced M-06 continuity failure fixture");
      error.code = "CONTINUITY_FAILED";
      throw error;
    };
    await assert.rejects(
      () => previous.runner.handoffDirect({ mode: "manual", confirm: false }),
      (error) => error.code === "CONTINUITY_FAILED",
    );
    const failed = previous.runner.storage.latestHandoffForTask("TASK-E2E");
    assert.equal(previous.runner.storage.getRunnerSessionBinding(failed.handoff_id).status, "ACTIVE");
    const root = previous.root;
    await previous.runner.dispose();
    previous.restoreFetch();
    previous = null;
    const current = await makeRunner({ ...options, existingRoot: root });
    return { ...current, failed };
  } catch (error) {
    if (previous) {
      await previous.runner.dispose();
      previous.restoreFetch();
    }
    throw error;
  }
}

function planDiskSnapshot(root, runner) {
  const path = join(root, "TASK_PLAN.md");
  const bytes = readFileSync(path);
  const plan = runner.ledger.read();
  const historyRoot = join(root, ".guardian", "plan-history");
  let history = [];
  try {
    history = readdirSync(historyRoot).sort().map((name) => {
      const value = readFileSync(join(historyRoot, name));
      return { name, digest: sha256(value), bytes: value };
    });
  } catch (error) { assert.equal(error.code, "ENOENT"); }
  return {
    bytes,
    contentDigest: sha256(bytes),
    revision: plan.plan_revision_id,
    gate: plan.owner_gate?.status ?? null,
    mtimeNs: statSync(path, { bigint: true }).mtimeNs,
    history,
  };
}

function recoveryDurableSnapshot(runner, failedHandoffId) {
  return {
    handoffs: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count,
    recoveryStarted: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM journal WHERE handoff_id=? AND event_type='CONTINUITY_RECOVERY_STARTED'").get(failedHandoffId).count,
    bindingSuperseded: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM journal WHERE handoff_id=? AND event_type='RUNNER_SESSION_BINDING_SUPERSEDED'").get(failedHandoffId).count,
    bindingStatus: runner.storage.getRunnerSessionBinding(failedHandoffId).status,
  };
}

function instrumentRecoveryPreparation(runner) {
  const prepare = runner.storage.prepareContinuityRecovery.bind(runner.storage);
  let calls = 0;
  runner.storage.prepareContinuityRecovery = (...args) => {
    calls += 1;
    return prepare(...args);
  };
  return () => calls;
}

function prepareRecoveryPlanChange(root, suffix = "M07") {
  const adapter = createPlanAdapter(join(root, "TASK_PLAN.md"));
  const observation = adapter.observe();
  const candidate = structuredClone(observation.plan);
  candidate.plan_revision_id = `${observation.plan_revision_id}-${suffix}`;
  candidate.updated_at = "2026-08-22T23:59:00.000Z";
  candidate.objective = `${candidate.objective} (${suffix} drift)`;
  const proposal = adapter.propose({
    schema: PLAN_INTENT_SCHEMA,
    proposal_id: `PPR-${suffix}-${Date.now()}`,
    producer: "aiopago:m07-real-plan-port",
    change_reason: "Exercise final recovery plan coordination.",
    base: {
      task_id: observation.task_id,
      plan_revision_id: observation.plan_revision_id,
      content_digest: observation.content_digest,
    },
    candidate_plan: candidate,
  });
  return { adapter, observation, proposal, apply: () => adapter.apply(proposal) };
}

function recoveryAttackSnapshot(runner, failedHandoffId) {
  return {
    ...recoveryDurableSnapshot(runner, failedHandoffId),
    activeSources: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM active_sources").get().count,
    recoveryChildren: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs WHERE projection_json LIKE ?").get(`%\"recovery_of_handoff_id\":\"${failedHandoffId}\"%`).count,
  };
}

function resealArtifactMutation(runner, kind, id, mutate) {
  const index = structuredClone(runner.storage.getArtifact(kind, id));
  const originalBytes = readFileSync(index.path);
  const envelope = JSON.parse(originalBytes.toString("utf8"));
  mutate(envelope.payload);
  envelope.payload.content_digest = null;
  envelope.payload.content_digest = digestObject(envelope.payload);
  const bytes = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
  const digest = sha256(bytes);
  writeFileSync(index.path, bytes);
  storageDatabaseForInternalTest(runner.storage).prepare("UPDATE artifacts SET digest=?,content_digest=? WHERE kind=? AND artifact_id=?")
    .run(digest, envelope.payload.content_digest, kind, id);
  return {
    bytes,
    digest,
    contentDigest: envelope.payload.content_digest,
    restore() {
      writeFileSync(index.path, originalBytes);
      storageDatabaseForInternalTest(runner.storage).prepare("UPDATE artifacts SET digest=?,content_digest=? WHERE kind=? AND artifact_id=?")
        .run(index.digest, index.content_digest, kind, id);
    },
  };
}

function installFailedManifestMutation(runner, failedHandoffId, mutate) {
  const originalFailed = runner.storage.getHandoff(failedHandoffId);
  const sealed = resealArtifactMutation(runner, "manifest", originalFailed.resume_manifest_id, mutate);
  const changed = runner.storage.getHandoff(failedHandoffId);
  changed.resume_manifest_digest = sealed.digest;
  saveHandoffForInternalTest(runner.storage, changed);
  return {
    sealed,
    restore() {
      sealed.restore();
      saveHandoffForInternalTest(runner.storage, structuredClone(originalFailed));
    },
  };
}

function installFailedCheckpointMutation(runner, failedHandoffId, mutate) {
  const originalFailed = runner.storage.getHandoff(failedHandoffId);
  const checkpoint = resealArtifactMutation(runner, "checkpoint", originalFailed.checkpoint_id, mutate);
  const manifest = resealArtifactMutation(runner, "manifest", originalFailed.resume_manifest_id, (payload) => {
    payload.checkpoint_digest = checkpoint.digest;
  });
  const changed = runner.storage.getHandoff(failedHandoffId);
  changed.checkpoint_digest = checkpoint.digest;
  changed.resume_manifest_digest = manifest.digest;
  saveHandoffForInternalTest(runner.storage, changed);
  return {
    checkpoint,
    manifest,
    restore() {
      checkpoint.restore();
      manifest.restore();
      saveHandoffForInternalTest(runner.storage, structuredClone(originalFailed));
    },
  };
}

function convertFailedManifestToLegacyV1(runner, failed) {
  const index = runner.storage.getArtifact("manifest", failed.resume_manifest_id);
  const envelope = JSON.parse(readFileSync(index.path, "utf8"));
  envelope.payload.manifest_version = "1.0.0";
  delete envelope.payload.required_local_paths;
  envelope.payload.minimal_reads = [...REAL_MINIMAL_READS];
  envelope.payload.content_digest = null;
  envelope.payload.content_digest = digestObject(envelope.payload);
  const bytes = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
  const digest = sha256(bytes);
  writeFileSync(index.path, bytes);
  storageDatabaseForInternalTest(runner.storage).prepare("UPDATE artifacts SET digest=?,content_digest=? WHERE kind='manifest' AND artifact_id=?")
    .run(digest, envelope.payload.content_digest, failed.resume_manifest_id);
  failed.resume_manifest_digest = digest;
  delete failed.failure;
  saveHandoffForInternalTest(runner.storage, failed);
  return { bytes, digest };
}

test("Pi E2E: a Pi-selected model becomes effective handoff policy when the Ledger leaves it null", async () => {
  const x = await makeRunner({ portableModelPolicy: true });
  try {
    assert.equal(x.runner.ledger.read().model_policy, null);
    assert.equal(x.runner.handoffService.modelPolicy, "offline-fake/offline-fake");
    const result = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    assert.equal(result.state, "RESUME_READY");
    assert.equal(result.model_policy, "offline-fake/offline-fake");
    const manifest = x.runner.artifacts.verify("manifest", result.resume_manifest_id, result.resume_manifest_digest);
    assert.equal(manifest.payload.model_policy, "offline-fake/offline-fake");
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("Pi SDK E2E: /aio status, why, next and plan use the shared read-only projection with zero model calls", async () => {
  const x = await makeRunner();
  try {
    const notifications = [];
    const uiContext = {
      notify(text, type) { notifications.push({ text, type }); },
      async confirm() { throw new Error("projection commands must not ask for authorization"); },
      setEditorText() { throw new Error("projection commands must not edit the command line"); },
    };
    const commandContextActions = {
      waitForIdle: () => x.runner.runtime.session.waitForIdle(),
      newSession: (options) => x.runner.runtime.newSession(options),
      fork: (entryId, options) => x.runner.runtime.fork(entryId, options),
      navigateTree: (targetId, options) => x.runner.runtime.session.navigateTree(targetId, options),
      switchSession: (path, options) => x.runner.runtime.switchSession(path, options),
      reload: async () => {},
    };
    await x.runner.runtime.session.bindExtensions({ mode: "print", uiContext, commandContextActions });
    const planBefore = readFileSync(join(x.root, "TASK_PLAN.md"));
    const countersBefore = storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT total_changes() AS changes, (SELECT COUNT(*) FROM journal) AS journal, (SELECT COUNT(*) FROM handoffs) AS handoffs").get();
    const latchBefore = x.runner.storage.getLatch("TASK-E2E");

    for (const command of ["/aio status", "/aio why", "/aio next", "/aio plan", "/aio status technical", "/aio plan technical"]) await x.runner.runtime.session.prompt(command);

    assert.equal(notifications.length, 6);
    assert.match(notifications[0].text, /^Aiopago — /);
    assert.match(notifications[0].text, /Pi real runtime handoff/);
    assert.match(notifications[1].text, /^Perché/);
    assert.match(notifications[2].text, /^Prossima azione:/);
    assert.match(notifications[3].text, /^Piano autorevole: E2E/);
    assert.match(notifications[4].text, /^Aiopago status — technical/);
    assert.match(notifications[4].text, /TASK-E2E.*PLAN-E2E-1|Task: TASK-E2E revision=PLAN-E2E-1/);
    assert.match(notifications[5].text, /^Aiopago plan — technical/);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
    assert.deepEqual(readFileSync(join(x.root, "TASK_PLAN.md")), planBefore);
    assert.deepEqual(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT total_changes() AS changes, (SELECT COUNT(*) FROM journal) AS journal, (SELECT COUNT(*) FROM handoffs) AS handoffs").get(), countersBefore);
    assert.deepEqual(x.runner.storage.getLatch("TASK-E2E"), latchBefore);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("Pi SDK Runner boundary: plan movement while guided confirmation is open rejects stale YES before handoff", async () => {
  const x = await makeRunner();
  try {
    const handlers = new Map();
    createGuardianExtension(x.runner)({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
    x.runner.contextAdvisor.observe = () => ({ percent: 60, thresholdPercent: 50 });
    let resolveConfirmation;
    const confirmation = new Promise((resolve) => { resolveConfirmation = resolve; });
    let trustedInvocations = 0;
    x.runner.handoffFromCommand = async () => { trustedInvocations += 1; };
    const notices = [];
    const ctx = {
      hasUI: true,
      getContextUsage: () => ({ percent: 60, tokens: 60, contextWindow: 100 }),
      ui: {
        confirm: async () => confirmation,
        notify(text, type) { notices.push({ text, type }); },
      },
    };
    const pending = handlers.get("turn_end")({}, ctx);
    writeFixtureLedger(x.root, true);
    resolveConfirmation(true);
    await pending;
    assert.equal(trustedInvocations, 0);
    assert.match(notices.at(-1).text, /stato è cambiato.*handoff non è stato avviato/i);
    assert.equal(x.runner.storage.latestHandoffForTask("TASK-E2E"), null);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("Pi SDK lifecycle: registered session_shutdown during SafePoint invalidates trusted source before reservation", async () => {
  const x = await makeRunner();
  try {
    const source = x.runner.runtime.session;
    const plan = x.runner.ledger.read();
    const expectedEligibility = guidedHandoffEligibilityIdentityFromAuthority({
      plan,
      sessionId: source.sessionId,
      runnerInstanceId: x.runner.runnerInstanceId,
      latch: x.runner.storage.getLatch(plan.task_id),
      handoff: null,
    });
    let releaseIdle;
    let waitStarted;
    const waiting = new Promise((resolve) => { waitStarted = resolve; });
    const release = new Promise((resolve) => { releaseIdle = resolve; });
    source.waitForIdle = async () => { waitStarted(); await release; };
    let replacements = 0;
    const ctx = {
      async newSession() { replacements += 1; throw new Error("replacement must not start"); },
      ui: { async confirm() { return false; }, notify() {}, setEditorText() {} },
    };
    const pending = x.runner.handoffFromCommand(ctx, "confirm", { intent: "guided-advisor", expectedEligibility });
    await waiting;
    await source.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    releaseIdle();
    await assert.rejects(() => pending, (error) => error.code === "HANDOFF_SOURCE_CHANGED");
    assert.equal(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
    assert.equal(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT COUNT(*) AS count FROM artifacts").get().count, 0);
    assert.equal(replacements, 0);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("M-06 Pi recovery revalidates the actual registered source lifecycle before durable preparation", async (t) => {
  for (const waitKind of ["waitForIdle", "waitForNoStreams", "lifecycle ABA"]) {
    await t.test(waitKind, async () => {
      const x = await makeContinuityRecoveryFixture();
      try {
        const source = x.runner.runtime.session;
        const lifecycleBefore = x.runner.sessionLifecycle;
        const durableBefore = recoveryDurableSnapshot(x.runner, x.failed.handoff_id);
        const latchBefore = x.runner.storage.getLatch(x.failed.task_id);
        const prepareCalls = instrumentRecoveryPreparation(x.runner);
        let replacementAttempts = 0;
        const ctx = {
          async newSession() { replacementAttempts += 1; throw new Error("replacement must not start"); },
          ui: { async confirm() { return false; }, notify() {}, setEditorText() {} },
        };
        let release;
        let entered;
        const waiting = new Promise((resolve) => { entered = resolve; });
        const blocked = new Promise((resolve) => { release = resolve; });
        if (waitKind === "waitForNoStreams") {
          x.runner.gate.activeStreams = 1;
          const waitForNoStreams = x.runner.gate.waitForNoStreams.bind(x.runner.gate);
          x.runner.gate.waitForNoStreams = (...args) => {
            entered();
            return waitForNoStreams(...args);
          };
        } else {
          source.waitForIdle = async () => { entered(); await blocked; };
        }

        const pending = x.runner.recoverHandoffFromCommand(ctx, x.failed.handoff_id);
        await waiting;
        await source.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        assert.equal(x.runner.sessionLifecycle.active, false);
        assert.ok(x.runner.sessionLifecycle.epoch > lifecycleBefore.epoch);
        if (waitKind === "lifecycle ABA") {
          await source.extensionRunner.emit({ type: "session_start", reason: "reload" });
          assert.equal(x.runner.sessionLifecycle.active, true);
          assert.ok(x.runner.sessionLifecycle.epoch > lifecycleBefore.epoch);
        }
        if (waitKind === "waitForNoStreams") x.runner.gate.streamDone();
        else release();

        await assert.rejects(() => pending, (error) => error.code === "HANDOFF_SOURCE_CHANGED");
        assert.deepEqual(recoveryDurableSnapshot(x.runner, x.failed.handoff_id), durableBefore);
        assert.equal(x.runner.storage.getRunnerSessionBinding(x.failed.handoff_id).status, "ACTIVE");
        assert.equal(prepareCalls(), 0);
        assert.equal(replacementAttempts, 0);
        assert.equal(x.calls, 0);
        assert.equal(x.networkAttempts, 0);
        assert.deepEqual(x.runner.storage.getLatch(x.failed.task_id), latchBefore, "the existing recovery latch remains engaged and unchanged");

        if (waitKind === "lifecycle ABA") {
          const recovered = await x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false });
          assert.equal(recovered.state, "RESUME_READY");
          assert.equal(recovered.recovery_of_handoff_id, x.failed.handoff_id);
          assert.equal(prepareCalls(), 1, "a fresh lifecycle capture remains retryable after the rejected stale attempt");
          const durableAfterRetry = recoveryDurableSnapshot(x.runner, x.failed.handoff_id);
          assert.equal(durableAfterRetry.handoffs, durableBefore.handoffs + 1);
          assert.equal(durableAfterRetry.recoveryStarted, durableBefore.recoveryStarted + 1);
          assert.equal(durableAfterRetry.bindingSuperseded, durableBefore.bindingSuperseded + 1);
          assert.equal(durableAfterRetry.bindingStatus, "SUPERSEDED");
          assert.equal(x.calls, 0);
          assert.equal(x.networkAttempts, 0);
        }
      } finally { await x.runner.dispose(); x.restoreFetch(); }
    });
  }

  await t.test("authoritative unrelated shutdown does not invalidate S1 and normal recovery prepares once", async () => {
    const x = await makeContinuityRecoveryFixture();
    try {
      const handlers = new Map();
      createGuardianExtension(x.runner)({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
      const source = x.runner.runtime.session;
      const lifecycleBefore = x.runner.sessionLifecycle;
      const durableBefore = recoveryDurableSnapshot(x.runner, x.failed.handoff_id);
      const prepareCalls = instrumentRecoveryPreparation(x.runner);
      handlers.get("session_shutdown")(
        { type: "session_shutdown", reason: "quit" },
        { sessionManager: { getSessionId: () => "SESSION-UNRELATED" } },
      );
      assert.equal(x.runner.runtime.session, source);
      assert.deepEqual(x.runner.sessionLifecycle, lifecycleBefore);
      const recovered = await x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false });
      assert.equal(recovered.state, "RESUME_READY");
      assert.equal(prepareCalls(), 1);
      const durableAfter = recoveryDurableSnapshot(x.runner, x.failed.handoff_id);
      assert.equal(durableAfter.handoffs, durableBefore.handoffs + 1);
      assert.equal(durableAfter.recoveryStarted, durableBefore.recoveryStarted + 1);
      assert.equal(durableAfter.bindingSuperseded, durableBefore.bindingSuperseded + 1);
      assert.equal(durableAfter.bindingStatus, "SUPERSEDED");
      assert.equal(x.calls, 0);
      assert.equal(x.networkAttempts, 0);
    } finally { await x.runner.dispose(); x.restoreFetch(); }
  });
});

test("M-07 actual Pi recovery re-attests every mutable SafePoint precondition before atomic preparation/reservation", async (t) => {
  async function runAttack(name, { options = {}, mutate, restore, errorCodes, restartForRetry = false, waitKind = "idle" }) {
    await t.test(name, async () => {
      let x = await makeContinuityRecoveryFixture(options);
      try {
        const source = x.runner.runtime.session;
        const durableBefore = recoveryAttackSnapshot(x.runner, x.failed.handoff_id);
        const latchBefore = x.runner.storage.getLatch(x.failed.task_id);
        const prepareCalls = instrumentRecoveryPreparation(x.runner);
        const waitForIdle = source.waitForIdle.bind(source);
        const waitForNoStreams = x.runner.gate.waitForNoStreams.bind(x.runner.gate);
        const newSession = x.runner.runtime.newSession.bind(x.runner.runtime);
        let replacementAttempts = 0;
        x.runner.runtime.newSession = (...args) => { replacementAttempts += 1; return newSession(...args); };
        if (waitKind === "streams") {
          x.runner.gate.activeStreams = 1;
          x.runner.gate.waitForNoStreams = async (...args) => {
            await mutate(x, source);
            x.runner.gate.streamDone();
            return waitForNoStreams(...args);
          };
        } else {
          source.waitForIdle = async () => { await waitForIdle(); await mutate(x, source); };
        }
        await assert.rejects(
          () => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }),
          (error) => errorCodes.includes(error.code),
        );
        source.waitForIdle = waitForIdle;
        x.runner.gate.waitForNoStreams = waitForNoStreams;
        x.runner.runtime.newSession = newSession;
        assert.deepEqual(recoveryAttackSnapshot(x.runner, x.failed.handoff_id), durableBefore);
        assert.equal(x.runner.storage.getRunnerSessionBinding(x.failed.handoff_id).status, "ACTIVE");
        assert.equal(prepareCalls(), 0);
        assert.equal(replacementAttempts, 0);
        assert.equal(x.calls, 0);
        assert.equal(x.networkAttempts, 0);
        assert.deepEqual(x.runner.storage.getLatch(x.failed.task_id), latchBefore);
        await restore(x, source);

        if (restartForRetry) {
          const root = x.root;
          const failed = x.failed;
          await x.runner.dispose(); x.restoreFetch();
          x = await makeRunner({ ...options, existingRoot: root });
          x.failed = failed;
        }
        const recovered = await x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false });
        assert.equal(recovered.state, "RESUME_READY");
        assert.equal(recovered.recovery_of_handoff_id, x.failed.handoff_id);
        assert.equal(x.runner.storage.getRunnerSessionBinding(x.failed.handoff_id).status, "SUPERSEDED");
        assert.equal(x.networkAttempts, 0);
      } finally {
        if (x?.runner) await x.runner.dispose();
        x?.restoreFetch();
      }
    });
  }

  await runAttack("real PlanPort P1 to P2 drift wins before final coordination", {
    mutate: async (x) => {
      x.planBytes = readFileSync(join(x.root, "TASK_PLAN.md"));
      x.planWriter = prepareRecoveryPlanChange(x.root, "PLAN-DRIFT");
      x.planWriter.apply();
    },
    restore: async (x) => { writeFileSync(join(x.root, "TASK_PLAN.md"), x.planBytes); },
    errorCodes: ["PLAN_REVISION_MISMATCH"],
  });

  await runAttack("real PlanPort P1 to P2 drift during waitForNoStreams", {
    waitKind: "streams",
    mutate: async (x) => {
      x.planBytes = readFileSync(join(x.root, "TASK_PLAN.md"));
      x.planWriter = prepareRecoveryPlanChange(x.root, "PLAN-STREAM-DRIFT");
      x.planWriter.apply();
    },
    restore: async (x) => { writeFileSync(join(x.root, "TASK_PLAN.md"), x.planBytes); },
    errorCodes: ["PLAN_REVISION_MISMATCH"],
  });

  await runAttack("real Git G1 to G2 drift", {
    mutate: async (x) => { x.driftPath = join(x.root, "drift.txt"); writeFileSync(x.driftPath, "M-07 drift\n"); },
    restore: async (x) => { unlinkSync(x.driftPath); },
    errorCodes: ["GIT_STATE_MISMATCH"],
  });

  await runAttack("actual AgentSession.setModel model drift", {
    mutate: async (x, source) => {
      x.originalModel = source.model;
      await source.setModel({ ...source.model, id: "offline-fake-m07" });
    },
    restore: async (x, source) => { await source.setModel(x.originalModel); },
    errorCodes: ["MODEL_POLICY_MISMATCH"],
  });

  await runAttack("actual AgentSession.setThinkingLevel reasoning drift", {
    options: { modelReasoning: true, reasoningPolicy: "low" },
    mutate: async (_x, source) => { source.setThinkingLevel("high"); },
    restore: async (_x, source) => { source.setThinkingLevel("low"); },
    errorCodes: ["REASONING_POLICY_MISMATCH"],
  });

  await runAttack("actual SessionManager.appendMessage history drift", {
    mutate: async (_x, source) => {
      source.sessionManager.appendMessage({ role: "user", content: "M-07 history drift", timestamp: Date.now() });
    },
    restore: async () => {},
    errorCodes: ["CONTINUITY_RECOVERY_SOURCE_INVALID"],
    restartForRetry: true,
  });

  for (const kind of ["checkpoint", "manifest"]) {
    await runAttack(`real sealed ${kind} tamper`, {
      mutate: async (x) => {
        const id = kind === "checkpoint" ? x.failed.checkpoint_id : x.failed.resume_manifest_id;
        const index = x.runner.storage.getArtifact(kind, id);
        x.artifactPath = index.path;
        x.artifactBytes = readFileSync(index.path);
        writeFileSync(index.path, Buffer.concat([x.artifactBytes, Buffer.from(" ")]));
      },
      restore: async (x) => { writeFileSync(x.artifactPath, x.artifactBytes); },
      errorCodes: [kind === "checkpoint" ? "CHECKPOINT_MISMATCH" : "MANIFEST_MISMATCH"],
    });
  }

  await t.test("preparation and recovery-child reservation roll back as one SQLite arbitration", async () => {
    const x = await makeContinuityRecoveryFixture();
    try {
      const before = recoveryAttackSnapshot(x.runner, x.failed.handoff_id);
      const append = x.runner.storage.appendEvent.bind(x.runner.storage);
      let replacementAttempts = 0;
      const newSession = x.runner.runtime.newSession.bind(x.runner.runtime);
      x.runner.runtime.newSession = (...args) => { replacementAttempts += 1; return newSession(...args); };
      x.runner.storage.appendEvent = (type, ...args) => {
        if (type === "HANDOFF_STARTED") throw new Error("forced recovery child journal failure");
        return append(type, ...args);
      };
      await assert.rejects(() => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }), /forced recovery child journal failure/);
      assert.deepEqual(recoveryAttackSnapshot(x.runner, x.failed.handoff_id), before);
      assert.equal(x.runner.storage.getRunnerSessionBinding(x.failed.handoff_id).status, "ACTIVE");
      assert.equal(replacementAttempts, 0);
      assert.equal(x.calls, 0);
      assert.equal(x.networkAttempts, 0);
    } finally { await x.runner.dispose(); x.restoreFetch(); }
  });

  for (const race of ["failed handoff state", "failed binding", "durable authorization evidence"]) {
    await t.test(`${race} movement during SafePoint fails without a recovery child`, async () => {
      const x = await makeContinuityRecoveryFixture();
      try {
        const source = x.runner.runtime.session;
        const initialChildren = recoveryAttackSnapshot(x.runner, x.failed.handoff_id).recoveryChildren;
        let replacementAttempts = 0;
        const newSession = x.runner.runtime.newSession.bind(x.runner.runtime);
        x.runner.runtime.newSession = (...args) => { replacementAttempts += 1; return newSession(...args); };
        const waitForIdle = source.waitForIdle.bind(source);
        source.waitForIdle = async () => {
          await waitForIdle();
          if (race === "failed handoff state") {
            const failed = x.runner.storage.getHandoff(x.failed.handoff_id);
            failed.state = "HANDOFF_FAILED";
            saveHandoffForInternalTest(x.runner.storage, failed);
          } else if (race === "failed binding") {
            supersedeRunnerSessionBindingForInternalTest(x.runner.storage, x.failed.handoff_id, "authorized concurrent reconciliation test");
          } else {
            storageDatabaseForInternalTest(x.runner.storage).prepare("INSERT INTO authorizations(resume_prompt_id,handoff_id,actor,latch_generation,authorized_at) VALUES(?,?,?,?,?)")
              .run(x.failed.resume_prompt_id, x.failed.handoff_id, "human:concurrent", x.failed.latch_generation, "2026-08-22T23:59:59.000Z");
          }
        };
        await assert.rejects(
          () => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }),
          (error) => ["CONTINUITY_RECOVERY_NOT_ALLOWED", "CONTINUITY_RECOVERY_SOURCE_INVALID", "CONTINUITY_RECOVERY_UNSAFE"].includes(error.code),
        );
        assert.equal(recoveryAttackSnapshot(x.runner, x.failed.handoff_id).recoveryChildren, initialChildren);
        assert.equal(x.runner.storage.events(x.failed.handoff_id).some((event) => event.event_type === "CONTINUITY_RECOVERY_STARTED"), false);
        assert.equal(replacementAttempts, 0);
        assert.equal(x.calls, 0);
        assert.equal(x.networkAttempts, 0);
      } finally { await x.runner.dispose(); x.restoreFetch(); }
    });
  }
});

test("M-08 reviewer exact valid-envelope manifest semantic conflict rejects before recovery arbitration", async () => {
  const x = await makeContinuityRecoveryFixture();
  try {
    const attack = installFailedManifestMutation(x.runner, x.failed.handoff_id, (manifest) => {
      manifest.objective = "Reviewer-conflicting objective X";
      manifest.relevant_decisions = ["Reviewer-conflicting decision X"];
      manifest.minimal_reads = ["Reviewer-conflicting minimal read X"];
    });
    const failed = x.runner.storage.getHandoff(x.failed.handoff_id);
    const verified = x.runner.artifacts.verify("manifest", failed.resume_manifest_id, failed.resume_manifest_digest);
    assert.equal(verified.digest, attack.sealed.digest, "the cryptographically recomputed artifact envelope must verify");
    const before = recoveryAttackSnapshot(x.runner, failed.handoff_id);
    const activeBefore = storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT source_session_id,handoff_id FROM active_sources ORDER BY source_session_id").all();
    const prepareCalls = instrumentRecoveryPreparation(x.runner);
    let replacementAttempts = 0;
    const newSession = x.runner.runtime.newSession.bind(x.runner.runtime);
    x.runner.runtime.newSession = (...args) => { replacementAttempts += 1; return newSession(...args); };

    await assert.rejects(
      () => x.runner.recoverHandoffDirect(failed.handoff_id, { confirm: false }),
      (error) => error.code === "MANIFEST_MISMATCH",
    );

    assert.deepEqual(recoveryAttackSnapshot(x.runner, failed.handoff_id), before);
    assert.deepEqual(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT source_session_id,handoff_id FROM active_sources ORDER BY source_session_id").all(), activeBefore);
    assert.equal(x.runner.storage.getRunnerSessionBinding(failed.handoff_id).status, "ACTIVE");
    assert.equal(prepareCalls(), 0);
    assert.equal(replacementAttempts, 0);
    assert.equal(x.runner.storage.events(failed.handoff_id).some((event) => ["CONTINUITY_RECOVERY_STARTED", "RUNNER_SESSION_BINDING_SUPERSEDED"].includes(event.event_type)), false);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("M-08 cryptographically valid manifest field matrix binds plan, Git, session, parent, and model semantics", async (t) => {
  const x = await makeContinuityRecoveryFixture();
  const mutations = [
    ["task_id", (m) => { m.task_id = "TASK-CONFLICT"; }],
    ["objective", (m) => { m.objective = "conflicting objective"; }],
    ["current_item", (m) => { m.current_item = null; }],
    ["next_item", (m) => { m.next_item = "ITEM-CONFLICT"; }],
    ["next_step", (m) => { m.next_step = "conflicting next step"; }],
    ["task_plan_revision", (m) => { m.task_plan_revision = "PLAN-CONFLICT"; }],
    ["task_plan_digest", (m) => { m.task_plan_digest = `sha256:${"9".repeat(64)}`; }],
    ["requirements_version", (m) => { m.requirements_version = "REQ-CONFLICT"; }],
    ["relevant_decisions", (m) => { m.relevant_decisions = ["conflicting decision"]; }],
    ["relevant_tests", (m) => { m.relevant_tests = ["conflicting test"]; }],
    ["evidence_references", (m) => { m.evidence_references = ["conflicting evidence"]; }],
    ["minimal_reads", (m) => { m.minimal_reads = ["conflicting read"]; }],
    ["required_local_paths", (m) => { m.required_local_paths = ["TASK_PLAN.md", "docs/adr.md"]; }],
    ["model_policy", (m) => { m.model_policy = "offline-fake/conflicting"; }],
    ["reasoning_policy", (m) => { m.reasoning_policy = "high"; }],
    ["repository", (m) => { m.repository = "conflicting-repository"; }],
    ["branch", (m) => { m.branch = "conflicting-branch"; }],
    ["worktree", (m) => { m.worktree = "/conflicting/worktree"; }],
    ["base_sha", (m) => { m.base_sha = "b".repeat(40); }],
    ["head_sha", (m) => { m.head_sha = "c".repeat(40); }],
    ["index_digest", (m) => { m.index_digest = `sha256:${"d".repeat(64)}`; }],
    ["worktree_digest", (m) => { m.worktree_digest = `sha256:${"e".repeat(64)}`; }],
    ["git_status_summary", (m) => { m.git_status_summary = ["?? semantic-conflict.txt"]; }],
    ["session_lineage", (m) => { m.session_lineage = [m.replacement_session_id, m.source_session_id]; }],
    ["parent_checkpoint_id", (m) => { m.parent_checkpoint_id = "CP-CONFLICT"; }],
    ["parent_session_id", (m) => { m.parent_session_id = "SESSION-CONFLICT"; }],
    ["source_session_id", (m) => { m.source_session_id = "SESSION-CONFLICT"; }],
    ["replacement_session_id", (m) => { m.replacement_session_id = "SESSION-CONFLICT"; }],
    ["runner_instance_id", (m) => { m.runner_instance_id = "RUNNER-CONFLICT"; }],
    ["session_binding_id", (m) => { m.session_binding_id = "BIND-CONFLICT"; }],
    ["checkpoint_id", (m) => { m.checkpoint_id = "CP-CONFLICT"; }],
    ["checkpoint_digest", (m) => { m.checkpoint_digest = `sha256:${"f".repeat(64)}`; }],
    ["handoff_id", (m) => { m.handoff_id = "HO-CONFLICT"; }],
    ["resume_manifest_id", (m) => { m.resume_manifest_id = "RM-CONFLICT"; }],
    ["resume_prompt_id", (m) => { m.resume_prompt_id = "RP-CONFLICT"; }],
    ["missing objective", (m) => { delete m.objective; }],
  ];
  try {
    let replacementAttempts = 0;
    const newSession = x.runner.runtime.newSession.bind(x.runner.runtime);
    x.runner.runtime.newSession = (...args) => { replacementAttempts += 1; return newSession(...args); };
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const attack = installFailedManifestMutation(x.runner, x.failed.handoff_id, mutate);
        try {
          const failed = x.runner.storage.getHandoff(x.failed.handoff_id);
          assert.equal(x.runner.artifacts.verify("manifest", failed.resume_manifest_id, failed.resume_manifest_digest).digest, attack.sealed.digest);
          const before = recoveryAttackSnapshot(x.runner, failed.handoff_id);
          await assert.rejects(
            () => x.runner.recoverHandoffDirect(failed.handoff_id, { confirm: false }),
            (error) => error.code === "MANIFEST_MISMATCH",
          );
          assert.deepEqual(recoveryAttackSnapshot(x.runner, failed.handoff_id), before);
          assert.equal(x.runner.storage.getRunnerSessionBinding(failed.handoff_id).status, "ACTIVE");
        } finally { attack.restore(); }
      });
    }
    assert.equal(replacementAttempts, 0);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("M-08 failed reserved snapshot semantic matrix rejects top-level P1 claims with conflicting P1 content", async (t) => {
  const x = await makeContinuityRecoveryFixture();
  const mutations = [
    ["reviewer exact objective/decisions/minimal reads", (p) => {
      p.objective = "reviewer conflicting objective";
      p.relevant_decisions = ["reviewer conflicting decision"];
      p.minimal_reads = ["reviewer conflicting read"];
    }],
    ["task_id", (p) => { p.task_id = "TASK-CONFLICT"; }],
    ["objective", (p) => { p.objective = "conflicting objective"; }],
    ["current_item", (p) => { p.current_item = null; }],
    ["next_item", (p) => { p.next_item = "ITEM-CONFLICT"; }],
    ["next_step", (p) => { p.next_step = "conflicting next step"; }],
    ["plan_revision_id", (p) => { p.plan_revision_id = "PLAN-CONFLICT"; }],
    ["content_digest", (p) => { p.content_digest = `sha256:${"8".repeat(64)}`; }],
    ["requirements_version", (p) => { p.requirements_version = "REQ-CONFLICT"; }],
    ["completion_criteria", (p) => { p.completion_criteria = ["conflicting criterion"]; }],
    ["relevant_decisions", (p) => { p.relevant_decisions = ["conflicting decision"]; }],
    ["relevant_tests", (p) => { p.relevant_tests = ["conflicting test"]; }],
    ["evidence_references", (p) => { p.evidence_references = ["conflicting evidence"]; }],
    ["minimal_reads", (p) => { p.minimal_reads = ["conflicting read"]; }],
    ["required_local_paths", (p) => { p.required_local_paths = ["TASK_PLAN.md", "docs/adr.md"]; }],
    ["model_policy", (p) => { p.model_policy = "offline-fake/conflicting"; }],
    ["reasoning_policy", (p) => { p.reasoning_policy = "high"; }],
    ["missing objective", (p) => { delete p.objective; }],
  ];
  try {
    const baseline = x.runner.storage.getHandoff(x.failed.handoff_id);
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const changed = x.runner.storage.getHandoff(x.failed.handoff_id);
        mutate(changed.reserved_plan_snapshot);
        saveHandoffForInternalTest(x.runner.storage, changed);
        const before = recoveryAttackSnapshot(x.runner, changed.handoff_id);
        await assert.rejects(
          () => x.runner.recoverHandoffDirect(changed.handoff_id, { confirm: false }),
          (error) => error.code === "HANDOFF_PLAN_PROVENANCE_MISMATCH",
        );
        assert.deepEqual(recoveryAttackSnapshot(x.runner, changed.handoff_id), before);
        assert.equal(x.runner.storage.getRunnerSessionBinding(changed.handoff_id).status, "ACTIVE");
        saveHandoffForInternalTest(x.runner.storage, structuredClone(baseline));
      });
    }
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("M-08 sealed checkpoint semantic matrix rejects conflicting duplicated plan, Git, and lineage fields", async (t) => {
  const x = await makeContinuityRecoveryFixture();
  const mutations = [
    ["checkpoint_id", (c) => { c.checkpoint_id = "CP-CONFLICT"; }],
    ["task_id", (c) => { c.task_id = "TASK-CONFLICT"; }],
    ["plan_revision_id", (c) => { c.plan_revision_id = "PLAN-CONFLICT"; }],
    ["requirements_version", (c) => { c.requirements_version = "REQ-CONFLICT"; }],
    ["completion_criteria", (c) => { c.completion_criteria = [{ criterion: "conflicting criterion", status: "IN_PROGRESS" }]; }],
    ["tests", (c) => { c.tests = ["conflicting test"]; }],
    ["decisions", (c) => { c.decisions = ["conflicting decision"]; }],
    ["next_step", (c) => { c.next_step = "conflicting next step"; }],
    ["task_item_ids", (c) => { c.task_item_ids = ["ITEM-CONFLICT"]; }],
    ["session_lineage", (c) => { c.session_lineage = ["SESSION-CONFLICT"]; }],
    ["parent_checkpoint_id", (c) => { c.parent_checkpoint_id = "CP-CONFLICT"; }],
    ["plan_content_digest", (c) => { c.plan_content_digest = `sha256:${"a".repeat(64)}`; }],
    ["git_state", (c) => { c.git_state.head_sha = "b".repeat(40); }],
    ["missing tests", (c) => { delete c.tests; }],
  ];
  try {
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const attack = installFailedCheckpointMutation(x.runner, x.failed.handoff_id, mutate);
        try {
          const failed = x.runner.storage.getHandoff(x.failed.handoff_id);
          assert.equal(x.runner.artifacts.verify("checkpoint", failed.checkpoint_id, failed.checkpoint_digest).digest, attack.checkpoint.digest);
          assert.equal(x.runner.artifacts.verify("manifest", failed.resume_manifest_id, failed.resume_manifest_digest).digest, attack.manifest.digest);
          const before = recoveryAttackSnapshot(x.runner, failed.handoff_id);
          await assert.rejects(
            () => x.runner.recoverHandoffDirect(failed.handoff_id, { confirm: false }),
            (error) => error.code === "CHECKPOINT_MISMATCH",
          );
          assert.deepEqual(recoveryAttackSnapshot(x.runner, failed.handoff_id), before);
          assert.equal(x.runner.storage.getRunnerSessionBinding(failed.handoff_id).status, "ACTIVE");
        } finally { attack.restore(); }
      });
    }
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("M-08 storage transaction revalidates reserved snapshot semantics after valid R-star capture", async () => {
  const x = await makeContinuityRecoveryFixture();
  try {
    const before = recoveryAttackSnapshot(x.runner, x.failed.handoff_id);
    const original = x.runner.storage.getHandoff(x.failed.handoff_id);
    const prepare = x.runner.storage.prepareContinuityRecovery.bind(x.runner.storage);
    let movementInstalled = false;
    x.runner.storage.prepareContinuityRecovery = (...args) => {
      const moved = x.runner.storage.getHandoff(x.failed.handoff_id);
      moved.reserved_plan_snapshot.objective = "semantic movement after R-star";
      saveHandoffForInternalTest(x.runner.storage, moved);
      movementInstalled = true;
      return prepare(...args);
    };
    await assert.rejects(
      () => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }),
      (error) => error.code === "CONTINUITY_RECOVERY_SOURCE_INVALID",
    );
    assert.equal(movementInstalled, true, "the deterministic seam is reached only after a valid final R-star capture");
    assert.deepEqual(recoveryAttackSnapshot(x.runner, x.failed.handoff_id), before);
    assert.equal(x.runner.storage.getRunnerSessionBinding(x.failed.handoff_id).status, "ACTIVE");
    assert.equal(x.runner.storage.events(x.failed.handoff_id).some((event) => ["CONTINUITY_RECOVERY_STARTED", "RUNNER_SESSION_BINDING_SUPERSEDED"].includes(event.event_type)), false);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
    saveHandoffForInternalTest(x.runner.storage, original);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("M-08 canonical required-path equivalence is accepted and child snapshot remains canonical P1", async () => {
  const x = await makeContinuityRecoveryFixture();
  try {
    const failed = x.runner.storage.getHandoff(x.failed.handoff_id);
    failed.reserved_plan_snapshot.required_local_paths = ["TASK_PLAN.md", "TASK_PLAN.md"];
    saveHandoffForInternalTest(x.runner.storage, failed);
    const recovered = await x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false });
    assert.equal(recovered.state, "RESUME_READY");
    assert.deepEqual(recovered.reserved_plan_snapshot.required_local_paths, ["TASK_PLAN.md"]);
    assert.equal(recovered.reserved_plan_snapshot.objective, x.runner.ledger.read().objective);
    const children = recoveryAttackSnapshot(x.runner, x.failed.handoff_id).recoveryChildren;
    await assert.rejects(
      () => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }),
      (error) => error.code === "CONTINUITY_RECOVERY_SOURCE_INVALID",
    );
    assert.equal(recoveryAttackSnapshot(x.runner, x.failed.handoff_id).recoveryChildren, children, "double recovery creates at most one child");
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("M-07 recovery-first final coordination reserves immutable R-star provenance before later P2/G2/M2", async () => {
  const x = await makeContinuityRecoveryFixture();
  try {
    const p1 = x.runner.ledger.read();
    const g1 = observeGitState(x.root);
    const m1 = `${x.runner.runtime.session.model.provider}/${x.runner.runtime.session.model.id}`;
    const writer = prepareRecoveryPlanChange(x.root, "AFTER-R-STAR");
    const source = x.runner.runtime.session;
    const prepare = x.runner.storage.prepareContinuityRecovery.bind(x.runner.storage);
    let writerWhileRecoveryHeldCode = null;
    x.runner.storage.prepareContinuityRecovery = (...args) => {
      try { writer.apply(); } catch (error) { writerWhileRecoveryHeldCode = error.code; }
      return prepare(...args);
    };
    x.runner.handoffService.testHooks = {
      async afterReservation({ handoff }) {
        x.reservedChild = structuredClone(handoff);
        writer.apply();
        writeFileSync(join(x.root, "post-attestation-drift.txt"), "G2\n");
        await source.setModel({ ...source.model, id: "offline-fake-after-r-star" });
      },
    };
    await assert.rejects(
      () => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }),
      (error) => ["PLAN_REVISION_MISMATCH", "GIT_STATE_MISMATCH"].includes(error.code),
    );
    const child = x.runner.storage.getHandoff(x.reservedChild.handoff_id);
    assert.equal(writerWhileRecoveryHeldCode, "PLAN_WRITE_LOCKED", "the compliant P2 writer cannot interleave while recovery holds final plan coordination");
    assert.equal(child.task_plan_revision, p1.plan_revision_id);
    assert.equal(child.task_plan_digest, p1.content_digest);
    assert.equal(child.current_item, p1.current_item);
    assert.equal(child.next_item, p1.next_item);
    assert.equal(child.next_step, p1.next_step);
    assert.equal(child.model_policy, m1);
    assert.equal(child.reasoning_policy, "off");
    assert.equal(child.recovery_of_handoff_id, x.failed.handoff_id);
    assert.equal(child.expected_git_state.index_digest, g1.index_digest);
    assert.equal(child.expected_git_state.worktree_digest, g1.worktree_digest);
    assert.notEqual(x.runner.ledger.read().plan_revision_id, child.task_plan_revision);
    assert.equal(child.expected_git_state.status_entries.includes("?? post-attestation-drift.txt"), false);
    assert.equal(x.runner.storage.events(x.failed.handoff_id).filter((event) => event.event_type === "CONTINUITY_RECOVERY_STARTED").length, 1);
    assert.equal(x.runner.storage.events(child.handoff_id).filter((event) => event.event_type === "HANDOFF_STARTED").length, 1);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

function resumeDurableCounts(runner, handoffId) {
  return {
    authorizations: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM authorizations WHERE handoff_id=?").get(handoffId).count,
    admissions: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM admissions WHERE handoff_id=?").get(handoffId).count,
    dispatches: storageDatabaseForInternalTest(runner.storage).prepare("SELECT COUNT(*) AS count FROM dispatch_attempts WHERE handoff_id=?").get(handoffId).count,
  };
}

test("R2-H-01 actual Runner resume YES rejects combined P2, G2, and SUPERSEDED binding drift", async () => {
  const x = await makeRunner();
  try {
    const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    const before = resumeDurableCounts(x.runner, ready.handoff_id);
    const latchBefore = x.runner.storage.getLatch(ready.task_id);
    let confirms = 0;
    const ctx = {
      ui: {
        async confirm() {
          confirms += 1;
          prepareRecoveryPlanChange(x.root, "R2-COMBINED").apply();
          writeFileSync(join(x.root, "r2-git-drift.txt"), "G2\n");
          supersedeRunnerSessionBindingForInternalTest(x.runner.storage, ready.handoff_id, "R2 combined prompt drift");
          return true;
        },
        notify() {},
      },
    };
    await assert.rejects(
      () => x.runner.resumeFromCommand(ctx, ready.handoff_id),
      (error) => ["RESUME_EXPECTATION_STALE", "PLAN_CAS_CONFLICT"].includes(error.code),
    );
    assert.equal(confirms, 1);
    assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), before);
    assert.deepEqual(x.runner.storage.getLatch(ready.task_id), latchBefore);
    assert.equal(x.runner.storage.getHandoff(ready.handoff_id).state, "RESUME_READY");
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R2-H-01 stale resume authority matrix rejects before durable admission and send", async (t) => {
  const attacks = [
    ["plan", async (x) => { prepareRecoveryPlanChange(x.root, "R2-PLAN").apply(); }],
    ["Git", async (x) => { writeFileSync(join(x.root, "r2-git-only.txt"), "G2\n"); }],
    ["binding", async (x, ready) => { supersedeRunnerSessionBindingForInternalTest(x.runner.storage, ready.handoff_id, "R2 binding drift"); }],
    ["takeover", async (x, ready) => { claimTakeoverForInternalTest(x.runner.storage, ready.task_id, "human:r2"); }],
    ["ownership header", async (x) => {
      const target = x.runner.runtime.session;
      const binding = readRuntimeRunnerBinding(target);
      target.sessionManager.appendCustomEntry(RUNNER_BINDING_CUSTOM_TYPE, binding);
    }],
    ["history", async (x) => { x.runner.runtime.session.sessionManager.appendMessage({ role: "user", content: "R2 history", timestamp: Date.now() }); }],
    ["model", async (x) => { await x.runner.runtime.session.setModel({ ...x.runner.runtime.session.model, id: "offline-fake-r2" }); }],
    ["reasoning", async (x) => { x.runner.runtime.session.setThinkingLevel("high"); }],
    ["checkpoint identity", async (x, ready) => {
      const moved = x.runner.storage.getHandoff(ready.handoff_id);
      moved.checkpoint_digest = `sha256:${"d".repeat(64)}`;
      saveHandoffForInternalTest(x.runner.storage, moved);
    }],
    ["manifest identity", async (x, ready) => {
      const moved = x.runner.storage.getHandoff(ready.handoff_id);
      moved.resume_manifest_digest = `sha256:${"e".repeat(64)}`;
      saveHandoffForInternalTest(x.runner.storage, moved);
    }],
    ["resume prompt identity", async (x, ready) => {
      const moved = x.runner.storage.getHandoff(ready.handoff_id);
      moved.resume_prompt_digest = `sha256:${"f".repeat(64)}`;
      saveHandoffForInternalTest(x.runner.storage, moved);
    }],
  ];
  for (const [name, mutate] of attacks) {
    await t.test(name, async () => {
      const x = await makeRunner({ modelReasoning: name === "reasoning", reasoningPolicy: name === "reasoning" ? "low" : "off" });
      try {
        const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
        const before = resumeDurableCounts(x.runner, ready.handoff_id);
        const expectedResume = x.runner.handoffService.prepareResumeConfirmation(ready.handoff_id, x.runner.runtime.session);
        await mutate(x, ready);
        await assert.rejects(
          () => x.runner.handoffService.resume(ready.handoff_id, {
            actor: "human:r2-matrix",
            sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt),
            expectedResume,
            targetSession: x.runner.runtime.session,
          }),
        );
        assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), before);
        assert.equal(x.runner.storage.getHandoff(ready.handoff_id).state, "RESUME_READY");
        assert.equal(x.calls, 0);
        assert.equal(x.networkAttempts, 0);
      } finally { await x.runner.dispose(); x.restoreFetch(); }
    });
  }
});

test("R2-H-01 required local path disappearance after YES rejects with zero send", async () => {
  const x = await makeRunner({ requiredLocalPaths: [".guardian/required-r2.md"] });
  try {
    const required = join(x.root, ".guardian", "required-r2.md");
    writeFileSync(required, "required\n");
    const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    const expectedResume = x.runner.handoffService.prepareResumeConfirmation(ready.handoff_id, x.runner.runtime.session);
    unlinkSync(required);
    await assert.rejects(
      () => x.runner.handoffService.resume(ready.handoff_id, {
        actor: "human:r2-required-path",
        sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt),
        expectedResume,
        targetSession: x.runner.runtime.session,
      }),
      (error) => error.code === "REQUIRED_LOCAL_PATH_MISSING",
    );
    assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), { authorizations: 0, admissions: 0, dispatches: 0 });
    assert.equal(x.calls, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R2-H-01 current Runner target and Runner identity drift during UI confirmation reject", async (t) => {
  for (const drift of ["target", "runner"]) {
    await t.test(drift, async () => {
      const x = await makeRunner();
      const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
      const target = x.runner.runtime.session;
      const runnerId = x.runner.runnerInstanceId;
      try {
        await assert.rejects(() => x.runner.resumeFromCommand({
          ui: {
            async confirm() {
              if (drift === "target") await target.extensionRunner.emit({ type: "session_shutdown", reason: "R2 target lifecycle drift" });
              else x.runner.runnerInstanceId = "RUNNER-R2-OTHER";
              return true;
            },
            notify() {},
          },
        }, ready.handoff_id), (error) => ["RESUME_EXPECTATION_STALE", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "HANDOFF_SOURCE_CHANGED"].includes(error.code));
        assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), { authorizations: 0, admissions: 0, dispatches: 0 });
        assert.equal(x.calls, 0);
      } finally {
        x.runner.runnerInstanceId = runnerId;
        await x.runner.dispose(); x.restoreFetch();
      }
    });
  }
});

test("R2-H-01 direct resume and resumeExisting confirmation cannot bypass final attestation", async () => {
  const x = await makeRunner();
  try {
    const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    await assert.rejects(
      () => x.runner.handoffService.resume(ready.handoff_id, {
        actor: "human:direct-bypass",
        sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt),
      }),
      (error) => error.code === "RESUME_ATTESTATION_REQUIRED",
    );
    await assert.rejects(
      () => x.runner.handoffService.resumeExisting(ready, {
        mode: "confirm",
        actor: "human:existing",
        targetSession: x.runner.runtime.session,
        confirmResume: async () => {
          supersedeRunnerSessionBindingForInternalTest(x.runner.storage, ready.handoff_id, "R2 resumeExisting prompt drift");
          return true;
        },
        sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt),
      }),
    );
    assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), { authorizations: 0, admissions: 0, dispatches: 0 });
    assert.equal(x.calls, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R2-H-01 final SQLite binding race and post-release failure both roll back admission", async (t) => {
  await t.test("binding superseded after final external capture", async () => {
    const x = await makeRunner();
    const other = new GuardianStorage(x.runner.storage.path);
    try {
      const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
      const expectedResume = x.runner.handoffService.prepareResumeConfirmation(ready.handoff_id, x.runner.runtime.session);
      const transaction = x.runner.storage.transaction.bind(x.runner.storage);
      let intercepted = false;
      x.runner.storage.transaction = (operation) => {
        x.runner.storage.transaction = transaction;
        intercepted = true;
        supersedeRunnerSessionBindingForInternalTest(other, ready.handoff_id, "R2 final SQLite race");
        return transaction(operation);
      };
      await assert.rejects(
        () => x.runner.handoffService.resume(ready.handoff_id, {
          actor: "human:r2-binding-race",
          sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt),
          expectedResume,
          targetSession: x.runner.runtime.session,
        }),
        (error) => error.code === "RUNNER_OWNERSHIP_ATTESTATION_FAILED",
      );
      assert.equal(intercepted, true);
      assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), { authorizations: 0, admissions: 0, dispatches: 0 });
      assert.equal(x.runner.storage.getLatch(ready.task_id).state, "ENGAGED");
      assert.equal(x.calls, 0);
    } finally { other.close(); await x.runner.dispose(); x.restoreFetch(); }
  });

  await t.test("failure after latch release rolls the whole transaction back", async () => {
    const x = await makeRunner();
    try {
      const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
      const expectedResume = x.runner.handoffService.prepareResumeConfirmation(ready.handoff_id, x.runner.runtime.session);
      const append = x.runner.storage.appendEvent.bind(x.runner.storage);
      x.runner.storage.appendEvent = (type, ...args) => {
        if (type === "RESUME_AUTHORIZED") throw new Error("forced post-release admission failure");
        return append(type, ...args);
      };
      await assert.rejects(
        () => x.runner.handoffService.resume(ready.handoff_id, {
          actor: "human:r2-rollback",
          sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt),
          expectedResume,
          targetSession: x.runner.runtime.session,
        }),
        /forced post-release admission failure/,
      );
      assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), { authorizations: 0, admissions: 0, dispatches: 0 });
      assert.equal(x.runner.storage.getLatch(ready.task_id).state, "ENGAGED");
      assert.equal(x.runner.storage.getHandoff(ready.handoff_id).state, "RESUME_READY");
      assert.equal(x.calls, 0);
    } finally { await x.runner.dispose(); x.restoreFetch(); }
  });
});

test("R2-H-01 resume-first plan coordination excludes P2 only through durable admission", async () => {
  const x = await makeRunner();
  try {
    const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    const expectedResume = x.runner.handoffService.prepareResumeConfirmation(ready.handoff_id, x.runner.runtime.session);
    const writer = prepareRecoveryPlanChange(x.root, "R2-RESUME-FIRST");
    const transaction = x.runner.storage.transaction.bind(x.runner.storage);
    let writerCode = null;
    x.runner.storage.transaction = (operation) => {
      x.runner.storage.transaction = transaction;
      try { writer.apply(); } catch (error) { writerCode = error.code; }
      return transaction(operation);
    };
    const resumed = await x.runner.handoffService.resume(ready.handoff_id, {
      actor: "human:r2-resume-first",
      sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt),
      expectedResume,
      targetSession: x.runner.runtime.session,
    });
    assert.equal(resumed.state, "RESUMED");
    assert.equal(writerCode, "PLAN_WRITE_LOCKED");
    assert.equal(x.calls, 1);
    writer.apply();
    assert.match(x.runner.ledger.read().plan_revision_id, /R2-RESUME-FIRST/);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R2-H-01 concurrent human YES attempts admit and send at most once", async () => {
  const x = await makeRunner();
  try {
    const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    const target = x.runner.runtime.session;
    const firstExpectation = x.runner.handoffService.prepareResumeConfirmation(ready.handoff_id, target);
    const secondExpectation = x.runner.handoffService.prepareResumeConfirmation(ready.handoff_id, target);
    let releaseSend;
    const blockedSend = new Promise((resolve) => { releaseSend = resolve; });
    let sends = 0;
    const first = x.runner.handoffService.resume(ready.handoff_id, {
      actor: "human:r2-concurrent-1",
      sendResume: async () => { sends += 1; await blockedSend; },
      expectedResume: firstExpectation,
      targetSession: target,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => x.runner.handoffService.resume(ready.handoff_id, {
      actor: "human:r2-concurrent-2",
      sendResume: async () => { sends += 1; },
      expectedResume: secondExpectation,
      targetSession: target,
    }));
    assert.equal(sends, 1);
    releaseSend();
    assert.equal((await first).state, "RESUMED");
    assert.deepEqual(resumeDurableCounts(x.runner, ready.handoff_id), { authorizations: 1, admissions: 1, dispatches: 1 });
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R2-H-01 finishPausedHandoff confirmation is bound before the human prompt", async () => {
  const x = await makeRunner();
  try {
    await assert.rejects(
      () => x.runner.handoffDirect({
        mode: "confirm",
        confirm: async () => {
          prepareRecoveryPlanChange(x.root, "R2-FINISH").apply();
          writeFileSync(join(x.root, "r2-finish-git.txt"), "G2\n");
          const current = x.runner.storage.latestHandoffForTask("TASK-E2E");
          supersedeRunnerSessionBindingForInternalTest(x.runner.storage, current.handoff_id, "R2 finish prompt drift");
          return true;
        },
      }),
    );
    const current = x.runner.storage.latestHandoffForTask("TASK-E2E");
    assert.deepEqual(resumeDurableCounts(x.runner, current.handoff_id), { authorizations: 0, admissions: 0, dispatches: 0 });
    assert.equal(x.calls, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R2-M-01 recovered child crash intent blocks manual handoff from a different source after restart", async () => {
  let x = await makeContinuityRecoveryFixture();
  let reopened = null;
  try {
    const crash = Object.assign(new Error("simulated process crash after replacement intent"), { code: "SIMULATED_CRASH" });
    x.runner.handoffService.testHooks = { afterReplacementIntent() { throw crash; } };
    await assert.rejects(() => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }), (error) => error === crash);
    const child = x.runner.storage.latestHandoffForTask("TASK-E2E");
    assert.equal(child.recovery_of_handoff_id, x.failed.handoff_id);
    assert.equal(child.state, "REPLACEMENT_SESSION_CREATING");
    const root = x.root;
    await x.runner.dispose(); x.restoreFetch(); x = null;

    reopened = await makeRunner({ existingRoot: root });
    const freshSource = reopened.runner.runtime.session.sessionId;
    assert.notEqual(freshSource, child.source_session_id);
    const changesBeforeRead = storageDatabaseForInternalTest(reopened.runner.storage).prepare("SELECT total_changes() AS count").get().count;
    const stalledView = projectHumanWorkflow(observeRunnerHumanWorkflow(reopened.runner));
    assert.equal(stalledView.state, "NEEDS_ATTENTION");
    assert.equal(stalledView.handoff.actionability, "manual-recovery");
    assert.match(`${stalledView.reason} ${stalledView.nextAction}`, /esito.*sconosciuto|riconcilia.*non.*secondo handoff/i);
    assert.equal(storageDatabaseForInternalTest(reopened.runner.storage).prepare("SELECT total_changes() AS count").get().count, changesBeforeRead, "crash-stalled projection remains read-only");
    let replacements = 0;
    const originalNewSession = reopened.runner.runtime.newSession.bind(reopened.runner.runtime);
    reopened.runner.runtime.newSession = (...args) => { replacements += 1; return originalNewSession(...args); };
    await assert.rejects(
      () => reopened.runner.handoffDirect({ mode: "manual", confirm: false }),
      (error) => error.code === "TASK_OPERATION_CONFLICT",
    );
    assert.equal(storageDatabaseForInternalTest(reopened.runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 2);
    assert.equal(reopened.runner.storage.latestHandoffForTask("TASK-E2E").handoff_id, child.handoff_id);
    assert.equal(replacements, 0);
    assert.equal(reopened.calls, 0);
    assert.equal(reopened.networkAttempts, 0);
  } finally {
    if (x) { await x.runner.dispose(); x.restoreFetch(); }
    if (reopened) { await reopened.runner.dispose(); reopened.restoreFetch(); }
  }
});

test("R2-M-01 explicit multi-generation recovery transfers F1 to C1 to C2 without a task fork", async () => {
  let x = await makeContinuityRecoveryFixture();
  let next = null;
  try {
    const originalContinuity = x.runner.handoffService.continuity.bind(x.runner.handoffService);
    x.runner.handoffService.continuity = () => { throw Object.assign(new Error("forced C1 continuity failure"), { code: "CONTINUITY_FAILED" }); };
    await assert.rejects(() => x.runner.recoverHandoffDirect(x.failed.handoff_id, { confirm: false }), (error) => error.code === "CONTINUITY_FAILED");
    x.runner.handoffService.continuity = originalContinuity;
    const c1 = x.runner.storage.latestHandoffForTask("TASK-E2E");
    assert.equal(c1.recovery_of_handoff_id, x.failed.handoff_id);
    assert.equal(c1.state, "CONTINUITY_FAILED");
    assert.equal(x.runner.storage.getRunnerSessionBinding(c1.handoff_id).status, "ACTIVE");
    const root = x.root;
    await x.runner.dispose(); x.restoreFetch(); x = null;

    next = await makeRunner({ existingRoot: root });
    const c2 = await next.runner.recoverHandoffDirect(c1.handoff_id, { confirm: false });
    assert.equal(c2.recovery_of_handoff_id, c1.handoff_id);
    assert.equal(c2.state, "RESUME_READY");
    assert.equal(next.runner.storage.getRunnerSessionBinding(x?.failed?.handoff_id ?? c1.recovery_of_handoff_id).status, "SUPERSEDED");
    assert.equal(next.runner.storage.getRunnerSessionBinding(c1.handoff_id).status, "SUPERSEDED");
    assert.equal(storageDatabaseForInternalTest(next.runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 3);
    assert.equal(next.calls, 0);
  } finally {
    if (x) { await x.runner.dispose(); x.restoreFetch(); }
    if (next) { await next.runner.dispose(); next.restoreFetch(); }
  }
});

test("Pi E2E: explicit /aio resume confirmation NO keeps the target paused and YES resumes once", async () => {
  const x = await makeRunner();
  try {
    const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    assert.equal(ready.state, "RESUME_READY");
    assert.equal(x.runner.storage.getLatch(ready.task_id).state, "ENGAGED");
    let decision = false;
    const ctx = {
      ui: {
        async confirm() { return decision; },
        notify() {},
      },
    };
    const declined = await x.runner.resumeFromCommand(ctx, ready.handoff_id);
    assert.equal(declined.state, "RESUME_READY");
    assert.equal(x.runner.storage.getLatch(ready.task_id).state, "ENGAGED");
    assert.equal(x.runner.storage.events(ready.handoff_id).some((event) => event.event_type === "RESUME_AUTHORIZED"), false);
    assert.equal(x.calls, 0);

    decision = true;
    const resumed = await x.runner.resumeFromCommand(ctx, ready.handoff_id);
    assert.equal(resumed.state, "RESUMED");
    assert.equal(x.runner.storage.events(ready.handoff_id).filter((event) => event.event_type === "RESUME_AUTHORIZED").length, 1);
    assert.equal(x.calls, 1);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("Pi E2E: source -> checkpoint -> paused/no-history target -> one resume", async () => {
  const x = await makeRunner();
  try {
    const source = x.runner.runtime.session;
    const initialPlan = x.runner.ledger.read();
    assert.equal(initialPlan.current_item, "ITEM-E2E-SETUP");
    assert.equal(initialPlan.next_item, "ITEM-E2E-HANDOFF");
    await source.prompt("SOURCE_ONLY_MARKER");
    assert.equal(x.calls, 1);
    writeFixtureLedger(x.root, true);
    const updatedPlan = x.runner.ledger.read();
    assert.equal(updatedPlan.plan_revision_id, "PLAN-E2E-2");
    assert.notEqual(updatedPlan.content_digest, initialPlan.content_digest);
    assert.equal(updatedPlan.current_item, "ITEM-E2E-HANDOFF");
    assert.equal(updatedPlan.next_item, null);
    const sourceId = source.sessionId;
    const sourceFile = source.sessionFile.replaceAll("\\", "/");
    const result = await x.runner.handoffDirect({ mode: "confirm", confirm: true });
    assert.equal(result.state, "RESUMED");
    assert.notEqual(result.target_session_id, sourceId);
    const target = x.runner.runtime.session;
    const header = target.sessionManager.getHeader();
    assert.equal(header.parentSession.replaceAll("\\", "/"), sourceFile);
    const entries = target.sessionManager.getEntries();
    const serialized = JSON.stringify(entries);
    assert.equal(serialized.includes("SOURCE_ONLY_MARKER"), false);
    assert.equal(serialized.includes("AIOPAGO_RESUME_V1"), true);
    assert.equal(serialized.includes("task_plan_revision=PLAN-E2E-2"), true);
    assert.equal(serialized.includes("current_item=ITEM-E2E-HANDOFF"), true);
    assert.equal(serialized.includes("next_item=null"), true);
    assert.equal(serialized.includes("next_step=Resume the updated handoff item"), true);
    assert.equal(x.calls, 2);
    const checkpoint = x.runner.artifacts.verify("checkpoint", result.checkpoint_id, result.checkpoint_digest);
    const manifest = x.runner.artifacts.verify("manifest", result.resume_manifest_id, result.resume_manifest_digest);
    assert.equal(checkpoint.payload.parent_checkpoint_id, null);
    assert.equal(checkpoint.payload.plan_revision_id, "PLAN-E2E-2");
    assert.equal(result.expected_git_state.status_entries.some((entry) => entry.includes("TASK_PLAN.md")), true);
    assert.equal(manifest.payload.replacement_session_id, result.target_session_id);
    assert.equal(manifest.payload.runner_instance_id, x.runner.runnerInstanceId);
    assert.equal(manifest.payload.session_binding_id, result.session_binding_id);
    const runtimeBindingEntries = target.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === RUNNER_BINDING_CUSTOM_TYPE);
    assert.equal(runtimeBindingEntries.length, 1);
    assert.equal(runtimeBindingEntries[0].data.replacement_session_id, target.sessionId);
    const journalBinding = x.runner.storage.getRunnerSessionBinding(result.handoff_id);
    assert.equal(journalBinding.status, "ACTIVE");
    assert.equal(journalBinding.runner_instance_id, x.runner.runnerInstanceId);
    assert.equal(journalBinding.session_binding_id, result.session_binding_id);
    assert.equal(manifest.payload.current_item, "ITEM-E2E-HANDOFF");
    assert.equal(manifest.payload.next_item, null);
    assert.equal(manifest.payload.next_step, "Resume the updated handoff item");
    assert.equal(manifest.payload.task_plan_revision, "PLAN-E2E-2");
    assert.equal(manifest.payload.task_plan_digest, updatedPlan.content_digest);
    assert.equal(manifest.payload.head_sha, result.expected_git_state.head_sha);
    assert.match(result.expected_git_state.index_digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(result.expected_git_state.worktree_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(manifest.payload.index_digest, result.expected_git_state.index_digest);
    assert.equal(manifest.payload.worktree_digest, result.expected_git_state.worktree_digest);
    assert.equal(Object.hasOwn(manifest.payload, "transcript"), false);
    assert.deepEqual(manifest.payload.minimal_reads, REAL_MINIMAL_READS);
    assert.deepEqual(manifest.payload.required_local_paths, ["TASK_PLAN.md"]);
    assert.equal(result.resume_prompt.includes(`semantic_minimal_reads_json=${JSON.stringify(REAL_MINIMAL_READS)}`), true);

    const metricSamples = x.runner.storage.metricSamples();
    assert.equal(metricSamples.length, 2, "one authoritative sample must be captured for each fake provider call");
    assert.equal(metricSamples.filter((sample) => sample.session_id === sourceId).length, 1);
    assert.equal(metricSamples.filter((sample) => sample.session_id === target.sessionId).length, 1);
    assert.equal(x.runner.storage.getMetricSession(sourceId).lifecycle.status, "ENDED");
    assert.equal(x.runner.storage.getMetricSession(target.sessionId).model_calls, 1);
    const measuredLifecycle = x.runner.storage.handoffMetricEvents(result.handoff_id);
    for (const state of ["STARTED", "CHECKPOINT_SEALED", "REPLACEMENT_STARTED", "RESUME_READY", "RESUME_STARTED", "COMPLETED"]) {
      assert.equal(measuredLifecycle.some((event) => event.lifecycle_state === state), true, `missing measured ${state}`);
    }
    assert.equal(measuredLifecycle.every((event) => event.threshold_percent === 50), true);
    const readyMeasurement = measuredLifecycle.find((event) => event.lifecycle_state === "RESUME_READY");
    assert.equal(readyMeasurement.artifacts.checkpoint_sealed_bytes, checkpoint.bytes.length);
    assert.equal(readyMeasurement.artifacts.manifest_bytes, manifest.bytes.length);
    assert.equal(readyMeasurement.artifacts.resume_prompt_bytes, Buffer.byteLength(result.resume_prompt, "utf8"));
    assert.equal(readyMeasurement.artifacts.minimal_reads_count, null);
    assert.equal(readyMeasurement.artifacts.minimal_reads_declared_count, manifest.payload.minimal_reads.length);
    assert.equal(JSON.stringify({ metricSamples, measuredLifecycle }).includes("SOURCE_ONLY_MARKER"), false);

    const handoffEvents = x.runner.storage.events(result.handoff_id);
    const admissionEvents = handoffEvents.filter((event) => event.event_type === "RESUME_ADMISSION_COMMITTED");
    assert.equal(admissionEvents.length, 1);
    const eventTypes = handoffEvents.map((event) => event.event_type);
    assert.ok(eventTypes.indexOf("REPLACEMENT_SESSION_CREATED_PAUSED") < eventTypes.indexOf("MANIFEST_PERSISTED"));
    assert.ok(eventTypes.indexOf("CONTINUITY_VALIDATED") < eventTypes.indexOf("RESUME_ADMISSION_COMMITTED"));
    assert.ok(eventTypes.indexOf("RESUME_DISPATCH_INTENT") < eventTypes.indexOf("RESUME_DISPATCHED"));
    const again = await x.runner.handoffService.resume(result.handoff_id, { actor: "human:retry", sendResume: (prompt) => target.sendUserMessage(prompt) });
    assert.equal(again.state, "RESUMED");
    const reloadedStorage = new GuardianStorage(x.runner.storage.path);
    try {
      const reloadedService = new HandoffService({ storage: reloadedStorage, artifacts: x.runner.artifacts, ledger: x.runner.ledger, observeGit: () => result.expected_git_state, safePoint: null, runnerInstanceId: x.runner.runnerInstanceId, modelPolicy: "offline-fake/offline-fake", reasoningPolicy: "off" });
      const afterReload = await reloadedService.resume(result.handoff_id, { actor: "human:reload", sendResume: (prompt) => target.sendUserMessage(prompt) });
      assert.equal(afterReload.state, "RESUMED");
    } finally { reloadedStorage.close(); }
    assert.equal(x.calls, 2);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R1-M-01 actual Pi /aio handoff confirm cannot mutate P1 owned by C1 and C1 later resumes once", async () => {
  const x = await makeRunner({ ownerGate: true });
  let fresh = null;
  try {
    const c1 = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    assert.equal(c1.state, "RESUME_READY");
    assert.equal(c1.task_plan_revision, "PLAN-E2E-GATE-1");
    const c1Session = x.runner.runtime.session;
    const before = planDiskSnapshot(x.root, x.runner);
    const rowsBefore = storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs WHERE task_id='TASK-E2E'").get().count;
    assert.equal(rowsBefore, 1);

    fresh = await makeRunner({ ownerGate: true, existingRoot: x.root });
    assert.notEqual(fresh.runner.runtime.session.sessionId, c1.source_session_id);
    assert.notEqual(fresh.runner.runtime.session.sessionId, c1.target_session_id);
    let replacements = 0;
    const originalNewSession = fresh.runner.runtime.newSession.bind(fresh.runner.runtime);
    fresh.runner.runtime.newSession = (...args) => { replacements += 1; return originalNewSession(...args); };
    const notices = [];
    await fresh.runner.runtime.session.bindExtensions({
      mode: "print",
      uiContext: {
        notify(text, type) { notices.push({ text, type }); },
        async confirm() { throw new Error("owner conflict must reject before any prompt"); },
        setEditorText() { throw new Error("owner conflict must not edit the command line"); },
      },
      commandContextActions: {
        waitForIdle: () => fresh.runner.runtime.session.waitForIdle(),
        newSession: (options) => fresh.runner.runtime.newSession(options),
        fork: (entryId, options) => fresh.runner.runtime.fork(entryId, options),
        navigateTree: (targetId, options) => fresh.runner.runtime.session.navigateTree(targetId, options),
        switchSession: (path, options) => fresh.runner.runtime.switchSession(path, options),
        reload: async () => {},
      },
    });
    await fresh.runner.runtime.session.prompt("/aio handoff confirm");

    const after = planDiskSnapshot(x.root, fresh.runner);
    assert.deepEqual(after.bytes, before.bytes, "TASK_PLAN.md bytes remain exact");
    assert.equal(after.contentDigest, before.contentDigest);
    assert.equal(after.revision, before.revision);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.gate, "BLOCKED");
    assert.deepEqual(after.history, before.history);
    assert.match(notices.at(-1)?.text ?? "", /TASK_OPERATION_CONFLICT/);
    assert.equal(storageDatabaseForInternalTest(fresh.runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs WHERE task_id='TASK-E2E'").get().count, 1);
    assert.equal(fresh.runner.storage.getHandoff(c1.handoff_id).state, "RESUME_READY");
    assert.equal(replacements, 0);
    assert.equal(x.calls, 0);
    assert.equal(fresh.calls, 0);
    assert.equal(x.networkAttempts, 0);
    assert.equal(fresh.networkAttempts, 0);

    await fresh.runner.dispose(); fresh.restoreFetch(); fresh = null;
    assert.equal(x.runner.runtime.session, c1Session);
    assert.equal(x.runner.handoffService.continuity(c1.handoff_id, c1Session).state, "RESUME_READY");
    const resumed = await x.runner.resumeFromCommand({ ui: { async confirm() { return true; }, notify() {} } }, c1.handoff_id);
    assert.equal(resumed.state, "RESUMED");
    assert.equal(x.calls, 1);
    assert.equal((await x.runner.handoffService.resume(c1.handoff_id, { actor: "human:idempotent" })).state, "RESUMED");
    assert.equal(x.calls, 1);
  } finally {
    if (fresh) { await fresh.runner.dispose(); fresh.restoreFetch(); }
    await x.runner.dispose(); x.restoreFetch();
  }
});

test("R1-M-02 actual Pi takeoverFromCommand wins before owner mutation with zero plan/history side effects", async () => {
  const x = await makeRunner({ ownerGate: true });
  try {
    const before = planDiskSnapshot(x.root, x.runner);
    let takeoverCalls = 0;
    let replacements = 0;
    const newSession = x.runner.runtime.newSession.bind(x.runner.runtime);
    x.runner.runtime.newSession = (...args) => { replacements += 1; return newSession(...args); };
    x.runner.handoffService.testHooks = {
      async beforeOwnerGate() {
        takeoverCalls += 1;
        await x.runner.takeoverFromCommand({ ui: { notify() {} } });
      },
    };
    await assert.rejects(
      () => x.runner.handoffDirect({ mode: "confirm", confirm: false }),
      (error) => error.code === "HUMAN_TAKEOVER_ACTIVE",
    );
    assert.equal(takeoverCalls, 1);
    assert.equal(x.runner.storage.getLatch("TASK-E2E").reason, "HUMAN_TAKEOVER");
    assert.deepEqual(planDiskSnapshot(x.root, x.runner), before);
    assert.equal(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
    assert.equal(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT COUNT(*) AS count FROM artifacts").get().count, 0);
    assert.equal(replacements, 0);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("R1-M-03 actual registered session_shutdown immediately before owner authority rejects, including same-ID ABA", async (t) => {
  for (const restart of [false, true]) {
    await t.test(restart ? "same-ID shutdown/start ABA then fresh retry" : "shutdown", async () => {
      const x = await makeRunner({ ownerGate: true });
      try {
        const source = x.runner.runtime.session;
        const before = planDiskSnapshot(x.root, x.runner);
        let hookCalls = 0;
        let replacements = 0;
        const newSession = x.runner.runtime.newSession.bind(x.runner.runtime);
        x.runner.runtime.newSession = (...args) => { replacements += 1; return newSession(...args); };
        x.runner.handoffService.testHooks = {
          async beforeOwnerGate() {
            hookCalls += 1;
            await source.extensionRunner.emit({ type: "session_shutdown", reason: "R1-M-03" });
            if (restart) await source.extensionRunner.emit({ type: "session_start", reason: "R1-M-03-ABA" });
          },
        };
        await assert.rejects(
          () => x.runner.handoffDirect({ mode: "confirm", confirm: false }),
          (error) => error.code === "HANDOFF_SOURCE_CHANGED",
        );
        assert.equal(hookCalls, 1);
        assert.deepEqual(planDiskSnapshot(x.root, x.runner), before);
        assert.equal(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
        assert.equal(storageDatabaseForInternalTest(x.runner.storage).prepare("SELECT COUNT(*) AS count FROM artifacts").get().count, 0);
        assert.equal(replacements, 0);
        assert.equal(x.calls, 0);
        assert.equal(x.networkAttempts, 0);

        if (restart) {
          x.runner.handoffService.testHooks = null;
          const fresh = await x.runner.handoffDirect({ mode: "confirm", confirm: false });
          assert.equal(fresh.state, "RESUME_READY");
          assert.equal(x.runner.ledger.read().owner_gate.status, "SATISFIED");
        }
      } finally { await x.runner.dispose(); x.restoreFetch(); }
    });
  }
});

test("Pi E2E confirmed owner gate advances H1-02 before checkpoint and manifest seal", async () => {
  const x = await makeRunner({ ownerGate: true });
  try {
    const blocked = x.runner.ledger.read();
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.current_item, null);
    assert.equal(blocked.next_item, "ITEM-H1-02");
    assert.match(blocked.next_step, /\/aio handoff confirm/);
    const result = await x.runner.handoffDirect({ mode: "confirm", confirm: true });
    assert.equal(result.state, "RESUMED");
    const advanced = x.runner.ledger.read();
    assert.equal(advanced.plan_revision_id, "PLAN-E2E-GATE-2");
    assert.equal(advanced.status, "IN_PROGRESS");
    assert.equal(advanced.owner_gate.status, "SATISFIED");
    assert.equal(advanced.current_item, "ITEM-H1-02");
    assert.equal(advanced.next_item, "ITEM-H1-03");
    assert.equal(advanced.task_items.find((item) => item.task_item_id === "ITEM-H1-02").status, "IN_PROGRESS");
    assert.equal(advanced.next_step, "Validate replacement continuity and finish H1-02 metrics");
    assert.doesNotMatch(advanced.next_step, /\/aio handoff confirm/);
    const checkpoint = x.runner.artifacts.verify("checkpoint", result.checkpoint_id, result.checkpoint_digest);
    const manifest = x.runner.artifacts.verify("manifest", result.resume_manifest_id, result.resume_manifest_digest);
    assert.equal(checkpoint.payload.plan_revision_id, "PLAN-E2E-GATE-2");
    assert.deepEqual(checkpoint.payload.task_item_ids, ["ITEM-H1-02"]);
    assert.equal(manifest.payload.current_item, "ITEM-H1-02");
    assert.equal(manifest.payload.next_item, "ITEM-H1-03");
    assert.equal(manifest.payload.next_step, advanced.next_step);
    assert.doesNotMatch(result.resume_prompt, /next_step=.*\/aio handoff confirm/);
    assert.equal(manifest.payload.runner_instance_id, x.runner.runnerInstanceId);
    assert.equal(manifest.payload.session_binding_id, result.session_binding_id);
    const binding = x.runner.storage.getRunnerSessionBinding(result.handoff_id);
    assert.equal(binding.replacement_session_id, result.target_session_id);
    assert.equal(binding.runner_instance_id, x.runner.runnerInstanceId);
    assert.equal(binding.session_binding_id, result.session_binding_id);
    const events = x.runner.storage.events(result.handoff_id);
    assert.equal(events.filter((event) => event.event_type === "HANDOFF_STARTED").length, 1);
    assert.equal(events.filter((event) => event.event_type === "RUNNER_SESSION_BOUND").length, 1);
    assert.ok(events.findIndex((event) => event.event_type === "CHECKPOINT_PERSISTED") < events.findIndex((event) => event.event_type === "RUNNER_SESSION_BOUND"));
    assert.ok(events.findIndex((event) => event.event_type === "RUNNER_SESSION_BOUND") < events.findIndex((event) => event.event_type === "MANIFEST_PERSISTED"));
    assert.ok(events.findIndex((event) => event.event_type === "MANIFEST_PERSISTED") < events.findIndex((event) => event.event_type === "RESUME_DISPATCHED"));
    const duplicate = await x.runner.handoffService.resume(result.handoff_id, { actor: "human:duplicate", sendResume: (prompt) => x.runner.runtime.session.sendUserMessage(prompt) });
    assert.equal(duplicate.state, "RESUMED");
    assert.equal(x.runner.storage.events(result.handoff_id).filter((event) => event.event_type === "RESUME_ADMISSION_COMMITTED").length, 1);
    assert.equal(x.calls, 1);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("Pi E2E direct session replacement and history fork outside the Guardian permit path are cancelled fail-closed", async () => {
  const x = await makeRunner();
  try {
    const source = x.runner.runtime.session;
    const direct = await x.runner.runtime.newSession();
    assert.equal(direct.cancelled, true);
    assert.equal(x.runner.runtime.session.sessionId, source.sessionId);

    await source.prompt("Create source history that must not be forked");
    const userEntry = source.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
    assert.ok(userEntry);
    const fork = await x.runner.runtime.fork(userEntry.id);
    assert.equal(fork.cancelled, true);
    assert.equal(x.runner.runtime.session.sessionId, source.sessionId);
    assert.throws(() => readRuntimeRunnerBinding(x.runner.runtime.session), (error) => error.code === "RUNNER_OWNERSHIP_ATTESTATION_FAILED");
    assert.equal(x.calls, 1);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("Pi E2E /aio takeover persists the latch and blocks the next prompt", async () => {
  const x = await makeRunner();
  try {
    await x.runner.runtime.session.prompt("/aio takeover");
    const latch = x.runner.storage.getLatch("TASK-E2E");
    assert.equal(latch.state, "ENGAGED");
    assert.equal(latch.reason, "HUMAN_TAKEOVER");
    await x.runner.runtime.session.prompt("THIS_MUST_NOT_REACH_PROVIDER");
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("replacement creation ambiguity preserves checkpoint and exact fail-closed recovery", async () => {
  const x = await makeRunner();
  try {
    const source = x.runner.runtime.session;
    await assert.rejects(
      () => x.runner.handoffService.handoff({
        sourceSession: source,
        mode: "manual",
        replacePaused: async () => { throw new Error("simulated ambiguous create"); },
      }),
      (error) => error.code === "HANDOFF_FAILED" && error.details.instructions.length >= 5,
    );
    const handoff = x.runner.storage.latestHandoffForTask("TASK-E2E");
    assert.equal(handoff.state, "HANDOFF_FAILED");
    assert.equal(handoff.target_session_id, null);
    assert.ok(handoff.checkpoint_digest);
    assert.equal(x.runner.artifacts.verify("checkpoint", handoff.checkpoint_id, handoff.checkpoint_digest).payload.task_id, "TASK-E2E");
    assert.match(handoff.manual_recovery.join("\n"), /Do not retry handoff/);
    assert.match(handoff.manual_recovery.join("\n"), /final Resume Context Manifest cannot be sealed/);
    assert.equal(x.calls, 0);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("Pi E2E /aio handoff manual leaves replacement paused with zero entries", async () => {
  const x = await makeRunner();
  try {
    await x.runner.runtime.session.prompt("source");
    await x.runner.runtime.session.prompt("/aio handoff manual");
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = x.runner.storage.latestHandoffForTask("TASK-E2E");
      if (result?.state !== "REPLACEMENT_SESSION_CREATING") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(result.state, "RESUME_READY");
    assert.equal(x.runner.runtime.session.sessionManager.getEntries().filter((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type)).length, 0);
    assert.equal(x.runner.storage.getLatch(result.task_id).state, "ENGAGED");
    assert.equal(x.calls, 1);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("semantic minimal_reads preserve the real five directives and do not require prose to exist as files", async () => {
  const x = await makeRunner();
  try {
    assert.equal(existsSync(join(x.root, "AGENTS.md section 18")), false);
    assert.equal(existsSync(join(x.root, "Complete PR #679 diff against its current base")), false);
    const result = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    assert.equal(result.state, "RESUME_READY");
    const manifest = x.runner.artifacts.verify("manifest", result.resume_manifest_id, result.resume_manifest_digest);
    assert.deepEqual(manifest.payload.minimal_reads, REAL_MINIMAL_READS);
    assert.deepEqual(manifest.payload.required_local_paths, ["TASK_PLAN.md"]);
    assert.equal(result.resume_prompt.includes(`semantic_minimal_reads_json=${JSON.stringify(REAL_MINIMAL_READS)}`), true);
    assert.equal(x.runner.storage.events(result.handoff_id).some((event) => event.event_type === "CONTINUITY_FAILED"), false);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("an explicitly required missing local path fails continuity closed without reclassifying semantic directives", async () => {
  const x = await makeRunner({ requiredLocalPaths: ["docs/machine-required.md"] });
  try {
    await assert.rejects(
      () => x.runner.handoffDirect({ mode: "manual", confirm: false }),
      (error) => error.code === "REQUIRED_LOCAL_PATH_MISSING" && error.message === "required local path unavailable: docs/machine-required.md",
    );
    const failed = x.runner.storage.latestHandoffForTask("TASK-E2E");
    assert.equal(failed.state, "CONTINUITY_FAILED");
    assert.equal(failed.failure.code, "REQUIRED_LOCAL_PATH_MISSING");
    assert.deepEqual(x.runner.artifacts.verify("manifest", failed.resume_manifest_id, failed.resume_manifest_digest).payload.minimal_reads, REAL_MINIMAL_READS);
    assert.equal(x.runner.storage.getLatch(failed.task_id).state, "ENGAGED");
    assert.equal(x.runner.storage.events(failed.handoff_id).some((event) => event.event_type === "RESUME_AUTHORIZED"), false);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
});

test("CONTINUITY_FAILED recovery crosses a process restart and accepts sealed legacy 1.0.0 evidence", async () => {
  let runnerA = await makeRunner();
  let runnerB = null;
  try {
    const continuity = runnerA.runner.handoffService.continuity.bind(runnerA.runner.handoffService);
    runnerA.runner.handoffService.continuity = () => { const error = new Error("minimal reads unavailable"); error.code = "CONTINUITY_FAILED"; throw error; };
    await assert.rejects(() => runnerA.runner.handoffDirect({ mode: "manual", confirm: false }), (error) => error.code === "CONTINUITY_FAILED" && error.message === "minimal reads unavailable");
    runnerA.runner.handoffService.continuity = continuity;
    let failed = runnerA.runner.storage.latestHandoffForTask("TASK-E2E");
    const failedTargetId = failed.target_session_id;
    const oldRunnerInstanceId = failed.runner_instance_id;
    const legacy = convertFailedManifestToLegacyV1(runnerA.runner, failed);
    failed = runnerA.runner.storage.getHandoff(failed.handoff_id);
    const failedSnapshot = structuredClone(failed);
    assert.equal(runnerA.runner.artifacts.verify("manifest", failed.resume_manifest_id, failed.resume_manifest_digest).payload.manifest_version, "1.0.0");
    assert.equal(failed.state, "CONTINUITY_FAILED");
    assert.equal(failed.authorization_state, "NOT_AUTHORIZED");
    assert.equal(failed.admission_state, "NOT_COMMITTED");
    assert.equal(failed.dispatch_state, "NOT_STARTED");

    await assert.rejects(
      () => runnerA.runner.handoffDirect({ mode: "confirm", confirm: true }),
      (error) => error.code === "CONTINUITY_RECOVERY_REQUIRED",
      "normal handoff confirm must not hide a retry of the failed target",
    );
    let oldDispatchCalled = false;
    await assert.rejects(
      () => runnerA.runner.handoffService.resume(failed.handoff_id, { actor: "human:implicit-retry", sendResume: async () => { oldDispatchCalled = true; } }),
      (error) => error.code === "CONTINUITY_RECOVERY_REQUIRED",
    );
    assert.equal(oldDispatchCalled, false);

    const root = runnerA.root;
    await runnerA.runner.dispose(); runnerA.restoreFetch(); runnerA = null;
    runnerB = await makeRunner({ existingRoot: root });
    const freshSourceId = runnerB.runner.runtime.session.sessionId;
    assert.notEqual(runnerB.runner.runnerInstanceId, oldRunnerInstanceId);
    assert.notEqual(freshSourceId, failedTargetId);
    assert.equal(runnerB.runner.runtime.session.sessionManager.getEntries().filter((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type)).length, 0);
    await assert.rejects(
      () => runnerB.runner.handoffDirect({ mode: "confirm", confirm: true }),
      (error) => error.code === "CONTINUITY_RECOVERY_REQUIRED",
      "a fresh Runner source must still use the explicit recover command",
    );

    let pausedEvidence;
    const recovered = await runnerB.runner.recoverHandoffDirect(failed.handoff_id, {
      confirm: async (handoff, session) => {
        const history = session.sessionManager.getEntries().filter((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type));
        pausedEvidence = { state: handoff.state, history: history.length, latch: runnerB.runner.storage.getLatch(handoff.task_id) };
        return true;
      },
    });

    assert.equal(recovered.state, "RESUMED");
    assert.notEqual(recovered.handoff_id, failed.handoff_id);
    assert.equal(recovered.recovery_of_handoff_id, failed.handoff_id);
    assert.equal(recovered.source_session_id, freshSourceId);
    assert.notEqual(recovered.target_session_id, failedTargetId);
    assert.equal(recovered.parent_checkpoint_id, failed.checkpoint_id);
    assert.equal(pausedEvidence.state, "RESUME_READY");
    assert.equal(pausedEvidence.history, 0);
    assert.equal(pausedEvidence.latch.state, "ENGAGED");
    assert.equal(pausedEvidence.latch.generation, failed.latch_generation);
    assert.deepEqual(runnerB.runner.storage.getHandoff(failed.handoff_id), failedSnapshot, "the terminal failed projection must remain immutable evidence");
    assert.deepEqual(readFileSync(runnerB.runner.storage.getArtifact("manifest", failed.resume_manifest_id).path), legacy.bytes, "legacy sealed evidence must not be migrated or rewritten");
    const newManifest = runnerB.runner.artifacts.verify("manifest", recovered.resume_manifest_id, recovered.resume_manifest_digest);
    assert.equal(newManifest.payload.manifest_version, "1.1.0");
    const oldBinding = runnerB.runner.storage.getRunnerSessionBinding(failed.handoff_id);
    assert.equal(oldBinding.status, "SUPERSEDED");
    assert.equal(oldBinding.replacement_session_id, failedTargetId);
    assert.equal(oldBinding.runner_instance_id, oldRunnerInstanceId);
    const oldEvents = runnerB.runner.storage.events(failed.handoff_id);
    assert.equal(oldEvents.filter((event) => event.event_type === "CONTINUITY_RECOVERY_STARTED").length, 1);
    assert.equal(oldEvents.some((event) => ["RESUME_AUTHORIZED", "RESUME_ADMISSION_COMMITTED", "RESUME_DISPATCH_INTENT"].includes(event.event_type)), false);
    const events = runnerB.runner.storage.events(recovered.handoff_id);
    assert.equal(events.filter((event) => event.event_type === "HANDOFF_STARTED").length, 1);
    assert.equal(events.filter((event) => event.event_type === "RESUME_AUTHORIZED").length, 1);
    assert.equal(events.filter((event) => event.event_type === "RESUME_ADMISSION_COMMITTED").length, 1);
    assert.equal(events.filter((event) => event.event_type === "RESUME_DISPATCH_INTENT").length, 1);
    assert.equal(events.filter((event) => event.event_type === "RESUME_ACKNOWLEDGED").length, 1);
    assert.ok(events.findIndex((event) => event.event_type === "CONTINUITY_VALIDATED") < events.findIndex((event) => event.event_type === "RESUME_AUTHORIZED"));
    assert.equal(runnerB.calls, 1);
    assert.equal(runnerB.networkAttempts, 0);
  } finally {
    if (runnerA) { await runnerA.runner.dispose(); runnerA.restoreFetch(); }
    if (runnerB) { await runnerB.runner.dispose(); runnerB.restoreFetch(); }
  }
});

test("CONTINUITY_FAILED recovery fails closed when HUMAN_TAKEOVER races its SafePoint", async () => {
  let runnerA = await makeRunner();
  let runnerB = null;
  let takeover = null;
  try {
    const continuity = runnerA.runner.handoffService.continuity.bind(runnerA.runner.handoffService);
    runnerA.runner.handoffService.continuity = () => { const error = new Error("forced recovery fixture"); error.code = "CONTINUITY_FAILED"; throw error; };
    await assert.rejects(() => runnerA.runner.handoffDirect({ mode: "manual", confirm: false }), (error) => error.code === "CONTINUITY_FAILED");
    runnerA.runner.handoffService.continuity = continuity;
    const failed = runnerA.runner.storage.latestHandoffForTask("TASK-E2E");
    const root = runnerA.root;
    await runnerA.runner.dispose(); runnerA.restoreFetch(); runnerA = null;

    runnerB = await makeRunner({ existingRoot: root });
    takeover = new GuardianStorage(runnerB.runner.storage.path);
    const fresh = runnerB.runner.runtime.session;
    let releaseIdle;
    let waitStarted;
    const waiting = new Promise((resolve) => { waitStarted = resolve; });
    const release = new Promise((resolve) => { releaseIdle = resolve; });
    fresh.waitForIdle = async () => { waitStarted(); await release; };
    const durableBefore = recoveryDurableSnapshot(runnerB.runner, failed.handoff_id);
    const prepareCalls = instrumentRecoveryPreparation(runnerB.runner);
    const pending = runnerB.runner.recoverHandoffDirect(failed.handoff_id, { confirm: true });
    const rejected = assert.rejects(pending, (error) => error.code === "HUMAN_TAKEOVER_ACTIVE");
    await waiting;
    claimTakeoverForInternalTest(takeover, failed.task_id, "human:/aio-takeover");
    releaseIdle();
    await rejected;
    assert.deepEqual(recoveryDurableSnapshot(runnerB.runner, failed.handoff_id), durableBefore);
    assert.equal(runnerB.runner.storage.getRunnerSessionBinding(failed.handoff_id).status, "ACTIVE");
    assert.equal(prepareCalls(), 0);
    assert.equal(runnerB.runner.storage.getLatch(failed.task_id).reason, "HUMAN_TAKEOVER");
    assert.equal(runnerB.runner.storage.events(failed.handoff_id).some((event) => ["CONTINUITY_RECOVERY_STARTED", "RUNNER_SESSION_BINDING_SUPERSEDED"].includes(event.event_type)), false);
    assert.equal(runnerB.runner.runtime.session.sessionId, fresh.sessionId);
    assert.equal(runnerB.calls, 0);
  } finally {
    takeover?.close();
    if (runnerA) { await runnerA.runner.dispose(); runnerA.restoreFetch(); }
    if (runnerB) { await runnerB.runner.dispose(); runnerB.restoreFetch(); }
  }
});

test("CONTINUITY_FAILED recovery rejects unknown or durable resume effects and unsupported states", async (t) => {
  await t.test("UNKNOWN dispatch projection", async () => {
    const x = await makeRunner({ requiredLocalPaths: ["docs/missing-unknown.md"] });
    try {
      await assert.rejects(() => x.runner.handoffDirect({ mode: "manual", confirm: false }), (error) => error.code === "REQUIRED_LOCAL_PATH_MISSING");
      const failed = x.runner.storage.latestHandoffForTask("TASK-E2E");
      failed.dispatch_state = "UNKNOWN";
      saveHandoffForInternalTest(x.runner.storage, failed);
      writeFileSync(join(x.root, "docs", "missing-unknown.md"), "fixed\n");
      assert.throws(
        () => x.runner.storage.prepareContinuityRecovery(failed.handoff_id, { sourceSessionId: "SES-fresh-unknown", runnerInstanceId: "RUNNER-fresh-unknown", actor: "human:test-recovery" }),
        (error) => error.code === "CONTINUITY_RECOVERY_TRUSTED_PATH_REQUIRED",
      );
      assert.equal(x.runner.storage.getRunnerSessionBinding(failed.handoff_id).status, "ACTIVE");
      assert.equal(x.runner.storage.getLatch(failed.task_id).state, "ENGAGED");
    } finally { await x.runner.dispose(); x.restoreFetch(); }
  });
  await t.test("durable authorization/admission/dispatch evidence", async () => {
    const x = await makeRunner({ requiredLocalPaths: ["docs/missing-durable.md"] });
    try {
      await assert.rejects(() => x.runner.handoffDirect({ mode: "manual", confirm: false }), (error) => error.code === "REQUIRED_LOCAL_PATH_MISSING");
      const failed = x.runner.storage.latestHandoffForTask("TASK-E2E");
      storageDatabaseForInternalTest(x.runner.storage).prepare("INSERT INTO authorizations(resume_prompt_id,handoff_id,actor,latch_generation,authorized_at) VALUES(?,?,?,?,?)")
        .run(failed.resume_prompt_id, failed.handoff_id, "human:simulated", failed.latch_generation, "2026-08-08T00:00:00Z");
      storageDatabaseForInternalTest(x.runner.storage).prepare("INSERT INTO admissions(admission_id,resume_prompt_id,idempotency_key,handoff_id,committed_at) VALUES(?,?,?,?,?)")
        .run("ADM-simulated", failed.resume_prompt_id, "resume:simulated", failed.handoff_id, "2026-08-08T00:00:00Z");
      storageDatabaseForInternalTest(x.runner.storage).prepare("INSERT INTO dispatch_attempts(dispatch_attempt_id,admission_id,handoff_id,attempt_no,state,intent_at) VALUES(?,?,?,?,?,?)")
        .run("DSP-simulated", "ADM-simulated", failed.handoff_id, 1, "DISPATCHING", "2026-08-08T00:00:00Z");
      writeFileSync(join(x.root, "docs", "missing-durable.md"), "fixed\n");
      assert.throws(
        () => x.runner.storage.prepareContinuityRecovery(failed.handoff_id, { sourceSessionId: "SES-fresh-durable", runnerInstanceId: "RUNNER-fresh-durable", actor: "human:test-recovery" }),
        (error) => error.code === "CONTINUITY_RECOVERY_TRUSTED_PATH_REQUIRED",
      );
      assert.equal(x.runner.storage.getRunnerSessionBinding(failed.handoff_id).status, "ACTIVE");
    } finally { await x.runner.dispose(); x.restoreFetch(); }
  });
  await t.test("unsupported non-failed state", async () => {
    const x = await makeRunner();
    try {
      const ready = await x.runner.handoffDirect({ mode: "manual", confirm: false });
      await assert.rejects(() => x.runner.handoffService.recoverContinuityFailure({ failedHandoffId: ready.handoff_id }), (error) => error.code === "CONTINUITY_RECOVERY_NOT_ALLOWED");
    } finally { await x.runner.dispose(); x.restoreFetch(); }
  });
});

async function continuityFailureScenario(code, mutate) {
  const x = await makeRunner();
  try {
    const result = await x.runner.handoffDirect({ mode: "manual", confirm: false });
    assert.equal(result.state, "RESUME_READY");
    const handoff = x.runner.storage.getHandoff(result.handoff_id);
    handoff.state = "MANIFEST_PERSISTED";
    saveHandoffForInternalTest(x.runner.storage, handoff);
    await mutate({ x, result, target: x.runner.runtime.session });
    assert.throws(
      () => x.runner.handoffService.continuity(result.handoff_id, x.runner.runtime.session),
      (error) => error.code === code,
    );
    assert.equal(x.runner.storage.getLatch(result.task_id).state, "ENGAGED");
    assert.equal(x.runner.storage.events(result.handoff_id).some((event) => event.event_type === "RESUME_ADMISSION_COMMITTED"), false);
    assert.equal(x.networkAttempts, 0);
  } finally { await x.runner.dispose(); x.restoreFetch(); }
}

test("P0-B continuity failure matrix remains fail-closed", async (t) => {
  await t.test("target Git mismatch", () => continuityFailureScenario("GIT_STATE_MISMATCH", async ({ x }) => {
    const other = mkdtempSync(join(tmpdir(), "aiopago-other-target-"));
    git(other, ["init"]); git(other, ["config", "user.email", "other@example.invalid"]); git(other, ["config", "user.name", "Other Target"]);
    writeFileSync(join(other, "other.txt"), "other\n"); git(other, ["add", "."]); git(other, ["commit", "-m", "other"]);
    x.runner.handoffService.observeGit = () => observeGitState(other);
  }));
  await t.test("HEAD mismatch", () => continuityFailureScenario("GIT_STATE_MISMATCH", async ({ x }) => {
    writeFileSync(join(x.root, "head-change.txt"), "new commit\n");
    git(x.root, ["add", "head-change.txt"]); git(x.root, ["commit", "-m", "move HEAD"]);
  }));
  await t.test("Ledger revision mismatch", () => continuityFailureScenario("PLAN_REVISION_MISMATCH", async ({ x }) => {
    writeFixtureLedger(x.root, true);
  }));
  await t.test("checkpoint digest mismatch", () => continuityFailureScenario("CHECKPOINT_MISMATCH", async ({ x, result }) => {
    const path = x.runner.storage.getArtifact("checkpoint", result.checkpoint_id).path;
    writeFileSync(path, `${readFileSync(path, "utf8")}tampered\n`);
  }));
  await t.test("manifest digest mismatch", () => continuityFailureScenario("MANIFEST_MISMATCH", async ({ x, result }) => {
    const path = x.runner.storage.getArtifact("manifest", result.resume_manifest_id).path;
    writeFileSync(path, `${readFileSync(path, "utf8")}tampered\n`);
  }));
  await t.test("model policy mismatch", () => continuityFailureScenario("MODEL_POLICY_MISMATCH", async ({ x }) => {
    x.runner.handoffService.modelPolicy = "offline-fake/other-model";
  }));
  await t.test("reasoning policy mismatch", () => continuityFailureScenario("REASONING_POLICY_MISMATCH", async ({ x }) => {
    x.runner.handoffService.reasoningPolicy = "high";
  }));
  await t.test("stale Runner binding", () => continuityFailureScenario("RUNNER_OWNERSHIP_ATTESTATION_FAILED", async ({ x, result }) => {
    supersedeRunnerSessionBindingForInternalTest(x.runner.storage, result.handoff_id, "simulated stale Runner");
  }));
});
