import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const PUBLIC_ROOT_EXPORTS = [
  "CONTEXT_HANDOFF_THRESHOLD_ENV", "ContextHandoffAdvisor", "DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT",
  "DEFAULT_METRICS_RETENTION", "DEFAULT_REPOSITORY_CONFIG", "GuardianError", "INSTALLATION_ROOT",
  "LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV", "LEGACY_REPOSITORY_CONFIG_SCHEMA", "LEGACY_RUNNER_BINDING_CUSTOM_TYPE",
  "METRICS_SCHEMA_VERSION", "REPOSITORY_CONFIG_FILE", "REPOSITORY_CONFIG_SCHEMA", "RUNNER_BINDING_CUSTOM_TYPE",
  "TaskLedger", "assertTelemetrySafe", "canonicalJson", "canonicalRequiredLocalPaths", "contextHandoffThreshold",
  "contextHandoffThresholdEnvironment", "createPlanAdapter", "digestObject", "discoverTargetRepository", "fail",
  "formatHumanNext", "formatHumanStatus", "formatHumanTechnical", "formatHumanWhy", "formatPlan", "formatPlanTechnical",
  "guidedHandoffEligibilityIdentity", "invariant", "jsonClone", "loadRepositoryContext", "measureHandoffArtifacts",
  "observeGitState", "observeHumanWorkflow", "observeRawTaskPlan", "observeRunnerHumanWorkflow", "observeTaskPlan",
  "opaqueId", "plan", "projectHumanWorkflow", "readRepositoryConfig", "readRuntimeProjection",
  "readRuntimeRunnerBinding", "sameGitState", "sameGuidedHandoffEligibility", "sha256", "stableId", "strictJsonClone",
  "utcNow", "validateRepositoryConfig", "validateRepositoryStateBoundaries", "validateRequiredLocalPaths",
  "validateRuntimeObservation", "validateTaskLedger", "verifyRunnerOwnership",
].sort();

const PRIVILEGED_ROOT_NAMES = [
  "GuardianRunner", "loadPi", "resolvePiRoot", "inspectPi", "runCli", "runCliEntrypoint",
  "createGuardianExtension", "ToolOperationTracker", "GuardianStorage", "PlanRevisionWriter",
  "SafePointCoordinator", "HandoffService", "ArtifactStore", "MeasurementInstrumentation",
  "initializeRepository", "checkPortableEnvironment", "createPiObjectivePlanner", "PiObjectivePlanner",
  "storageDatabaseForInternalUse", "storageDatabaseForInternalTest", "runnerForInternalTest", "createRunnerForInternalTest",
  "claimTrustedHumanTakeoverCurrentPlan", "reserveTrustedHandoffPlan", "prepareTrustedContinuityRecovery",
  "authorizeTrustedResume", "taskOperationDisposition", "canonicalPlanSemantics", "planSemanticDigest",
];

function npmOptions() { return { shell: process.platform === "win32" }; }

function packAndInstall(label = "consumer") {
  const root = mkdtempSync(join(tmpdir(), "aiopago-package-boundary-"));
  const packedName = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], {
    cwd: process.cwd(), encoding: "utf8", ...npmOptions(),
  }).trim().split(/\r?\n/).at(-1);
  const consumer = join(root, label);
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: label, private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-package-lock", join(root, packedName)], {
    cwd: consumer, stdio: "pipe", ...npmOptions(),
  });
  return { root, consumer, packageRoot: join(consumer, "node_modules", "aiopago"), tarball: join(root, packedName) };
}

function walk(path, relative = "") {
  const files = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    const child = relative ? `${relative}/${name}` : name;
    if (statSync(full).isDirectory()) files.push(...walk(full, child));
    else files.push(child.replaceAll("\\", "/"));
  }
  return files;
}

function makeFakePi(root) {
  const modules = join(root, "fake-node-modules");
  for (const name of ["pi-coding-agent", "pi-ai"]) {
    const packageRoot = join(modules, "@earendil-works", name);
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: `@earendil-works/${name}`, version: "0.83.77", type: "module", main: "dist/index.js",
    }));
    writeFileSync(join(packageRoot, "dist", "index.js"),
      `import { appendFileSync } from "node:fs"; appendFileSync(process.env.AIOPAGO_FAKE_PI_CAPTURE, ${JSON.stringify(name)}+"\\n"); export const attacker=true;\n`);
  }
  return modules;
}

function gitRepository(path) {
  execFileSync("git", ["init"], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "package@example.invalid"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Package Boundary"], { cwd: path });
}

test("R1-M-08/R1-M-13 real tarball root exposes only the enumerated read/data and PlanPort API", () => {
  const x = packAndInstall("public-root-attacker");
  const fakeModules = makeFakePi(x.root);
  const capture = join(x.root, "fake-pi-evaluated");
  const attack = `
    import assert from "node:assert/strict";
    import fsPromises from "node:fs/promises";
    fsPromises.lstat = async () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false });
    fsPromises.realpath = async (path) => path;
    const root = await import("aiopago");
    assert.deepEqual(Object.keys(root).sort(), ${JSON.stringify(PUBLIC_ROOT_EXPORTS)});
    for (const name of ${JSON.stringify(PRIVILEGED_ROOT_NAMES)}) assert.equal(Object.hasOwn(root, name), false, name);
    assert.equal(typeof root.createPlanAdapter, "function");
    assert.deepEqual(Object.keys(root.plan).sort(), ["apply", "diff", "observe", "propose", "validate"]);
    const packageRoot = ${JSON.stringify(x.packageRoot)};
    const absolute = await import(new URL("file:///" + (packageRoot + "/dist/index.mjs").replaceAll("\\\\", "/")));
    assert.deepEqual(Object.keys(absolute).sort(), ${JSON.stringify(PUBLIC_ROOT_EXPORTS)});
    assert.equal(absolute.TaskLedger, root.TaskLedger);
    process.stdout.write(JSON.stringify({ factoryCapture: 0, registeredHandlers: 0, opForged: false, humanTakeover: false }));
  `;
  writeFileSync(join(x.consumer, "attack.mjs"), attack);
  const result = JSON.parse(execFileSync(process.execPath, ["attack.mjs"], {
    cwd: x.consumer,
    env: {
      ...process.env,
      NODE_PATH: fakeModules,
      PI_CODING_AGENT_ROOT: join(fakeModules, "@earendil-works", "pi-coding-agent"),
      AIOPAGO_FAKE_PI_CAPTURE: capture,
    },
    encoding: "utf8",
  }));
  assert.deepEqual(result, { factoryCapture: 0, registeredHandlers: 0, opForged: false, humanTakeover: false });
  assert.equal(existsSync(capture), false, "patched fs/promises cannot reach or evaluate privileged Pi through package-root APIs");

  const files = walk(x.packageRoot).sort();
  assert.deepEqual(files, [
    "README.md", "bin/aio.mjs", "bin/eio.mjs", "dist/cli-entry.mjs", "dist/index.mjs",
    "docs/0.2-b-plan-proposal-foundation.md", "docs/0.2-c-intent-adapter.md", "docs/0.2-d-start-objective.md",
    "docs/0.2-e-unified-human-ux.md", "docs/portable-alpha.md", "docs/rename-aiopago-migration.md", "package.json",
  ].sort());
  assert.equal(files.some((name) => /^(?:src|test|scripts)\//.test(name) || name.endsWith(".map")), false);
  assert.ok(readFileSync(x.tarball).length > 0);
});

test("R1-M-13 supported aio bootstrap starts a clean child and ignores ambient Pi selection", () => {
  const x = packAndInstall("cli-boundary-attacker");
  const fakeModules = makeFakePi(x.root);
  const capture = join(x.root, "ambient-fake-pi-evaluated");
  const preloadCapture = join(x.root, "node-options-child-preload");
  const preload = join(x.root, "preload.mjs");
  writeFileSync(preload, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(preloadCapture)}, "preloaded");\n`);
  gitRepository(x.consumer);

  const embed = `
    import fsPromises from "node:fs/promises";
    fsPromises.lstat = async () => { throw new Error("ATTACKER_FS_PROMISES"); };
    fsPromises.realpath = async () => "attacker";
    const originalKill = process._kill;
    process._kill = new Proxy(originalKill, { apply() { return -3; } });
    Function.prototype.toString = new Proxy(Function.prototype.toString, { apply() { return "function () { [native code] }"; } });
    process.env.NODE_OPTIONS = "--import=" + ${JSON.stringify(preload)};
    process.env.NODE_PATH = ${JSON.stringify(fakeModules)};
    process.env.PI_CODING_AGENT_ROOT = ${JSON.stringify(join(fakeModules, "@earendil-works", "pi-coding-agent"))};
    process.argv = [process.execPath, ${JSON.stringify(join(x.packageRoot, "bin", "aio.mjs"))}, "init", "--target", ${JSON.stringify(x.consumer)}];
    await import(new URL("file:///" + ${JSON.stringify(join(x.packageRoot, "bin", "aio.mjs"))}.replaceAll("\\\\", "/")));
  `;
  writeFileSync(join(x.consumer, "embed.mjs"), embed);
  const output = execFileSync(process.execPath, ["embed.mjs"], {
    cwd: x.consumer,
    env: { ...process.env, AIOPAGO_FAKE_PI_CAPTURE: capture },
    encoding: "utf8",
  });
  assert.match(output, /Aiopago init complete/);
  assert.match(output, /Pi 0\.83\.0/);
  assert.equal(existsSync(capture), false);
  assert.equal(existsSync(preloadCapture), false, "fresh privileged child strips inherited NODE_OPTIONS");
  assert.equal(existsSync(join(x.consumer, "TASK_PLAN.md")), true);

  for (const command of [["status"], ["why"], ["next"], ["plan", "--check"], ["plan"], ["--version"], ["--help"]]) {
    const result = execFileSync(process.execPath, [join(x.packageRoot, "bin", "aio.mjs"), ...command], {
      cwd: x.consumer,
      env: {
        ...process.env,
        NODE_PATH: fakeModules,
        PI_CODING_AGENT_ROOT: join(fakeModules, "@earendil-works", "pi-coding-agent"),
        AIOPAGO_FAKE_PI_CAPTURE: capture,
      },
      encoding: "utf8",
    });
    assert.ok(result.length > 0, command.join(" "));
  }
  assert.equal(existsSync(capture), false);

  const directEntry = `process.argv=[process.execPath,${JSON.stringify(join(x.packageRoot, "dist", "cli-entry.mjs"))},"--version"]; const ns=await import(${JSON.stringify(new URL(`file:///${join(x.packageRoot, "dist", "cli-entry.mjs").replaceAll("\\", "/")}`).href)}); process.stdout.write("\\nEXPORTS="+JSON.stringify(Object.keys(ns)));`;
  writeFileSync(join(x.consumer, "absolute-cli.mjs"), directEntry);
  const direct = execFileSync(process.execPath, ["absolute-cli.mjs"], { cwd: x.consumer, encoding: "utf8" });
  assert.match(direct, /EXPORTS=\[\]$/);
});

test("trusted-process Pi layout validation rejects redirected, missing and wrong-version owned slots", () => {
  const x = packAndInstall("trusted-layout-validation");
  const fakeModules = makeFakePi(x.root);
  const trustedPi = join(x.consumer, "node_modules", "@earendil-works", "pi-coding-agent");
  const backup = join(x.root, "trusted-pi-backup");
  const run = () => execFileSync(process.execPath, [join(x.packageRoot, "bin", "aio.mjs"), "init", "--target", x.consumer], {
    cwd: x.consumer, encoding: "utf8", stdio: "pipe",
  });
  gitRepository(x.consumer);

  renameSync(trustedPi, backup);
  try {
    symlinkSync(join(fakeModules, "@earendil-works", "pi-coding-agent"), trustedPi, process.platform === "win32" ? "junction" : "dir");
    assert.throws(run, (error) => /PI_TRUSTED_INSTALLATION_REDIRECTED/.test(String(error.stderr)));
    rmSync(trustedPi, { recursive: true, force: true });
    assert.throws(run, (error) => /PI_UNAVAILABLE/.test(String(error.stderr)));
  } finally {
    rmSync(trustedPi, { recursive: true, force: true });
    renameSync(backup, trustedPi);
  }

  const manifestPath = join(trustedPi, "package.json");
  const original = readFileSync(manifestPath);
  try {
    const manifest = JSON.parse(original); manifest.version = "0.83.1";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(run, (error) => /PI_VERSION_UNSUPPORTED/.test(String(error.stderr)));
  } finally { writeFileSync(manifestPath, original); }
});
