import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

export const CALIBRATION_QUALITY_SCHEMA = "aiopago.calibration-quality-evidence/1.0.0";
export const LEGACY_CALIBRATION_QUALITY_SCHEMA = "eiopago.calibration-quality-evidence/1.0.0";
export const QUALITY_EVIDENCE_FILE = "quality-evidence.json";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function exactKeys(value, keys, code) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code);
  const actual = Object.keys(value).sort();
  invariant(JSON.stringify(actual) === JSON.stringify([...keys].sort()), code);
}
function boundedString(value, code, { nullable = false, max = 512 } = {}) {
  if (nullable && value === null) return;
  invariant(typeof value === "string" && value.length > 0 && value.length <= max, code);
}
function boundedArray(value, code, max = 100) {
  invariant(Array.isArray(value) && value.length <= max, code);
}
function iso(value, code, nullable = false) {
  if (nullable && value === null) return;
  invariant(typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)), code);
}
function unique(values, code) { invariant(new Set(values).size === values.length, code); }

export function emptyCalibrationQualityEvidence(runId) {
  boundedString(runId, "QUALITY_RUN_ID_INVALID", { max: 128 });
  return {
    schema_version: CALIBRATION_QUALITY_SCHEMA,
    run_id: runId,
    accepted_checkpoints: [],
    completion_marker_observed: null,
    controls: {
      no_conversation_history_saved: null,
      cold_review_new_session: null,
      operator_protocol_deviation: null,
      external_services_used: null,
    },
    gate_attempts: [],
    review_findings: [],
    rework_cycles: [],
    regressions: [],
    final_acceptance: null,
  };
}

export function validateCalibrationQualityEvidence(evidence, { runId = evidence?.run_id, expectedCommands = [] } = {}) {
  exactKeys(evidence, ["schema_version", "run_id", "accepted_checkpoints", "completion_marker_observed", "controls", "gate_attempts", "review_findings", "rework_cycles", "regressions", "final_acceptance"], "QUALITY_EVIDENCE_FIELDS_INVALID");
  invariant([CALIBRATION_QUALITY_SCHEMA, LEGACY_CALIBRATION_QUALITY_SCHEMA].includes(evidence.schema_version), "QUALITY_EVIDENCE_SCHEMA_MISMATCH");
  invariant(evidence.run_id === runId, "QUALITY_RUN_ID_MISMATCH");
  boundedArray(expectedCommands, "QUALITY_EXPECTED_COMMANDS_INVALID", 16);
  unique(expectedCommands, "QUALITY_EXPECTED_COMMANDS_DUPLICATE");

  boundedArray(evidence.accepted_checkpoints, "QUALITY_CHECKPOINTS_INVALID", 32);
  for (const id of evidence.accepted_checkpoints) boundedString(id, "QUALITY_CHECKPOINT_ID_INVALID", { max: 128 });
  unique(evidence.accepted_checkpoints, "QUALITY_CHECKPOINT_DUPLICATE");
  boundedString(evidence.completion_marker_observed, "QUALITY_COMPLETION_MARKER_INVALID", { nullable: true });

  exactKeys(evidence.controls, ["no_conversation_history_saved", "cold_review_new_session", "operator_protocol_deviation", "external_services_used"], "QUALITY_CONTROLS_INVALID");
  for (const value of Object.values(evidence.controls)) invariant(value === null || typeof value === "boolean", "QUALITY_CONTROL_VALUE_INVALID");

  boundedArray(evidence.gate_attempts, "QUALITY_GATE_ATTEMPTS_INVALID");
  const gateIds = [];
  for (const gate of evidence.gate_attempts) {
    exactKeys(gate, ["suite_attempt", "ordinal", "command", "started_at", "ended_at", "exit_code", "output_sha256"], "QUALITY_GATE_FIELDS_INVALID");
    invariant(Number.isInteger(gate.suite_attempt) && gate.suite_attempt > 0 && Number.isInteger(gate.ordinal) && gate.ordinal > 0, "QUALITY_GATE_ORDER_INVALID");
    invariant(expectedCommands.includes(gate.command), "QUALITY_GATE_COMMAND_INVALID", gate.command);
    iso(gate.started_at, "QUALITY_GATE_TIME_INVALID");
    iso(gate.ended_at, "QUALITY_GATE_TIME_INVALID");
    invariant(Date.parse(gate.ended_at) >= Date.parse(gate.started_at), "QUALITY_GATE_TIME_INVALID");
    invariant(Number.isInteger(gate.exit_code) && gate.exit_code >= 0 && gate.exit_code <= 255, "QUALITY_GATE_EXIT_INVALID");
    invariant(SHA256.test(gate.output_sha256), "QUALITY_GATE_OUTPUT_DIGEST_INVALID");
    gateIds.push(`${gate.suite_attempt}:${gate.ordinal}`);
  }
  unique(gateIds, "QUALITY_GATE_DUPLICATE");

  boundedArray(evidence.review_findings, "QUALITY_REVIEW_FINDINGS_INVALID");
  for (const finding of evidence.review_findings) {
    exactKeys(finding, ["finding_id", "severity", "status", "code", "artifact_path", "artifact_sha256"], "QUALITY_REVIEW_FINDING_FIELDS_INVALID");
    boundedString(finding.finding_id, "QUALITY_FINDING_ID_INVALID", { max: 128 });
    invariant(["BLOCKING", "NON_BLOCKING"].includes(finding.severity) && ["OPEN", "RESOLVED"].includes(finding.status), "QUALITY_FINDING_STATE_INVALID");
    boundedString(finding.code, "QUALITY_FINDING_CODE_INVALID", { max: 128 });
    boundedString(finding.artifact_path, "QUALITY_FINDING_ARTIFACT_INVALID", { nullable: true, max: 512 });
    invariant(finding.artifact_sha256 === null || SHA256.test(finding.artifact_sha256), "QUALITY_FINDING_ARTIFACT_DIGEST_INVALID");
  }
  unique(evidence.review_findings.map((item) => item.finding_id), "QUALITY_FINDING_DUPLICATE");

  boundedArray(evidence.rework_cycles, "QUALITY_REWORK_INVALID");
  for (const cycle of evidence.rework_cycles) {
    exactKeys(cycle, ["cycle_id", "status", "trigger_refs", "files_changed"], "QUALITY_REWORK_FIELDS_INVALID");
    boundedString(cycle.cycle_id, "QUALITY_REWORK_ID_INVALID", { max: 128 });
    invariant(["OPEN", "CLOSED"].includes(cycle.status), "QUALITY_REWORK_STATUS_INVALID");
    boundedArray(cycle.trigger_refs, "QUALITY_REWORK_TRIGGERS_INVALID", 32);
    boundedArray(cycle.files_changed, "QUALITY_REWORK_FILES_INVALID", 256);
    for (const value of [...cycle.trigger_refs, ...cycle.files_changed]) boundedString(value, "QUALITY_REWORK_VALUE_INVALID", { max: 512 });
    unique(cycle.trigger_refs, "QUALITY_REWORK_TRIGGER_DUPLICATE");
    unique(cycle.files_changed, "QUALITY_REWORK_FILE_DUPLICATE");
  }
  unique(evidence.rework_cycles.map((item) => item.cycle_id), "QUALITY_REWORK_DUPLICATE");

  boundedArray(evidence.regressions, "QUALITY_REGRESSIONS_INVALID");
  for (const regression of evidence.regressions) {
    exactKeys(regression, ["regression_id", "status", "code"], "QUALITY_REGRESSION_FIELDS_INVALID");
    boundedString(regression.regression_id, "QUALITY_REGRESSION_ID_INVALID", { max: 128 });
    boundedString(regression.code, "QUALITY_REGRESSION_CODE_INVALID", { max: 128 });
    invariant(["DETECTED", "RESOLVED"].includes(regression.status), "QUALITY_REGRESSION_STATUS_INVALID");
  }
  unique(evidence.regressions.map((item) => item.regression_id), "QUALITY_REGRESSION_DUPLICATE");

  if (evidence.final_acceptance !== null) {
    exactKeys(evidence.final_acceptance, ["decision_id", "status", "decided_at"], "QUALITY_FINAL_ACCEPTANCE_FIELDS_INVALID");
    boundedString(evidence.final_acceptance.decision_id, "QUALITY_FINAL_ACCEPTANCE_ID_INVALID", { max: 128 });
    invariant(["PASS", "FAIL"].includes(evidence.final_acceptance.status), "QUALITY_FINAL_ACCEPTANCE_STATUS_INVALID");
    iso(evidence.final_acceptance.decided_at, "QUALITY_FINAL_ACCEPTANCE_TIME_INVALID");
  }
  return structuredClone(evidence);
}

export function loadCalibrationQualityEvidence(path, options = {}) {
  const resolved = resolve(path);
  invariant(existsSync(resolved), "QUALITY_EVIDENCE_MISSING", resolved);
  let evidence;
  try { evidence = JSON.parse(readFileSync(resolved, "utf8")); }
  catch { invariant(false, "QUALITY_EVIDENCE_JSON_INVALID"); }
  return validateCalibrationQualityEvidence(evidence, options);
}

export function writeCalibrationQualityEvidence(path, evidence, options = {}) {
  const resolved = resolve(path);
  const validated = validateCalibrationQualityEvidence(evidence, options);
  const bytes = `${canonicalJson(validated)}\n`;
  const temp = `${resolved}.${process.pid}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, resolved);
    try { const dirFd = openSync(dirname(resolved), "r"); fsyncSync(dirFd); closeSync(dirFd); } catch {}
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
  return validated;
}
