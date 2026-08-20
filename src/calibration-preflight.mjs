import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, sha256, utcNow } from "./canonical.mjs";
import { emptyCalibrationQualityEvidence, QUALITY_EVIDENCE_FILE } from "./calibration-quality.mjs";
import { contextHandoffThreshold, contextHandoffThresholdEnvironment, CONTEXT_HANDOFF_THRESHOLD_ENV } from "./context-advisor.mjs";
import { GuardianError, invariant } from "./errors.mjs";

export const CALIBRATION_ATTESTATION_SCHEMA = "aiopago.calibration-preflight/1.0.0";
export const LEGACY_CALIBRATION_ATTESTATION_SCHEMA = "eiopago.calibration-preflight/1.0.0";
export const CALIBRATION_RUN_RECORD_SCHEMA = "aiopago.calibration-run-record/1.0.0";
export const DEFAULT_CALIBRATION_PROTOCOL = "docs/m1-h2-calibration-pilot.json";

function digestHex(bytes) { return sha256(bytes).slice("sha256:".length); }
function slash(path) { return resolve(path).replaceAll("\\", "/"); }
function samePath(a, b) { return slash(a).toLowerCase() === slash(b).toLowerCase(); }
function git(cwd, args, encoding = "utf8") {
  const output = execFileSync("git", args, { cwd, encoding: encoding === "buffer" ? null : encoding, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return Buffer.isBuffer(output) ? output : output.trim();
}
function safeJson(bytes) {
  try { return { value: JSON.parse(bytes.toString("utf8")), error: null }; }
  catch (error) { return { value: null, error }; }
}
function reason(code, details = undefined) {
  if (details === undefined) return { code };
  return { code, details: JSON.parse(JSON.stringify(details, (_key, value) => value === undefined ? null : value)) };
}
function safeRunId(runId) { return typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId); }
function writeJson(path, value) { writeFileSync(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx" }); }
function readPiVersion(piRoot) {
  const pkg = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
  return pkg.version;
}

export function makeCalibrationRunId(variantId) {
  invariant(typeof variantId === "string" && variantId.length > 0, "CALIBRATION_VARIANT_REQUIRED");
  return `H2-02B-${variantId}-${randomUUID()}`;
}

export function calibrationPaths(cwd, runId, calibrationRoot = join(cwd, ".guardian", "calibration")) {
  invariant(safeRunId(runId), "CALIBRATION_RUN_ID_INVALID", runId);
  const runRoot = resolve(calibrationRoot, runId);
  return Object.freeze({
    calibrationRoot: resolve(calibrationRoot),
    runRoot,
    protocolCopyPath: join(runRoot, "pilot-protocol.json"),
    workloadProtocolPath: join(resolve(calibrationRoot), "pilot-protocol.json"),
    attestationPath: join(runRoot, "preflight-attestation.json"),
    runtimeRoot: join(runRoot, "runtime"),
    runtimeStorePath: join(runRoot, "runtime", "guardian.sqlite"),
    qualityEvidencePath: join(runRoot, QUALITY_EVIDENCE_FILE),
    runRecordPath: join(runRoot, "run-record.json"),
  });
}

function emptyRunRecord(attestation) {
  return {
    schema_version: CALIBRATION_RUN_RECORD_SCHEMA,
    run_id: attestation.run_id,
    variant_id: attestation.variant_id,
    status: attestation.preflight_result === "PASS" ? "PREFLIGHT_PASSED" : "INVALID_PREFLIGHT",
    classification: attestation.preflight_result === "PASS" ? null : "INVALID",
    classification_reasons: attestation.failure_reasons.map((item) => item.code),
    preflight_attestation_path: attestation.attestation_path,
    identity: {
      experiment_id: attestation.experiment_id,
      workload_id: attestation.workload_id,
      threshold_percent: attestation.effective_threshold,
      application_baseline_commit: attestation.application_baseline_commit,
      experiment_baseline_commit: attestation.experiment_baseline_commit,
      protocol_file_sha256: attestation.protocol_digest,
      workload_prompt_sha256: attestation.workload_digest,
      branch: attestation.branch,
      worktree: attestation.worktree,
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
    session_ids: [],
    telemetry: null,
    handoff: null,
    quality: null,
    run_started_at: null,
    run_ended_at: null,
  };
}

export function runCalibrationPreflight({
  cwd = process.cwd(),
  variantId,
  experimentBaselineCommit,
  protocolPath = join(cwd, DEFAULT_CALIBRATION_PROTOCOL),
  calibrationRoot = join(cwd, ".guardian", "calibration"),
  runId = makeCalibrationRunId(variantId),
  piRoot,
  now = utcNow(),
} = {}) {
  cwd = resolve(cwd);
  protocolPath = resolve(protocolPath);
  invariant(safeRunId(runId), "CALIBRATION_RUN_ID_INVALID", runId);
  invariant(/^[a-f0-9]{40}$/.test(experimentBaselineCommit ?? ""), "EXPERIMENT_BASELINE_INVALID");
  invariant(piRoot && isAbsolute(piRoot), "PI_ROOT_REQUIRED");

  const paths = calibrationPaths(cwd, runId, calibrationRoot);
  const failures = [];
  let protocolBytes = null;
  let protocol = null;
  try { protocolBytes = readFileSync(protocolPath); }
  catch (error) { failures.push(reason("PROTOCOL_SOURCE_MISSING", error.code)); }
  if (protocolBytes) {
    const parsed = safeJson(protocolBytes);
    protocol = parsed.value;
    if (parsed.error) failures.push(reason("PROTOCOL_JSON_INVALID"));
  }

  let repoRoot = null;
  let head = null;
  let branch = null;
  let status = null;
  try { repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]); }
  catch { failures.push(reason("REPOSITORY_INVALID")); }
  if (repoRoot && !samePath(repoRoot, cwd)) failures.push(reason("WORKTREE_ROOT_MISMATCH", { expected: slash(cwd), actual: slash(repoRoot) }));
  try { head = git(cwd, ["rev-parse", "HEAD"]); }
  catch { failures.push(reason("HEAD_UNAVAILABLE")); }
  if (head && head !== experimentBaselineCommit) failures.push(reason("HEAD_MISMATCH", { expected: experimentBaselineCommit, actual: head }));
  try { branch = git(cwd, ["branch", "--show-current"]); }
  catch { failures.push(reason("BRANCH_UNAVAILABLE")); }
  try { status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]); }
  catch { failures.push(reason("GIT_STATUS_UNAVAILABLE")); }
  if (status) failures.push(reason("WORKTREE_DIRTY", status.split(/\r?\n/)));

  const variant = protocol?.runs?.find((item) => (item.variant_id ?? item.run_id) === variantId) ?? null;
  if (!variant) failures.push(reason("CALIBRATION_VARIANT_UNKNOWN", variantId));
  if (variant?.branch && branch && branch !== variant.branch) failures.push(reason("BRANCH_MISMATCH", { expected: variant.branch, actual: branch }));
  if (variant?.worktree && !samePath(variant.worktree, cwd)) failures.push(reason("WORKTREE_PATH_MISMATCH", { expected: slash(variant.worktree), actual: slash(cwd) }));

  let frozenProtocolBytes = null;
  if (protocolBytes && head === experimentBaselineCommit) {
    const protocolRelative = relative(cwd, protocolPath).replaceAll("\\", "/");
    if (protocolRelative.startsWith("../") || protocolRelative === "..") failures.push(reason("PROTOCOL_OUTSIDE_WORKTREE"));
    else {
      try { frozenProtocolBytes = git(cwd, ["show", `${experimentBaselineCommit}:${protocolRelative}`], "buffer"); }
      catch { failures.push(reason("FROZEN_PROTOCOL_MISSING")); }
      if (frozenProtocolBytes && !frozenProtocolBytes.equals(protocolBytes)) failures.push(reason("PROTOCOL_DIGEST_MISMATCH"));
    }
  }

  const protocolDigest = protocolBytes ? digestHex(protocolBytes) : null;
  const promptBytes = typeof protocol?.workload_prompt === "string" ? Buffer.from(protocol.workload_prompt, "utf8") : null;
  const workloadDigest = promptBytes ? digestHex(promptBytes) : null;
  if (!promptBytes) failures.push(reason("WORKLOAD_PROMPT_MISSING"));
  if (workloadDigest && workloadDigest !== protocol?.workload_prompt_sha256) failures.push(reason("WORKLOAD_DIGEST_MISMATCH"));

  let piVersion = null;
  try { piVersion = readPiVersion(piRoot); }
  catch { failures.push(reason("PI_VERSION_UNAVAILABLE")); }
  if (piVersion && protocol?.controlled_environment?.pi_version !== piVersion) failures.push(reason("PI_VERSION_MISMATCH", { expected: protocol?.controlled_environment?.pi_version, actual: piVersion }));
  if (protocol?.controlled_environment?.node_version && protocol.controlled_environment.node_version !== process.version) failures.push(reason("NODE_VERSION_MISMATCH", { expected: protocol.controlled_environment.node_version, actual: process.version }));

  const requestedThreshold = variant?.threshold_percent ?? null;
  let effectiveThreshold = null;
  try { effectiveThreshold = contextHandoffThreshold(requestedThreshold); }
  catch { failures.push(reason("THRESHOLD_INVALID")); }
  if (effectiveThreshold !== requestedThreshold) failures.push(reason("THRESHOLD_MISMATCH", { requested: requestedThreshold, effective: effectiveThreshold }));

  const provider = protocol?.controlled_environment?.provider ?? null;
  const modelId = protocol?.controlled_environment?.model ?? null;
  const reasoning = protocol?.controlled_environment?.reasoning_level ?? null;
  const confirmMode = protocol?.controlled_environment?.confirm_mode ?? null;
  if (!provider || !modelId) failures.push(reason("MODEL_POLICY_MISSING"));
  if (!reasoning) failures.push(reason("REASONING_POLICY_MISSING"));
  if (confirmMode !== "confirm") failures.push(reason("CONFIRM_MODE_INVALID", confirmMode));

  try { mkdirSync(paths.runRoot, { recursive: false }); }
  catch (error) {
    if (error.code === "ENOENT") {
      mkdirSync(dirname(paths.runRoot), { recursive: true });
      try { mkdirSync(paths.runRoot, { recursive: false }); }
      catch (again) { throw new GuardianError(again.code === "EEXIST" ? "DUPLICATE_RUN_ID" : "CALIBRATION_RUN_ROOT_CREATE_FAILED", again.message); }
    } else throw new GuardianError(error.code === "EEXIST" ? "DUPLICATE_RUN_ID" : "CALIBRATION_RUN_ROOT_CREATE_FAILED", error.message);
  }

  if (protocolBytes) {
    writeFileSync(paths.protocolCopyPath, protocolBytes, { flag: "wx" });
    if (failures.length === 0) {
      try { writeFileSync(paths.workloadProtocolPath, protocolBytes, { flag: "wx" }); }
      catch (error) {
        if (error.code !== "EEXIST" || !readFileSync(paths.workloadProtocolPath).equals(protocolBytes)) failures.push(reason("WORKLOAD_PROTOCOL_COPY_CONFLICT"));
      }
      if (!readFileSync(paths.protocolCopyPath).equals(protocolBytes) || !readFileSync(paths.workloadProtocolPath).equals(protocolBytes)) failures.push(reason("PROTOCOL_COPY_NOT_BYTE_IDENTICAL"));
    }
  }
  const runtimeStoreId = `CALSTORE-${randomUUID()}`;
  const attestation = {
    schema_version: CALIBRATION_ATTESTATION_SCHEMA,
    run_id: runId,
    variant_id: variantId,
    experiment_id: protocol?.protocol_id ?? null,
    workload_id: protocol?.workload?.id ?? null,
    experiment_baseline_commit: experimentBaselineCommit,
    application_baseline_commit: protocol?.application_baseline_commit ?? null,
    branch,
    worktree: slash(cwd),
    clean_status: status === "",
    pi_version: piVersion,
    node_version: process.version,
    protocol_source_path: slash(protocolPath),
    protocol_copy_path: slash(paths.protocolCopyPath),
    workload_protocol_path: slash(paths.workloadProtocolPath),
    protocol_digest: protocolDigest,
    workload_digest: workloadDigest,
    requested_threshold: requestedThreshold,
    effective_threshold: effectiveThreshold,
    provider,
    model: modelId,
    reasoning,
    confirm_mode: confirmMode,
    runtime_store: {
      identity: runtimeStoreId,
      path: slash(paths.runtimeStorePath),
      created_fresh: true,
    },
    created_at: now,
    preflight_result: failures.length === 0 ? "PASS" : "FAIL",
    failure_reasons: failures,
    attestation_path: slash(paths.attestationPath),
  };
  writeJson(paths.attestationPath, attestation);
  writeJson(paths.qualityEvidencePath, emptyCalibrationQualityEvidence(runId));
  writeJson(paths.runRecordPath, emptyRunRecord(attestation));
  return Object.freeze({ attestation, protocol, paths });
}

export function loadCalibrationAttestation(attestationPath) {
  let bytes;
  try { bytes = readFileSync(attestationPath); }
  catch (error) { throw new GuardianError("CALIBRATION_ATTESTATION_MISSING", error.message); }
  let attestation;
  try { attestation = JSON.parse(bytes.toString("utf8")); }
  catch { throw new GuardianError("CALIBRATION_ATTESTATION_INVALID"); }
  invariant([CALIBRATION_ATTESTATION_SCHEMA, LEGACY_CALIBRATION_ATTESTATION_SCHEMA].includes(attestation.schema_version), "CALIBRATION_ATTESTATION_SCHEMA_MISMATCH");
  return { attestation, bytes, digest: digestHex(bytes), path: resolve(attestationPath) };
}

export function calibrationRunnerOptions(attestationPath, { resume = false } = {}) {
  const loaded = loadCalibrationAttestation(attestationPath);
  const { attestation } = loaded;
  invariant(attestation.preflight_result === "PASS" && attestation.failure_reasons.length === 0, "CALIBRATION_PREFLIGHT_NOT_PASSED");
  return {
    cwd: attestation.worktree,
    storagePath: attestation.runtime_store.path,
    modelPolicy: `${attestation.provider}/${attestation.model}`,
    reasoningPolicy: attestation.reasoning,
    contextHandoffThresholdPercent: attestation.effective_threshold,
    confirmMode: attestation.confirm_mode,
    calibration: {
      attestationPath: loaded.path,
      attestationDigest: loaded.digest,
      runtimeIdentity: {
        run_id: attestation.run_id,
        runtime_store_id: attestation.runtime_store.identity,
        attestation_sha256: loaded.digest,
      },
      resume,
    },
  };
}

export function verifyCalibrationRuntimeState({ runner, attestationPath, processEnv = process.env, requestModel = null } = {}) {
  const { attestation, digest } = loadCalibrationAttestation(attestationPath);
  const failures = [];
  const mismatch = (code, expected, actual) => failures.push(reason(code, { expected, actual }));
  if (attestation.preflight_result !== "PASS" || attestation.failure_reasons.length !== 0) failures.push(reason("CALIBRATION_PREFLIGHT_NOT_PASSED"));
  if (!samePath(attestation.worktree, runner.cwd)) mismatch("RUNTIME_WORKTREE_MISMATCH", attestation.worktree, runner.cwd);
  if (!samePath(attestation.runtime_store.path, runner.storage.path)) mismatch("RUNTIME_STORE_PATH_MISMATCH", attestation.runtime_store.path, runner.storage.path);
  const identity = runner.storage.getCalibrationRuntimeIdentity?.();
  if (!identity || identity.run_id !== attestation.run_id || identity.runtime_store_id !== attestation.runtime_store.identity || identity.attestation_sha256 !== digest) {
    mismatch("RUNTIME_IDENTITY_MISMATCH", { run_id: attestation.run_id, runtime_store_id: attestation.runtime_store.identity, attestation_sha256: digest }, identity);
  }
  let protocolSource = null;
  let protocolCopy = null;
  let workloadProtocolCopy = null;
  try { protocolSource = readFileSync(attestation.protocol_source_path); }
  catch { failures.push(reason("PROTOCOL_SOURCE_MISSING")); }
  try { protocolCopy = readFileSync(attestation.protocol_copy_path); }
  catch { failures.push(reason("PROTOCOL_COPY_MISSING")); }
  try { workloadProtocolCopy = readFileSync(attestation.workload_protocol_path); }
  catch { failures.push(reason("WORKLOAD_PROTOCOL_COPY_MISSING")); }
  if (protocolSource && digestHex(protocolSource) !== attestation.protocol_digest) mismatch("PROTOCOL_DIGEST_MISMATCH", attestation.protocol_digest, digestHex(protocolSource));
  if (protocolCopy && digestHex(protocolCopy) !== attestation.protocol_digest) mismatch("PROTOCOL_COPY_DIGEST_MISMATCH", attestation.protocol_digest, digestHex(protocolCopy));
  if (workloadProtocolCopy && digestHex(workloadProtocolCopy) !== attestation.protocol_digest) mismatch("WORKLOAD_PROTOCOL_COPY_DIGEST_MISMATCH", attestation.protocol_digest, digestHex(workloadProtocolCopy));
  if (protocolSource && ((!protocolCopy || !protocolSource.equals(protocolCopy)) || (!workloadProtocolCopy || !protocolSource.equals(workloadProtocolCopy)))) failures.push(reason("PROTOCOL_COPY_NOT_BYTE_IDENTICAL"));
  if (protocolSource) {
    const parsed = safeJson(protocolSource);
    if (!parsed.value) failures.push(reason("PROTOCOL_JSON_INVALID"));
    else {
      const frozen = parsed.value;
      const promptDigest = typeof frozen.workload_prompt === "string" ? digestHex(Buffer.from(frozen.workload_prompt, "utf8")) : null;
      if (promptDigest !== attestation.workload_digest || promptDigest !== frozen.workload_prompt_sha256) mismatch("WORKLOAD_DIGEST_MISMATCH", attestation.workload_digest, promptDigest);
      const variant = frozen.runs?.find((item) => (item.variant_id ?? item.run_id) === attestation.variant_id);
      if (variant?.threshold_percent !== attestation.requested_threshold) mismatch("REQUESTED_THRESHOLD_MISMATCH", attestation.requested_threshold, variant?.threshold_percent);
      if (variant?.branch !== attestation.branch) mismatch("ATTESTED_BRANCH_PROTOCOL_MISMATCH", variant?.branch, attestation.branch);
      if (variant?.worktree && !samePath(variant.worktree, attestation.worktree)) mismatch("ATTESTED_WORKTREE_PROTOCOL_MISMATCH", variant.worktree, attestation.worktree);
      if (frozen.protocol_id !== attestation.experiment_id) mismatch("EXPERIMENT_ID_MISMATCH", frozen.protocol_id, attestation.experiment_id);
      if (frozen.workload?.id !== attestation.workload_id) mismatch("WORKLOAD_ID_MISMATCH", frozen.workload?.id, attestation.workload_id);
      if (frozen.application_baseline_commit !== attestation.application_baseline_commit) mismatch("APPLICATION_BASELINE_MISMATCH", frozen.application_baseline_commit, attestation.application_baseline_commit);
      const controlled = frozen.controlled_environment ?? {};
      if (controlled.provider !== attestation.provider || controlled.model !== attestation.model) mismatch("ATTESTED_MODEL_PROTOCOL_MISMATCH", `${controlled.provider}/${controlled.model}`, `${attestation.provider}/${attestation.model}`);
      if (controlled.reasoning_level !== attestation.reasoning) mismatch("ATTESTED_REASONING_PROTOCOL_MISMATCH", controlled.reasoning_level, attestation.reasoning);
      if (controlled.confirm_mode !== attestation.confirm_mode) mismatch("ATTESTED_CONFIRM_PROTOCOL_MISMATCH", controlled.confirm_mode, attestation.confirm_mode);
      if (controlled.pi_version !== attestation.pi_version) mismatch("ATTESTED_PI_VERSION_PROTOCOL_MISMATCH", controlled.pi_version, attestation.pi_version);
      if (controlled.node_version !== attestation.node_version) mismatch("ATTESTED_NODE_VERSION_PROTOCOL_MISMATCH", controlled.node_version, attestation.node_version);
    }
  }
  if (runner.contextAdvisor?.thresholdPercent !== attestation.effective_threshold) mismatch("EFFECTIVE_THRESHOLD_MISMATCH", attestation.effective_threshold, runner.contextAdvisor?.thresholdPercent);
  let processThreshold = null;
  try { processThreshold = contextHandoffThresholdEnvironment(processEnv, { warn: () => {} }); }
  catch (error) { failures.push(reason(error.code ?? "PROCESS_THRESHOLD_ENV_CONFLICT")); }
  if (String(processThreshold ?? "") !== String(attestation.requested_threshold)) mismatch("PROCESS_THRESHOLD_MISMATCH", String(attestation.requested_threshold), processThreshold ?? null);
  const sessionModel = requestModel ?? runner.runtime?.session?.model;
  if (sessionModel?.provider !== attestation.provider || sessionModel?.id !== attestation.model) mismatch("MODEL_MISMATCH", `${attestation.provider}/${attestation.model}`, sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : null);
  const thinking = runner.runtime?.session?.thinkingLevel;
  if (thinking !== attestation.reasoning) mismatch("REASONING_MISMATCH", attestation.reasoning, thinking);
  if (runner.confirmMode !== attestation.confirm_mode) mismatch("CONFIRM_MODE_MISMATCH", attestation.confirm_mode, runner.confirmMode);
  let piVersion = null;
  try { piVersion = readPiVersion(runner.pi.root); } catch {}
  if (piVersion !== attestation.pi_version) mismatch("PI_VERSION_MISMATCH", attestation.pi_version, piVersion);
  if (process.version !== attestation.node_version) mismatch("NODE_VERSION_MISMATCH", attestation.node_version, process.version);
  try {
    const head = git(runner.cwd, ["rev-parse", "HEAD"]);
    const branch = git(runner.cwd, ["branch", "--show-current"]);
    if (head !== attestation.experiment_baseline_commit) mismatch("HEAD_MISMATCH", attestation.experiment_baseline_commit, head);
    if (branch !== attestation.branch) mismatch("BRANCH_MISMATCH", attestation.branch, branch);
    const protocolRelative = relative(runner.cwd, attestation.protocol_source_path).replaceAll("\\", "/");
    if (protocolRelative.startsWith("../") || protocolRelative === "..") failures.push(reason("PROTOCOL_OUTSIDE_WORKTREE"));
    else if (protocolSource) {
      const frozenBytes = git(runner.cwd, ["show", `${attestation.experiment_baseline_commit}:${protocolRelative}`], "buffer");
      if (!frozenBytes.equals(protocolSource)) failures.push(reason("FROZEN_PROTOCOL_RUNTIME_MISMATCH"));
    }
  } catch { failures.push(reason("RUNTIME_GIT_STATE_UNAVAILABLE")); }
  if (failures.length) throw new GuardianError("CALIBRATION_RUNTIME_ATTESTATION_MISMATCH", "Calibration runtime does not match the frozen attestation", failures);
  return Object.freeze({ run_id: attestation.run_id, result: "PASS" });
}

export function markCalibrationRunInvalid(runRecordPath, error) {
  const record = JSON.parse(readFileSync(runRecordPath, "utf8"));
  record.status = "INVALID_PREFLIGHT";
  record.classification = "INVALID";
  record.classification_reasons = [error?.code ?? "CALIBRATION_RUNTIME_PREFLIGHT_FAILED"];
  writeFileSync(runRecordPath, `${canonicalJson(record)}\n`, "utf8");
  return record;
}

export function assertFreshRuntimeStore(path) {
  try { statSync(path); throw new GuardianError("STALE_RUNTIME_STORE", path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
