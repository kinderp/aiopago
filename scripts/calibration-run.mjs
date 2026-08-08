#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  assertFreshRuntimeStore,
  calibrationRunnerOptions,
  loadCalibrationAttestation,
  markCalibrationRunInvalid,
  runCalibrationPreflight,
} from "../src/calibration-preflight.mjs";
import { CONTEXT_HANDOFF_THRESHOLD_ENV } from "../src/context-advisor.mjs";
import { GuardianRunner } from "../src/runner.mjs";
import { resolvePiRoot } from "../src/pi-loader.mjs";

function usage() {
  return "Usage: npm run calibration -- --variant RUN-40 --experiment-baseline <40-hex-sha> | --resume-run <run-id>";
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!["--variant", "--experiment-baseline", "--resume-run"].includes(name) || !argv[i + 1]) throw new Error(usage());
    values[name.slice(2)] = argv[i + 1];
    i += 1;
  }
  const initial = values.variant && values["experiment-baseline"] && !values["resume-run"];
  const resume = values["resume-run"] && !values.variant && !values["experiment-baseline"];
  if (!initial && !resume) throw new Error(usage());
  return values;
}

const args = parseArgs(process.argv.slice(2));
const cwd = resolve(process.cwd());
const piRoot = await resolvePiRoot();
let prepared;
let resume = false;
if (args["resume-run"]) {
  resume = true;
  const path = join(cwd, ".guardian", "calibration", args["resume-run"], "preflight-attestation.json");
  if (!existsSync(path)) throw new Error(`Missing attestation: ${path}`);
  prepared = { ...loadCalibrationAttestation(path), paths: { attestationPath: path, runRecordPath: join(resolve(path, ".."), "run-record.json") } };
} else {
  prepared = runCalibrationPreflight({
    cwd,
    variantId: args.variant,
    experimentBaselineCommit: args["experiment-baseline"],
    piRoot: isAbsolute(piRoot) ? piRoot : resolve(piRoot),
  });
  console.log(`preflight=${prepared.attestation.preflight_result} run_id=${prepared.attestation.run_id}`);
  console.log(`attestation=${prepared.paths.attestationPath}`);
  if (prepared.attestation.preflight_result !== "PASS") {
    process.exitCode = 2;
    process.exit();
  }
  assertFreshRuntimeStore(prepared.paths.runtimeStorePath);
}

const attestationPath = prepared.paths?.attestationPath ?? prepared.path;
const loaded = loadCalibrationAttestation(attestationPath);
process.env[CONTEXT_HANDOFF_THRESHOLD_ENV] = String(loaded.attestation.requested_threshold);
let runner;
try {
  runner = await GuardianRunner.create(calibrationRunnerOptions(attestationPath, { resume }));
  console.log(`runtime-preflight=PASS run_id=${loaded.attestation.run_id}`);
  await runner.runInteractive();
} catch (error) {
  const runRecordPath = join(resolve(attestationPath, ".."), "run-record.json");
  if (existsSync(runRecordPath)) markCalibrationRunInvalid(runRecordPath, error);
  throw error;
} finally {
  if (runner) await runner.dispose();
}
