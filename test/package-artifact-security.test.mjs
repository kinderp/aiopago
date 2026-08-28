import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
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
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
  "ProtectedSqliteOperationAuthority", "PortableOperationAuthority", "requireSecureOperationAuthority",
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
    "README.md", "bin/aio.mjs", "bin/eio.mjs", "dist/cli-entry.mjs", "dist/index.mjs", "dist/operation-authority-worker.mjs",
    "docs/0.2-b-plan-proposal-foundation.md", "docs/0.2-c-intent-adapter.md", "docs/0.2-d-start-objective.md",
    "docs/0.2-e-unified-human-ux.md", "docs/portable-alpha.md", "docs/rename-aiopago-migration.md", "package.json",
  ].sort());
  assert.equal(files.some((name) => /^(?:src|test|scripts)\//.test(name) || name.endsWith(".map")), false);
  assert.ok(readFileSync(x.tarball).length > 0);
});

test("R1-M-13 exact genuine-Pi prototype attack cannot cross an absolute operational import", () => {
  const x = packAndInstall("absolute-operational-attacker");
  gitRepository(x.consumer);
  const init = execFileSync(process.execPath, [join(x.packageRoot, "bin", "aio.mjs"), "init", "--target", x.consumer], {
    cwd: x.consumer, encoding: "utf8",
  });
  assert.match(init, /Pi 0\.83\.0/);

  const piManifest = join(x.consumer, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  const attack = `
    import { AgentSession, AgentSessionRuntime, DefaultResourceLoader, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const manifest = JSON.parse(readFileSync(${JSON.stringify(piManifest)}, "utf8"));
    const captures = { factoryCapture: 0, registeredHandlers: 0, registeredCommands: 0, runnerAuthority: 0, prototypeCalls: 0 };
    for (const [prototype, names] of [
      [DefaultResourceLoader.prototype, ["reload", "loadProjectTrustExtensions"]],
      [SessionManager.prototype, ["newSession"]],
      [ExtensionRunner.prototype, ["bindCore", "emit"]],
      [AgentSession.prototype, ["bindExtensions", "subscribe"]],
      [AgentSessionRuntime.prototype, ["apply"]],
    ]) for (const name of names) {
      const original = prototype[name];
      prototype[name] = function (...args) { captures.prototypeCalls += 1; return Reflect.apply(original, this, args); };
    }
    const handlers = new Map();
    const commands = new Map();
    DefaultResourceLoader.prototype.loadExtensionFactories = async function attackerInterposition() {
      const factories = this.extensionFactories ?? [];
      captures.factoryCapture += factories.length;
      for (const value of factories) {
        const factory = typeof value === "function" ? value : value.factory;
        factory({
          registerCommand(name, command) { commands.set(name, command); captures.registeredCommands += 1; },
          on(name, handler) { handlers.set(name, handler); captures.registeredHandlers += 1; },
        });
      }
      captures.runnerAuthority = commands.has("aio") && handlers.has("tool_call") && handlers.has("tool_execution_end") ? 1 : 0;
      handlers.get("tool_call")?.({ toolCallId: "OP-FORGED", toolName: "read", input: { path: "attacker-chosen.txt" } });
      handlers.get("tool_execution_end")?.({
        toolCallId: "OP-FORGED", toolName: "read", input: { path: "attacker-chosen.txt" }, isError: false,
        result: { content: [{ type: "text", text: "forged" }] },
      }, { signal: { aborted: false } });
      throw new Error("REVIEW_CAPTURE_COMPLETE");
    };
    process.argv = [process.execPath, ${JSON.stringify(join(x.packageRoot, "dist", "cli-entry.mjs"))}, "--target", ${JSON.stringify(x.consumer)}];
    const namespace = await import(${JSON.stringify(pathToFileURL(join(x.packageRoot, "dist", "cli-entry.mjs")).href)});
    process.exitCode = 0;
    const databasePath = join(${JSON.stringify(x.consumer)}, ".guardian", "runtime", "guardian.sqlite");
    let forged = null; let humanTakeover = 0;
    if (existsSync(databasePath)) {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      forged = database.prepare("SELECT operation_id,state,outcome,profile FROM operations WHERE operation_id='OP-FORGED'").get() ?? null;
      humanTakeover = database.prepare("SELECT COUNT(*) count FROM journal WHERE event_type IN ('LATCH_ENGAGED','LATCH_ESCALATED') AND data_json LIKE '%HUMAN_TAKEOVER%'").get().count;
      database.close();
    }
    process.stdout.write(JSON.stringify({ piVersion: manifest.version, exports: Object.keys(namespace), ...captures, forged, humanTakeover }));
  `;
  writeFileSync(join(x.consumer, "attack.mjs"), attack);
  const result = JSON.parse(execFileSync(process.execPath, ["attack.mjs"], { cwd: x.consumer, encoding: "utf8" }));
  assert.deepEqual(result, {
    piVersion: "0.83.0", exports: [], factoryCapture: 0, registeredHandlers: 0,
    registeredCommands: 0, runnerAuthority: 0, prototypeCalls: 0, forged: null, humanTakeover: 0,
  });
});

test("R1-M-13 exact Worker-entry preload cannot cross the OS-process boundary", () => {
  const x = packAndInstall("worker-entry-attacker");
  gitRepository(x.consumer);
  const init = execFileSync(process.execPath, [join(x.packageRoot, "bin", "aio.mjs"), "init", "--target", x.consumer], {
    cwd: x.consumer, encoding: "utf8",
  });
  assert.match(init, /Pi 0\.83\.0/);

  const capturePath = join(x.root, "worker-capture.json");
  const preloadPath = join(x.consumer, "attacker-preload.mjs");
  writeFileSync(preloadPath, `
    import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { threadId } from "node:worker_threads";
    const manifest = JSON.parse(readFileSync(new URL("./node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
    const capture = { pid: process.pid, threadId, piVersion: manifest.version, factory: 0, commands: 0, handlers: 0, runnerAuthority: 0 };
    function save() {
      const databasePath = join(${JSON.stringify(x.consumer)}, ".guardian", "runtime", "guardian.sqlite");
      let forged = null; let humanTakeover = 0;
      if (existsSync(databasePath)) {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        forged = database.prepare("SELECT state,outcome,profile FROM operations WHERE operation_id='OP-FORGED-WORKER'").get() ?? null;
        humanTakeover = database.prepare("SELECT COUNT(*) count FROM journal WHERE event_type IN ('LATCH_ENGAGED','LATCH_ESCALATED') AND data_json LIKE '%HUMAN_TAKEOVER%'").get().count;
        database.close();
      }
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ ...capture, forged, humanTakeover }));
    }
    save();
    DefaultResourceLoader.prototype.loadExtensionFactories = async function attackerInterposition() {
      const commands = new Map(); const handlers = new Map();
      const factories = this.extensionFactories ?? [];
      capture.factory += factories.length;
      for (const value of factories) {
        const factory = typeof value === "function" ? value : value.factory;
        factory({
          registerCommand(name, command) { commands.set(name, command); capture.commands += 1; },
          on(name, handler) { handlers.set(name, handler); capture.handlers += 1; },
        });
      }
      capture.runnerAuthority = commands.has("aio") && handlers.has("tool_call") && handlers.has("tool_execution_end") ? 1 : 0;
      handlers.get("tool_call")?.({ toolCallId: "OP-FORGED-WORKER", toolName: "read", input: { path: "attacker-chosen.txt" } });
      handlers.get("tool_execution_end")?.({
        toolCallId: "OP-FORGED-WORKER", toolName: "read", input: { path: "attacker-chosen.txt" }, isError: false,
        result: { content: [{ type: "text", text: "forged" }] },
      }, { signal: { aborted: false } });
      await commands.get("aio")?.handler("takeover", { ui: { notify() {} } });
      save();
      throw new Error("WORKER_CAPTURE_COMPLETE");
    };
    process.on("exit", save);
  `);
  const parentPath = join(x.consumer, "worker-parent.mjs");
  writeFileSync(parentPath, `
    import { Worker, threadId } from "node:worker_threads";
    import { pathToFileURL } from "node:url";
    const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(join(x.packageRoot, "dist", "cli-entry.mjs")).href)}), {
      argv: ["--target", ${JSON.stringify(x.consumer)}],
      execArgv: ["--import", pathToFileURL(${JSON.stringify(preloadPath)}).href],
    });
    await Promise.race([
      new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); }),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
    await worker.terminate();
    process.stdout.write(JSON.stringify({ pid: process.pid, threadId }));
  `);
  const parent = JSON.parse(execFileSync(process.execPath, [parentPath], { cwd: x.consumer, encoding: "utf8" }));
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  assert.equal(parent.pid, capture.pid, "Worker shares the public consumer's OS PID");
  assert.equal(parent.threadId, 0);
  assert.ok(capture.threadId > 0);
  assert.deepEqual(capture, {
    pid: parent.pid, threadId: capture.threadId, piVersion: "0.83.0", factory: 0, commands: 0,
    handlers: 0, runnerAuthority: 0, forged: null, humanTakeover: 0,
  });
});

test("R1-M-13 forgeable Worker/process JavaScript indicators have no authority-boundary role", () => {
  const x = packAndInstall("worker-oracle-attacker");
  const capturePath = join(x.root, "oracle-capture.json");
  const preloadPath = join(x.consumer, "oracle-preload.mjs");
  writeFileSync(preloadPath, `
    import workerThreads from "node:worker_threads";
    import { syncBuiltinESMExports } from "node:module";
    import { writeFileSync } from "node:fs";
    workerThreads.isMainThread = true;
    workerThreads.threadId = 0;
    workerThreads.parentPort = null;
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(join(x.packageRoot, "dist", "cli-entry.mjs"))}, "--target", ${JSON.stringify(x.consumer)}];
    process.env.AIOPAGO_OPERATIONAL_COMMAND_NAME = "aio";
    globalThis.AIOPAGO_OPERATIONAL = true;
    const observed = await import("node:worker_threads");
    process.on("exit", () => writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      isMainThread: observed.isMainThread, threadId: observed.threadId, parentPort: observed.parentPort,
      taskPlan: false,
    })));
  `);
  const parentPath = join(x.consumer, "oracle-parent.mjs");
  writeFileSync(parentPath, `
    import { Worker } from "node:worker_threads";
    import { pathToFileURL } from "node:url";
    const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(join(x.packageRoot, "dist", "cli-entry.mjs")).href)}), {
      execArgv: ["--import", pathToFileURL(${JSON.stringify(preloadPath)}).href],
    });
    await new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
  `);
  execFileSync(process.execPath, [parentPath], { cwd: x.consumer, encoding: "utf8" });
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  capture.taskPlan = existsSync(join(x.consumer, "TASK_PLAN.md"));
  assert.deepEqual(capture, { isMainThread: true, threadId: 0, parentPort: null, taskPlan: false });
});

test("R1-M-13 every packed JavaScript file is inert or public-only on direct import", () => {
  const x = packAndInstall("all-artifact-attacker");
  const target = join(x.root, "direct-import-target");
  const packageCopy = join(x.root, "package-copy");
  const packageLink = join(x.root, "package-link");
  mkdirSync(target);
  cpSync(x.packageRoot, packageCopy, { recursive: true });
  symlinkSync(x.packageRoot, packageLink, process.platform === "win32" ? "junction" : "dir");
  const shippedJavaScript = walk(x.packageRoot).filter((name) => /\.(?:c?js|mjs)$/.test(name)).sort();
  assert.deepEqual(shippedJavaScript, ["bin/aio.mjs", "bin/eio.mjs", "dist/cli-entry.mjs", "dist/index.mjs", "dist/operation-authority-worker.mjs"]);
  const script = `
    import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
    import { existsSync } from "node:fs";
    import { createRequire } from "node:module";
    let factoryCapture = 0; let registeredHandlers = 0;
    DefaultResourceLoader.prototype.loadExtensionFactories = async function () {
      factoryCapture += (this.extensionFactories ?? []).length;
      for (const value of this.extensionFactories ?? []) {
        const factory = typeof value === "function" ? value : value.factory;
        factory({ registerCommand() {}, on() { registeredHandlers += 1; } });
      }
      throw new Error("ARTIFACT_AUTHORITY_CAPTURED");
    };
    const artifacts = ${JSON.stringify(shippedJavaScript)};
    const rows = [];
    for (const artifact of artifacts) {
      process.argv = [process.execPath, ${JSON.stringify(x.packageRoot)} + "/" + artifact, "init", "--target", ${JSON.stringify(target)}];
      const namespace = await import(new URL("file:///" + (${JSON.stringify(x.packageRoot)} + "/" + artifact).replaceAll("\\\\", "/")));
      rows.push({ artifact, exports: Object.keys(namespace).sort(), factoryCapture, registeredHandlers });
    }
    const aliases = [];
    for (const [kind, root] of [["copy", ${JSON.stringify(packageCopy)}], ["link", ${JSON.stringify(packageLink)}]]) {
      const namespace = await import(new URL("file:///" + (root + "/dist/cli-entry.mjs?" + kind).replaceAll("\\\\", "/")));
      aliases.push({ kind, exports: Reflect.ownKeys(namespace).map(String), prototype: Object.getPrototypeOf(namespace) === null });
    }
    const require = createRequire(import.meta.url);
    let cjs;
    try {
      const cjsNamespace = require(${JSON.stringify(join(x.packageRoot, "dist", "cli-entry.mjs"))});
      cjs = { code: null, keys: Object.keys(cjsNamespace), symbols: Reflect.ownKeys(cjsNamespace).filter((key) => typeof key === "symbol").map(String) };
    } catch (error) { cjs = { code: error.code, keys: [], symbols: [] }; }
    process.stdout.write(JSON.stringify({ rows, aliases, cjs, mutated: existsSync(${JSON.stringify(join(target, "TASK_PLAN.md"))}) }));
  `;
  writeFileSync(join(x.consumer, "all-artifacts.mjs"), script);
  const result = JSON.parse(execFileSync(process.execPath, ["all-artifacts.mjs"], { cwd: x.consumer, encoding: "utf8" }));
  assert.equal(result.mutated, false, "directly imported bins and operational bundle perform no CLI mutation");
  assert.equal(result.rows.every((row) => row.factoryCapture === 0 && row.registeredHandlers === 0), true);
  assert.deepEqual(result.rows.slice(0, 3).map((row) => row.exports), [[], [], []]);
  assert.deepEqual(result.rows[3].exports, PUBLIC_ROOT_EXPORTS);
  assert.deepEqual(result.rows[4].exports, []);
  assert.deepEqual(result.aliases, [
    { kind: "copy", exports: ["Symbol(Symbol.toStringTag)"], prototype: true },
    { kind: "link", exports: ["Symbol(Symbol.toStringTag)"], prototype: true },
  ]);
  assert.deepEqual(result.cjs, { code: null, keys: [], symbols: ["Symbol(Symbol.toStringTag)"] });

  const workerPreload = join(x.consumer, "artifact-worker-preload.mjs");
  writeFileSync(workerPreload, `
    import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
    import { parentPort, threadId } from "node:worker_threads";
    parentPort.postMessage({ type: "preload", pid: process.pid, threadId });
    DefaultResourceLoader.prototype.loadExtensionFactories = async function () {
      let factory = 0; let commands = 0; let handlers = 0;
      for (const value of this.extensionFactories ?? []) {
        factory += 1;
        const extension = typeof value === "function" ? value : value.factory;
        extension({ registerCommand() { commands += 1; }, on() { handlers += 1; } });
      }
      parentPort.postMessage({ type: "authority", factory, commands, handlers });
      throw new Error("ARTIFACT_WORKER_CAPTURE");
    };
  `);
  const workerMatrix = join(x.consumer, "artifact-worker-matrix.mjs");
  const generalWorkerJavaScript = shippedJavaScript.filter((artifact) => artifact !== "dist/operation-authority-worker.mjs");
  const routes = [
    ...generalWorkerJavaScript.flatMap((artifact) => [
      { artifact, route: "Worker file URL", value: pathToFileURL(join(x.packageRoot, artifact)).href, url: true },
      { artifact, route: "Worker path", value: join(x.packageRoot, artifact), url: false },
    ]),
    { artifact: "dist/cli-entry.mjs", route: "Worker copied package", value: pathToFileURL(join(packageCopy, "dist", "cli-entry.mjs")).href, url: true },
    { artifact: "dist/cli-entry.mjs", route: "Worker junction/symlink", value: pathToFileURL(join(packageLink, "dist", "cli-entry.mjs")).href, url: true },
    { artifact: "dist/cli-entry.mjs", route: "Worker query URL", value: `${pathToFileURL(join(x.packageRoot, "dist", "cli-entry.mjs")).href}?worker-query`, url: true },
    { artifact: "dist/cli-entry.mjs", route: "Worker hash URL", value: `${pathToFileURL(join(x.packageRoot, "dist", "cli-entry.mjs")).href}#worker-hash`, url: true },
  ];
  writeFileSync(workerMatrix, `
    import { writeFileSync } from "node:fs";
    import { Worker } from "node:worker_threads";
    import { pathToFileURL } from "node:url";
    const parentPid = process.pid;
    const routes = ${JSON.stringify(routes)};
    const run = (route) => new Promise((resolve, reject) => {
      const worker = new Worker(route.url ? new URL(route.value) : route.value, {
        argv: ["--version"],
        execArgv: ["--import", pathToFileURL(${JSON.stringify(workerPreload)}).href],
        env: { ...process.env, AIOPAGO_OPERATIONAL_COMMAND_NAME: "aio", AIOPAGO_WORKER_ATTACK: "1" },
      });
      const row = { ...route, parentPid, pid: null, threadId: null, factory: 0, commands: 0, handlers: 0 };
      let timer = null;
      worker.on("message", (message) => {
        if (message.type === "preload") {
          row.pid = message.pid; row.threadId = message.threadId;
          timer = setTimeout(() => worker.terminate(), 5000);
        } else if (message.type === "authority") Object.assign(row, message);
      });
      worker.once("error", reject);
      worker.once("exit", () => { if (timer) clearTimeout(timer); resolve(row); });
    });
    const index = Number(process.argv[2]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= routes.length) throw new Error("ROUTE_INDEX_INVALID");
    process.stdout.write(JSON.stringify(await run(routes[index])));
  `);
  // One fresh process per route avoids making Node 22.19's cumulative native
  // Windows Worker teardown a security oracle. Every route still uses genuine
  // Pi preload interposition and must independently remain inert.
  const workerRows = [];
  for (let index = 0; index < routes.length; index += 1) {
    let output = null; let lastError = null;
    for (let attempt = 0; attempt < 3 && output === null; attempt += 1) {
      try {
        output = execFileSync(process.execPath, [workerMatrix, String(index)], {
          cwd: x.consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
        });
      } catch (error) {
        lastError = error;
        // Windows Node 22.19 occasionally aborts during native Worker teardown
        // after genuine Pi loading. A fresh process retry cannot turn a captured
        // authority into a pass; all returned rows are still checked exactly.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
      }
    }
    if (output === null) throw lastError;
    workerRows.push(JSON.parse(output.trim().split(/\r?\n/).at(-1)));
  }
  assert.equal(workerRows.length, 12);
  for (const row of workerRows) {
    assert.equal(row.pid, row.parentPid, `${row.artifact} ${row.route} must remain in the public PID`);
    assert.ok(row.threadId > 0, `${row.artifact} ${row.route} must be a Worker thread`);
    assert.deepEqual([row.factory, row.commands, row.handlers], [0, 0, 0], `${row.artifact} ${row.route}`);
  }

  // Keep the protected worker in its own fresh Node process. Node 22.19 on
  // Windows can abort natively after the historical 12-route genuine-Pi Worker
  // matrix when a thirteenth distinct ESM graph is added; process isolation is
  // also the deployed P1S->P2 shape and retains the same preload attack.
  const protectedWorkerProbe = join(x.consumer, "protected-worker-probe.mjs");
  writeFileSync(protectedWorkerProbe, `
    import { Worker } from "node:worker_threads";
    import { pathToFileURL } from "node:url";
    const parentPid = process.pid;
    const worker = new Worker(pathToFileURL(${JSON.stringify(join(x.packageRoot, "dist", "operation-authority-worker.mjs"))}), {
      execArgv: ["--import", pathToFileURL(${JSON.stringify(workerPreload)}).href],
      env: { ...process.env, AIOPAGO_OPERATIONAL_COMMAND_NAME: "aio", AIOPAGO_WORKER_ATTACK: "1" },
    });
    const row = { parentPid, pid: null, threadId: null, factory: 0, commands: 0, handlers: 0 };
    worker.on("message", (message) => {
      if (message.type === "preload") { row.pid = message.pid; row.threadId = message.threadId; }
      else if (message.type === "authority") Object.assign(row, message);
    });
    await new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
    process.stdout.write(JSON.stringify(row));
  `);
  const protectedWorker = JSON.parse(execFileSync(process.execPath, [protectedWorkerProbe], { cwd: x.consumer, encoding: "utf8" }));
  assert.equal(protectedWorker.pid, protectedWorker.parentPid);
  assert.ok(protectedWorker.threadId > 0);
  assert.deepEqual([protectedWorker.factory, protectedWorker.commands, protectedWorker.handlers], [0, 0, 0]);
});

test("R1-M-13 supported aio bootstrap starts a clean child and ignores ambient Pi selection", () => {
  const x = packAndInstall("cli-boundary-attacker");
  const fakeModules = makeFakePi(x.root);
  const capture = join(x.root, "ambient-fake-pi-evaluated");
  const preloadCapture = join(x.root, "node-options-processes");
  const preload = join(x.root, "preload.mjs");
  writeFileSync(preload, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(preloadCapture)}, String(process.argv[1])+"\\n");\n`);
  gitRepository(x.consumer);

  const embeddedTarget = join(x.root, "embedded-target");
  mkdirSync(embeddedTarget);
  const embed = `
    import fsPromises from "node:fs/promises";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    fsPromises.lstat = async () => { throw new Error("ATTACKER_FS_PROMISES"); };
    fsPromises.realpath = async () => "attacker";
    childProcess.spawnSync = () => { throw new Error("ATTACKER_SPAWN"); };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(join(x.packageRoot, "bin", "aio.mjs"))}, "init", "--target", ${JSON.stringify(embeddedTarget)}];
    await import(${JSON.stringify(pathToFileURL(join(x.packageRoot, "bin", "aio.mjs")).href)});
  `;
  writeFileSync(join(x.consumer, "embed.mjs"), embed);
  execFileSync(process.execPath, ["embed.mjs"], { cwd: x.consumer, encoding: "utf8" });
  assert.equal(existsSync(join(embeddedTarget, "TASK_PLAN.md")), false, "same-process bin import is inert despite process/fs patches");

  const output = execFileSync(process.execPath, [join(x.packageRoot, "bin", "aio.mjs"), "init", "--target", x.consumer], {
    cwd: x.consumer,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      NODE_PATH: fakeModules,
      PI_CODING_AGENT_ROOT: join(fakeModules, "@earendil-works", "pi-coding-agent"),
      AIOPAGO_FAKE_PI_CAPTURE: capture,
    },
    encoding: "utf8",
  });
  assert.match(output, /Aiopago init complete/);
  assert.match(output, /Pi 0\.83\.0/);
  assert.equal(existsSync(capture), false);
  assert.equal(readFileSync(preloadCapture, "utf8").trim(), join(x.packageRoot, "bin", "aio.mjs"), "NODE_OPTIONS reaches only the non-privileged bootstrap");
  assert.equal(existsSync(join(x.consumer, "TASK_PLAN.md")), true);

  const targetShadow = join(x.root, "target-shadow");
  mkdirSync(targetShadow);
  renameSync(makeFakePi(targetShadow), join(targetShadow, "node_modules"));
  gitRepository(targetShadow);
  const ancestorShadow = join(x.root, "ancestor-shadow");
  const ancestorTarget = join(ancestorShadow, "project");
  mkdirSync(ancestorTarget, { recursive: true });
  renameSync(makeFakePi(ancestorShadow), join(ancestorShadow, "node_modules"));
  gitRepository(ancestorTarget);
  for (const target of [targetShadow, ancestorTarget]) {
    const shadowed = execFileSync(process.execPath, [join(x.packageRoot, "bin", "aio.mjs"), "init", "--target", target], {
      cwd: target, env: { ...process.env, AIOPAGO_FAKE_PI_CAPTURE: capture }, encoding: "utf8",
    });
    assert.match(shadowed, /Pi 0\.83\.0/);
  }
  assert.equal(existsSync(capture), false, "target, nested and ancestor node_modules cannot shadow Aiopago-owned Pi");
  const linkedPackage = join(x.root, "linked-aiopago");
  symlinkSync(x.packageRoot, linkedPackage, process.platform === "win32" ? "junction" : "dir");
  assert.equal(execFileSync(process.execPath, [join(linkedPackage, "bin", "aio.mjs"), "--version"], {
    cwd: ancestorTarget, encoding: "utf8",
  }).trim(), "0.1.0");

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
