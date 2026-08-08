import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadCalibrationAttestation,
  runCalibrationPreflight,
  verifyCalibrationRuntimeState,
} from "../src/calibration-preflight.mjs";
import { GuardianError } from "../src/errors.mjs";
import { resolvePiRoot } from "../src/pi-loader.mjs";
import { AdmissionGate } from "../src/safety.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const piRoot = await resolvePiRoot();
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function protocol(root, branch = "calibration/test") {
  const prompt = "Implement the frozen offline fixture workload.";
  return {
    schema_version: "eiopago.threshold-calibration-protocol/1.0.0",
    protocol_id: "TEST-PILOT-1",
    application_baseline_commit: "a".repeat(40),
    controlled_environment: {
      provider: "test-provider",
      model: "test-model",
      reasoning_level: "high",
      pi_version: "0.83.0",
      node_version: process.version,
      confirm_mode: "confirm",
    },
    runs: [{ variant_id: "RUN-40", status: "AUTHORIZED_NOT_STARTED", threshold_percent: 40, branch, worktree: root }],
    workload: { id: "WL-TEST-1" },
    workload_prompt: prompt,
    workload_prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eiopago-calibration-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, ".gitignore"), ".guardian/calibration/\n");
  writeFileSync(join(root, "docs", "m1-h2-calibration-pilot.json"), `${JSON.stringify(protocol(root), null, 2)}\n`);
  git(root, ["init", "-b", "calibration/test"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Calibration Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return { root, baseline: git(root, ["rev-parse", "HEAD"]) };
}

function preflight(x, overrides = {}) {
  return runCalibrationPreflight({
    cwd: x.root,
    variantId: "RUN-40",
    experimentBaselineCommit: x.baseline,
    piRoot,
    runId: overrides.runId ?? `TEST-${Math.random().toString(16).slice(2)}`,
    ...overrides,
  });
}

function failureCodes(result) { return result.attestation.failure_reasons.map((item) => item.code); }
function runtimeFixture() {
  const x = fixture();
  const prepared = preflight(x);
  assert.equal(prepared.attestation.preflight_result, "PASS");
  const loaded = loadCalibrationAttestation(prepared.paths.attestationPath);
  const storage = new GuardianStorage(prepared.paths.runtimeStorePath);
  storage.bindCalibrationRuntimeIdentity({
    run_id: prepared.attestation.run_id,
    runtime_store_id: prepared.attestation.runtime_store.identity,
    attestation_sha256: loaded.digest,
  });
  storage.ensureLatch("TASK-TEST");
  const runner = {
    cwd: x.root,
    storage,
    contextAdvisor: { thresholdPercent: 40 },
    runtime: { session: { model: { provider: "test-provider", id: "test-model" }, thinkingLevel: "high" } },
    confirmMode: "confirm",
    pi: { root: piRoot },
  };
  const processEnv = { EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT: "40" };
  return { x, prepared, runner, processEnv, close: () => storage.close() };
}

function mismatchCode(error, code) {
  return error?.code === "CALIBRATION_RUNTIME_ATTESTATION_MISMATCH" && error.details.some((item) => item.code === code);
}

test("calibration preflight happy path persists byte-identical protocol, PASS attestation and run record", () => {
  const x = fixture();
  const result = preflight(x);
  assert.equal(result.attestation.preflight_result, "PASS");
  assert.equal(result.attestation.clean_status, true);
  assert.equal(result.attestation.requested_threshold, 40);
  assert.equal(result.attestation.effective_threshold, 40);
  assert.equal(readFileSync(result.paths.protocolCopyPath).equals(readFileSync(join(x.root, "docs", "m1-h2-calibration-pilot.json"))), true);
  const record = JSON.parse(readFileSync(result.paths.runRecordPath, "utf8"));
  assert.equal(record.status, "PREFLIGHT_PASSED");
});

test("calibration preflight rejects wrong HEAD", () => {
  const x = fixture();
  writeFileSync(join(x.root, "extra.txt"), "next\n");
  git(x.root, ["add", "."]); git(x.root, ["commit", "-m", "next"]);
  assert.ok(failureCodes(preflight(x)).includes("HEAD_MISMATCH"));
});

test("calibration preflight rejects wrong branch", () => {
  const x = fixture();
  git(x.root, ["switch", "-c", "calibration/wrong"]);
  assert.ok(failureCodes(preflight(x)).includes("BRANCH_MISMATCH"));
});

test("calibration preflight rejects a dirty worktree", () => {
  const x = fixture();
  writeFileSync(join(x.root, "dirty.txt"), "dirty\n");
  assert.ok(failureCodes(preflight(x)).includes("WORKTREE_DIRTY"));
});

test("calibration preflight rejects protocol digest mismatch against frozen Git bytes", () => {
  const x = fixture();
  writeFileSync(join(x.root, "docs", "m1-h2-calibration-pilot.json"), "{}\n");
  const codes = failureCodes(preflight(x));
  assert.ok(codes.includes("PROTOCOL_DIGEST_MISMATCH"));
});

test("runtime accepts matching attestation and authoritative effective state", () => {
  const f = runtimeFixture();
  try {
    assert.deepEqual(verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), { run_id: f.prepared.attestation.run_id, result: "PASS" });
  } finally { f.close(); }
});

test("runtime rejects threshold mismatch", () => {
  const f = runtimeFixture();
  try {
    f.runner.contextAdvisor.thresholdPercent = 50;
    assert.throws(() => verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), (error) => mismatchCode(error, "EFFECTIVE_THRESHOLD_MISMATCH"));
  } finally { f.close(); }
});

test("runtime rejects model mismatch", () => {
  const f = runtimeFixture();
  try {
    f.runner.runtime.session.model.id = "wrong-model";
    assert.throws(() => verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), (error) => mismatchCode(error, "MODEL_MISMATCH"));
  } finally { f.close(); }
});

test("runtime rejects reasoning mismatch", () => {
  const f = runtimeFixture();
  try {
    f.runner.runtime.session.thinkingLevel = "medium";
    assert.throws(() => verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), (error) => mismatchCode(error, "REASONING_MISMATCH"));
  } finally { f.close(); }
});

test("runtime rejects confirm-mode mismatch", () => {
  const f = runtimeFixture();
  try {
    f.runner.confirmMode = "confirm-or-manual";
    assert.throws(() => verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), (error) => mismatchCode(error, "CONFIRM_MODE_MISMATCH"));
  } finally { f.close(); }
});

test("stale runtime database contamination is rejected", () => {
  const x = fixture();
  const prepared = preflight(x);
  const loaded = loadCalibrationAttestation(prepared.paths.attestationPath);
  const storage = new GuardianStorage(prepared.paths.runtimeStorePath);
  try {
    storage.ensureLatch("OLD-TASK");
    assert.throws(() => storage.bindCalibrationRuntimeIdentity({ run_id: prepared.attestation.run_id, runtime_store_id: prepared.attestation.runtime_store.identity, attestation_sha256: loaded.digest }), (error) => error.code === "STALE_RUNTIME_STORE");
  } finally { storage.close(); }
});

test("runtime rejects wrong runtime identity", () => {
  const f = runtimeFixture();
  try {
    f.runner.storage = { path: f.prepared.paths.runtimeStorePath, getCalibrationRuntimeIdentity: () => ({ run_id: "wrong", runtime_store_id: "wrong", attestation_sha256: "0".repeat(64) }) };
    assert.throws(() => verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), (error) => mismatchCode(error, "RUNTIME_IDENTITY_MISMATCH"));
  } finally { f.close(); }
});

test("runtime rejects a protocol copy that is not byte-identical", () => {
  const f = runtimeFixture();
  try {
    writeFileSync(f.prepared.paths.protocolCopyPath, `${readFileSync(f.prepared.paths.protocolCopyPath, "utf8")} `);
    assert.throws(() => verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), (error) => mismatchCode(error, "PROTOCOL_COPY_NOT_BYTE_IDENTICAL"));
  } finally { f.close(); }
});

test("duplicate run_id is rejected without overwriting the first attestation", () => {
  const x = fixture();
  const runId = "TEST-DUPLICATE";
  const first = preflight(x, { runId });
  const bytes = readFileSync(first.paths.attestationPath);
  assert.throws(() => preflight(x, { runId }), (error) => error.code === "DUPLICATE_RUN_ID");
  assert.equal(readFileSync(first.paths.attestationPath).equals(bytes), true);
});

test("missing attestation is rejected", () => {
  assert.throws(() => loadCalibrationAttestation(join(tmpdir(), `missing-${Date.now()}.json`)), (error) => error.code === "CALIBRATION_ATTESTATION_MISSING");
});

test("runtime vs attestation protocol mismatch is fail-closed", () => {
  const f = runtimeFixture();
  try {
    writeFileSync(f.prepared.attestation.protocol_source_path, "{}\n");
    assert.throws(() => verifyCalibrationRuntimeState({ runner: f.runner, attestationPath: f.prepared.paths.attestationPath, processEnv: f.processEnv }), (error) => mismatchCode(error, "PROTOCOL_DIGEST_MISMATCH"));
  } finally { f.close(); }
});

test("transport gate fails closed before workload/provider execution", () => {
  let calls = 0;
  const storage = { isAdmissionOpen: () => true };
  const gate = new AdmissionGate(storage, "TASK");
  gate.setPreflightVerifier(() => { throw new GuardianError("CALIBRATION_RUNTIME_ATTESTATION_MISMATCH"); });
  const provider = {
    id: "fake", name: "fake", baseUrl: "offline://", headers: {}, auth: {}, getModels: () => [],
    streamSimple: () => { calls += 1; return {}; }, stream: () => { calls += 1; return {}; },
  };
  const guarded = gate.guardProvider(provider);
  assert.throws(() => guarded.streamSimple({ provider: "fake", id: "model" }, {}, {}), (error) => error.code === "CALIBRATION_RUNTIME_ATTESTATION_MISMATCH");
  assert.equal(calls, 0);
});
