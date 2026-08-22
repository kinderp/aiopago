import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { ContextHandoffAdvisor } from "../src/context-advisor.mjs";
import { createGuardianExtension } from "../src/extension.mjs";
import {
  formatHumanNext,
  formatHumanStatus,
  formatHumanWhy,
  formatPlan,
  observeRunnerHumanWorkflow,
  projectHumanWorkflow,
} from "../src/human-workflow.mjs";
import { TaskLedger } from "../src/ledger.mjs";

function temp() { return mkdtempSync(join(tmpdir(), "aiopago-unified-ux-")); }

function task() {
  return {
    schema_version: "0.1.0", task_id: "TASK-UX", title: "Unified human UX",
    objective: "Show one deterministic workflow on CLI and Pi.", requirements_version: "REQ-UX-1",
    plan_revision_id: "PLAN-UX-1", status: "IN_PROGRESS", completion_criteria: ["parity"], risk: "MEDIUM",
    created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z",
    current_item: "ITEM-UX-1", next_item: "ITEM-UX-2", next_step: "Finish the shared projection.",
    model_policy: "offline/fake", reasoning_policy: "off", minimal_reads: ["TASK_PLAN.md"],
    task_items: [
      { task_item_id: "ITEM-UX-1", task_id: "TASK-UX", title: "Project human state", description: "shared", status: "IN_PROGRESS", depends_on: [], completion_criteria: ["projected"], evidence: [], requirements_refs: ["0.2-E"], risk: "MEDIUM", milestone: "0.2-E", last_updated_at: "2026-08-22T00:00:00.000Z", last_updated_by: "human:test" },
      { task_item_id: "ITEM-UX-2", task_id: "TASK-UX", title: "Review UX", description: "review", status: "PLANNED", depends_on: ["ITEM-UX-1"], completion_criteria: ["reviewed"], evidence: [], requirements_refs: ["0.2-E"], risk: "LOW", milestone: "0.2-E", last_updated_at: "2026-08-22T00:00:00.000Z", last_updated_by: "human:test" },
    ],
  };
}

function writeLedger(root, value = task()) {
  const path = join(root, "TASK_PLAN.md");
  writeFileSync(path, `# UX fixture\n\n\`\`\`json task-ledger\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
  return path;
}

function runnerFixture({ contextPercent = 35, handoff = null, latch = { state: "RELEASED", generation: 0, reason: null } } = {}) {
  const root = temp();
  const path = writeLedger(root);
  const mutations = { handoff: 0, takeover: 0, resume: 0, editor: 0, provider: 0 };
  const ledger = new TaskLedger(path);
  const runner = {
    cwd: root,
    roots: { targetRoot: root, runtimeRoot: join(root, ".guardian", "runtime"), artifactRoot: join(root, ".guardian") },
    ledger,
    runnerInstanceId: "RUNNER-UX",
    runtime: { session: { sessionId: "SESSION-UX", model: { provider: "offline", id: "fake" }, thinkingLevel: "off" } },
    storage: {
      getLatch: () => ({ ...latch }),
      latestHandoffForTask: () => handoff ? structuredClone(handoff) : null,
      getRunnerSessionBinding: () => null,
      isAdmissionOpen: () => latch.state === "RELEASED",
    },
    handoffService: {
      observeGit: () => ({ repository_id: root.replaceAll("\\", "/"), workdir: root.replaceAll("\\", "/"), branch: "feat/ux", head_sha: "a".repeat(40), base_sha: "a".repeat(40), index_digest: "sha256:index", worktree_digest: "sha256:worktree" }),
    },
    contextAdvisor: new ContextHandoffAdvisor({ thresholdPercent: 50 }),
    toolTracker: { admit() {}, finish() {} },
    async handoffFromCommand() { mutations.handoff += 1; },
    async takeoverFromCommand() { mutations.takeover += 1; },
    async resumeFromCommand() { mutations.resume += 1; },
  };
  const ctx = {
    hasUI: true,
    getContextUsage: () => ({ percent: contextPercent, tokens: contextPercent, contextWindow: 100 }),
    ui: { notify() {}, async confirm() { return false; }, setEditorText() { mutations.editor += 1; } },
  };
  return { root, path, runner, ctx, mutations };
}

function install(runner) {
  const commands = new Map();
  const handlers = new Map();
  createGuardianExtension(runner)({
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
  });
  return { commands, handlers };
}

function semantic(view) {
  return {
    state: view.state,
    reason: view.reason,
    next: view.nextAction,
    objective: view.objective,
    currentActivity: view.currentActivity,
    progress: view.progress,
  };
}

async function cli(command, observation) {
  const output = [];
  const result = await runCli([command, "--target", observation.targetRoot], {
    stdout: (text) => output.push(text),
    observeHumanWorkflow: () => observation,
    checkEnvironment: () => { throw new Error("model/provider environment must not be inspected"); },
  });
  return { result, output: output.join("\n") };
}

test("0.2-E one immutable projection drives CLI and faithful Pi handlers for status/why/next/plan", async () => {
  const x = runnerFixture();
  const before = readFileSync(x.path);
  const observation = observeRunnerHumanWorkflow(x.runner, x.ctx);
  const expected = projectHumanWorkflow(observation);
  assert.equal(Object.isFrozen(expected), true);
  assert.equal(Object.isFrozen(expected.planSummary.items), true);
  assert.throws(() => { expected.progress.completed = 99; }, TypeError);
  assert.throws(() => { expected.planSummary.items[0].title = "mutated"; }, TypeError);
  assert.equal(x.runner.ledger.read().task_items[0].title, "Project human state");

  const { commands } = install(x.runner);
  const notifications = [];
  const tuiCtx = { ...x.ctx, ui: { ...x.ctx.ui, notify(text, type) { notifications.push({ text, type }); } } };
  for (const name of ["status", "why", "next", "plan"]) {
    const cliResult = await cli(name, observation);
    const tuiView = await commands.get("aio").handler(name, tuiCtx);
    assert.deepEqual(semantic(cliResult.result.view), semantic(tuiView), `${name} semantic parity`);
    assert.equal(cliResult.output, name === "status" ? formatHumanStatus(expected) : name === "why" ? formatHumanWhy(expected) : name === "next" ? formatHumanNext(expected) : formatPlan(expected));
  }
  assert.deepEqual(readFileSync(x.path), before);
  assert.deepEqual(x.mutations, { handoff: 0, takeover: 0, resume: 0, editor: 0, provider: 0 });
  assert.equal(notifications.length, 4);
});

test("runtime availability is explicit and live Runner facts remain derived rather than authoritative", () => {
  const plan = { valid: true, path: "/repo/TASK_PLAN.md", digest: "sha256:plan", plan: task() };
  for (const [runtime, availability, code] of [
    [{ available: false, verified: false, condition: "NO_RUNTIME_DATABASE", error: { code: "RUNTIME_NOT_VERIFIED", message: "absent" } }, "unavailable", "RUNTIME_NOT_VERIFIED"],
    [{ available: true, verified: false, condition: "RUNTIME_NOT_QUIESCENT", error: { code: "RUNTIME_NOT_QUIESCENT", message: "changing" } }, "unverified", "RUNTIME_NOT_QUIESCENT"],
    [{ available: true, verified: false, condition: "RUNTIME_READ_FAILED", error: { code: "RUNTIME_READ_FAILED", message: "read failed" } }, "unverified", "RUNTIME_READ_FAILED"],
  ]) {
    const view = projectHumanWorkflow({ initialized: true, targetRoot: "/repo", plan, runtime });
    assert.equal(view.state, "NEEDS_ATTENTION");
    assert.equal(view.runtimeSummary.availability, availability);
    assert.equal(view.technical.diagnostic.code, code);
    assert.doesNotMatch(view.reason, /normal|sano|healthy/i);
  }
  const malformedLive = projectHumanWorkflow({ initialized: true, targetRoot: "/repo", plan, runtime: { available: true, verified: true, condition: "LIVE_RUNNER" } });
  assert.equal(malformedLive.state, "NEEDS_ATTENTION");
  assert.equal(malformedLive.technical.diagnostic.code, "RUNTIME_OBSERVATION_INVALID");

  const x = runnerFixture({ contextPercent: 78 });
  const live = projectHumanWorkflow(observeRunnerHumanWorkflow(x.runner, x.ctx));
  assert.equal(live.runtimeSummary.verified, true);
  assert.equal(live.runtimeSummary.availability, "available");
  assert.equal(live.handoff.recommendation, "recommended");
  assert.equal(live.humanControl.latchState, "RELEASED");
  assert.equal(Object.hasOwn(live, "storage"), false);
});

test("invalid TASK_PLAN has the same projected state/reason/next in CLI and Pi without mutation", async () => {
  const x = runnerFixture();
  writeFileSync(x.path, "# invalid human plan\n");
  const before = readFileSync(x.path);
  const observation = observeRunnerHumanWorkflow(x.runner, x.ctx);
  const cliResult = await cli("status", observation);
  const { commands } = install(x.runner);
  const tuiView = await commands.get("aio").handler("status", x.ctx);
  assert.deepEqual(semantic(cliResult.result.view), semantic(tuiView));
  assert.equal(tuiView.state, "NEEDS_ATTENTION");
  assert.equal(tuiView.technical.diagnostic.code, "LEDGER_FORMAT_INVALID");
  assert.deepEqual(readFileSync(x.path), before);
});

test("technical disclosure retains plan, Runner, Git, latch, handoff, session, model and context identifiers", async () => {
  const handoff = { handoff_id: "HO-UX", state: "RESUME_READY", target_session_id: "SESSION-UX", manual_recovery: [] };
  const x = runnerFixture({ contextPercent: 63, handoff, latch: { state: "ENGAGED", generation: 4, reason: "INTEGRITY" } });
  x.runner.storage.getRunnerSessionBinding = () => ({ status: "ACTIVE" });
  const { commands } = install(x.runner);
  const notices = [];
  const ctx = { ...x.ctx, ui: { ...x.ctx.ui, notify(text) { notices.push(text); } } };
  await commands.get("aio").handler("status technical", ctx);
  await commands.get("aio").handler("plan technical", ctx);
  const output = notices.join("\n");
  for (const expected of ["TASK-UX", "PLAN-UX-1", "RUNNER-UX", "SESSION-UX", "offline/fake", "feat/ux", "generation=4", "HO-UX", "63%"] ) assert.match(output, new RegExp(expected.replace("/", "\\/")));
});

function advisorHarness({ decision = true, handoffImpl = null } = {}) {
  const x = runnerFixture({ contextPercent: 60 });
  let admissionOpen = true;
  x.runner.storage.isAdmissionOpen = () => admissionOpen;
  x.runner.handoffFromCommand = handoffImpl ?? (async (_ctx, mode) => { assert.equal(mode, "confirm"); x.mutations.handoff += 1; });
  const confirmations = [];
  let resolveDecision;
  const pendingDecision = decision === "deferred" ? new Promise((resolve) => { resolveDecision = resolve; }) : null;
  const ctx = {
    ...x.ctx,
    ui: {
      notify() {},
      async confirm(_title, text) { confirmations.push(text); return pendingDecision ?? decision; },
      setEditorText() { throw new Error("editor command ceremony is forbidden"); },
    },
  };
  const installed = install(x.runner);
  return { ...x, ...installed, ctx, confirmations, resolveDecision, setAdmission(value) { admissionOpen = value; } };
}

test("guided advisor NO performs no handoff mutation and YES invokes the trusted use case exactly once without editor ceremony", async () => {
  const no = advisorHarness({ decision: false });
  await no.handlers.get("turn_end")({}, no.ctx);
  assert.equal(no.confirmations.length, 1);
  assert.equal(no.mutations.handoff, 0);
  assert.equal(no.mutations.editor, 0);

  const yes = advisorHarness({ decision: true });
  await yes.handlers.get("turn_end")({}, yes.ctx);
  await yes.handlers.get("turn_end")({}, yes.ctx);
  assert.equal(yes.confirmations.length, 1);
  assert.equal(yes.mutations.handoff, 1);
  assert.equal(yes.mutations.resume, 0, "guided preparation does not authorize resume");
  assert.equal(yes.mutations.editor, 0);
});

test("guided advisor deduplicates concurrent events and cancels safely on takeover/existing handoff/session shutdown", async (t) => {
  await t.test("two turn_end events", async () => {
    const x = advisorHarness({ decision: "deferred" });
    const first = x.handlers.get("turn_end")({}, x.ctx);
    const second = x.handlers.get("turn_end")({}, x.ctx);
    x.resolveDecision(true);
    await Promise.all([first, second]);
    assert.equal(x.confirmations.length, 1);
    assert.equal(x.mutations.handoff, 1);
  });
  await t.test("takeover wins during prompt", async () => {
    const x = advisorHarness({ decision: "deferred" });
    const pending = x.handlers.get("turn_end")({}, x.ctx);
    x.setAdmission(false);
    x.resolveDecision(true);
    await pending;
    assert.equal(x.mutations.handoff, 0);
  });
  await t.test("existing handoff closes admission before advisory", async () => {
    const x = advisorHarness({ decision: true });
    x.setAdmission(false);
    await x.handlers.get("turn_end")({}, x.ctx);
    assert.equal(x.confirmations.length, 0);
    assert.equal(x.mutations.handoff, 0);
  });
  await t.test("session shutdown during prompt", async () => {
    const x = advisorHarness({ decision: "deferred" });
    const pending = x.handlers.get("turn_end")({}, x.ctx);
    x.handlers.get("session_shutdown")({}, x.ctx);
    x.resolveDecision(true);
    await pending;
    assert.equal(x.mutations.handoff, 0);
  });
});

test("guided handoff errors retain their precise code, actionable next step and no automatic retry", async () => {
  const error = Object.assign(new Error("replacement outcome ambiguous"), { code: "HANDOFF_FAILED" });
  const x = advisorHarness({ decision: true, handoffImpl: async () => { x.mutations.handoff += 1; throw error; } });
  const notices = [];
  x.ctx.ui.notify = (text, type) => notices.push({ text, type });
  await x.handlers.get("turn_end")({}, x.ctx);
  await x.handlers.get("turn_end")({}, x.ctx);
  assert.equal(x.mutations.handoff, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /HANDOFF_FAILED/);
  assert.match(notices[0].text, /Prossima azione:/);
  assert.match(notices[0].text, /non ritenterà automaticamente/);
});
