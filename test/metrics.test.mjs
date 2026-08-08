import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeasurementInstrumentation, METRICS_SCHEMA_VERSION, assertTelemetrySafe, measureHandoffArtifacts } from "../src/metrics.mjs";
import { GuardianStorage } from "../src/storage.mjs";

function temp() { return mkdtempSync(join(tmpdir(), "eiopago-metrics-")); }
function plan(item = "ITEM-H2-01") {
  return { task_id: "TASK-H2", current_item: item };
}
function context(sessionId, contextUsage) {
  return {
    sessionManager: { getSessionId: () => sessionId },
    getContextUsage: () => contextUsage,
  };
}
function assistant(usage, timestamp = Date.parse("2026-08-09T00:00:01Z")) {
  return {
    message: {
      role: "assistant",
      provider: "provider-test",
      model: "model-test",
      timestamp,
      usage,
    },
  };
}
function completeUsage(overrides = {}) {
  return {
    input: 100,
    output: 20,
    reasoning: 7,
    cacheRead: 80,
    cacheWrite: 5,
    totalTokens: 205,
    cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0.005, total: 0.135 },
    ...overrides,
  };
}
function instrumentation(storage, overrides = {}) {
  return new MeasurementInstrumentation({
    storage,
    ledger: { read: () => plan(overrides.item) },
    runnerInstanceId: "RUNNER-H2",
    thresholdPercent: 50,
    retention: overrides.retention,
  });
}
function correlateTarget(storage, sessionId = "SES-target") {
  storage.reserveHandoff({
    handoff_id: "HO-H2",
    source_session_id: "SES-source",
    target_session_id: null,
    task_id: "TASK-H2",
    current_item: "ITEM-H2-01",
    checkpoint_id: "CP-H2",
    state: "REPLACEMENT_SESSION_CREATING",
    latch_generation: 1,
  });
  const handoff = storage.getHandoff("HO-H2");
  handoff.target_session_id = sessionId;
  handoff.state = "REPLACEMENT_SESSION_CREATED_PAUSED";
  storage.saveHandoff(handoff);
  return storage.getHandoff("HO-H2");
}

test("H2 metrics capture a complete authoritative model-call sample and correlation", () => {
  const root = temp();
  const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  try {
    correlateTarget(storage);
    const metrics = instrumentation(storage);
    const ctx = context("SES-target", { tokens: 50000, contextWindow: 100000, percent: 50 });
    metrics.startSession(ctx, { reason: "startup" });
    const sample = metrics.captureModelCall(assistant(completeUsage()), ctx);

    assert.equal(sample.schema_version, METRICS_SCHEMA_VERSION);
    assert.deepEqual(
      [sample.session_id, sample.runner_instance_id, sample.task_id, sample.item_id, sample.checkpoint_id, sample.handoff_id],
      ["SES-target", "RUNNER-H2", "TASK-H2", "ITEM-H2-01", "CP-H2", "HO-H2"],
    );
    assert.deepEqual(sample.context, { tokens: 50000, context_window: 100000, occupancy_percent: 50, status: "available_runtime_estimate" });
    assert.equal(sample.usage.input_tokens, 100);
    assert.equal(sample.usage.output_tokens, 20);
    assert.equal(sample.usage.reasoning_tokens, 7);
    assert.equal(sample.usage.cache_read_tokens, 80);
    assert.equal(sample.usage.cache_hit, null, "Pi exposes cache-read tokens, not an authoritative hit boolean");
    assert.equal(sample.cost.equivalent.amount, 0.135);
    assert.equal(sample.cost.charged_provider.amount, null);
    assert.equal(storage.getMetricSession("SES-target").model_calls, 1);
    assert.equal(storage.metricSamples("SES-target").length, 1);
  } finally { storage.close(); }
});

test("H2 metrics preserve unavailable values as explicit unknown/null", () => {
  const root = temp();
  const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  try {
    const metrics = instrumentation(storage);
    const ctx = context("SES-unknown", undefined);
    metrics.startSession(ctx, { reason: "startup" });
    const sample = metrics.captureModelCall(assistant({}), ctx);
    assert.deepEqual(sample.context, { tokens: null, context_window: null, occupancy_percent: null, status: "unknown" });
    assert.deepEqual(sample.usage, {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cache_hit: null,
      cache_hit_rate: null,
      model_calls: 1,
    });
    assert.equal(sample.cost.equivalent.status, "unknown");
    assert.equal(sample.cost.subscription.status, "unknown");
    assert.equal(storage.getMetricSession("SES-unknown").totals.input_tokens, null);
  } finally { storage.close(); }
});

test("H2 handoff measurement lifecycle records threshold at every event", () => {
  const root = temp();
  const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  try {
    const handoff = correlateTarget(storage);
    const metrics = instrumentation(storage);
    const states = ["SUGGESTED", "PREPARED", "STARTED", "RESUME_STARTED", "COMPLETED"];
    for (const lifecycle of states) metrics.recordHandoffEvent(lifecycle, {
      handoff,
      session_id: lifecycle === "SUGGESTED" || lifecycle === "PREPARED" || lifecycle === "STARTED" ? "SES-source" : "SES-target",
      checkpoint_id: "CP-H2",
      reason: `TEST_${lifecycle}`,
    });
    const events = storage.handoffMetricEvents("HO-H2");
    assert.deepEqual(events.map((event) => event.lifecycle_state), states);
    assert.equal(events.every((event) => event.threshold_percent === 50), true);
    assert.equal(events.every((event) => event.task_id === "TASK-H2" && event.item_id === "ITEM-H2-01" && event.checkpoint_id === "CP-H2"), true);
  } finally { storage.close(); }
});

test("H2 artifact sizes use byte surfaces and never inspect conversation history", () => {
  const root = temp();
  const taskPlan = join(root, "TASK_PLAN.md");
  writeFileSync(taskPlan, "# π\n", "utf8");
  const forbiddenSession = new Proxy({}, { get() { throw new Error("conversation history must not be read"); } });
  const measured = measureHandoffArtifacts({
    taskPlanPath: taskPlan,
    checkpointBytes: Buffer.from("checkpoint", "utf8"),
    manifestBytes: Buffer.from("manifest-π", "utf8"),
    resumePrompt: "resume-π",
    minimalReads: ["TASK_PLAN.md", "CHECKPOINT.md"],
    sessionManager: forbiddenSession,
  });
  assert.equal(measured.task_plan_bytes, statSync(taskPlan).size);
  assert.equal(measured.checkpoint_sealed_bytes, Buffer.byteLength("checkpoint"));
  assert.equal(measured.manifest_bytes, Buffer.byteLength("manifest-π"));
  assert.equal(measured.resume_prompt_bytes, Buffer.byteLength("resume-π"));
  assert.equal(measured.minimal_reads_count, null, "actual reads are not exposed authoritatively");
  assert.equal(measured.minimal_reads_declared_count, 2);
});

test("H2 bounded retention prunes sessions, samples, events, and diagnostics", () => {
  const root = temp();
  const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  try {
    const metrics = instrumentation(storage, { retention: { sessions: 2, samples: 2, handoffEvents: 2, diagnostics: 2 } });
    for (let index = 1; index <= 3; index += 1) {
      const ctx = context(`SES-${index}`, { tokens: index, contextWindow: 100, percent: index });
      metrics.startSession(ctx, { reason: "startup" });
      metrics.captureModelCall(assistant(completeUsage(), Date.parse(`2026-08-09T00:00:0${index}Z`)), ctx);
      metrics.recordHandoffEvent("SUGGESTED", { session_id: `SES-${index}`, reason: "RETENTION_TEST" });
      metrics.diagnostic("retention_test", Object.assign(new Error("not persisted"), { code: `E${index}` }), { session_id: `SES-${index}` });
    }
    assert.equal(storage.metricSessions().length, 2);
    assert.equal(storage.metricSamples().length, 2);
    assert.equal(storage.handoffMetricEvents().length, 2);
    assert.equal(storage.metricDiagnostics().length, 2);
  } finally { storage.close(); }
});

test("H2 records contain no conversation history or full prompt/response fields", () => {
  const root = temp();
  const storage = new GuardianStorage(join(root, "guardian.sqlite"));
  try {
    const metrics = instrumentation(storage);
    const ctx = context("SES-private", { tokens: 10, contextWindow: 100, percent: 10 });
    metrics.startSession(ctx, { reason: "startup" });
    metrics.captureModelCall(assistant(completeUsage()), ctx);
    const serialized = JSON.stringify({ sessions: storage.metricSessions(), samples: storage.metricSamples(), events: storage.handoffMetricEvents() });
    for (const forbidden of ["conversation", "history", "transcript", "SECRET_PROMPT_MARKER", "SECRET_RESPONSE_MARKER"]) assert.equal(serialized.includes(forbidden), false);
    assert.throws(() => assertTelemetrySafe({ prompt: "must not persist" }), /METRICS_FORBIDDEN_FIELD/);
  } finally { storage.close(); }
});

test("H2 telemetry failure emits a bounded diagnostic and does not fabricate a sample", () => {
  let sessionRecord = null;
  const samples = [];
  const diagnostics = [];
  const storage = {
    findHandoffByTarget: () => null,
    getMetricSession: () => sessionRecord,
    upsertMetricSession(record) { sessionRecord = record; },
    appendMetricSample() { throw Object.assign(new Error("simulated storage failure"), { code: "SQLITE_TEST_FAILURE" }); },
    appendMetricDiagnostic(record) { diagnostics.push(record); },
  };
  const metrics = instrumentation(storage);
  const ctx = context("SES-failure", { tokens: 1, contextWindow: 100, percent: 1 });
  metrics.startSession(ctx, { reason: "startup" });
  const result = metrics.captureModelCall(assistant(completeUsage()), ctx);
  assert.equal(result, null);
  assert.deepEqual(samples, []);
  assert.equal(sessionRecord.model_calls, 0, "failed persistence must not advance the authoritative summary");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].status, "collection_failed_no_metric_substitution");
  assert.equal(diagnostics[0].error_code, "SQLITE_TEST_FAILURE");
  assert.equal(Object.hasOwn(diagnostics[0], "error_message"), false);
});
