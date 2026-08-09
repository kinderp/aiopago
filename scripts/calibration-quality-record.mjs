#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadCalibrationAttestation } from "../src/calibration-preflight.mjs";
import { QUALITY_EVIDENCE_FILE, writeCalibrationQualityEvidence } from "../src/calibration-quality.mjs";

function usage() { return "Usage: npm run calibration:quality -- --run <run-id> --input <machine-readable-json>"; }
const argv = process.argv.slice(2);
const values = {};
for (let index = 0; index < argv.length; index += 2) {
  if (!["--run", "--input"].includes(argv[index]) || !argv[index + 1]) throw new Error(usage());
  values[argv[index].slice(2)] = argv[index + 1];
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values.run ?? "") || !values.input) throw new Error(usage());
const cwd = resolve(process.cwd());
const runRoot = join(cwd, ".guardian", "calibration", values.run);
const { attestation } = loadCalibrationAttestation(join(runRoot, "preflight-attestation.json"));
const protocol = JSON.parse(readFileSync(join(runRoot, "pilot-protocol.json"), "utf8"));
const inputPath = isAbsolute(values.input) ? values.input : resolve(cwd, values.input);
const evidence = JSON.parse(readFileSync(inputPath, "utf8"));
const output = join(runRoot, QUALITY_EVIDENCE_FILE);
writeCalibrationQualityEvidence(output, evidence, {
  runId: attestation.run_id,
  expectedCommands: protocol.workload?.acceptance_commands ?? [],
});
console.log(`quality_evidence=${output}`);
