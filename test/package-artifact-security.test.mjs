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
      "taskOperationDisposition", "canonicalPlanSemantics", "planSemanticDigest",
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
        const child = value[key];
        assert.equal(child?.constructor?.name === "DatabaseSync", false, "raw DatabaseSync is not reachable");
        if (child && (typeof child === "object" || typeof child === "function")) queue.push(child);
      }
    }
    assert.equal(visited.has(ledger), true);
    assert.equal(readFileSync(${JSON.stringify(planPath)}).equals(before), true);
  `;
  writeFileSync(join(consumer, "attack.mjs"), script);
  execFileSync(process.execPath, ["attack.mjs"], { cwd: consumer, stdio: "pipe" });
  assert.ok(readFileSync(tarball).length > 0);
});
