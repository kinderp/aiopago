import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.mjs";
import {
  CONTEXT_HANDOFF_THRESHOLD_ENV,
  LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV,
  ContextHandoffAdvisor,
  contextHandoffThreshold,
  contextHandoffThresholdEnvironment,
} from "../src/context-advisor.mjs";
import { GuardianError } from "../src/errors.mjs";
import { createGuardianExtension } from "../src/extension.mjs";
import { observeGitState, sameGitState } from "../src/git-state.mjs";
import { HandoffService, verifyRequiredLocalPaths } from "../src/handoff.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { LEGACY_RUNNER_BINDING_CUSTOM_TYPE, readRuntimeRunnerBinding, verifyRunnerOwnership } from "../src/runner-ownership.mjs";
import { AdmissionGate, SafePointCoordinator, TOOL_PROFILES, ToolOperationTracker } from "../src/safety.mjs";
import { GuardianStorage } from "../src/storage.mjs";

function temp() { return mkdtempSync(join(tmpdir(), "aiopago-core-")); }

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

test("context threshold environment uses Aiopago canonically and fails on incompatible legacy values", () => {
  const warnings = [];
  const options = { warn: (message) => warnings.push(message) };
  assert.equal(contextHandoffThresholdEnvironment({ [CONTEXT_HANDOFF_THRESHOLD_ENV]: "40" }, options), "40");
  assert.equal(contextHandoffThresholdEnvironment({ [LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV]: "45" }, options), "45");
  assert.equal(contextHandoffThresholdEnvironment({ [CONTEXT_HANDOFF_THRESHOLD_ENV]: "50", [LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV]: "50" }, options), "50");
  assert.equal(warnings.length, 2);
  assert.throws(
    () => contextHandoffThresholdEnvironment({ [CONTEXT_HANDOFF_THRESHOLD_ENV]: "40", [LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV]: "60" }, options),
    (error) => error.code === "CONTEXT_HANDOFF_THRESHOLD_ENV_CONFLICT",
  );
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
  assert.equal(prepared, "/aio handoff confirm");
  assert.equal(automaticHandoffs, 0);
});

function minimalTask(overrides = {}) {
  return {
    schema_version: "0.1.0", task_id: "TASK-T", title: "t", objective: "o",
    requirements_version: "REQ-1", plan_revision_id: "PLAN-1", status: "IN_PROGRESS",
    completion_criteria: ["tested"], risk: "HIGH", created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z", current_item: "ITEM-1", next_item: null, next_step: "next",
    task_items: [{ task_item_id: "ITEM-1", task_id: "TASK-T", title: "i", description: "d", status: "IN_PROGRESS", depends_on: [], completion_criteria: ["x"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "M1-H0", last_updated_at: "2026-08-08T00:00:00Z", last_updated_by: "human" }],
    ...overrides,
  };
}

function writeLedger(path, task) {
  writeFileSync(path, `# Ledger\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

function minimalLedger(path, overrides = {}) {
  writeLedger(path, minimalTask(overrides));
}

function twoItemActiveTask() {
  const task = minimalTask({ next_item: "ITEM-2", next_step: "Complete ITEM-1, then continue ITEM-2" });
  task.task_items.push({
    ...task.task_items[0], task_item_id: "ITEM-2", title: "i2", description: "d2", status: "PLANNED",
    depends_on: ["ITEM-1"], last_updated_by: "agent",
  });
  return task;
}

test("Ledger status vocabulary remains canonical and rejects PENDING", () => {
  const root = temp(); const path = join(root, "TASK_PLAN.md");
  const allowed = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED", "SUPERSEDED"];
  for (const status of allowed) {
    const task = minimalTask({ status });
    task.task_items[0].status = status;
    task.current_item = status === "IN_PROGRESS" ? "ITEM-1" : null;
    task.next_item = ["PLANNED", "BLOCKED"].includes(status) ? "ITEM-1" : null;
    if (status === "DONE") {
      task.evidence = ["task verified"];
      task.task_items[0].evidence = ["item verified"];
    }
    if (["DROPPED", "SUPERSEDED"].includes(status)) {
      const terminal = { terminal_reason: "terminal fixture", terminal_actor: "human:test", terminal_at: "2026-01-01T00:00:00.000Z" };
      Object.assign(task, terminal); Object.assign(task.task_items[0], terminal);
    }
    if (status === "SUPERSEDED") {
      task.task_items[0].superseded_by = "ITEM-2";
      task.task_items.push({ ...minimalTask().task_items[0], task_item_id: "ITEM-2", status: "PLANNED", supersedes: "ITEM-1" });
    }
    writeLedger(path, task);
    assert.equal(new TaskLedger(path).read().status, status);
  }

  minimalLedger(path, { status: "PENDING" });
  assert.throws(() => new TaskLedger(path).read(), (error) => {
    assert.equal(error.code, "LEDGER_STATUS_INVALID");
    assert.equal(error.message, `task status must be one of ${allowed.join(", ")}`);
    return true;
  });

  const pendingItem = twoItemActiveTask();
  pendingItem.task_items[1].status = "PENDING";
  writeLedger(path, pendingItem);
  assert.throws(() => new TaskLedger(path).read(), (error) => {
    assert.equal(error.code, "LEDGER_ITEM_STATUS_INVALID");
    assert.equal(error.message, `item status must be one of ${allowed.join(", ")}`);
    return true;
  });
});

test("Ledger validates the dogfood active-to-canonical-blocked transition", () => {
  const root = temp(); const path = join(root, "TASK_PLAN.md");
  const active = twoItemActiveTask();
  writeLedger(path, active);
  const activeRead = new TaskLedger(path).read();
  assert.equal(activeRead.status, "IN_PROGRESS");
  assert.equal(activeRead.current_item, "ITEM-1");
  assert.equal(activeRead.next_item, "ITEM-2");

  const blocked = structuredClone(active);
  blocked.status = "BLOCKED";
  blocked.task_items[0].status = "BLOCKED";
  blocked.current_item = null;
  blocked.next_item = "ITEM-1";
  blocked.next_step = "Blocker: external approval; unblock when approved; resume ITEM-1.";
  writeLedger(path, blocked);
  const blockedRead = new TaskLedger(path).read();
  assert.equal(blockedRead.status, "BLOCKED");
  assert.equal(blockedRead.current_item, null);
  assert.equal(blockedRead.next_item, "ITEM-1");
  assert.deepEqual(blockedRead.task_items.map((item) => item.status), ["BLOCKED", "PLANNED"]);
});

test("Ledger accepts a final active item with no future item", () => {
  const root = temp(); const path = join(root, "TASK_PLAN.md");
  const task = twoItemActiveTask();
  task.task_items[0].status = "DONE";
  task.task_items[0].evidence = ["ITEM-1 verified"];
  task.task_items[1].status = "IN_PROGRESS";
  task.current_item = "ITEM-2";
  task.next_item = null;
  task.next_step = "Finish ITEM-2";
  writeLedger(path, task);
  const read = new TaskLedger(path).read();
  assert.equal(read.current_item, "ITEM-2");
  assert.equal(read.next_item, null);
});

test("Ledger rejects a blocked current_item and identical current/next item", () => {
  const root = temp(); const path = join(root, "TASK_PLAN.md");
  const blockedCurrent = minimalTask({ status: "BLOCKED", current_item: "ITEM-1", next_item: null });
  blockedCurrent.task_items[0].status = "BLOCKED";
  writeLedger(path, blockedCurrent);
  assert.throws(
    () => new TaskLedger(path).read(),
    (error) => error.code === "LEDGER_CURRENT_ITEM_MISMATCH" && error.message === "current_item must reference the sole IN_PROGRESS item",
  );

  const sameItem = twoItemActiveTask();
  sameItem.next_item = "ITEM-1";
  writeLedger(path, sameItem);
  assert.throws(
    () => new TaskLedger(path).read(),
    (error) => error.code === "LEDGER_LIFECYCLE_INVALID" && error.message === "current_item and next_item must differ",
  );
});

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
  await assert.doesNotReject(() => commands.get("aio").handler("status", ctx));
  await assert.doesNotReject(() => commands.get("aio").handler("handoff confirm", ctx));
  assert.equal(handoffStarts, 0);
  assert.equal(notifications.length, 8);
  for (const notification of notifications) {
    assert.match(notification.text, /^Aiopago Ledger invalid:\nLEDGER_LIFECYCLE_INVALID — current_item and next_item must differ\.\nRepair TASK_PLAN\.md before continuing\.$/);
    assert.doesNotMatch(notification.text, /\n\s+at |Extension \"inline:aiopago\" error/);
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

test("a pre-rename Ledger heading and owner command remain readable and advance through canonical aio", () => {
  const root = temp(); const path = join(root, "TASK_PLAN.md");
  const task = minimalTask({
    status: "BLOCKED",
    current_item: null,
    next_item: "ITEM-1",
    next_step: "Owner gate: execute /eio handoff confirm",
    owner_gate: {
      kind: "HANDOFF_CONFIRM",
      status: "BLOCKED",
      command: "/eio handoff confirm",
      item_id: "ITEM-1",
      satisfied_plan_revision_id: "PLAN-2",
      satisfied_task_status: "IN_PROGRESS",
      satisfied_next_item: null,
      satisfied_next_step: "Continue the bounded item",
    },
  });
  task.task_items[0].status = "BLOCKED";
  writeFileSync(path, `# Eiopago Task Ledger\n\n**Schema:** \`eiopago.task-ledger/0.1.0\`\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
  const ledger = new TaskLedger(path);
  assert.equal(ledger.read().owner_gate.command, "/eio handoff confirm");
  const advanced = ledger.satisfyOwnerGate({ command: "/aio handoff confirm", actor: "human:/aio-handoff" });
  assert.equal(advanced.owner_gate.status, "SATISFIED");
  assert.equal(advanced.current_item, "ITEM-1");
});

test("Ledger preserves semantic minimal-read directives and validates only explicit required local paths", () => {
  const root = temp(); const path = join(root, "TASK_PLAN.md");
  const directives = [
    "AGENTS.md section 18",
    "CHECKPOINT.md",
    "TASK_PLAN.md",
    "Complete PR #679 diff against its current base",
    "Current PR #679 status, checks, reviews, and discussions",
  ];
  minimalLedger(path, { minimal_reads: directives, required_local_paths: ["docs/required.md"] });
  const plan = new TaskLedger(path).read();
  assert.deepEqual(plan.minimal_reads, directives);
  assert.deepEqual(plan.required_local_paths, ["docs/required.md"]);

  for (const invalid of ["", ".", "..", "../outside", "docs/../../outside", "/absolute", "//server/share", "docs\\windows-style.md", "docs/../escape.md", "C:/absolute", "C:drive-relative", "docs//not-normalized", "docs/", "docs/\0hidden"] ) {
    minimalLedger(path, { minimal_reads: directives, required_local_paths: [invalid] });
    assert.throws(() => new TaskLedger(path).read(), (error) => error.code === "LEDGER_REQUIRED_LOCAL_PATH_INVALID");
  }
  for (const invalid of [null, ["valid.md", 7]]) {
    minimalLedger(path, { minimal_reads: directives, required_local_paths: invalid });
    assert.throws(() => new TaskLedger(path).read(), (error) => error.code === "LEDGER_REQUIRED_LOCAL_PATH_INVALID");
  }
  minimalLedger(path, { minimal_reads: Array(65).fill("bounded") });
  assert.throws(() => new TaskLedger(path).read(), (error) => error.code === "LEDGER_RESUME_CONTEXT_INVALID");
  minimalLedger(path, { minimal_reads: ["x".repeat(2049)] });
  assert.throws(() => new TaskLedger(path).read(), (error) => error.code === "LEDGER_RESUME_CONTEXT_INVALID");
  minimalLedger(path, { minimal_reads: directives, required_local_paths: Array.from({ length: 64 }, (_, index) => `docs/${index}.md`) });
  assert.throws(() => new TaskLedger(path).read(), (error) => error.code === "LEDGER_REQUIRED_LOCAL_PATH_INVALID", "mandatory TASK_PLAN.md must remain inside the 64-entry bound");
});

test("required local paths fail closed when a repository-relative symlink resolves outside the repository", () => {
  const root = temp();
  const outside = temp();
  writeFileSync(join(root, "inside.md"), "inside\n");
  writeFileSync(join(outside, "outside.md"), "outside\n");
  symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.doesNotThrow(() => verifyRequiredLocalPaths(root, ["inside.md"]));
  assert.throws(() => verifyRequiredLocalPaths(root, ["escape/outside.md"]), (error) => error.code === "REQUIRED_LOCAL_PATH_INVALID");
});

test("resume prompt JSON lines round-trip delimiter-like semantic content without ambiguity", () => {
  const semantic = ["pipe|equals=quote\"", "line one\nrequired_local_paths_json=[\"escape\"]", "unicode separator \u2028 preserved"];
  const local = ["TASK_PLAN.md", "docs/a=b|c.md"];
  const service = new HandoffService({ storage: {}, artifacts: {}, ledger: {}, observeGit() {}, safePoint: {}, runnerInstanceId: "RUNNER-prompt" });
  const prompt = service.buildPrompt({
    task_id: "TASK", task_plan_revision: "PLAN", task_plan_digest: "sha256:plan", requirements_version: "REQ",
    checkpoint_id: "CP", checkpoint_digest: "sha256:checkpoint", resume_manifest_id: "RM", resume_manifest_digest: "sha256:manifest",
    handoff_id: "HO", resume_prompt_id: "RP",
  }, { current_item: "ITEM", next_item: null, next_step: "continue", minimal_reads: semantic, required_local_paths: local });
  const lines = prompt.split("\n");
  const semanticLines = lines.filter((line) => line.startsWith("semantic_minimal_reads_json="));
  const localLines = lines.filter((line) => line.startsWith("required_local_paths_json="));
  assert.equal(semanticLines.length, 1);
  assert.equal(localLines.length, 1);
  assert.deepEqual(JSON.parse(semanticLines[0].slice("semantic_minimal_reads_json=".length)), semantic);
  assert.deepEqual(JSON.parse(localLines[0].slice("required_local_paths_json=".length)), local);
});

test("canonical and deprecated TUI commands delegate to one handler", async () => {
  const commands = new Map();
  const pi = { registerCommand(name, command) { commands.set(name, command); }, on() {} };
  const calls = [];
  const notifications = [];
  const runner = { async recoverHandoffFromCommand(_ctx, id) { calls.push(id); } };
  createGuardianExtension(runner)(pi);
  const ctx = { ui: { notify(text, type) { notifications.push({ text, type }); } } };
  for (const name of ["aio", "eio", "eiopago"]) await commands.get(name).handler("handoff recover HO-legacy", ctx);
  assert.deepEqual(calls, ["HO-legacy", "HO-legacy", "HO-legacy"]);
  assert.deepEqual(notifications.map((item) => item.text), ["/eio is deprecated; use /aio", "/eiopago is deprecated; use /aio"]);
});

test("explicit handoff recovery command routes only with its failed handoff id", async () => {
  const commands = new Map();
  const pi = { registerCommand(name, command) { commands.set(name, command); }, on() {} };
  const calls = [];
  const runner = {
    async recoverHandoffFromCommand(ctx, id) { calls.push({ ctx, id }); },
  };
  createGuardianExtension(runner)(pi);
  const ctx = { ui: { notify() {} } };
  await commands.get("aio").handler("handoff recover HO-failed", ctx);
  assert.deepEqual(calls, [{ ctx, id: "HO-failed" }]);
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
  execFileSync("git", ["config", "user.name", "Aiopago Core"], { cwd: root });
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
  await t.test("a pre-rename custom entry remains readable", () => {
    const entry = { type: "custom", customType: LEGACY_RUNNER_BINDING_CUSTOM_TYPE, data: runtimeBinding };
    const session = { sessionId: expected.replacement_session_id, sessionManager: { getSessionId: () => expected.replacement_session_id, getEntries: () => [entry] } };
    assert.deepEqual(readRuntimeRunnerBinding(session), runtimeBinding);
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
  storage.engageLatch("TASK-T", "HUMAN_TAKEOVER", "human:/aio-takeover");
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

test("bash safety profile tracks known outcomes without journaling raw commands", async () => {
  const root = temp(); const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  const taskId = "TASK-BASH"; storage.ensureLatch(taskId);
  const tracker = new ToolOperationTracker(storage, taskId);
  const idleSession = {
    isIdle: true, isStreaming: false, pendingMessageCount: 0, isRetrying: false, isCompacting: false,
    clearQueue() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {},
    async abort() {}, async waitForIdle() {},
  };

  assert.equal(TOOL_PROFILES.bash, "SHELL_ATOMIC_OPERATION");
  assert.notEqual(TOOL_PROFILES.bash, "READ_ONLY");
  tracker.admit("OP-bash-success", "bash", { command: "printf 'secret-value'" });
  assert.equal(storage.operationsForTask(taskId)[0].state, "ACTIVE");
  tracker.finish("OP-bash-success", false, { content: [{ type: "text", text: "secret-value" }] });
  const success = storage.operationsForTask(taskId)[0];
  assert.equal(success.outcome, "KNOWN_SUCCESS");
  assert.match(success.effect_reference, /^shell:sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(success).includes("printf 'secret-value'"), false);
  const safe = new SafePointCoordinator({ storage, taskId, gate: new AdmissionGate(storage, taskId) });
  assert.equal((await safe.request(idleSession)).state, "SAFE_TO_HANDOFF", "bash success needs no input.path");

  const failureTask = "TASK-BASH-FAILURE"; storage.ensureLatch(failureTask);
  const failureTracker = new ToolOperationTracker(storage, failureTask);
  failureTracker.admit("OP-bash-failure", "bash", { command: "exit 7" });
  failureTracker.finish("OP-bash-failure", true, { content: [{ type: "text", text: "Command exited with code 7" }] });
  const failure = storage.operationsForTask(failureTask)[0];
  assert.equal(failure.outcome, "KNOWN_FAILURE");
  assert.equal(failure.effect_reference, null);
  assert.equal((await new SafePointCoordinator({ storage, taskId: failureTask, gate: new AdmissionGate(storage, failureTask) }).request(idleSession)).state, "SAFE_TO_HANDOFF");

  for (const [task, operation, finish] of [
    ["TASK-BASH-ABORT", "OP-bash-abort", (current) => current.finish("OP-bash-abort", true, { content: [{ type: "text", text: "partial\n\nCommand aborted" }] }, true)],
    ["TASK-BASH-AMBIGUOUS", "OP-bash-ambiguous", (current) => current.finish("OP-bash-ambiguous", false)],
    ["TASK-BASH-UNKNOWN", "OP-bash-unknown", (current) => current.unknown("OP-bash-unknown")],
  ]) {
    storage.ensureLatch(task);
    const current = new ToolOperationTracker(storage, task);
    current.admit(operation, "bash", { command: "opaque" });
    finish(current);
    assert.equal(storage.operationsForTask(task)[0].outcome, "UNKNOWN");
    await assert.rejects(
      () => new SafePointCoordinator({ storage, taskId: task, gate: new AdmissionGate(storage, task) }).request(idleSession),
      (error) => error.code === "HUMAN_DECISION_REQUIRED",
    );
  }

  const unchangedTask = "TASK-TOOLS-UNCHANGED"; storage.ensureLatch(unchangedTask);
  const unchanged = new ToolOperationTracker(storage, unchangedTask);
  unchanged.admit("OP-read", "read", { path: "src/read.txt" }); unchanged.finish("OP-read", false);
  unchanged.admit("OP-edit", "edit", { path: "src\\edit.txt" }); unchanged.finish("OP-edit", false);
  unchanged.admit("OP-write", "write", { path: "src/write.txt" }); unchanged.finish("OP-write", true);
  const [read, edit, write] = storage.operationsForTask(unchangedTask);
  assert.equal(read.profile, "READ_ONLY"); assert.equal(read.effect_reference, null);
  assert.equal(edit.profile, "LOCAL_ATOMIC_MUTATION"); assert.equal(edit.effect_reference, "file:src/edit.txt");
  assert.equal(write.profile, "LOCAL_ATOMIC_MUTATION"); assert.equal(write.outcome, "KNOWN_FAILURE");
  assert.throws(() => unchanged.admit("OP-unknown", "custom-shell", {}), (error) => error.code === "TOOL_PROFILE_REQUIRED");
  storage.close();
});

test("safe point waits for an active bash terminal boundary", async () => {
  const root = temp(); const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  const taskId = "TASK-BASH-DRAIN"; storage.ensureLatch(taskId);
  const tracker = new ToolOperationTracker(storage, taskId);
  tracker.admit("OP-bash-drain", "bash", { command: "node -e deterministic" });
  let releaseIdle;
  let waitStarted;
  const started = new Promise((resolve) => { waitStarted = resolve; });
  const idle = new Promise((resolve) => { releaseIdle = resolve; });
  let aborts = 0;
  const session = {
    isIdle: false, isStreaming: false, pendingMessageCount: 0, isRetrying: false, isCompacting: false,
    clearQueue() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {},
    async abort() { aborts += 1; },
    async waitForIdle() { waitStarted(); await idle; this.isIdle = true; },
  };
  const request = new SafePointCoordinator({ storage, taskId, gate: new AdmissionGate(storage, taskId) }).request(session);
  let settled = false;
  request.finally(() => { settled = true; });
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(storage.operationsForTask(taskId)[0].state, "ACTIVE");
  tracker.finish("OP-bash-drain", false, { content: [{ type: "text", text: "done" }] });
  releaseIdle();
  assert.equal((await request).state, "SAFE_TO_HANDOFF");
  assert.equal(aborts, 0, "FINISH CURRENT ATOMIC OPERATION must not abort admitted bash");
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
  const escalated = storage.engageLatch("TASK-T", "HUMAN_TAKEOVER", "human:/aio-takeover");
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
