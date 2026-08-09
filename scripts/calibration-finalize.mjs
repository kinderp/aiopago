#!/usr/bin/env node
import { join, resolve } from "node:path";
import { finalizeCalibrationRun } from "../src/calibration-finalizer.mjs";

function usage() { return "Usage: npm run calibration:finalize -- --run <run-id>"; }
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--run" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(argv[1])) throw new Error(usage());
const runId = argv[1];
const runRoot = join(resolve(process.cwd()), ".guardian", "calibration", runId);
const { record, path } = finalizeCalibrationRun({ runRoot, runId });
console.log(`classification=${record.classification} detail=${record.status}`);
console.log(`run_record=${path}`);
