import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--omit=peer", "--no-package-lock", tarball], {
    cwd: consumer, stdio: "pipe", ...npmOptions,
  });
  const planPath = join(consumer, "TASK_PLAN.md");
  writeFileSync(planPath, `# Package fixture\n\n\`\`\`json task-ledger\n${JSON.stringify(blockedTask(), null, 2)}\n\`\`\`\n`);
  const script = `
    import assert from "node:assert/strict";
    import { readdirSync, readFileSync, statSync } from "node:fs";
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
      "taskOperationDisposition", "canonicalPlanSemantics", "planSemanticDigest", "runnerForInternalTest", "processIdentityProbeForInternalTest",
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
    process.argv = [process.execPath, join(packageRoot, "bin/aio.mjs"), "--help"];
    assert.deepEqual(Object.keys(await import(pathToFileURL(join(packageRoot, "bin/aio.mjs")))), []);
    process.argv = [process.execPath, join(packageRoot, "bin/eio.mjs"), "--help"];
    assert.deepEqual(Object.keys(await import(pathToFileURL(join(packageRoot, "bin/eio.mjs")))), []);

    for (const name of ["dist/index.mjs", "dist/cli-entry.mjs"]) {
      const bytes = readFileSync(join(packageRoot, name), "utf8");
      assert.doesNotMatch(bytes, /storageDatabaseForInternal|ForInternalTest|internalTestCapabilities/);
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
    realTask.model_policy = "offline-fake/offline-fake";
    realTask.reasoning_policy = "off";
    writeFileSync(realPlan, "# packed real Runner\\n\\n\`\`\`json task-ledger\\n" + JSON.stringify(realTask, null, 2) + "\\n\`\`\`\\n");
    execFileSync("git", ["init"], { cwd: realRoot });
    execFileSync("git", ["config", "user.email", "packed@example.invalid"], { cwd: realRoot });
    execFileSync("git", ["config", "user.name", "Packed Security"], { cwd: realRoot });
    execFileSync("git", ["add", "."], { cwd: realRoot });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: realRoot });
    const pi = await root.loadPi({ root: ${JSON.stringify(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent"))} });
    const credentials = new pi.ai.InMemoryCredentialStore();
    const modelRuntime = await pi.coding.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
    const model = { id: "offline-fake", name: "Offline", api: "openai-completions", provider: "offline-fake", baseUrl: "offline://local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
    modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: "x", api: model.api, models: [model], streamSimple() { throw new Error("provider must not run"); } });
    await modelRuntime.setRuntimeApiKey(model.provider, "x");
    const settingsManager = pi.coding.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const realRunner = await root.GuardianRunner.create({
      cwd: realRoot, pi, modelRuntime, model, modelPolicy: "offline-fake/offline-fake", reasoningPolicy: "off",
      settingsManager, sessionDir: mkdtempSync(join(tmpdir(), "aiopago-packed-authority-sessions-")), noTools: "all",
    });
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
    db.close();
  `;
  writeFileSync(join(consumer, "attack.mjs"), script);
  execFileSync(process.execPath, ["attack.mjs"], { cwd: consumer, stdio: "pipe" });
  assert.ok(readFileSync(tarball).length > 0);
});
