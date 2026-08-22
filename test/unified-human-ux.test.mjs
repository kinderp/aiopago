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
  formatHumanTechnical,
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
  const initialPlan = ledger.read();
  const authority = {
    latch: structuredClone(latch),
    handoff: handoff ? {
      task_id: initialPlan.task_id,
      source_session_id: "SESSION-SOURCE",
      runner_instance_id: "RUNNER-UX",
      task_plan_revision: initialPlan.plan_revision_id,
      task_plan_digest: initialPlan.content_digest,
      latch_generation: latch.generation,
      authorization_state: "NOT_AUTHORIZED",
      admission_state: "NOT_COMMITTED",
      dispatch_state: "NOT_STARTED",
      failure: null,
      manual_recovery: [],
      ...structuredClone(handoff),
    } : null,
  };
  const runner = {
    cwd: root,
    roots: { targetRoot: root, runtimeRoot: join(root, ".guardian", "runtime"), artifactRoot: join(root, ".guardian") },
    ledger,
    runnerInstanceId: "RUNNER-UX",
    runtime: { session: { sessionId: "SESSION-UX", model: { provider: "offline", id: "fake" }, thinkingLevel: "off" } },
    storage: {
      getLatch: () => structuredClone(authority.latch),
      latestHandoffForTask: () => authority.handoff ? structuredClone(authority.handoff) : null,
      getRunnerSessionBinding: () => null,
      isAdmissionOpen: () => authority.latch.state === "RELEASED",
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
  return { root, path, runner, ctx, mutations, authority };
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

function verifiedObservation({ planValue = task(), runtime = {} } = {}) {
  const plan = { valid: true, path: "/repo/TASK_PLAN.md", digest: "sha256:plan", plan: planValue };
  return {
    initialized: true,
    targetRoot: "/repo",
    plan,
    runtime: {
      available: true,
      verified: true,
      workflow: "LIVE_RUNNER",
      condition: "LIVE_RUNNER",
      error: null,
      planIdentity: { taskId: planValue.task_id, revision: planValue.plan_revision_id, digest: plan.digest },
      session: { id: "SESSION-1", runnerInstanceId: "RUNNER-1", model: "offline/fake", reasoning: "off", ownership: "source" },
      latch: { state: "RELEASED", generation: 4, reason: null },
      handoff: null,
      context: { availability: "available", percent: 35, tokens: 35, contextWindow: 100, thresholdPercent: 50, recommended: false },
      git: null,
      ...runtime,
    },
  };
}

function verifiedHandoff(observation, overrides = {}) {
  return {
    handoff_id: "HO-1",
    state: "RESUMED",
    task_id: observation.plan.plan.task_id,
    source_session_id: "SESSION-SOURCE",
    target_session_id: "SESSION-1",
    runner_instance_id: "RUNNER-1",
    task_plan_revision: observation.plan.plan.plan_revision_id,
    task_plan_digest: observation.plan.digest,
    latch_generation: 3,
    authorization_state: "AUTHORIZED",
    admission_state: "COMMITTED",
    dispatch_state: "ACKNOWLEDGED",
    failure: null,
    manual_recovery: [],
    ...overrides,
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

test("verified runtime coherence validator fails the public projector closed before every positive state", async (t) => {
  const malformed = [
    ["missing session ID", (o) => { delete o.runtime.session.id; }],
    ["malformed session ID", (o) => { o.runtime.session.id = ""; }],
    ["missing latch", (o) => { delete o.runtime.latch; }],
    ["malformed latch generation", (o) => { o.runtime.latch.generation = "4"; }],
    ["unknown latch state", (o) => { o.runtime.latch.state = "FUTURE"; }],
    ["handoff state missing handoff ID", (o) => { o.runtime.handoff = verifiedHandoff(o); delete o.runtime.handoff.handoff_id; }],
    ["failure state missing failure code", (o) => { o.runtime.handoff = verifiedHandoff(o, { state: "HANDOFF_FAILED", target_session_id: null, failure: { message: "failed" } }); }],
    ["healthy workflow carrying a runtime error", (o) => { o.runtime.error = { code: "BROKEN", message: "contradiction" }; }],
    ["healthy workflow carrying a top-level failure object", (o) => { o.runtime.failure = { code: "BROKEN", message: "contradiction" }; }],
    ["malformed nested handoff object", (o) => { o.runtime.handoff = []; }],
    ["mismatched runtime task binding", (o) => { o.runtime.planIdentity.taskId = "TASK-OTHER"; }],
    ["unknown verified workflow", (o) => { o.runtime.workflow = "FUTURE_HEALTHY"; }],
    ["malformed nested context", (o) => { o.runtime.context.percent = Number.NaN; }],
  ];
  for (const [name, mutate] of malformed) {
    await t.test(name, () => {
      const observation = verifiedObservation();
      mutate(observation);
      const view = projectHumanWorkflow(observation);
      assert.equal(view.state, "NEEDS_ATTENTION");
      assert.equal(view.runtimeSummary.verified, false);
      assert.equal(view.technical.diagnostic.code, "RUNTIME_OBSERVATION_INVALID");
      assert.doesNotMatch(view.state, /WORKING|COMPLETED/);
    });
  }

  const working = projectHumanWorkflow(verifiedObservation());
  assert.equal(working.state, "WORKING");
  const donePlan = task();
  donePlan.status = "DONE";
  donePlan.current_item = null;
  donePlan.next_item = null;
  donePlan.task_items = donePlan.task_items.map((item) => ({ ...item, status: "DONE", evidence: ["verified"] }));
  const completed = projectHumanWorkflow(verifiedObservation({ planValue: donePlan }));
  assert.equal(completed.state, "COMPLETED");
});

test("technical output preserves nested handoff/continuity root failure identity without aliasing caller data", () => {
  for (const [state, code, message] of [
    ["HANDOFF_FAILED", "REPLACEMENT_SESSION_CREATE_UNKNOWN", "replacement outcome is ambiguous"],
    ["CONTINUITY_FAILED", "REQUIRED_LOCAL_PATH_MISSING", "Required local path docs/resume.md is missing"],
  ]) {
    const observation = verifiedObservation({ runtime: { latch: { state: "ENGAGED", generation: 5, reason: "INTEGRITY" } } });
    const failure = { code, message };
    observation.runtime.handoff = verifiedHandoff(observation, { state, failure, manual_recovery: ["inspect safely"] });
    const view = projectHumanWorkflow(observation);
    assert.equal(view.technical.runtime.failure.code, code);
    assert.notEqual(view.technical.runtime.failure, failure);
    assert.equal(Object.isFrozen(view.technical.runtime.failure), true);
    assert.equal(Object.isFrozen(failure), false);
    const output = formatHumanTechnical(view);
    assert.match(output, new RegExp(code));
    assert.match(output, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, /condition=LIVE_RUNNER/);
    assert.match(output, new RegExp(`state=${state}`));
    failure.code = "CALLER_MUTATED";
    failure.message = "caller changed";
    assert.equal(view.technical.runtime.failure.code, code);
    assert.doesNotMatch(formatHumanTechnical(view), /CALLER_MUTATED|caller changed/);
  }

  const runtimeError = verifiedObservation();
  runtimeError.runtime.verified = false;
  runtimeError.runtime.workflow = "NEEDS_ATTENTION";
  runtimeError.runtime.condition = "RUNTIME_READ_FAILED";
  runtimeError.runtime.error = { code: "SQLITE_CORRUPT", message: "runtime database cannot be read" };
  const runtimeOutput = formatHumanTechnical(projectHumanWorkflow(runtimeError));
  assert.match(runtimeOutput, /SQLITE_CORRUPT/);
  assert.match(runtimeOutput, /runtime database cannot be read/);

  const noFailure = formatHumanTechnical(projectHumanWorkflow(verifiedObservation()));
  assert.doesNotMatch(noFailure, /Runtime failure code:/);
  const bounded = verifiedObservation();
  bounded.runtime.verified = false;
  bounded.runtime.condition = "RUNTIME_READ_FAILED";
  bounded.runtime.workflow = "NEEDS_ATTENTION";
  bounded.runtime.error = { code: "UNKNOWN_RUNTIME_DIAGNOSTIC", message: `unknown ${" detail".repeat(100)}` };
  const boundedView = projectHumanWorkflow(bounded);
  assert.equal(boundedView.technical.diagnostic.code, "UNKNOWN_RUNTIME_DIAGNOSTIC");
  assert.ok(boundedView.technical.diagnostic.message.length <= 320);
});

test("PLAN_CHANGED_DURING_READ requests re-observation and does not describe plan corruption", () => {
  const observation = {
    initialized: true,
    targetRoot: "/repo",
    plan: {
      valid: false,
      path: "/repo/TASK_PLAN.md",
      error: { code: "PLAN_CHANGED_DURING_READ", message: "plan moved" },
    },
    runtime: { available: false, verified: false },
  };
  const view = projectHumanWorkflow(observation);
  assert.equal(view.state, "NEEDS_ATTENTION");
  assert.equal(view.technical.diagnostic.code, "PLAN_CHANGED_DURING_READ");
  assert.match(`${view.reason} ${view.nextAction}`, /cambiat|osserva di nuovo/i);
  assert.doesNotMatch(`${view.reason} ${view.nextAction}`, /non è valido|correggi manualmente|plan --check/i);
  const planOutput = formatPlan(view);
  assert.match(planOutput, /cambiato durante la lettura|osserva di nuovo/i);
  assert.doesNotMatch(planOutput, /non valido|plan --check|correggi manualmente/i);
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

test("/aio status technical renders exact durable continuity failure code and message", async () => {
  const x = runnerFixture({
    latch: { state: "ENGAGED", generation: 7, reason: "INTEGRITY" },
    handoff: {
      handoff_id: "HO-CONTINUITY",
      state: "CONTINUITY_FAILED",
      target_session_id: "SESSION-UX",
      failure: { code: "REQUIRED_LOCAL_PATH_MISSING", message: "Required local path docs/local.md is missing" },
    },
  });
  const notices = [];
  x.ctx.ui.notify = (text) => notices.push(text);
  const { commands } = install(x.runner);
  await commands.get("aio").handler("status technical", x.ctx);
  assert.match(notices[0], /CONTINUITY_FAILED/);
  assert.match(notices[0], /REQUIRED_LOCAL_PATH_MISSING/);
  assert.match(notices[0], /Required local path docs\/local\.md is missing/);
});

function runnerHandoff(x, overrides = {}) {
  const plan = x.runner.ledger.read();
  return {
    handoff_id: "HO-OLD",
    state: "RESUMED",
    task_id: plan.task_id,
    source_session_id: "SESSION-SOURCE",
    target_session_id: x.runner.runtime.session.sessionId,
    runner_instance_id: x.runner.runnerInstanceId,
    task_plan_revision: plan.plan_revision_id,
    task_plan_digest: plan.content_digest,
    latch_generation: Math.max(0, x.authority.latch.generation - 1),
    authorization_state: "AUTHORIZED",
    admission_state: "COMMITTED",
    dispatch_state: "ACKNOWLEDGED",
    failure: null,
    manual_recovery: [],
    ...overrides,
  };
}

function advisorHarness({ decision = true, handoffImpl = null, handoff = null } = {}) {
  const x = runnerFixture({ contextPercent: 60, handoff });
  let admissionOpen = true;
  x.runner.storage.isAdmissionOpen = () => admissionOpen;
  x.runner.handoffFromCommand = handoffImpl ?? (async (_ctx, mode) => { assert.equal(mode, "confirm"); x.mutations.handoff += 1; });
  const confirmations = [];
  const notices = [];
  let resolveDecision;
  const pendingDecision = decision === "deferred" ? new Promise((resolve) => { resolveDecision = resolve; }) : null;
  const ctx = {
    ...x.ctx,
    ui: {
      notify(text, type) { notices.push({ text, type }); },
      async confirm(_title, text) { confirmations.push(text); return pendingDecision ?? decision; },
      setEditorText() { throw new Error("editor command ceremony is forbidden"); },
    },
  };
  const installed = install(x.runner);
  return { ...x, ...installed, ctx, confirmations, notices, resolveDecision, setAdmission(value) { admissionOpen = value; } };
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

test("guided preparation consent is bound to exact plan/session/latch/handoff/Runner authority identity", async (t) => {
  async function stale(name, mutate, options = {}) {
    await t.test(name, async () => {
      const x = advisorHarness({ decision: "deferred", ...options });
      const pending = x.handlers.get("turn_end")({}, x.ctx);
      assert.equal(x.confirmations.length, 1, "identity is captured before the prompt is displayed");
      await mutate(x);
      x.resolveDecision(true);
      await pending;
      assert.equal(x.mutations.handoff, 0, "stale YES must not cross the trusted mutation boundary");
      assert.equal(x.notices.length, 1);
      assert.match(x.notices[0].text, /stato è cambiato.*handoff non è stato avviato/i);
    });
  }

  await stale("plan revision changes during prompt", (x) => {
    writeLedger(x.root, { ...task(), plan_revision_id: "PLAN-R1-2", updated_at: "2026-08-22T00:01:00.000Z" });
  });
  await stale("plan digest changes while revision and visible status remain", (x) => {
    writeLedger(x.root, { ...task(), objective: "Same status, different authoritative plan bytes." });
  });
  await stale("plan and session both move from R1/S1 to R2/S2", (x) => {
    writeLedger(x.root, { ...task(), plan_revision_id: "PLAN-R1-2", updated_at: "2026-08-22T00:01:00.000Z" });
    x.runner.runtime.session = { ...x.runner.runtime.session, sessionId: "SESSION-S2" };
  });
  await stale("session ID changes with the same model", (x) => {
    x.runner.runtime.session = { ...x.runner.runtime.session, sessionId: "SESSION-S2" };
  });
  await stale("latch state changes", (x) => {
    x.authority.latch = { state: "ENGAGED", generation: 5, reason: "HUMAN_TAKEOVER" };
  });
  await stale("latch ABA returns RELEASED with a new generation", (x) => {
    x.authority.latch = { state: "RELEASED", generation: 5, reason: null };
  });
  await stale("handoff appears while prompt is open", (x) => {
    x.authority.handoff = runnerHandoff(x, { handoff_id: "HO-NEW" });
  });
  await stale("existing terminal handoff identity changes", (x) => {
    x.authority.handoff.handoff_id = "HO-CHANGED";
  }, { handoff: { handoff_id: "HO-OLD", state: "RESUMED", target_session_id: "SESSION-UX" } });
  await stale("Runner instance replacement invalidates consent", (x) => {
    x.runner.runnerInstanceId = "RUNNER-REPLACEMENT";
  });

  await t.test("no state movement invokes trusted handoff exactly once", async () => {
    const x = advisorHarness({ decision: true });
    await x.handlers.get("turn_end")({}, x.ctx);
    assert.equal(x.mutations.handoff, 1);
  });
  await t.test("context percentage movement alone does not stale authority consent", async () => {
    const x = advisorHarness({ decision: "deferred" });
    const pending = x.handlers.get("turn_end")({}, x.ctx);
    x.ctx.getContextUsage = () => ({ percent: 88, tokens: 88, contextWindow: 100 });
    x.resolveDecision(true);
    await pending;
    assert.equal(x.mutations.handoff, 1);
  });
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
    x.authority.latch = { state: "ENGAGED", generation: 1, reason: "HUMAN_TAKEOVER" };
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
