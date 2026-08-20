#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const legacyShort = ["e", "i", "o"].join("");
const legacyFull = [legacyShort, "pago"].join("");
const fullPattern = new RegExp(legacyFull, "gi");
const shortPattern = new RegExp(`(?<![A-Za-z0-9])${legacyShort}(?![A-Za-z0-9])`, "gi");

// Exact path/count allowlist. A count change requires an explicit migration review.
const fullAllowlist = new Map(Object.entries({
  "CHECKPOINT.md": [75, "rename closure allowlist and immutable session history"],
  "TASK_PLAN.md": [11, "closed Ledger provenance and stable IDs"],
  "docs/audit/guardian-requirements-coverage.md": [15, "historical audit record"],
  "docs/m1-h1-context-handoff-advisor.md": [1, "persisted runner-binding compatibility"],
  "docs/m1-h2-calibration-pilot.json": [7, "frozen digest-bound protocol"],
  "docs/m1-h2-run-finalization.md": [1, "historical calibration record"],
  "docs/m1-h2-threshold-calibration.md": [10, "historical calibration protocol and paths"],
  "docs/m1-h2-workload-feasibility.md": [2, "historical workload record"],
  "docs/portable-alpha.md": [4, "compatibility documentation"],
  "docs/rename-aiopago-migration.md": [39, "rename inventory and compatibility documentation"],
  "src/bootstrap.mjs": [4, "legacy managed-ignore compatibility"],
  "src/calibration-finalizer.mjs": [1, "legacy protocol reader"],
  "src/calibration-preflight.mjs": [1, "legacy attestation reader"],
  "src/calibration-quality.mjs": [1, "legacy quality-evidence reader"],
  "src/extension.mjs": [1, "deprecated TUI alias"],
  "src/ledger.mjs": [1, "legacy command normalization"],
  "src/repository.mjs": [1, "legacy repository-config reader"],
  "src/runner-ownership.mjs": [1, "legacy session-binding reader"],
  "test/calibration-finalizer.test.mjs": [1, "legacy protocol compatibility test"],
  "test/calibration-preflight.test.mjs": [1, "legacy protocol compatibility test"],
  "test/core.test.mjs": [4, "legacy Ledger, command and binding tests"],
}));

const shortAllowlist = new Map(Object.entries({
  "CHECKPOINT.md": [26, "rename closure compatibility summary and immutable session history"],
  "README.md": [1, "deprecated CLI notice"],
  "TASK_PLAN.md": [11, "closed Ledger command provenance"],
  [["bin", `${legacyShort}.mjs`].join("/")]: [1, "deprecated thin CLI wrapper"],
  "docs/m1-h2-calibration-pilot.json": [2, "frozen digest-bound protocol"],
  "docs/m1-h2-threshold-calibration.md": [5, "historical calibration commands and environment"],
  "docs/m1-h2-workload-feasibility.md": [8, "historical workload commands"],
  "docs/portable-alpha.md": [3, "deprecated CLI/TUI and environment compatibility"],
  "docs/rename-aiopago-migration.md": [16, "rename inventory and compatibility documentation"],
  "package.json": [4, "deprecated executable and npm script"],
  "src/bootstrap.mjs": [1, "legacy managed-ignore marker"],
  "src/cli-entry.mjs": [1, "deprecated CLI warning"],
  "src/context-advisor.mjs": [1, "legacy environment fallback"],
  "src/extension.mjs": [1, "deprecated TUI alias"],
  "src/ledger.mjs": [1, "legacy command normalization"],
  "test/core.test.mjs": [5, "legacy environment, Ledger and TUI tests"],
  "test/portable-alpha.test.mjs": [5, "deprecated CLI and package tests"],
}));

const legacyPathAllowlist = new Map([
  [["bin", `${legacyShort}.mjs`].join("/"), "deprecated thin CLI wrapper"],
]);

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return output.toString("utf8").split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

function count(text, pattern) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

const files = trackedFiles();
const failures = [];
const observedFull = new Map();
const observedShort = new Map();
for (const path of files) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  const fullCount = count(text, fullPattern);
  const shortCount = count(text, shortPattern);
  if (fullCount) observedFull.set(path, fullCount);
  if (shortCount) observedShort.set(path, shortCount);

  fullPattern.lastIndex = 0;
  shortPattern.lastIndex = 0;
  if (fullPattern.test(path)) failures.push(`${path}: legacy full brand in path`);
  if (shortPattern.test(path) && !legacyPathAllowlist.has(path)) failures.push(`${path}: unapproved legacy short name in path`);
}

function verify(label, observed, allowlist) {
  for (const [path, actual] of observed) {
    const allowed = allowlist.get(path);
    if (!allowed) failures.push(`${path}: ${label} occurrence is not allowlisted (${actual})`);
    else if (actual !== allowed[0]) failures.push(`${path}: ${label} count ${actual}, expected ${allowed[0]} (${allowed[1]})`);
  }
  for (const [path, [expected, reason]] of allowlist) {
    const actual = observed.get(path) ?? 0;
    if (actual !== expected && !failures.some((failure) => failure.startsWith(`${path}: ${label}`))) {
      failures.push(`${path}: ${label} count ${actual}, expected ${expected} (${reason})`);
    }
  }
}

verify("legacy full brand", observedFull, fullAllowlist);
verify("legacy short name", observedShort, shortAllowlist);
for (const [path, reason] of legacyPathAllowlist) {
  if (!files.includes(path)) failures.push(`${path}: allowlisted path missing (${reason})`);
}

if (failures.length) {
  console.error("Brand migration guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`brand migration guard: ok (${fullAllowlist.size} full-brand and ${shortAllowlist.size} short-name path rules)`);
}
