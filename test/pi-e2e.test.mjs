import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, digestObject, sha256 } from "../src/canonical.mjs";
import { observeGitState } from "../src/git-state.mjs";
import { HandoffService } from "../src/handoff.mjs";
import { loadPi } from "../src/pi-loader.mjs";
import { GuardianRunner } from "../src/runner.mjs";
import { readRuntimeRunnerBinding, RUNNER_BINDING_CUSTOM_TYPE } from "../src/runner-ownership.mjs";
import { GuardianStorage } from "../src/storage.mjs";

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
  writeFileSync(join(root, "TASK_PLAN.md"), `# E2E Ledger\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

function fixtureLedger(root, modelPolicy = "offline-fake/offline-fake", requiredLocalPaths = undefined) {
  writeFixtureLedger(root, false, modelPolicy, requiredLocalPaths);
  writeFileSync(join(root, "CHECKPOINT.md"), "# Project checkpoint\n");
  mkdirSync(join(root, "docs"));
  for (const name of ["adr.md", "safe.md", "resume.md"]) writeFileSync(join(root, "docs", name), `# ${name}\n`);
  writeFileSync(join(root, ".gitignore"), ".guardian/\n");
}

function writeOwnerGateLedger(root) {
  const blockedStep = "Owner gate: execute /eio handoff confirm";
  const resumedStep = "Validate replacement continuity and finish H1-02 metrics";
  const task = {
    schema_version: "0.1.0", task_id: "TASK-E2E", title: "E2E owner gate", objective: "Advance a blocked handoff gate before sealing",
    requirements_version: "REQ-E2E-1", plan_revision_id: "PLAN-E2E-GATE-1", status: "BLOCKED",
    completion_criteria: ["owner gate handoff resumes"], risk: "HIGH", created_at: "2026-08-08T00:00:00Z", updated_at: "2026-08-08T00:00:00Z",
    current_item: null, next_item: "ITEM-H1-02", next_step: blockedStep,
    model_policy: "offline-fake/offline-fake", reasoning_policy: "off", minimal_reads: ["TASK_PLAN.md", "docs/adr.md", "docs/safe.md", "docs/resume.md"],
    owner_gate: {
      kind: "HANDOFF_CONFIRM", status: "BLOCKED", command: "/eio handoff confirm", item_id: "ITEM-H1-02",
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

async function makeRunner({ ownerGate = false, portableModelPolicy = false, requiredLocalPaths = undefined, existingRoot = null } = {}) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "eiopago-pi-e2e-"));
  if (!existingRoot) {
    fixtureLedger(root, portableModelPolicy ? null : "offline-fake/offline-fake", requiredLocalPaths);
    if (ownerGate) writeOwnerGateLedger(root);
    git(root, ["init"]); git(root, ["config", "user.email", "e2e@example.invalid"]); git(root, ["config", "user.name", "Eiopago E2E"]);
    git(root, ["add", "."]); git(root, ["commit", "-m", "fixture"]);
  }
  const pi = await loadPi();
  const credentials = new pi.ai.InMemoryCredentialStore();
  const modelRuntime = await pi.coding.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = { id: "offline-fake", name: "Offline fake", api: "openai-completions", provider: "offline-fake", baseUrl: "offline://local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
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
  const sessions = mkdtempSync(join(tmpdir(), "eiopago-pi-sessions-"));
  const runner = await GuardianRunner.create({ cwd: root, pi, modelRuntime, model, ...(portableModelPolicy ? {} : { modelPolicy: "offline-fake/offline-fake" }), reasoningPolicy: "off", contextHandoffThresholdPercent: 50, settingsManager: settings, sessionDir: sessions, noTools: "all" });
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

function convertFailedManifestToLegacyV1(runner, failed) {
  const index = runner.storage.getArtifact("manifest", failed.resume_manifest_id);
  const envelope = JSON.parse(readFileSync(index.path, "utf8"));
  envelope.payload.manifest_version = "1.0.0";
  delete envelope.payload.required_local_paths;
  envelope.payload.minimal_reads = [
    ...REAL_MINIMAL_READS,
    `.guardian/checkpoints/${failed.checkpoint_id}.json`,
    `.guardian/manifests/${failed.resume_manifest_id}.json`,
  ];
  envelope.payload.content_digest = null;
  envelope.payload.content_digest = digestObject(envelope.payload);
  const bytes = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
  const digest = sha256(bytes);
  writeFileSync(index.path, bytes);
  runner.storage.db.prepare("UPDATE artifacts SET digest=?,content_digest=? WHERE kind='manifest' AND artifact_id=?")
    .run(digest, envelope.payload.content_digest, failed.resume_manifest_id);
  failed.resume_manifest_digest = digest;
  delete failed.failure;
  runner.storage.saveHandoff(failed);
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
    assert.equal(serialized.includes("EIOPAGO_RESUME_V1"), true);
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

test("Pi E2E confirmed owner gate advances H1-02 before checkpoint and manifest seal", async () => {
  const x = await makeRunner({ ownerGate: true });
  try {
    const blocked = x.runner.ledger.read();
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.current_item, null);
    assert.equal(blocked.next_item, "ITEM-H1-02");
    assert.match(blocked.next_step, /\/eio handoff confirm/);
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
    assert.doesNotMatch(advanced.next_step, /\/eio handoff confirm/);
    const checkpoint = x.runner.artifacts.verify("checkpoint", result.checkpoint_id, result.checkpoint_digest);
    const manifest = x.runner.artifacts.verify("manifest", result.resume_manifest_id, result.resume_manifest_digest);
    assert.equal(checkpoint.payload.plan_revision_id, "PLAN-E2E-GATE-2");
    assert.deepEqual(checkpoint.payload.task_item_ids, ["ITEM-H1-02"]);
    assert.equal(manifest.payload.current_item, "ITEM-H1-02");
    assert.equal(manifest.payload.next_item, "ITEM-H1-03");
    assert.equal(manifest.payload.next_step, advanced.next_step);
    assert.doesNotMatch(result.resume_prompt, /next_step=.*\/eio handoff confirm/);
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

test("Pi E2E /eio takeover persists the latch and blocks the next prompt", async () => {
  const x = await makeRunner();
  try {
    await x.runner.runtime.session.prompt("/eio takeover");
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

test("Pi E2E /eio handoff manual leaves replacement paused with zero entries", async () => {
  const x = await makeRunner();
  try {
    await x.runner.runtime.session.prompt("source");
    await x.runner.runtime.session.prompt("/eio handoff manual");
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

test("CONTINUITY_FAILED recovery rejects unknown or durable resume effects and unsupported states", async (t) => {
  await t.test("UNKNOWN dispatch projection", async () => {
    const x = await makeRunner({ requiredLocalPaths: ["docs/missing-unknown.md"] });
    try {
      await assert.rejects(() => x.runner.handoffDirect({ mode: "manual", confirm: false }), (error) => error.code === "REQUIRED_LOCAL_PATH_MISSING");
      const failed = x.runner.storage.latestHandoffForTask("TASK-E2E");
      failed.dispatch_state = "UNKNOWN";
      x.runner.storage.saveHandoff(failed);
      writeFileSync(join(x.root, "docs", "missing-unknown.md"), "fixed\n");
      assert.throws(
        () => x.runner.storage.prepareContinuityRecovery(failed.handoff_id, { sourceSessionId: "SES-fresh-unknown", runnerInstanceId: "RUNNER-fresh-unknown", actor: "human:test-recovery" }),
        (error) => error.code === "CONTINUITY_RECOVERY_UNSAFE",
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
      x.runner.storage.db.prepare("INSERT INTO authorizations(resume_prompt_id,handoff_id,actor,latch_generation,authorized_at) VALUES(?,?,?,?,?)")
        .run(failed.resume_prompt_id, failed.handoff_id, "human:simulated", failed.latch_generation, "2026-08-08T00:00:00Z");
      x.runner.storage.db.prepare("INSERT INTO admissions(admission_id,resume_prompt_id,idempotency_key,handoff_id,committed_at) VALUES(?,?,?,?,?)")
        .run("ADM-simulated", failed.resume_prompt_id, "resume:simulated", failed.handoff_id, "2026-08-08T00:00:00Z");
      x.runner.storage.db.prepare("INSERT INTO dispatch_attempts(dispatch_attempt_id,admission_id,handoff_id,attempt_no,state,intent_at) VALUES(?,?,?,?,?,?)")
        .run("DSP-simulated", "ADM-simulated", failed.handoff_id, 1, "DISPATCHING", "2026-08-08T00:00:00Z");
      writeFileSync(join(x.root, "docs", "missing-durable.md"), "fixed\n");
      assert.throws(
        () => x.runner.storage.prepareContinuityRecovery(failed.handoff_id, { sourceSessionId: "SES-fresh-durable", runnerInstanceId: "RUNNER-fresh-durable", actor: "human:test-recovery" }),
        (error) => error.code === "CONTINUITY_RECOVERY_UNSAFE",
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
    x.runner.storage.saveHandoff(handoff);
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
    const other = mkdtempSync(join(tmpdir(), "eiopago-other-target-"));
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
    x.runner.storage.supersedeRunnerSessionBinding(result.handoff_id, "simulated stale Runner");
  }));
});
