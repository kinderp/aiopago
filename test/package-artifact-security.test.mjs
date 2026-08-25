import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function blockedTask() {
  return {
    schema_version: "0.1.0", task_id: "TASK-PACK", title: "Package", objective: "No physical authority",
    requirements_version: "REQ-1", plan_revision_id: "PLAN-P1", status: "BLOCKED", completion_criteria: ["safe"], risk: "HIGH",
    created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z", current_item: null, next_item: "ITEM-1", next_step: "wait",
    owner_gate: { kind: "HANDOFF_CONFIRM", status: "BLOCKED", command: "/aio handoff confirm", item_id: "ITEM-1", satisfied_plan_revision_id: "PLAN-P2", satisfied_task_status: "IN_PROGRESS", satisfied_next_item: null, satisfied_next_step: "continue" },
    task_items: [{ task_item_id: "ITEM-1", task_id: "TASK-PACK", title: "Wait", description: "wait", status: "BLOCKED", depends_on: [], completion_criteria: ["safe"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "0.2-E", last_updated_at: "2026-08-24T00:00:00.000Z", last_updated_by: "human:test" }],
  };
}

test("R1-M-08 real npm tarball has one bundled lexical authority boundary under absolute file imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aiopago-real-tarball-security-"));
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  const npmOptions = { shell: process.platform === "win32" };
  const packedName = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], {
    cwd: process.cwd(), encoding: "utf8", ...npmOptions,
  }).trim().split(/\r?\n/).at(-1);
  const tarball = join(root, packedName);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "artifact-attacker", private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-package-lock", tarball, "@earendil-works/pi-coding-agent@0.83.0"], {
    cwd: consumer, stdio: "pipe", ...npmOptions,
  });
  const planPath = join(consumer, "TASK_PLAN.md");
  writeFileSync(planPath, `# Package fixture\n\n\`\`\`json task-ledger\n${JSON.stringify(blockedTask(), null, 2)}\n\`\`\`\n`);
  const script = `
    import assert from "node:assert/strict";
    import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";
    import * as root from "aiopago";

    const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("aiopago"))));
    const files = [];
    const walk = (path, relative = "") => { for (const name of readdirSync(path)) { const full = join(path, name); const rel = relative ? relative + "/" + name : name; if (statSync(full).isDirectory()) walk(full, rel); else files.push(rel.replaceAll("\\\\", "/")); } };
    walk(packageRoot);
    assert.equal(files.some((name) => name.startsWith("src/") || name.startsWith("test/") || name.startsWith("scripts/")), false);
    assert.equal(files.some((name) => /handoff-plan-internal|task-operation-internal|plan-semantics-internal|plan-store|storage\\.mjs/.test(name)), false);
    const jsFiles = files.filter((name) => /\\.(?:mjs|js)$/.test(name));
    assert.deepEqual(jsFiles.sort(), ["bin/aio.mjs", "bin/eio.mjs", "dist/cli-entry.mjs", "dist/index.mjs"].sort());

    const forbidden = [
      "GuardianStorage", "PlanRevisionWriter", "storageDatabaseForInternalUse", "storageDatabaseForInternalTest",
      "reserveHandoffForInternalTest", "claimTakeoverForInternalTest", "claimLatchForInternalTest",
      "saveHandoffForInternalTest", "bindRunnerSessionForInternalTest", "supersedeRunnerSessionBindingForInternalTest",
      "beginDispatchForInternalTest", "finishDispatchForInternalTest", "claimTrustedHumanTakeoverCurrentPlan",
      "claimTrustedHandoffLatch", "reserveTrustedHandoffPlan", "prepareTrustedContinuityRecovery", "authorizeTrustedResume",
      "taskOperationDisposition", "canonicalPlanSemantics", "planSemanticDigest", "runnerForInternalTest", "createRunnerForInternalTest", "processIdentityProbeForInternalTest",
      "createGuardianExtension", "trustedRunnerFacade", "RUNNER_INTERNAL_AUTHORITY", "ToolOperationTracker",
    ];
    for (const name of forbidden) assert.equal(Object.hasOwn(root, name), false, name);

    const imported = new Map();
    for (const name of jsFiles.filter((name) => name.startsWith("dist/"))) {
      const namespace = await import(pathToFileURL(join(packageRoot, name)));
      imported.set(name, namespace);
      for (const forbiddenName of forbidden) assert.equal(Object.hasOwn(namespace, forbiddenName), false, name + ":" + forbiddenName);
    }
    assert.equal(imported.get("dist/index.mjs").TaskLedger, root.TaskLedger, "absolute and root imports share the same bundled module instance");
    assert.deepEqual(Object.keys(imported.get("dist/cli-entry.mjs")), ["runCliEntrypoint"]);
    const duplicateRoot = join(dirname(packageRoot), "aiopago-duplicate");
    cpSync(packageRoot, duplicateRoot, { recursive: true });
    const duplicate = await import(pathToFileURL(join(duplicateRoot, "dist", "index.mjs")));
    assert.notEqual(duplicate.GuardianRunner, root.GuardianRunner, "duplicate package bundles retain isolated lexical registries");
    for (const forbiddenName of forbidden) assert.equal(Object.hasOwn(duplicate, forbiddenName), false, "duplicate:" + forbiddenName);
    process.argv = [process.execPath, join(packageRoot, "bin/aio.mjs"), "--help"];
    assert.deepEqual(Object.keys(await import(pathToFileURL(join(packageRoot, "bin/aio.mjs")))), []);
    process.argv = [process.execPath, join(packageRoot, "bin/eio.mjs"), "--help"];
    assert.deepEqual(Object.keys(await import(pathToFileURL(join(packageRoot, "bin/eio.mjs")))), []);

    for (const name of ["dist/index.mjs", "dist/cli-entry.mjs"]) {
      const bytes = readFileSync(join(packageRoot, name), "utf8");
      assert.doesNotMatch(bytes, /storageDatabaseForInternal|ForInternalTest|internalTestCapabilities|createRunnerForInternalTest/);
    }

    const ledger = new root.TaskLedger(${JSON.stringify(planPath)});
    const before = readFileSync(${JSON.stringify(planPath)});
    assert.deepEqual(Object.getOwnPropertyNames(root.TaskLedger.prototype).sort(), ["constructor", "read", "validate"].sort());
    assert.equal(Object.hasOwn(ledger, "writer"), false);
    for (const attack of ["satisfyOwnerGate", "withAuthorityCoordination", "coordinate", "commit"]) {
      assert.equal(typeof ledger[attack], "undefined");
      assert.throws(() => ledger[attack]({}), TypeError);
    }
    assert.deepEqual(readFileSync(${JSON.stringify(planPath)}), before);
    assert.equal(ledger.read().owner_gate.status, "BLOCKED");

    const runner = new root.GuardianRunner({ ledger, storage: { reserveHandoff() { throw new Error("fake"); } } });
    await assert.rejects(
      () => duplicate.GuardianRunner.prototype.runInteractive.call(runner),
      (error) => error.code === "RUNNER_INTERNAL_INVALID",
      "one bundle cannot consume another bundle's lexical Runner internals",
    );
    const visited = new Set();
    const queue = [runner];
    while (queue.length) {
      const value = queue.shift();
      if (!value || (typeof value !== "object" && typeof value !== "function") || visited.has(value)) continue;
      visited.add(value);
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const child = descriptor?.value;
        assert.equal(child?.constructor?.name === "DatabaseSync", false, "raw DatabaseSync is not reachable");
        if (child && (typeof child === "object" || typeof child === "function")) queue.push(child);
      }
    }
    assert.equal(visited.has(ledger), false, "constructor-supplied internals are not public object-graph properties");
    assert.equal(readFileSync(${JSON.stringify(planPath)}).equals(before), true);

    // R1-M-10: construct a real Runner from this installed tarball. Its public
    // graph may expose detached reads, but no operation/journal/lifecycle writer.
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { DatabaseSync } = await import("node:sqlite");
    const realRoot = mkdtempSync(join(tmpdir(), "aiopago-packed-authority-"));
    const realPlan = join(realRoot, "TASK_PLAN.md");
    const realTask = ${JSON.stringify(blockedTask())};
    realTask.status = "IN_PROGRESS";
    realTask.current_item = "ITEM-1";
    realTask.next_item = null;
    realTask.next_step = "continue";
    realTask.task_items[0].status = "IN_PROGRESS";
    delete realTask.owner_gate;
    realTask.model_policy = "openai-codex/gpt-5.6-sol";
    realTask.reasoning_policy = "high";
    writeFileSync(realPlan, "# packed real Runner\\n\\n\`\`\`json task-ledger\\n" + JSON.stringify(realTask, null, 2) + "\\n\`\`\`\\n");
    execFileSync("git", ["init"], { cwd: realRoot });
    execFileSync("git", ["config", "user.email", "packed@example.invalid"], { cwd: realRoot });
    execFileSync("git", ["config", "user.name", "Packed Security"], { cwd: realRoot });
    execFileSync("git", ["add", "."], { cwd: realRoot });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: realRoot });
    const pi = await root.loadPi({ root: ${JSON.stringify(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent"))} });

    // R1-M-11 exact exploit: a Proxy around genuine Pi must be rejected before
    // Aiopago publishes its privileged extension factory to caller code.
    const capturedFactories = [];
    const codingProxy = new Proxy(pi.coding, { get(target, property, receiver) {
      if (property === "createAgentSessionServices") return async (options) => {
        capturedFactories.push(...(options.resourceLoaderOptions?.extensionFactories ?? []));
        return Reflect.apply(target[property], target, [options]);
      };
      return Reflect.get(target, property, receiver);
    } });
    const proxyPi = new Proxy(pi, { get(target, property, receiver) { return property === "coding" ? codingProxy : Reflect.get(target, property, receiver); } });
    let registeredCommands = 0;
    let registeredHandlers = 0;
    await assert.rejects(
      () => root.GuardianRunner.create({ cwd: realRoot, pi: proxyPi }),
      (error) => error.code === "RUNNER_PI_INJECTION_FORBIDDEN",
    );
    assert.equal(capturedFactories.length, 0);
    assert.equal(registeredCommands, 0);
    assert.equal(registeredHandlers, 0);
    assert.equal(existsSync(join(realRoot, ".guardian", "runtime", "guardian.sqlite")), false, "Pi rejection precedes durable runtime mutation");

    await assert.rejects(
      () => root.GuardianRunner.create({ cwd: realRoot, pi: {} }),
      (error) => error.code === "RUNNER_PI_INJECTION_FORBIDDEN",
    );
    let piGetterCalls = 0;
    const getterOptions = { cwd: realRoot };
    Object.defineProperty(getterOptions, "pi", { enumerable: true, get() { piGetterCalls += 1; return proxyPi; } });
    await assert.rejects(() => root.GuardianRunner.create(getterOptions), (error) => error.code === "RUNNER_PI_INJECTION_FORBIDDEN");
    assert.equal(piGetterCalls, 0, "the forbidden Pi value is never read");
    let optionGets = 0;
    const proxyOptions = new Proxy({ cwd: realRoot }, {
      has(_target, property) { return property === "pi" || property === "cwd"; },
      get(target, property, receiver) { optionGets += 1; return Reflect.get(target, property, receiver); },
    });
    await assert.rejects(() => root.GuardianRunner.create(proxyOptions), (error) => error.code === "RUNNER_PI_INJECTION_FORBIDDEN");
    assert.equal(optionGets, 0, "Proxy get traps cannot expose a Pi object before rejection");

    for (const dependency of ["sessionManager", "settingsManager", "modelRuntime", "model", "metrics", "contextAdvisor", "ledger", "storage", "artifacts", "tools"]) {
      let getterCalls = 0;
      const options = { cwd: realRoot };
      Object.defineProperty(options, dependency, { enumerable: true, get() { getterCalls += 1; return {}; } });
      await assert.rejects(
        () => root.GuardianRunner.create(options),
        (error) => error.code === "RUNNER_RUNTIME_INJECTION_FORBIDDEN",
        dependency,
      );
      assert.equal(getterCalls, 0, dependency + " must be rejected without reading the injected runtime object");
    }
    assert.equal(capturedFactories.length, 0);

    let observeThis = "not-called";
    let observeArgs = null;
    function safeObserveGit(...args) { observeThis = this; observeArgs = args; return root.observeGitState(realRoot); }
    const priorPiRoot = process.env.PI_CODING_AGENT_ROOT;
    process.env.PI_CODING_AGENT_ROOT = join(realRoot, "attacker-selected-pi");
    let realRunner;
    try {
      realRunner = await root.GuardianRunner.create({ cwd: realRoot, observeGit: safeObserveGit, sessionDir: mkdtempSync(join(tmpdir(), "aiopago-packed-authority-sessions-")), noTools: "all" });
    } finally {
      if (priorPiRoot === undefined) delete process.env.PI_CODING_AGENT_ROOT;
      else process.env.PI_CODING_AGENT_ROOT = priorPiRoot;
    }
    realRunner.handoffService.observeGit();
    assert.equal(observeThis, undefined, "safe read callbacks receive no HandoffService/Runner this authority");
    assert.deepEqual(observeArgs, [], "safe read callbacks receive no privileged arguments");
    const operationBefore = realRunner.storage.operationsForTask(realTask.task_id);
    assert.equal(Object.isFrozen(realRunner.storage), true);
    for (const name of [
      "appendEvent", "admitOperation", "finishOperation", "transaction", "bindCalibrationRuntimeIdentity", "indexArtifact",
      "upsertMetricSession", "appendMetricSample", "appendHandoffMetricEvent", "appendMetricDiagnostic", "claimLatch",
      "ensureLatch", "reserveHandoff", "saveHandoff", "transition", "authorizeAndAdmit", "beginDispatch", "finishDispatch",
    ]) assert.equal(typeof realRunner.storage[name], "undefined", "public storage facade must omit " + name);
    for (const name of ["toolTracker", "safePoint", "gate", "metrics", "artifacts", "pi", "modelRuntime", "settingsManager", "recoverySourceSession"]) {
      assert.equal(realRunner[name], undefined, "Runner must hide " + name);
    }
    for (const attack of [
      () => realRunner.storage.appendEvent("FORGED_REVIEW_EVENT", { attacker: true }),
      () => realRunner.storage.admitOperation({ operationId: "OP-FORGED", taskId: realTask.task_id, generation: 0, profile: "LOCAL_ATOMIC_MUTATION" }),
      () => realRunner.storage.finishOperation("OP-FORGED", "KNOWN_SUCCESS", "file:attacker-chosen"),
      () => realRunner.storage.transaction(() => {}),
      () => realRunner.storage.bindCalibrationRuntimeIdentity({ run_id: "attacker" }),
      () => realRunner.storage.indexArtifact({ kind: "checkpoint", id: "CP-FORGED", path: "attacker", digest: "attacker", contentDigest: "attacker" }),
      () => realRunner.toolTracker.finish("OP-FORGED", false),
      () => realRunner.toolTracker.unknown("OP-FORGED"),
    ]) assert.throws(attack, TypeError);
    assert.equal(typeof realRunner.handoffService.observeGit, "function");
    assert.deepEqual(Object.keys(realRunner.handoffService), ["observeGit"]);

    const graphVisited = new Set();
    const graphQueue = [realRunner, realRunner.storage, realRunner.runtime, realRunner.handoffService, realRunner.contextAdvisor, realRunner.ledger];
    const dangerousNames = new Set([
      "appendEvent", "admitOperation", "finishOperation", "finish", "unknown", "transaction", "bindCalibrationRuntimeIdentity",
      "indexArtifact", "upsertMetricSession", "appendMetricSample", "appendHandoffMetricEvent", "appendMetricDiagnostic",
      "claimLatch", "engageLatch", "reserveHandoff", "saveHandoff", "transition", "authorizeAndAdmit", "beginDispatch", "finishDispatch",
    ]);
    const reachableDangerous = [];
    while (graphQueue.length && graphVisited.size < 500) {
      const value = graphQueue.shift();
      if (!value || (typeof value !== "object" && typeof value !== "function") || graphVisited.has(value)) continue;
      graphVisited.add(value);
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (dangerousNames.has(String(key)) && typeof descriptor?.value === "function") reachableDangerous.push(String(key));
        const child = descriptor?.value;
        assert.notEqual(child?.constructor?.name, "DatabaseSync");
        if (child && (typeof child === "object" || typeof child === "function")) graphQueue.push(child);
      }
      let prototype = Object.getPrototypeOf(value);
      for (let depth = 0; prototype && depth < 3; depth += 1, prototype = Object.getPrototypeOf(prototype)) {
        for (const key of Reflect.ownKeys(prototype)) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          if (dangerousNames.has(String(key)) && typeof descriptor?.value === "function") reachableDangerous.push(String(key));
        }
      }
    }
    assert.deepEqual([...new Set(reachableDangerous)], [], "no safety-bearing mutator is reachable through the real Runner graph");

    for (const [name, args] of [
      ["handoffDirect", []], ["recoverHandoffDirect", ["HO-FORGED"]], ["takeoverFromCommand", [{ ui: { notify() {} } }]],
      ["resumeFromCommand", [{ ui: { confirm: async () => true, notify() {} } }, "HO-FORGED"]],
      ["handoffFromCommand", [{}, "manual"]], ["recoverHandoffFromCommand", [{}, "HO-FORGED"]],
      ["noteSessionStart", [{}]], ["noteSessionShutdown", [{}]], ["permitReplacement", []], ["consumeReplacementPermit", []],
    ]) {
      let refused = false;
      try { await realRunner[name](...args); }
      catch (error) { refused = error?.code === "RUNNER_TRUSTED_PATH_REQUIRED"; }
      assert.equal(refused, true, name + " must fail closed outside the lexical Pi capability");
    }
    assert.deepEqual(realRunner.storage.operationsForTask(realTask.task_id), operationBefore);
    const storagePath = realRunner.storage.path;
    await realRunner.dispose();
    const db = new DatabaseSync(storagePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE operation_id='OP-FORGED'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal WHERE event_type='FORGED_REVIEW_EVENT'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal WHERE event_type IN ('LATCH_ENGAGED','LATCH_ESCALATED') AND data_json LIKE '%HUMAN_TAKEOVER%'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM authorizations").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admissions").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM dispatch_attempts").get().count, 0);
    assert.equal(db.prepare("SELECT reason FROM latches WHERE task_id='TASK-PACK'").get().reason, null);
    db.close();
  `;
  writeFileSync(join(consumer, "attack.mjs"), script);
  execFileSync(process.execPath, ["attack.mjs"], { cwd: consumer, stdio: "pipe" });
  assert.ok(readFileSync(tarball).length > 0);
});

test("R1-M-12 real tarball ignores NODE_PATH Pi and rejects redirected adjacent Pi before factory publication", () => {
  const root = mkdtempSync(join(tmpdir(), "aiopago-packed-pi-resolution-"));
  const npmOptions = { shell: process.platform === "win32" };
  const packedName = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], {
    cwd: process.cwd(), encoding: "utf8", ...npmOptions,
  }).trim().split(/\r?\n/).at(-1);
  const tarball = join(root, packedName);
  const fakeModules = join(root, "fake-node-modules");
  const fakePi = join(fakeModules, "@earendil-works", "pi-coding-agent");
  const fakeAi = join(fakeModules, "@earendil-works", "pi-ai");
  mkdirSync(join(fakePi, "dist"), { recursive: true });
  mkdirSync(join(fakeAi, "dist"), { recursive: true });
  writeFileSync(join(fakePi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.77", type: "module", main: "dist/index.js" }));
  writeFileSync(join(fakeAi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.83.77", type: "module", main: "dist/index.js" }));
  const fakeModule = `import { writeFileSync } from "node:fs"; writeFileSync(process.env.AIOPAGO_FAKE_PI_CAPTURE, "evaluated"); export const attacker = true;\n`;
  writeFileSync(join(fakePi, "dist", "index.js"), fakeModule);
  writeFileSync(join(fakeAi, "dist", "index.js"), fakeModule);

  for (const mode of ["NODE_PATH", "adjacent-junction"]) {
    const consumer = join(root, `consumer-${mode.toLowerCase()}`);
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "packed-pi-attacker", private: true, type: "module" }));
    execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-package-lock", tarball], {
      cwd: consumer, stdio: "pipe", ...npmOptions,
    });
    if (mode === "adjacent-junction") {
      const scope = join(consumer, "node_modules", "@earendil-works");
      mkdirSync(scope, { recursive: true });
      symlinkSync(fakePi, join(scope, "pi-coding-agent"), "junction");
      symlinkSync(fakeAi, join(scope, "pi-ai"), "junction");
    }
    const planPath = join(consumer, "TASK_PLAN.md");
    writeFileSync(planPath, `# Packed Pi resolution fixture\n\n\`\`\`json task-ledger\n${JSON.stringify(blockedTask(), null, 2)}\n\`\`\`\n`);
    const attack = `
      import { existsSync } from "node:fs";
      import { join } from "node:path";
      import { GuardianRunner } from "aiopago";
      let code = null; let message = null;
      try { await GuardianRunner.create({ cwd: process.cwd() }); }
      catch (error) { code = error.code ?? null; message = error.message; }
      process.stdout.write(JSON.stringify({ code, message, runtime: existsSync(join(process.cwd(), ".guardian", "runtime", "guardian.sqlite")) }));
    `;
    writeFileSync(join(consumer, "attack.mjs"), attack);
    const capture = join(root, `capture-${mode}.txt`);
    const env = { ...process.env, AIOPAGO_FAKE_PI_CAPTURE: capture };
    if (mode === "NODE_PATH") env.NODE_PATH = fakeModules;
    const result = JSON.parse(execFileSync(process.execPath, ["attack.mjs"], { cwd: consumer, env, encoding: "utf8" }));
    assert.equal(result.code, mode === "NODE_PATH" ? "PI_UNAVAILABLE" : "PI_TRUSTED_INSTALLATION_REDIRECTED", mode);
    assert.equal(result.runtime, false, `${mode}: reject before durable Runner mutation`);
    assert.equal(existsSync(capture), false, `${mode}: neither fake Pi nor fake pi-ai is evaluated`);
    if (mode === "NODE_PATH") assert.doesNotMatch(result.message, /PI_CODING_AGENT_ROOT/, "privileged loading must not recommend an ignored override");
  }
});
