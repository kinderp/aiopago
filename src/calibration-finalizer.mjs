import { existsSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, digestObject, sha256 } from "./canonical.mjs";
import { CALIBRATION_RUN_RECORD_SCHEMA, loadCalibrationAttestation } from "./calibration-preflight.mjs";
import { loadCalibrationQualityEvidence, QUALITY_EVIDENCE_FILE } from "./calibration-quality.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { TaskLedger } from "./ledger.mjs";

export const CALIBRATION_FINALIZER_SCHEMA = "eiopago.calibration-finalizer/1.0.0";

const REQUIRED_HANDOFF_STATES = ["SUGGESTED", "PREPARED", "STARTED", "COMPLETED"];
const REQUIRED_ACCEPTANCE_COMMANDS = [
  "npm run check",
  "node --test --test-concurrency=1 test/handoff-inspector.test.mjs",
  "npm test",
  "git diff --check",
];
const PROTOCOL_SCHEMA = "eiopago.threshold-calibration-protocol/1.0.0";
const BLOCKING_DIAGNOSTIC_STATUSES = new Set(["collection_failed_no_metric_substitution", "measurement_missing"]);

function digestHex(bytes) { return sha256(bytes).slice("sha256:".length); }
function parseJson(path, code) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new GuardianError(code, error.message); }
}
function unique(values) { return [...new Set(values)]; }
function numeric(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function sumKnown(values) { return values.length > 0 && values.every(numeric) ? values.reduce((sum, value) => sum + value, 0) : null; }
function minIso(values) {
  const valid = values.filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return valid.length ? valid.sort((a, b) => Date.parse(a) - Date.parse(b))[0] : null;
}
function duration(start, end) {
  return start && end && Date.parse(end) >= Date.parse(start) ? Date.parse(end) - Date.parse(start) : null;
}
function unknownCost(semantic) { return { amount: null, currency: null, status: "unknown", semantic }; }
function aggregateCost(samples, field, semantic, sampleSemantic, telemetryComplete) {
  const costs = samples.map((sample) => sample.cost?.[field]);
  const semanticallyValid = costs.length > 0 && costs.every((cost) => cost?.status === "available"
    && cost.currency === "USD" && cost.semantic === sampleSemantic && numeric(cost.amount));
  if (!semanticallyValid) return unknownCost(semantic);
  return {
    amount: costs.reduce((sum, cost) => sum + cost.amount, 0),
    currency: "USD",
    status: telemetryComplete ? "available" : "observed_incomplete",
    semantic,
  };
}
function slash(path) { return resolve(path).replaceAll("\\", "/").toLowerCase(); }
function samePath(a, b) { return typeof a === "string" && typeof b === "string" && slash(a) === slash(b); }
function sameArray(a, b) { return Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]); }
function logicalRows(db, table, order = "rowid") {
  return db.prepare(`SELECT record_json FROM ${table} ORDER BY ${order}`).all().map((row) => JSON.parse(row.record_json));
}
function readRuntime(path) {
  invariant(existsSync(path), "CALIBRATION_RUNTIME_STORE_MISSING", path);
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only=ON; BEGIN;");
  try {
    const runtime = {
      identity: db.prepare("SELECT run_id,runtime_store_id,attestation_sha256,created_at FROM calibration_runtime_identity WHERE singleton=1").get() ?? null,
      sessions: logicalRows(db, "metric_sessions", "started_at, rowid"),
      samples: logicalRows(db, "metric_samples", "seq"),
      handoffEvents: logicalRows(db, "metric_handoff_events", "seq"),
      diagnostics: logicalRows(db, "metric_diagnostics", "seq"),
    };
    db.exec("COMMIT;");
    return runtime;
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  } finally { db.close(); }
}
function artifactDigestStatus(worktree, finding) {
  if (finding.artifact_path === null && finding.artifact_sha256 === null) return "not_declared";
  if (finding.artifact_path === null || finding.artifact_sha256 === null || isAbsolute(finding.artifact_path)) return "invalid";
  const root = resolve(worktree);
  const path = resolve(root, finding.artifact_path);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(path)) return "invalid";
  return sha256(readFileSync(path)) === finding.artifact_sha256 ? "verified" : "mismatch";
}
function latestGateSuite(attempts, commands) {
  if (!attempts.length) return { number: null, records: [], complete: false, pass: false };
  const number = Math.max(...attempts.map((item) => item.suite_attempt));
  const records = attempts.filter((item) => item.suite_attempt === number).sort((a, b) => a.ordinal - b.ordinal);
  const complete = records.length === commands.length
    && records.every((item, index) => item.ordinal === index + 1 && item.command === commands[index]);
  return { number, records, complete, pass: complete && records.every((item) => item.exit_code === 0) };
}
function nearestSuggestedSample(samples, event) {
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  const candidates = samples.filter((sample) => sample.session_id === event.session_id
    && Number.isFinite(Date.parse(sample.captured_at)) && Date.parse(sample.captured_at) <= timestamp);
  return candidates.sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at))[0] ?? null;
}
function latestEventBefore(events, state, sessionId, before) {
  const limit = Date.parse(before);
  if (!Number.isFinite(limit)) return null;
  return events.filter((event) => event.lifecycle_state === state && event.session_id === sessionId
    && Number.isFinite(Date.parse(event.timestamp)) && Date.parse(event.timestamp) <= limit)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] ?? null;
}
function handoffLifecycleChains(events, samples, threshold) {
  const ids = unique(events.filter((event) => ["STARTED", "COMPLETED"].includes(event.lifecycle_state) && event.handoff_id)
    .map((event) => event.handoff_id));
  const chains = ids.map((handoffId) => {
    const started = events.filter((event) => event.handoff_id === handoffId && event.lifecycle_state === "STARTED")
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0] ?? null;
    const completed = events.filter((event) => event.handoff_id === handoffId && event.lifecycle_state === "COMPLETED"
      && started && Date.parse(event.timestamp) >= Date.parse(started.timestamp))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0] ?? null;
    const prepared = started ? latestEventBefore(events, "PREPARED", started.session_id, started.timestamp) : null;
    const suggested = prepared ? latestEventBefore(events, "SUGGESTED", started.session_id, prepared.timestamp) : null;
    const sample = suggested ? nearestSuggestedSample(samples, suggested) : null;
    const crossing = numeric(sample?.context?.occupancy_percent) && sample.context.occupancy_percent >= threshold;
    return { handoff_id: handoffId, suggested, prepared, started, completed, sample, crossing };
  });
  const usedSuggestions = chains.map((chain) => chain.suggested?.metric_event_id).filter(Boolean);
  const noReusedSuggestion = usedSuggestions.length === new Set(usedSuggestions).size;
  const complete = chains.length > 0 && noReusedSuggestion && chains.every((chain) => chain.suggested && chain.prepared
    && chain.started && chain.completed && chain.crossing);
  return { chains, complete };
}
function aggregateArtifacts(events) {
  const completedIds = unique(events.filter((event) => event.lifecycle_state === "COMPLETED" && event.handoff_id).map((event) => event.handoff_id));
  const selected = [];
  for (const handoffId of completedIds) {
    const candidates = events.filter((event) => event.handoff_id === handoffId && event.artifacts);
    candidates.sort((a, b) => {
      const known = (event) => Object.values(event.artifacts).filter(numeric).length;
      return known(b) - known(a) || Date.parse(b.timestamp) - Date.parse(a.timestamp);
    });
    if (candidates[0]) selected.push(candidates[0].artifacts);
  }
  const field = (name) => sumKnown(selected.map((item) => item[name]));
  const components = ["task_plan_bytes", "checkpoint_sealed_bytes", "manifest_bytes", "resume_prompt_bytes"];
  const perHandoff = selected.map((item) => sumKnown(components.map((name) => item[name])));
  return {
    total: sumKnown(perHandoff),
    task_plan_bytes: field("task_plan_bytes"),
    checkpoint_sealed_bytes: field("checkpoint_sealed_bytes"),
    manifest_bytes: field("manifest_bytes"),
    resume_prompt_bytes: field("resume_prompt_bytes"),
    minimal_reads_declared_total: field("minimal_reads_declared_count"),
    minimal_reads_actual_total: null,
  };
}
function writeDeterministic(path, value) {
  const bytes = `${canonicalJson(value)}\n`;
  const prior = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prior === bytes) return Buffer.from(bytes);
  const temp = `${path}.${process.pid}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
    try { const dirFd = openSync(dirname(path), "r"); fsyncSync(dirFd); closeSync(dirFd); } catch {}
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
  return Buffer.from(bytes);
}

export function finalizeCalibrationRun({ runRoot, runId = null } = {}) {
  runRoot = resolve(runRoot);
  const attestationPath = join(runRoot, "preflight-attestation.json");
  const protocolPath = join(runRoot, "pilot-protocol.json");
  const qualityPath = join(runRoot, QUALITY_EVIDENCE_FILE);
  const outputPath = join(runRoot, "run-record.json");
  const loaded = loadCalibrationAttestation(attestationPath);
  const { attestation } = loaded;
  if (runId !== null) invariant(attestation.run_id === runId, "CALIBRATION_RUN_ID_MISMATCH");
  const protocolBytes = readFileSync(protocolPath);
  const protocol = parseJson(protocolPath, "CALIBRATION_PROTOCOL_INVALID");
  const sourceFailures = [];
  if (attestation.preflight_result !== "PASS" || attestation.failure_reasons.length) sourceFailures.push("INVALID_PREFLIGHT");
  if (digestHex(protocolBytes) !== attestation.protocol_digest) sourceFailures.push("PROTOCOL_DIGEST_MISMATCH");
  if (protocol.schema_version !== PROTOCOL_SCHEMA
    || protocol.protocol_id !== attestation.experiment_id
    || protocol.workload?.id !== attestation.workload_id) sourceFailures.push("PROTOCOL_IDENTITY_MISMATCH");
  const variant = protocol.runs?.find((item) => (item.variant_id ?? item.run_id) === attestation.variant_id) ?? null;
  if (!variant || variant.threshold_percent !== attestation.effective_threshold) sourceFailures.push("CONTROLLED_THRESHOLD_MISMATCH");
  if (variant && (variant.branch !== attestation.branch || (variant.worktree && !samePath(variant.worktree, attestation.worktree)))) sourceFailures.push("CONTROLLED_WORKTREE_MISMATCH");
  const controlled = protocol.controlled_environment ?? {};
  if (protocol.application_baseline_commit !== attestation.application_baseline_commit
    || controlled.provider !== attestation.provider
    || controlled.model !== attestation.model
    || controlled.reasoning_level !== attestation.reasoning
    || controlled.pi_version !== attestation.pi_version
    || controlled.node_version !== attestation.node_version
    || controlled.confirm_mode !== attestation.confirm_mode) sourceFailures.push("CONTROLLED_ENVIRONMENT_MISMATCH");
  if (!sameArray(protocol.workload?.acceptance_commands, REQUIRED_ACCEPTANCE_COMMANDS)) sourceFailures.push("CONTROLLED_ACCEPTANCE_COMMANDS_MISMATCH");

  const expectedRuntimePath = join(runRoot, "runtime", "guardian.sqlite");
  if (!samePath(attestation.runtime_store?.path, expectedRuntimePath)) sourceFailures.push("RUNTIME_STORE_PATH_MISMATCH");
  const runtime = readRuntime(expectedRuntimePath);
  if (!runtime.identity
    || runtime.identity.run_id !== attestation.run_id
    || runtime.identity.runtime_store_id !== attestation.runtime_store.identity
    || runtime.identity.attestation_sha256 !== loaded.digest) sourceFailures.push("RUNTIME_IDENTITY_MISMATCH");

  let ledger = null;
  let ledgerFailure = null;
  try { ledger = new TaskLedger(join(attestation.worktree, "TASK_PLAN.md")).read(); }
  catch (error) { ledgerFailure = error.code ?? "WORKLOAD_LEDGER_INVALID"; }
  let qualityEvidence = null;
  let qualityFailure = null;
  const acceptanceCommands = REQUIRED_ACCEPTANCE_COMMANDS;
  try { qualityEvidence = loadCalibrationQualityEvidence(qualityPath, { runId: attestation.run_id, expectedCommands: acceptanceCommands }); }
  catch (error) { qualityFailure = error.code ?? "QUALITY_EVIDENCE_INVALID"; }

  const blockingDiagnostics = runtime.diagnostics.filter((item) => BLOCKING_DIAGNOSTIC_STATUSES.has(item.status) || item.diagnostic_type === "measurement_missing");
  const sessionMeasurementMissing = runtime.sessions.some((session) => session.collection_status === "measurement_missing");
  const correlationDiagnostics = runtime.diagnostics.filter((item) => item.status === "measurement_complete_correlation_partial" || item.diagnostic_type === "correlation_degraded");
  const expectedModelCalls = sumKnown(runtime.sessions.map((session) => session.model_calls));
  const perSessionCallCountsComplete = runtime.sessions.every((session) => {
    if (!Number.isInteger(session.model_calls) || session.model_calls < 0) return false;
    const calls = runtime.samples.filter((sample) => sample.session_id === session.session_id)
      .map((sample) => sample.call_index).sort((a, b) => a - b);
    return calls.length === session.model_calls && calls.every((callIndex, index) => callIndex === index + 1);
  });
  const usageFields = ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"];
  const usageComplete = runtime.samples.every((sample) => usageFields.every((field) => numeric(sample.usage?.[field])));
  const modelsConform = runtime.samples.every((sample) => sample.model?.provider === attestation.provider && sample.model?.id === attestation.model);
  if (!modelsConform) sourceFailures.push("CONTROLLED_MODEL_MISMATCH");
  const callCountComplete = expectedModelCalls !== null && expectedModelCalls === runtime.samples.length && perSessionCallCountsComplete;
  const tokenTotals = Object.fromEntries(usageFields.map((field) => [field, sumKnown(runtime.samples.map((sample) => sample.usage?.[field] ?? null))]));
  const knownContexts = runtime.samples.filter((sample) => numeric(sample.context?.occupancy_percent));
  const contextComplete = knownContexts.length === runtime.samples.length;
  const coreTelemetryComplete = runtime.samples.length > 0 && usageComplete && contextComplete && callCountComplete
    && blockingDiagnostics.length === 0 && !sessionMeasurementMissing;
  const maxContext = knownContexts.length ? Math.max(...knownContexts.map((sample) => sample.context.occupancy_percent)) : null;
  const crossings = knownContexts.filter((sample) => sample.context.occupancy_percent >= attestation.effective_threshold).map((sample) => ({
    sample_id: sample.sample_id,
    session_id: sample.session_id,
    captured_at: sample.captured_at,
    occupancy_percent: sample.context.occupancy_percent,
  }));
  const contextSamples = runtime.samples.map((sample) => ({
    sample_id: sample.sample_id,
    session_id: sample.session_id,
    call_index: sample.call_index,
    timestamp: sample.timestamp,
    captured_at: sample.captured_at,
    task_id: sample.task_id ?? null,
    item_id: sample.item_id ?? null,
    checkpoint_id: sample.checkpoint_id ?? null,
    handoff_id: sample.handoff_id ?? null,
    correlation_status: sample.task_id === null ? "partial" : "correlated",
    context: sample.context,
  }));

  const suggested = runtime.handoffEvents.filter((event) => event.lifecycle_state === "SUGGESTED");
  const effectiveHandoffContexts = suggested.map((event) => {
    const sample = nearestSuggestedSample(runtime.samples, event);
    return {
      metric_event_id: event.metric_event_id,
      session_id: event.session_id,
      handoff_id: event.handoff_id ?? null,
      sample_id: sample?.sample_id ?? null,
      occupancy_percent: sample?.context?.occupancy_percent ?? null,
      status: numeric(sample?.context?.occupancy_percent) ? "measured" : "unknown",
    };
  });
  const completedEvents = runtime.handoffEvents.filter((event) => event.lifecycle_state === "COMPLETED");
  const handoffCount = unique(completedEvents.map((event) => event.handoff_id).filter(Boolean)).length;
  const lifecycle = handoffLifecycleChains(runtime.handoffEvents, runtime.samples, attestation.effective_threshold);
  const lifecycleComplete = lifecycle.complete;
  const artifactBytes = aggregateArtifacts(runtime.handoffEvents);
  const handoff = {
    lifecycle_events: runtime.handoffEvents,
    required_lifecycle_states: REQUIRED_HANDOFF_STATES,
    lifecycle_complete: lifecycleComplete,
    handoff_count: handoffCount,
    effective_handoff_contexts: effectiveHandoffContexts,
    lifecycle_correlations: lifecycle.chains.map((chain) => ({
      handoff_id: chain.handoff_id,
      suggested_metric_event_id: chain.suggested?.metric_event_id ?? null,
      prepared_metric_event_id: chain.prepared?.metric_event_id ?? null,
      started_metric_event_id: chain.started?.metric_event_id ?? null,
      completed_metric_event_id: chain.completed?.metric_event_id ?? null,
      suggested_sample_id: chain.sample?.sample_id ?? null,
      crossing: chain.crossing,
    })),
    duration_ms: sumKnown(completedEvents.map((event) => event.duration_ms)),
    continuity_duration_ms: sumKnown(runtime.handoffEvents.filter((event) => numeric(event.continuity_duration_ms)).map((event) => event.continuity_duration_ms)),
    resume_duration_ms: sumKnown(runtime.handoffEvents.filter((event) => numeric(event.resume_duration_ms)).map((event) => event.resume_duration_ms)),
    artifact_bytes: artifactBytes,
    token_overhead: { amount: null, status: "unknown", semantic: "resume_calls_include_useful_work" },
    cost_overhead: unknownCost("resume_calls_include_useful_work"),
  };

  const expectedCheckpoints = protocol.accepted_checkpoints ?? protocol.workload?.phases?.map((phase) => phase.checkpoint) ?? [];
  const ledgerAccepted = ledger ? expectedCheckpoints.filter((id) => {
    const item = ledger.task_items.find((candidate) => candidate.task_item_id === id);
    return item?.status === "DONE" && Array.isArray(item.evidence) && item.evidence.length > 0;
  }) : [];
  const declaredAccepted = qualityEvidence?.accepted_checkpoints ?? [];
  const acceptedCheckpoints = expectedCheckpoints.filter((id) => ledgerAccepted.includes(id) && declaredAccepted.includes(id));
  const latestSuite = qualityEvidence ? latestGateSuite(qualityEvidence.gate_attempts, acceptanceCommands) : { number: null, records: [], complete: false, pass: false };
  const suiteChronological = latestSuite.complete && latestSuite.records.every((gate, index) => index === 0
    || Date.parse(gate.started_at) >= Date.parse(latestSuite.records[index - 1].ended_at));
  const decisionAfterSuite = latestSuite.complete && qualityEvidence?.final_acceptance
    && Date.parse(qualityEvidence.final_acceptance.decided_at) >= Date.parse(latestSuite.records.at(-1).ended_at);
  const taskComplete = ledger?.status === "DONE" && ledger.current_item === null && ledger.next_item === null;
  const reviewFindings = (qualityEvidence?.review_findings ?? []).map((finding) => ({
    ...finding,
    artifact_digest_status: artifactDigestStatus(attestation.worktree, finding),
  }));
  const blockingReviewOpen = reviewFindings.some((item) => item.severity === "BLOCKING" && item.status === "OPEN");
  const reviewArtifactsValid = reviewFindings.every((item) => ["not_declared", "verified"].includes(item.artifact_digest_status));
  const unresolvedRegressions = (qualityEvidence?.regressions ?? []).filter((item) => item.status === "DETECTED");
  const openRework = (qualityEvidence?.rework_cycles ?? []).filter((item) => item.status === "OPEN");
  const reworkTriggersPresent = (qualityEvidence?.gate_attempts ?? []).some((item) => item.exit_code !== 0)
    || reviewFindings.some((item) => item.severity === "BLOCKING" && item.status === "RESOLVED")
    || (qualityEvidence?.regressions ?? []).some((item) => item.status === "RESOLVED");
  const reworkEvidenceComplete = !reworkTriggersPresent || (qualityEvidence?.rework_cycles ?? []).length > 0;
  const controlsPass = qualityEvidence?.controls?.no_conversation_history_saved === true
    && qualityEvidence?.controls?.cold_review_new_session === true
    && qualityEvidence?.controls?.operator_protocol_deviation === false
    && qualityEvidence?.controls?.external_services_used === false;
  const qualityPass = Boolean(qualityEvidence
    && latestSuite.pass
    && suiteChronological
    && decisionAfterSuite
    && taskComplete
    && acceptedCheckpoints.length === expectedCheckpoints.length
    && qualityEvidence.completion_marker_observed === protocol.workload?.completion_marker
    && !blockingReviewOpen
    && reviewArtifactsValid
    && unresolvedRegressions.length === 0
    && openRework.length === 0
    && reworkEvidenceComplete
    && controlsPass
    && qualityEvidence.final_acceptance?.status === "PASS");
  const quality = {
    evidence_schema: qualityEvidence?.schema_version ?? null,
    accepted_checkpoints: acceptedCheckpoints,
    accepted_checkpoint_count: acceptedCheckpoints.length,
    expected_checkpoints: expectedCheckpoints,
    completion_marker_observed: qualityEvidence?.completion_marker_observed ?? null,
    acceptance_commands: acceptanceCommands,
    gate_attempts: qualityEvidence?.gate_attempts ?? [],
    test_attempts: qualityEvidence?.gate_attempts ?? [],
    latest_gate_suite: latestSuite,
    latest_gate_suite_chronological: suiteChronological,
    final_decision_after_latest_suite: Boolean(decisionAfterSuite),
    task_complete: taskComplete,
    failures: (qualityEvidence?.gate_attempts ?? []).filter((item) => item.exit_code !== 0),
    test_failures: (qualityEvidence?.gate_attempts ?? []).filter((item) => item.exit_code !== 0),
    rework_cycles: qualityEvidence?.rework_cycles ?? [],
    rework_cycle_count: qualityEvidence?.rework_cycles?.length ?? 0,
    rework_evidence_complete: reworkEvidenceComplete,
    review_findings: reviewFindings,
    regressions: qualityEvidence?.regressions ?? [],
    controls: qualityEvidence?.controls ?? null,
    final_acceptance: qualityEvidence?.final_acceptance ?? null,
    result: qualityPass ? "PASS" : "FAIL",
    input_error: qualityFailure ?? ledgerFailure,
  };

  const sufficientNoCrossingProof = coreTelemetryComplete;
  const classificationReasons = [...sourceFailures];
  if (!coreTelemetryComplete || (!crossings.length && !sufficientNoCrossingProof)) {
    classificationReasons.push("INVALID_TELEMETRY");
    if (blockingDiagnostics.length) classificationReasons.push("BLOCKING_MEASUREMENT_DIAGNOSTICS");
    if (sessionMeasurementMissing) classificationReasons.push("SESSION_MEASUREMENT_MISSING");
    if (!callCountComplete) classificationReasons.push("MODEL_CALL_SAMPLE_COUNT_MISMATCH");
    if (!usageComplete) classificationReasons.push("ESSENTIAL_USAGE_INCOMPLETE");
    if (!contextComplete) classificationReasons.push("CONTEXT_COVERAGE_INCOMPLETE");
  }
  if (!qualityPass) classificationReasons.push(qualityFailure ?? ledgerFailure ?? "INVALID_QUALITY");
  if ((crossings.length > 0 || runtime.handoffEvents.length > 0) && !lifecycleComplete) classificationReasons.push("INVALID_HANDOFF_LIFECYCLE");
  const reasons = unique(classificationReasons);
  let classification;
  let status;
  if (reasons.length) {
    classification = "INVALID";
    status = reasons.includes("INVALID_TELEMETRY") ? "INVALID_TELEMETRY"
      : reasons.some((item) => item.includes("PROTOCOL") || item.includes("CONTROLLED") || item.includes("PREFLIGHT") || item.includes("IDENTITY") || item.includes("RUNTIME")) ? "INVALID_CONTROLLED_VARIABLE"
        : reasons.includes("INVALID_HANDOFF_LIFECYCLE") ? "INVALID_HANDOFF"
          : "INVALID_QUALITY";
  } else if (!crossings.length) {
    classification = "CENSORED";
    status = "CENSORED_EARLY_COMPLETION";
  } else {
    classification = "VALID";
    status = "VALID";
  }

  const telemetryCompleteForCost = coreTelemetryComplete;
  const chargedCost = aggregateCost(runtime.samples, "charged_provider", "provider_invoice_or_charge", "provider_invoice_or_charge", telemetryCompleteForCost);
  const equivalentCost = aggregateCost(runtime.samples, "equivalent", "pi_model_catalog_equivalent_cost_not_provider_charge", "pi_model_catalog_equivalent_cost_not_provider_charge", telemetryCompleteForCost);
  const runStartedAt = minIso(runtime.sessions.map((session) => session.started_at));
  const runEndedAt = qualityEvidence?.final_acceptance?.decided_at ?? null;
  const acceptedCount = acceptedCheckpoints.length;
  const costPerCheckpoint = {
    charged: chargedCost.status === "available" && acceptedCount > 0
      ? { amount: chargedCost.amount / acceptedCount, currency: "USD", status: "available", semantic: chargedCost.semantic }
      : unknownCost(acceptedCount > 0 ? chargedCost.semantic : "no_accepted_checkpoint"),
    equivalent: equivalentCost.status === "available" && acceptedCount > 0
      ? { amount: equivalentCost.amount / acceptedCount, currency: "USD", status: "available", semantic: equivalentCost.semantic }
      : unknownCost(acceptedCount > 0 ? equivalentCost.semantic : "no_accepted_checkpoint"),
  };
  const correlationPartialSamples = runtime.samples.filter((sample) => (sample.task_id ?? null) === null
    || sample.collection_status === "measurement_complete_correlation_partial");
  const telemetry = {
    session_ids: runtime.sessions.map((session) => session.session_id),
    context_samples: contextSamples,
    max_context_percent: maxContext,
    crossing_samples: crossings,
    input_tokens: tokenTotals.input_tokens,
    output_tokens: tokenTotals.output_tokens,
    reasoning_tokens: tokenTotals.reasoning_tokens,
    cache_read_tokens: tokenTotals.cache_read_tokens,
    cache_write_tokens: tokenTotals.cache_write_tokens,
    model_calls: runtime.samples.length,
    expected_model_calls_from_session_summaries: expectedModelCalls,
    equivalent_cost: equivalentCost,
    charged_cost: chargedCost,
    diagnostics: runtime.diagnostics,
    blocking_diagnostic_count: blockingDiagnostics.length,
    correlation_degraded_count: correlationDiagnostics.length,
    measurement_status: coreTelemetryComplete
      ? (correlationDiagnostics.length || correlationPartialSamples.length ? "measurement_complete_correlation_partial" : "measurement_complete")
      : "measurement_missing",
  };
  const logicalRuntimeDigest = digestObject({
    identity: runtime.identity,
    sessions: runtime.sessions,
    samples: runtime.samples,
    handoff_events: runtime.handoffEvents,
    diagnostics: runtime.diagnostics,
  });
  const outcome = {
    run_started_at: runStartedAt,
    run_ended_at: runEndedAt,
    completion_time_ms: duration(runStartedAt, runEndedAt),
    classification,
    classification_detail: status,
    classification_reasons: reasons,
    cost_per_accepted_checkpoint: costPerCheckpoint,
  };
  const record = {
    schema_version: CALIBRATION_RUN_RECORD_SCHEMA,
    finalizer_schema_version: CALIBRATION_FINALIZER_SCHEMA,
    run_id: attestation.run_id,
    variant_id: attestation.variant_id,
    status,
    classification,
    classification_reasons: reasons,
    preflight_attestation_path: attestation.attestation_path,
    identity: {
      run_id: attestation.run_id,
      session_ids: telemetry.session_ids,
      preflight_attestation_path: attestation.attestation_path,
      experiment_id: attestation.experiment_id,
      workload_id: attestation.workload_id,
      threshold_percent: attestation.effective_threshold,
      application_baseline_commit: attestation.application_baseline_commit,
      experiment_baseline_commit: attestation.experiment_baseline_commit,
      protocol_id: protocol.protocol_id,
      protocol_file_sha256: attestation.protocol_digest,
      workload_prompt_sha256: attestation.workload_digest,
      workload_ledger_sha256: ledger?.content_digest?.slice("sha256:".length) ?? null,
      branch: attestation.branch,
      worktree: attestation.worktree,
      runtime_store_identity: runtime.identity?.runtime_store_id ?? null,
    },
    environment: {
      provider: attestation.provider,
      model: attestation.model,
      reasoning_level: attestation.reasoning,
      pi_version: attestation.pi_version,
      node_version: attestation.node_version,
      confirm_mode: attestation.confirm_mode,
    },
    runtime_store: attestation.runtime_store,
    session_ids: telemetry.session_ids,
    telemetry,
    handoff,
    quality,
    outcome,
    run_started_at: runStartedAt,
    run_ended_at: runEndedAt,
    finalizer_inputs: {
      preflight_attestation_sha256: loaded.digest,
      protocol_sha256: sha256(protocolBytes),
      runtime_logical_sha256: logicalRuntimeDigest,
      workload_ledger_sha256: ledger?.content_digest ?? null,
      quality_evidence_sha256: qualityEvidence ? digestObject(qualityEvidence) : null,
    },
  };
  writeDeterministic(outputPath, record);
  return Object.freeze({ record, path: outputPath });
}
