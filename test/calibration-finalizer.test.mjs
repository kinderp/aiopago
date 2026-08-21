import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizeCalibrationRun } from "../src/calibration-finalizer.mjs";
import { CALIBRATION_ATTESTATION_SCHEMA } from "../src/calibration-preflight.mjs";
import { LEGACY_CALIBRATION_QUALITY_SCHEMA, emptyCalibrationQualityEvidence, writeCalibrationQualityEvidence } from "../src/calibration-quality.mjs";
import { sha256 } from "../src/canonical.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const COMMANDS = [
  "npm run check",
  "node --test --test-concurrency=1 test/handoff-inspector.test.mjs",
  "npm test",
  "git diff --check",
];
const CHECKPOINTS = ["WCP-1", "WCP-2", "WCP-3", "WCP-4"];
const RUN_ID = "H2-TEST-RUN-40";

function ledger() {
  return {
    schema_version: "0.1.0",
    task_id: "TASK-WORKLOAD",
    title: "Workload",
    objective: "Test finalization",
    requirements_version: "REQ-1",
    plan_revision_id: "PLAN-1",
    status: "DONE",
    completion_criteria: ["all WCP accepted"],
    risk: "LOW",
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:30:00.000Z",
    current_item: null,
    next_item: null,
    next_step: "READY_FOR_ACCEPTANCE",
    evidence: ["machine quality evidence"],
    task_items: CHECKPOINTS.map((id) => ({
      task_item_id: id,
      task_id: "TASK-WORKLOAD",
      title: id,
      description: id,
      status: "DONE",
      depends_on: [],
      completion_criteria: [`${id} complete`],
      evidence: [`${id} evidence`],
      requirements_refs: ["REQ-1"],
      risk: "LOW",
      milestone: "H2-CALIBRATION",
      last_updated_at: "2026-08-09T00:30:00.000Z",
      last_updated_by: "human:test",
    })),
  };
}

function quality(overrides = {}) {
  const evidence = emptyCalibrationQualityEvidence(RUN_ID);
  evidence.accepted_checkpoints = [...CHECKPOINTS];
  evidence.completion_marker_observed = "READY_FOR_ACCEPTANCE";
  evidence.controls = {
    no_conversation_history_saved: true,
    cold_review_new_session: true,
    operator_protocol_deviation: false,
    external_services_used: false,
  };
  evidence.gate_attempts = COMMANDS.map((command, index) => ({
    suite_attempt: 1,
    ordinal: index + 1,
    command,
    started_at: `2026-08-09T00:4${index}:00.000Z`,
    ended_at: `2026-08-09T00:4${index}:01.000Z`,
    exit_code: 0,
    output_sha256: sha256(Buffer.from(`gate-${index}`)),
  }));
  evidence.final_acceptance = { decision_id: "ACCEPT-1", status: "PASS", decided_at: "2026-08-09T01:00:00.000Z" };
  return Object.assign(evidence, overrides);
}

function metricSession(modelCalls = 1) {
  return {
    schema_version: "1.0.0",
    session_id: "SES-1",
    runner_instance_id: "RUNNER-1",
    task_id: "TASK-WORKLOAD",
    item_id: "WCP-1",
    checkpoint_id: null,
    handoff_id: null,
    started_at: "2026-08-09T00:00:00.000Z",
    ended_at: "2026-08-09T00:30:00.000Z",
    duration_ms: 1800000,
    updated_at: "2026-08-09T00:30:00.000Z",
    lifecycle: { status: "ENDED" },
    model_calls: modelCalls,
    totals: {},
    latest_context: {},
    quality: {},
    collection_status: "ok",
  };
}

function sample(percent = 41, overrides = {}) {
  return {
    schema_version: "1.0.0",
    sample_id: "MS-1",
    session_id: "SES-1",
    runner_instance_id: "RUNNER-1",
    task_id: "TASK-WORKLOAD",
    item_id: "WCP-1",
    checkpoint_id: null,
    handoff_id: null,
    timestamp: "2026-08-09T00:00:00.500Z",
    captured_at: "2026-08-09T00:00:01.000Z",
    call_index: 1,
    task_phase: "WCP-1",
    model: { provider: "test-provider", id: "test-model" },
    context: { tokens: percent * 1000, context_window: 100000, occupancy_percent: percent, status: "available_runtime_estimate" },
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 7,
      cache_read_tokens: 80,
      cache_write_tokens: 5,
      cache_hit: null,
      cache_hit_rate: null,
      model_calls: 1,
    },
    cost: {
      charged_provider: { amount: null, currency: null, status: "unknown", semantic: "provider_invoice_or_charge_not_exposed_by_pi" },
      equivalent: { amount: 4, currency: "USD", status: "available", semantic: "pi_model_catalog_equivalent_cost_not_provider_charge" },
      subscription: { amount: null, currency: null, status: "unknown", semantic: "subscription_equivalent_not_exposed_by_pi" },
    },
    ...overrides,
  };
}

function handoffEvent(state, index) {
  return {
    schema_version: "1.0.0",
    metric_event_id: `HME-${state}`,
    session_id: "SES-1",
    runner_instance_id: "RUNNER-1",
    task_id: "TASK-WORKLOAD",
    item_id: "WCP-1",
    checkpoint_id: "CP-1",
    handoff_id: "HO-1",
    timestamp: `2026-08-09T00:00:0${index}.000Z`,
    lifecycle_state: state,
    threshold_percent: 40,
    reason: state === "SUGGESTED" ? "CONTEXT_THRESHOLD_REACHED" : `TEST_${state}`,
    task_phase: "WCP-1",
    duration_ms: state === "COMPLETED" ? 25 : null,
    continuity_duration_ms: state === "COMPLETED" ? 10 : null,
    resume_duration_ms: state === "COMPLETED" ? 15 : null,
    artifacts: {
      task_plan_bytes: 100,
      checkpoint_sealed_bytes: 200,
      manifest_bytes: 300,
      resume_prompt_bytes: 50,
      minimal_reads_count: null,
      minimal_reads_declared_count: 2,
    },
  };
}

function fixture({ percent = 41, samplePercents = null, withHandoff = true, diagnostics = [], qualityEvidence = quality(), sampleOverrides = {}, protocolSchema = "aiopago.threshold-calibration-protocol/1.0.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiopago-finalizer-"));
  const runRoot = join(root, ".guardian", "calibration", RUN_ID);
  const runtimeRoot = join(runRoot, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const protocol = {
    schema_version: protocolSchema,
    protocol_id: "TEST-PILOT",
    application_baseline_commit: "a".repeat(40),
    runs: [{ variant_id: "RUN-40", threshold_percent: 40, branch: "calibration/test", worktree: root.replaceAll("\\", "/") }],
    controlled_environment: {
      provider: "test-provider", model: "test-model", reasoning_level: "high",
      pi_version: "0.83.0", node_version: process.version, confirm_mode: "confirm",
    },
    workload: {
      id: "WL-TEST", acceptance_commands: COMMANDS, completion_marker: "READY_FOR_ACCEPTANCE",
      phases: CHECKPOINTS.map((checkpoint) => ({ checkpoint })),
    },
    accepted_checkpoints: CHECKPOINTS,
  };
  const protocolBytes = Buffer.from(`${JSON.stringify(protocol, null, 2)}\n`);
  const protocolPath = join(runRoot, "pilot-protocol.json");
  writeFileSync(protocolPath, protocolBytes);
  writeFileSync(join(root, "TASK_PLAN.md"), `# Workload\n\n\`\`\`json task-ledger\n${JSON.stringify(ledger(), null, 2)}\n\`\`\`\n`);
  const runtimePath = join(runtimeRoot, "guardian.sqlite");
  const attestationPath = join(runRoot, "preflight-attestation.json");
  const attestation = {
    schema_version: CALIBRATION_ATTESTATION_SCHEMA,
    run_id: RUN_ID,
    variant_id: "RUN-40",
    experiment_id: "TEST-PILOT",
    workload_id: "WL-TEST",
    experiment_baseline_commit: "b".repeat(40),
    application_baseline_commit: "a".repeat(40),
    branch: "calibration/test",
    worktree: root.replaceAll("\\", "/"),
    clean_status: true,
    pi_version: "0.83.0",
    node_version: process.version,
    protocol_source_path: protocolPath.replaceAll("\\", "/"),
    protocol_copy_path: protocolPath.replaceAll("\\", "/"),
    workload_protocol_path: protocolPath.replaceAll("\\", "/"),
    protocol_digest: sha256(protocolBytes).slice("sha256:".length),
    workload_digest: "c".repeat(64),
    requested_threshold: 40,
    effective_threshold: 40,
    provider: "test-provider",
    model: "test-model",
    reasoning: "high",
    confirm_mode: "confirm",
    runtime_store: { identity: "CALSTORE-1", path: runtimePath.replaceAll("\\", "/"), created_fresh: true },
    created_at: "2026-08-09T00:00:00.000Z",
    preflight_result: "PASS",
    failure_reasons: [],
    attestation_path: attestationPath.replaceAll("\\", "/"),
  };
  writeFileSync(attestationPath, `${JSON.stringify(attestation)}\n`);
  const attestationDigest = sha256(readFileSync(attestationPath)).slice("sha256:".length);
  const storage = new GuardianStorage(runtimePath);
  storage.bindCalibrationRuntimeIdentity({ run_id: RUN_ID, runtime_store_id: "CALSTORE-1", attestation_sha256: attestationDigest });
  const observedPercents = samplePercents ?? [percent];
  const session = metricSession(observedPercents.length);
  storage.upsertMetricSession({ ...session, model_calls: 0 }, 100);
  observedPercents.forEach((observedPercent, index) => storage.appendMetricSample(sample(observedPercent, {
    ...sampleOverrides,
    sample_id: `MS-${index + 1}`,
    call_index: index + 1,
    timestamp: `2026-08-09T00:00:01.${String(index).padStart(3, "0")}Z`,
    captured_at: `2026-08-09T00:00:01.${String(index + 1).padStart(3, "0")}Z`,
  }), { ...session, model_calls: index + 1 }, 2000));
  if (withHandoff) ["SUGGESTED", "PREPARED", "STARTED", "COMPLETED"].forEach((state, index) => storage.appendHandoffMetricEvent(handoffEvent(state, index + 2), 1000));
  for (const [index, diagnostic] of diagnostics.entries()) storage.appendMetricDiagnostic({
    schema_version: "1.0.0",
    diagnostic_id: `MDIAG-${index}`,
    timestamp: `2026-08-09T00:20:0${index}.000Z`,
    operation: "model_call_sample",
    error_name: "GuardianError",
    error_code: "LEDGER_FIELD_MISSING",
    session_id: "SES-1",
    task_id: null,
    handoff_id: null,
    status: "collection_failed_no_metric_substitution",
    ...diagnostic,
  }, 100);
  storage.close();
  writeCalibrationQualityEvidence(join(runRoot, "quality-evidence.json"), qualityEvidence, { runId: RUN_ID, expectedCommands: COMMANDS });
  return { root, runRoot };
}

test("calibration finalizer produces VALID from an actual MetricSample crossing and complete lifecycle", () => {
  const x = fixture();
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot, runId: RUN_ID });
  assert.equal(record.classification, "VALID");
  assert.equal(record.status, "VALID");
  assert.equal(record.telemetry.max_context_percent, 41);
  assert.equal(record.telemetry.crossing_samples.length, 1);
  assert.equal(record.handoff.effective_handoff_contexts[0].occupancy_percent, 41);
  assert.equal(record.telemetry.input_tokens, 100);
  assert.equal(record.telemetry.equivalent_cost.amount, 4);
  assert.equal(record.telemetry.charged_cost.status, "unknown");
  assert.equal(record.outcome.cost_per_accepted_checkpoint.equivalent.amount, 1);
  assert.equal(record.outcome.cost_per_accepted_checkpoint.charged.status, "unknown");
});

test("calibration finalizer accepts frozen pre-rename protocol and quality schemas without rewriting the protocol", () => {
  const x = fixture({
    protocolSchema: "eiopago.threshold-calibration-protocol/1.0.0",
    qualityEvidence: quality({ schema_version: LEGACY_CALIBRATION_QUALITY_SCHEMA }),
  });
  const before = readFileSync(join(x.runRoot, "pilot-protocol.json"));
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot, runId: RUN_ID });
  assert.equal(record.classification, "VALID");
  assert.deepEqual(readFileSync(join(x.runRoot, "pilot-protocol.json")), before);
});

test("calibration finalizer produces CENSORED when quality passes before any measured crossing", () => {
  const x = fixture({ percent: 31, withHandoff: false });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "CENSORED");
  assert.equal(record.status, "CENSORED_EARLY_COMPLETION");
  assert.equal(record.telemetry.crossing_samples.length, 0);
});

test("nominal threshold and lifecycle metadata are never substituted for an actual crossing sample", () => {
  const x = fixture({ percent: 39, withHandoff: true });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.telemetry.max_context_percent, 39);
  assert.deepEqual(record.telemetry.crossing_samples, []);
  assert.equal(record.classification, "INVALID");
  assert.equal(record.status, "INVALID_HANDOFF");
});

test("a crossing cannot validate lifecycle states assembled across unrelated sessions", () => {
  const x = fixture({ withHandoff: false });
  const storage = new GuardianStorage(join(x.runRoot, "runtime", "guardian.sqlite"));
  try {
    ["SUGGESTED", "PREPARED", "STARTED", "COMPLETED"].forEach((state, index) => storage.appendHandoffMetricEvent({
      ...handoffEvent(state, index + 2),
      session_id: state === "SUGGESTED" ? "SES-unrelated" : "SES-1",
    }, 1000));
  } finally { storage.close(); }
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.status, "INVALID_HANDOFF");
  assert.equal(record.handoff.lifecycle_complete, false);
});

test("a crossing with incomplete per-call context telemetry is INVALID_TELEMETRY", () => {
  const x = fixture({ samplePercents: [41, null] });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.status, "INVALID_TELEMETRY");
  assert.ok(record.classification_reasons.includes("CONTEXT_COVERAGE_INCOMPLETE"));
});

test("RUN-40 salvage remains INVALID_TELEMETRY with 69 low-context samples and three missing-measurement diagnostics", () => {
  const observed = Array.from({ length: 69 }, (_value, index) => 20 + (11.0165 * index / 68));
  const x = fixture({ samplePercents: observed, withHandoff: false, diagnostics: [{}, {}, {}] });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.status, "INVALID_TELEMETRY");
  assert.ok(record.classification_reasons.includes("BLOCKING_MEASUREMENT_DIAGNOSTICS"));
  assert.equal(record.telemetry.blocking_diagnostic_count, 3);
  assert.equal(record.telemetry.model_calls, 69, "only the 69 observed samples are aggregated");
  assert.equal(record.telemetry.max_context_percent, 31.0165);
  assert.deepEqual(record.telemetry.crossing_samples, []);
  assert.equal(record.telemetry.equivalent_cost.status, "observed_incomplete");
  assert.equal(record.outcome.cost_per_accepted_checkpoint.equivalent.status, "unknown");
});

test("the same 31 percent exposure can be CENSORED when telemetry and quality are complete", () => {
  const observed = Array.from({ length: 69 }, (_value, index) => 20 + (11.0165 * index / 68));
  const x = fixture({ samplePercents: observed, withHandoff: false });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "CENSORED");
  assert.equal(record.status, "CENSORED_EARLY_COMPLETION");
});

test("correlation-degraded diagnostics preserve complete measurement and do not masquerade as missing samples", () => {
  const x = fixture({
    sampleOverrides: { task_id: null, item_id: null, checkpoint_id: null, handoff_id: null },
    diagnostics: [{
      diagnostic_type: "correlation_degraded",
      operation: "correlation_degraded",
      source: "ledger",
      status: "measurement_complete_correlation_partial",
    }],
  });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "VALID");
  assert.equal(record.telemetry.measurement_status, "measurement_complete_correlation_partial");
  assert.equal(record.telemetry.blocking_diagnostic_count, 0);
  assert.equal(record.telemetry.context_samples[0].correlation_status, "partial");
});

test("quality evidence preserves gate failures and closed rework without parsing human output", () => {
  const evidence = quality();
  evidence.gate_attempts[0].exit_code = 1;
  evidence.gate_attempts.push(...COMMANDS.map((command, index) => ({
    suite_attempt: 2,
    ordinal: index + 1,
    command,
    started_at: `2026-08-09T00:5${index}:00.000Z`,
    ended_at: `2026-08-09T00:5${index}:01.000Z`,
    exit_code: 0,
    output_sha256: sha256(Buffer.from(`rerun-${index}`)),
  })));
  evidence.rework_cycles = [{ cycle_id: "RW-1", status: "CLOSED", trigger_refs: ["gate:1:1"], files_changed: ["src/example.mjs"] }];
  const x = fixture({ qualityEvidence: evidence });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.quality.result, "PASS");
  assert.equal(record.quality.failures.length, 1);
  assert.equal(record.quality.rework_cycle_count, 1);
  assert.equal(record.quality.latest_gate_suite.number, 2);
});

test("an earlier complete PASS suite cannot substitute for an incomplete latest suite", () => {
  const evidence = quality();
  evidence.gate_attempts.push({
    suite_attempt: 2,
    ordinal: 1,
    command: COMMANDS[0],
    started_at: "2026-08-09T00:50:00.000Z",
    ended_at: "2026-08-09T00:50:01.000Z",
    exit_code: 0,
    output_sha256: sha256(Buffer.from("incomplete-latest-suite")),
  });
  const x = fixture({ qualityEvidence: evidence });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.quality.latest_gate_suite.number, 2);
  assert.equal(record.quality.latest_gate_suite.complete, false);
  assert.equal(record.quality.result, "FAIL");
});

test("unresolved quality regression prevents final acceptance", () => {
  const evidence = quality();
  evidence.regressions = [{ regression_id: "REG-1", status: "DETECTED", code: "M1_H1_REGRESSION" }];
  const x = fixture({ qualityEvidence: evidence });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.status, "INVALID_QUALITY");
  assert.equal(record.quality.result, "FAIL");
});

test("CENSORED requires the authoritative Ledger task to be complete", () => {
  const x = fixture({ percent: 31, withHandoff: false });
  const incomplete = { ...ledger(), status: "IN_PROGRESS" };
  writeFileSync(join(x.root, "TASK_PLAN.md"), `# Workload\n\n\`\`\`json task-ledger\n${JSON.stringify(incomplete, null, 2)}\n\`\`\`\n`);
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.status, "INVALID_QUALITY");
  assert.equal(record.quality.task_complete, false);
});

test("quality PASS requires the final decision after the ordered latest suite", () => {
  const evidence = quality();
  evidence.final_acceptance.decided_at = "2026-08-09T00:00:00.000Z";
  const x = fixture({ qualityEvidence: evidence });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.quality.final_decision_after_latest_suite, false);
  assert.equal(record.quality.result, "FAIL");
});

test("cost per checkpoint rejects a numeric cost with incoherent semantics", () => {
  const x = fixture({ sampleOverrides: {
    cost: {
      charged_provider: { amount: null, currency: null, status: "unknown", semantic: "provider_invoice_or_charge_not_exposed_by_pi" },
      equivalent: { amount: 4, currency: "EUR", status: "available", semantic: "pi_model_catalog_equivalent_cost_not_provider_charge" },
      subscription: { amount: null, currency: null, status: "unknown", semantic: "subscription_equivalent_not_exposed_by_pi" },
    },
  } });
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.telemetry.equivalent_cost.status, "unknown");
  assert.equal(record.outcome.cost_per_accepted_checkpoint.equivalent.status, "unknown");
});

test("controlled-environment mismatch between protocol and attestation is INVALID", () => {
  const x = fixture();
  const protocolPath = join(x.runRoot, "pilot-protocol.json");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
  protocol.controlled_environment.model = "different-model";
  const protocolBytes = Buffer.from(`${JSON.stringify(protocol, null, 2)}\n`);
  writeFileSync(protocolPath, protocolBytes);
  const attestationPath = join(x.runRoot, "preflight-attestation.json");
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  attestation.protocol_digest = sha256(protocolBytes).slice("sha256:".length);
  writeFileSync(attestationPath, `${JSON.stringify(attestation)}\n`);
  const storage = new GuardianStorage(join(x.runRoot, "runtime", "guardian.sqlite"));
  try {
    storage.db.prepare("UPDATE calibration_runtime_identity SET attestation_sha256=? WHERE singleton=1")
      .run(sha256(readFileSync(attestationPath)).slice("sha256:".length));
  } finally { storage.close(); }
  const { record } = finalizeCalibrationRun({ runRoot: x.runRoot });
  assert.equal(record.classification, "INVALID");
  assert.equal(record.status, "INVALID_CONTROLLED_VARIABLE");
  assert.ok(record.classification_reasons.includes("CONTROLLED_ENVIRONMENT_MISMATCH"));
});

test("calibration finalization is byte-idempotent and does not modify the measured SQLite", () => {
  const x = fixture();
  const runtimePath = join(x.runRoot, "runtime", "guardian.sqlite");
  const runtimeBefore = readFileSync(runtimePath);
  finalizeCalibrationRun({ runRoot: x.runRoot });
  const first = readFileSync(join(x.runRoot, "run-record.json"));
  assert.equal(readFileSync(runtimePath).equals(runtimeBefore), true);
  finalizeCalibrationRun({ runRoot: x.runRoot });
  const second = readFileSync(join(x.runRoot, "run-record.json"));
  assert.equal(first.equals(second), true);
  assert.equal(readFileSync(runtimePath).equals(runtimeBefore), true);
});
