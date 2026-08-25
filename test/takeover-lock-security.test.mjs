import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createPlanAdapter, PLAN_INTENT_SCHEMA } from "../src/intent-adapter.mjs";
import { TaskLedger, validateTaskLedger } from "../src/ledger.mjs";
import { PlanRevisionWriter, processIdentityProbeForInternalTest } from "../src/plan-store.mjs";
import { GuardianRunner, runnerForInternalTest } from "../src/runner.mjs";
import { AdmissionGate, SafePointCoordinator } from "../src/safety.mjs";
import { GuardianStorage, storageDatabaseForInternalTest } from "../src/storage.mjs";

function task(overrides = {}) {
  return {
    schema_version: "0.1.0", task_id: "TASK-TAKEOVER", title: "Takeover", objective: "Preserve one human command",
    requirements_version: "REQ-1", plan_revision_id: "PLAN-P1", status: "BLOCKED",
    completion_criteria: ["safe"], risk: "HIGH", created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z", current_item: null, next_item: "ITEM-1", next_step: "Authorize owner",
    owner_gate: {
      kind: "HANDOFF_CONFIRM", status: "BLOCKED", command: "/aio handoff confirm", item_id: "ITEM-1",
      satisfied_plan_revision_id: "PLAN-P1-PRIME", satisfied_task_status: "IN_PROGRESS", satisfied_next_item: null,
      satisfied_next_step: "Continue after owner authorization.",
    },
    task_items: [{
      task_item_id: "ITEM-1", task_id: "TASK-TAKEOVER", title: "Owner", description: "owner", status: "BLOCKED",
      depends_on: [], completion_criteria: ["safe"], evidence: [], requirements_refs: [], risk: "HIGH", milestone: "0.2-E",
      last_updated_at: "2026-08-24T00:00:00.000Z", last_updated_by: "human:test",
    }],
    ...overrides,
  };
}

function writePlan(path, value = task()) {
  writeFileSync(path, `# Takeover fixture\n\n**Schema:** \`aiopago.task-ledger/0.1.0\`\n\n\`\`\`json task-ledger\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-takeover-lock-"));
  const planPath = join(root, "TASK_PLAN.md");
  const storagePath = join(root, ".guardian", "runtime", "guardian.sqlite");
  writePlan(planPath);
  const ledger = new TaskLedger(planPath);
  const storage = new GuardianStorage(storagePath);
  storage.ensureLatch("TASK-TAKEOVER");
  const gate = new AdmissionGate(storage, "TASK-TAKEOVER");
  const safePoint = new SafePointCoordinator({ storage, taskId: "TASK-TAKEOVER", gate });
  const session = {
    sessionId: "SESSION-TAKEOVER", isIdle: true, isStreaming: false, pendingMessageCount: 0, isRetrying: false, isCompacting: false,
    clearQueue() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, async abort() {}, async waitForIdle() {},
  };
  const runner = runnerForInternalTest(new GuardianRunner({ ledger, storage, safePoint }));
  runner.runtime = { session };
  const notifications = [];
  const ctx = { ui: { notify(text, type) { notifications.push({ text, type }); } } };
  return { root, planPath, storagePath, ledger, storage, runner, ctx, notifications, close: () => storage.close() };
}

async function waitFor(path, timeoutMs = 10_000) {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function ownerChild(x, holdMs = 500) {
  const script = join(x.root, "owner-child.mjs");
  const ready = join(x.root, "owner-ready");
  writeFileSync(script, `
    import { writeFileSync } from "node:fs";
    import { TaskLedger } from ${JSON.stringify(new URL("../src/ledger.mjs", import.meta.url).href)};
    import { GuardianStorage } from ${JSON.stringify(new URL("../src/storage.mjs", import.meta.url).href)};
    import { satisfyOwnerGateForTest } from ${JSON.stringify(new URL("./trusted-owner-gate-helper.mjs", import.meta.url).href)};
    let held = false;
    const ledger = new TaskLedger(${JSON.stringify(x.planPath)}, { writerOptions: { testHooks: { afterPreparation() {
      if (held) return; held = true; writeFileSync(${JSON.stringify(ready)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
    } } } });
    const storage = new GuardianStorage(${JSON.stringify(x.storagePath)});
    try {
      const plan = satisfyOwnerGateForTest(ledger, { command: "/aio handoff confirm", actor: "human:owner-child" }, storage);
      process.stdout.write(JSON.stringify({ ok: true, revision: plan.plan_revision_id }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? null })); }
    finally { storage.close(); }
  `);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const done = new Promise((resolveDone, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveDone(JSON.parse(stdout)) : reject(new Error(`owner child exit ${code}`)));
  });
  return { child, ready, done };
}

function lockOwnerChild(x, holdMs) {
  const script = join(x.root, `lock-owner-${holdMs}.mjs`);
  const ready = join(x.root, `lock-owner-${holdMs}-ready`);
  writeFileSync(script, `
    import { writeFileSync } from "node:fs";
    import { PlanRevisionWriter } from ${JSON.stringify(new URL("../src/plan-store.mjs", import.meta.url).href)};
    const writer = new PlanRevisionWriter(${JSON.stringify(x.planPath)});
    writer.coordinate({ validate() {}, use() {
      writeFileSync(${JSON.stringify(ready)}, "ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
    } });
  `);
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const done = new Promise((resolveDone, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 || signal === "SIGKILL" ? resolveDone({ code, signal }) : reject(new Error(`lock owner exit ${code}`)));
  });
  return { child, ready, done };
}

function fakePowerShell(root) {
  const directory = join(root, "fake-powershell");
  mkdirSync(directory);
  const source = join(directory, "FakePowerShell.cs");
  writeFileSync(source, `using System; using System.IO; class FakePowerShell { static int Main() { var marker=Environment.GetEnvironmentVariable("AIOPAGO_FAKE_MARKER"); if (!String.IsNullOrEmpty(marker)) File.WriteAllText(marker, "invoked"); Console.Out.Write(Environment.GetEnvironmentVariable("AIOPAGO_FAKE_OUTPUT") ?? ""); return Int32.Parse(Environment.GetEnvironmentVariable("AIOPAGO_FAKE_EXIT") ?? "0"); } }`);
  execFileSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", ["/nologo", `/out:${join(directory, "powershell.exe")}`, source]);
  return directory;
}

function lockSnapshot(path) {
  const stat = statSync(path, { bigint: true });
  return { bytes: readFileSync(path), dev: stat.dev, ino: stat.ino };
}

function sameLockSnapshot(path, snapshot) {
  if (!existsSync(path)) return false;
  const stat = statSync(path, { bigint: true });
  return stat.dev === snapshot.dev && stat.ino === snapshot.ino && readFileSync(path).equals(snapshot.bytes);
}

function applyP2(path, suffix = "P2") {
  const adapter = createPlanAdapter(path);
  const observed = adapter.observe();
  const candidate = structuredClone(observed.plan);
  candidate.plan_revision_id = `PLAN-${suffix}`;
  candidate.updated_at = "2026-08-24T00:01:00.000Z";
  candidate.objective = `Current plan ${suffix}`;
  const proposal = adapter.propose({
    schema: PLAN_INTENT_SCHEMA, proposal_id: `PPR-${suffix}`, producer: "test/takeover", change_reason: "legitimate current plan drift",
    base: { task_id: observed.task_id, plan_revision_id: observed.plan_revision_id, content_digest: observed.content_digest },
    candidate_plan: candidate,
  });
  return adapter.apply(proposal);
}

function lockMetadata(planPath, { pid, identity, nonce = "a".repeat(64), schema = "aiopago.plan-write-lock/0.3.0" }) {
  return `${JSON.stringify({
    schema, ownership_nonce: nonce, pid, process_identity: identity, created_at: "2026-08-24T00:00:00.000Z",
    plan_path: resolve(planPath), guardian_root: resolve(dirname(planPath), ".guardian"),
  })}\n`;
}

test("R1-M-06 owner-first contention keeps one takeover command alive until HUMAN_TAKEOVER is canonical", async () => {
  const x = fixture();
  try {
    // Keep the owner alive across the real Windows process-identity probe; a
    // cold Get-CimInstance can legitimately take several seconds.
    const owner = ownerChild(x, 3_500);
    await waitFor(owner.ready);
    const pending = x.runner.takeoverFromCommand(x.ctx);
    const ownerResult = await owner.done;
    const takeover = await pending;
    assert.deepEqual(ownerResult, { ok: true, revision: "PLAN-P1-PRIME" });
    assert.equal(x.ledger.read().plan_revision_id, "PLAN-P1-PRIME");
    assert.equal(takeover.state, "HUMAN_TAKEOVER");
    assert.equal(takeover.plan_revision_id, "PLAN-P1-PRIME");
    assert.equal(x.storage.getLatch("TASK-TAKEOVER").reason, "HUMAN_TAKEOVER");
    assert.equal(x.notifications.length, 1, "pause notification occurs only after the canonical SafePoint");
  } finally { x.close(); }
});

test("R1-M-06 takeover-first rejects a later owner mutation with zero stale P1-prime", async () => {
  const x = fixture();
  const script = join(x.root, "owner-after.mjs");
  writeFileSync(script, `
    import { TaskLedger } from ${JSON.stringify(new URL("../src/ledger.mjs", import.meta.url).href)};
    import { GuardianStorage } from ${JSON.stringify(new URL("../src/storage.mjs", import.meta.url).href)};
    import { satisfyOwnerGateForTest } from ${JSON.stringify(new URL("./trusted-owner-gate-helper.mjs", import.meta.url).href)};
    const ledger = new TaskLedger(${JSON.stringify(x.planPath)});
    const storage = new GuardianStorage(${JSON.stringify(x.storagePath)});
    try { satisfyOwnerGateForTest(ledger, { command: "/aio handoff confirm", actor: "human:late-owner" }, storage); process.stdout.write(JSON.stringify({ ok: true })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? null })); }
    finally { storage.close(); }
  `);
  try {
    await x.runner.takeoverFromCommand(x.ctx);
    const owner = JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" }));
    assert.deepEqual(owner, { ok: false, code: "HUMAN_TAKEOVER_ACTIVE" });
    assert.equal(x.ledger.read().plan_revision_id, "PLAN-P1");
    assert.equal(x.ledger.read().owner_gate.status, "BLOCKED");
  } finally { x.close(); }
});

test("R1-M-06 P2-first drift binds the same takeover command to current P2 authority", async () => {
  const x = fixture();
  try {
    applyP2(x.planPath, "P2");
    const result = await x.runner.takeoverFromCommand(x.ctx);
    assert.equal(result.plan_revision_id, "PLAN-P2");
    assert.equal(result.plan_content_digest, x.ledger.read().content_digest);
    assert.equal(x.storage.getLatch("TASK-TAKEOVER").reason, "HUMAN_TAKEOVER");
  } finally { x.close(); }
});

test("R1-M-06 repeated bounded P2 churn and one takeover command converge without a second prompt", async () => {
  const x = fixture();
  const script = join(x.root, "p2-churn-child.mjs");
  const ready = join(x.root, "p2-churn-ready");
  writeFileSync(script, `
    import { writeFileSync } from "node:fs";
    import { TaskLedger } from ${JSON.stringify(new URL("../src/ledger.mjs", import.meta.url).href)};
    import { GuardianStorage } from ${JSON.stringify(new URL("../src/storage.mjs", import.meta.url).href)};
    import { createPlanAdapter, PLAN_INTENT_SCHEMA } from ${JSON.stringify(new URL("../src/intent-adapter.mjs", import.meta.url).href)};
    import { satisfyOwnerGateForTest } from ${JSON.stringify(new URL("./trusted-owner-gate-helper.mjs", import.meta.url).href)};
    let held = false;
    const ledger = new TaskLedger(${JSON.stringify(x.planPath)}, { writerOptions: { testHooks: { afterPreparation() { if (!held) { held = true; writeFileSync(${JSON.stringify(ready)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450); } } } } });
    const storage = new GuardianStorage(${JSON.stringify(x.storagePath)});
    try {
      satisfyOwnerGateForTest(ledger, { command: "/aio handoff confirm", actor: "human:churn-owner" }, storage);
      for (let index = 0; index < 4; index += 1) {
        for (let attempt = 0; ; attempt += 1) {
          const adapter = createPlanAdapter(${JSON.stringify(x.planPath)}); const observed = adapter.observe(); const candidate = structuredClone(observed.plan);
          candidate.plan_revision_id = "PLAN-CHURN-" + index; candidate.updated_at = "2026-08-24T00:0" + (index + 2) + ":00.000Z"; candidate.objective = "P2 churn " + index;
          try { adapter.apply(adapter.propose({ schema: PLAN_INTENT_SCHEMA, proposal_id: "PPR-CHURN-" + index + "-" + attempt, producer: "test/churn", change_reason: "bounded churn", base: { task_id: observed.task_id, plan_revision_id: observed.plan_revision_id, content_digest: observed.content_digest }, candidate_plan: candidate })); break; }
          catch (error) { if (error.code !== "PLAN_WRITE_LOCKED" || attempt >= 20) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
        }
      }
      process.stdout.write(JSON.stringify({ ok: true }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? null })); }
    finally { storage.close(); }
  `);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
  try {
    await waitFor(ready);
    const takeover = x.runner.takeoverFromCommand(x.ctx).then((result) => ({ result }), (error) => ({ error }));
    await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`churn child exit ${code}`))); });
    assert.deepEqual(JSON.parse(output), { ok: true });
    const outcome = await takeover;
    if (outcome.result) {
      assert.equal(outcome.result.state, "HUMAN_TAKEOVER");
      assert.equal(x.storage.getLatch("TASK-TAKEOVER").reason, "HUMAN_TAKEOVER");
      assert.equal(x.notifications.length, 1);
    } else {
      assert.equal(outcome.error?.code, "PLAN_LOCK_RECONCILIATION_REQUIRED", "probe ambiguity intentionally narrows availability without stealing a writer");
      assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
      assert.equal(x.notifications.length, 0);
    }
    assert.equal(x.ledger.read().plan_revision_id, "PLAN-CHURN-3");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); x.close(); }
});

test("R1-M-06 task-id movement is a terminal identity failure and never claims another task latch", async () => {
  const x = fixture();
  try {
    const moved = task({ task_id: "TASK-OTHER", plan_revision_id: "PLAN-OTHER" });
    moved.task_items[0].task_id = "TASK-OTHER";
    writePlan(x.planPath, moved);
    await assert.rejects(() => x.runner.takeoverFromCommand(x.ctx), (error) => error.code === "HUMAN_TAKEOVER_TASK_CHANGED");
    assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
    assert.equal(x.notifications.length, 0);
  } finally { x.close(); }
});

test("R1-M-09 Windows probe failures are UNKNOWN and PowerShell absence cannot steal a real live lock", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows process probe regression");

  await t.test("structured probe classification", () => {
    const spawnCase = (result) => processIdentityProbeForInternalTest(process.pid, { spawn: () => result });
    for (const [name, result] of [
      ["powershell executable absent", { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }],
      ["generic exit 1", { status: 1, stdout: "", stderr: "localized generic failure" }],
      ["access denied", { status: null, stdout: "", stderr: "", error: Object.assign(new Error("access denied"), { code: "EACCES" }) }],
      ["timeout", { status: null, stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }],
      ["malformed stdout", { status: 0, stdout: "AIOPAGO_PROCESS_LIVE_V1:not-ticks", stderr: "" }],
      ["empty stdout", { status: 0, stdout: "", stderr: "" }],
      ["dead exit without sentinel", { status: 3, stdout: "", stderr: "" }],
    ]) assert.deepEqual(spawnCase(result), { status: "UNKNOWN", identity: null }, name);
    assert.deepEqual(spawnCase({ status: 3, stdout: "AIOPAGO_PROCESS_DEAD_V1", stderr: "" }), { status: "UNKNOWN", identity: null }, "a syntactically exact user-space DEAD sentinel has no cleanup authority");
    assert.equal(processIdentityProbeForInternalTest(process.pid).status, "LIVE");
    assert.deepEqual(processIdentityProbeForInternalTest(2_147_483_000), { status: "DEAD", identity: null }, "native ESRCH is positive absence evidence");
  });

  await t.test("PATH/PATHEXT/cwd-shadowed PowerShell cannot steal a real live owner lock", async () => {
    const x = fixture();
    const writer = new PlanRevisionWriter(x.planPath);
    writer.coordinate({ validate: validateTaskLedger, use() {} });
    const owner = lockOwnerChild(x, 30_000);
    const lockPath = join(x.root, ".guardian", "plan-write.lock");
    const fakeDirectory = fakePowerShell(x.root);
    const original = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, cwd: process.cwd() };
    try {
      await waitFor(owner.ready);
      const before = lockSnapshot(lockPath);
      const ownerMetadata = JSON.parse(before.bytes.toString("utf8"));
      const exactTicks = ownerMetadata.process_identity.slice("win32:".length);
      const cases = [
        ["fake DEAD", "AIOPAGO_PROCESS_DEAD_V1", "3", false, false, "PLAN_LOCK_RECONCILIATION_REQUIRED"],
        ["fake LIVE wrong ticks", "AIOPAGO_PROCESS_LIVE_V1:1", "0", false, false, "PLAN_LOCK_RECONCILIATION_REQUIRED"],
        ["fake LIVE exact ticks", `AIOPAGO_PROCESS_LIVE_V1:${exactTicks}`, "0", false, false, "PLAN_WRITE_LOCKED"],
        ["malformed fake sentinel", "AIOPAGO_PROCESS_LIVE_V1:not-ticks", "0", false, false, "PLAN_LOCK_RECONCILIATION_REQUIRED"],
        ["PATHEXT manipulation", "AIOPAGO_PROCESS_DEAD_V1", "3", true, false, "PLAN_LOCK_RECONCILIATION_REQUIRED"],
        ["working-directory shadow", "AIOPAGO_PROCESS_DEAD_V1", "3", false, true, "PLAN_LOCK_RECONCILIATION_REQUIRED"],
      ];
      for (const [name, output, exit, pathext, cwdShadow, expectedCode] of cases) {
        const marker = join(x.root, `fake-${name.replaceAll(/[^A-Za-z]/g, "-")}`);
        process.env.AIOPAGO_FAKE_OUTPUT = output;
        process.env.AIOPAGO_FAKE_EXIT = exit;
        process.env.AIOPAGO_FAKE_MARKER = marker;
        process.env.PATHEXT = pathext ? ".COM;.BAT;.CMD" : original.PATHEXT;
        process.env.PATH = cwdShadow ? "" : `${fakeDirectory};${original.PATH}`;
        if (cwdShadow) process.chdir(fakeDirectory);
        let callbacks = 0;
        assert.throws(
          () => new PlanRevisionWriter(x.planPath).coordinate({ validate: validateTaskLedger, use() { callbacks += 1; writeFileSync(x.planPath, "forged\n"); } }),
          (error) => error.code === expectedCode,
          name,
        );
        if (cwdShadow) process.chdir(original.cwd);
        assert.equal(existsSync(marker), true, `${name}: the shadow executable ran`);
        assert.equal(callbacks, 0, `${name}: no overlapping coordination callback`);
        assert.equal(owner.child.exitCode, null, `${name}: original owner remains alive`);
        assert.equal(sameLockSnapshot(lockPath, before), true, `${name}: owner nonce, bytes, inode and device remain exact`);
        assert.equal(existsSync(`${lockPath}.recovery`), false, `${name}: no recovery marker cleanup`);
        assert.equal(x.ledger.read().plan_revision_id, "PLAN-P1", `${name}: no plan mutation`);
        assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED", `${name}: no latch mutation`);
      }
    } finally {
      process.chdir(original.cwd);
      process.env.PATH = original.PATH;
      process.env.PATHEXT = original.PATHEXT;
      delete process.env.AIOPAGO_FAKE_OUTPUT;
      delete process.env.AIOPAGO_FAKE_EXIT;
      delete process.env.AIOPAGO_FAKE_MARKER;
      if (owner.child.exitCode === null) owner.child.kill("SIGKILL");
      await owner.done;
      x.close();
    }
  });

  await t.test("real live owner with powershell.exe unavailable", async () => {
    const x = fixture();
    const writer = new PlanRevisionWriter(x.planPath);
    writer.coordinate({ validate: validateTaskLedger, use() {} }); // cache only this process's exact start identity
    const owner = lockOwnerChild(x, 30_000);
    const lockPath = join(x.root, ".guardian", "plan-write.lock");
    const originalPath = process.env.PATH;
    try {
      await waitFor(owner.ready);
      const before = lockSnapshot(lockPath);
      process.env.PATH = x.root;
      await assert.rejects(() => x.runner.takeoverFromCommand(x.ctx), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
      assert.equal(owner.child.exitCode, null, "the exact owner remains live");
      assert.equal(sameLockSnapshot(lockPath, before), true, "lock bytes and filesystem identity remain exact");
      assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
      assert.equal(x.notifications.length, 0);
    } finally {
      process.env.PATH = originalPath;
      if (owner.child.exitCode === null) owner.child.kill("SIGKILL");
      await owner.done;
      x.close();
    }
  });
});

test("R1-H-13 forged same-process liveness intrinsics cannot authorize removal of a real live Windows lock", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows real-owner liveness regression");
  for (const patchTiming of ["before-import", "after-import"]) await t.test(patchTiming, async () => {
    const x = fixture();
    const owner = lockOwnerChild(x, 30_000);
    const competitorScript = join(x.root, `process-kill-forgery-${patchTiming}.mjs`);
    const lockPath = join(x.root, ".guardian", "plan-write.lock");
    try {
      await waitFor(owner.ready);
      const before = lockSnapshot(lockPath);
      writeFileSync(competitorScript, `
        import fs from "node:fs";
        import childProcess from "node:child_process";
        import util from "node:util";
        import { syncBuiltinESMExports } from "node:module";
        const originalKill = process.kill;
        const originalRead = fs.readFileSync;
        const originalDescriptor = Object.getOwnPropertyDescriptor;
        const forgedNative = new Proxy(process._kill.bind(process), { apply() { return -3; } });
        const patch = () => {
          process.kill = function forgedSelectiveEsrch(pid, signal) {
            if (pid === ${owner.child.pid} && signal === 0) throw Object.assign(new Error("forged ESRCH"), { code: "ESRCH" });
            return Reflect.apply(originalKill, process, [pid, signal]);
          };
          process._kill = new Proxy(forgedNative, { apply() { return -3; } });
          Function.prototype.toString = new Proxy(Function.prototype.toString, { apply() { return "function forged() { [native code] }"; } });
          Object.getOwnPropertyDescriptor = new Proxy(originalDescriptor, { apply(target, thisArg, args) { return Reflect.apply(target, thisArg, args); } });
          util.getSystemErrorName = () => "ESRCH";
          fs.readFileSync = (path, ...args) => { if (String(path).includes("/proc/${owner.child.pid}/")) throw Object.assign(new Error("forged missing proc"), { code: "ENOENT" }); return Reflect.apply(originalRead, fs, [path, ...args]); };
          childProcess.spawnSync = () => ({ status: 4, stdout: "AIOPAGO_PROCESS_UNKNOWN_V1", stderr: "" });
          childProcess.execFileSync = () => "";
          Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
          syncBuiltinESMExports();
        };
        if (${JSON.stringify(patchTiming)} === "before-import") patch();
        const { PlanRevisionWriter } = await import(${JSON.stringify(new URL("../src/plan-store.mjs", import.meta.url).href)});
        const { createPlanAdapter } = await import(${JSON.stringify(new URL("../src/intent-adapter.mjs", import.meta.url).href)});
        if (${JSON.stringify(patchTiming)} === "after-import") patch();
        let callbacks = 0; let code = null;
        try { new PlanRevisionWriter(${JSON.stringify(x.planPath)}).coordinate({ validate() {}, use() { callbacks += 1; } }); }
        catch (error) { code = error.code ?? null; }
        const adapter = createPlanAdapter(${JSON.stringify(x.planPath)});
        const observed = adapter.observe();
        const candidate = structuredClone(observed.plan);
        candidate.plan_revision_id = "PLAN-H13-FORGED";
        candidate.updated_at = "2026-08-24T00:09:00.000Z";
        candidate.objective = "forged competing plan";
        const proposal = adapter.propose({
          schema: "aiopago.plan-intent/0.1.0", proposal_id: "PPR-H13-FORGED", producer: "attack/h13",
          change_reason: "attempt lock theft", base: { task_id: observed.task_id, plan_revision_id: observed.plan_revision_id, content_digest: observed.content_digest }, candidate_plan: candidate,
        });
        let publicCode = null;
        try { adapter.apply(proposal); }
        catch (error) { publicCode = error.code ?? null; }
        process.stdout.write(JSON.stringify({ code, publicCode, callbacks }));
      `);
      const result = JSON.parse(execFileSync(process.execPath, [competitorScript], { encoding: "utf8" }));
      assert.equal(["PLAN_WRITE_LOCKED", "PLAN_LOCK_RECONCILIATION_REQUIRED"].includes(result.code), true, JSON.stringify(result));
      assert.equal(["PLAN_WRITE_LOCKED", "PLAN_LOCK_RECONCILIATION_REQUIRED"].includes(result.publicCode), true, JSON.stringify(result));
      assert.equal(result.callbacks, 0);
      assert.equal(owner.child.exitCode, null, "the original lock owner remains alive");
      assert.equal(sameLockSnapshot(lockPath, before), true, "the exact live lock remains byte- and identity-stable");
      assert.equal(existsSync(`${lockPath}.recovery`), false);
      assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
    } finally {
      if (owner.child.exitCode === null) owner.child.kill("SIGKILL");
      await owner.done;
      x.close();
    }
  });
});

test("R1-L-09 takeover coordination authority obeys one 10-second monotonic deadline", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows deadline boundary regression");
  for (const holdMs of [9_000, 9_800, 9_950, 11_000]) {
    await t.test(`holder ${holdMs}ms`, async () => {
      const x = fixture();
      const owner = lockOwnerChild(x, holdMs);
      try {
        await waitFor(owner.ready);
        const started = performance.now();
        let result = null;
        let error = null;
        try { result = await x.runner.takeoverFromCommand(x.ctx); }
        catch (caught) { error = caught; }
        const elapsed = performance.now() - started;
        t.diagnostic(`holder=${holdMs}ms completion=${elapsed.toFixed(1)}ms acquisition=${result?.coordination_acquired_ms?.toFixed(1) ?? "none"}ms outcome=${result ? "acquired" : error?.code}`);
        assert.ok(elapsed < 10_200, `coordination returned in ${elapsed}ms`);
        if (result) {
          assert.equal(result.state, "HUMAN_TAKEOVER");
          assert.equal(result.coordination_deadline_ms, 10_000);
          assert.ok(result.coordination_acquired_ms < result.coordination_deadline_ms,
            `authority acquired before the bounded deadline (${result.coordination_acquired_ms}ms)`);
        } else {
          assert.equal(error?.code, "HUMAN_TAKEOVER_COORDINATION_TIMEOUT");
          assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
          const eventsBefore = storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM journal WHERE event_type='LATCH_ENGAGED' AND data_json LIKE '%HUMAN_TAKEOVER%'").get().count;
          await new Promise((resolveWait) => setTimeout(resolveWait, 350));
          assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED", "no delayed retry claims the latch after timeout");
          assert.equal(storageDatabaseForInternalTest(x.storage).prepare("SELECT COUNT(*) AS count FROM journal WHERE event_type='LATCH_ENGAGED' AND data_json LIKE '%HUMAN_TAKEOVER%'").get().count, eventsBefore);
        }
      } finally {
        if (owner.child.exitCode === null) owner.child.kill("SIGKILL");
        await owner.done;
        x.close();
      }
    });
  }
});

test("R1-M-07 dead-owner lock requires explicit reconciliation and is never automatically removed", async () => {
  const x = fixture();
  const script = join(x.root, "dead-lock-child.mjs");
  const ready = join(x.root, "dead-lock-ready");
  writeFileSync(script, `
    import { writeFileSync } from "node:fs";
    import { PlanRevisionWriter } from ${JSON.stringify(new URL("../src/plan-store.mjs", import.meta.url).href)};
    import { validateTaskLedger } from ${JSON.stringify(new URL("../src/ledger.mjs", import.meta.url).href)};
    let held = false;
    const writer = new PlanRevisionWriter(${JSON.stringify(x.planPath)}, { testHooks: { afterLockAttestation() {
      if (held) return; held = true; writeFileSync(${JSON.stringify(ready)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    } } });
    writer.coordinate({ validate: validateTaskLedger, use() {} });
  `);
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  try {
    await waitFor(ready);
    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
    const lockPath = join(x.root, ".guardian", "plan-write.lock");
    assert.equal(existsSync(lockPath), true);
    const before = lockSnapshot(lockPath);
    await assert.rejects(() => x.runner.takeoverFromCommand(x.ctx), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
    assert.equal(sameLockSnapshot(lockPath, before), true, "dead-owner evidence never grants unlink authority");
    assert.equal(existsSync(`${lockPath}.recovery`), false);
    assert.equal(x.ledger.read().plan_revision_id, "PLAN-P1");
    assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); x.close(); }
});

test("R1-M-07 crash seams preserve any published stale lock for explicit reconciliation", async (t) => {
  for (const seam of ["after-metadata", "after-create", "after-attestation", "during-critical", "before-release"]) {
    await t.test(seam, async () => {
      const x = fixture();
      const script = join(x.root, `crash-${seam}.mjs`);
      const ready = join(x.root, `crash-${seam}-ready`);
      writeFileSync(script, `
        import { writeFileSync } from "node:fs";
        import { PlanRevisionWriter } from ${JSON.stringify(new URL("../src/plan-store.mjs", import.meta.url).href)};
        import { validateTaskLedger } from ${JSON.stringify(new URL("../src/ledger.mjs", import.meta.url).href)};
        const seam = ${JSON.stringify(seam)}; let blocked = false;
        const block = (name) => { if (!blocked && seam === name) { blocked = true; writeFileSync(${JSON.stringify(ready)}, name); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } };
        const writer = new PlanRevisionWriter(${JSON.stringify(x.planPath)}, { testHooks: {
          afterLockMetadataWrite() { block("after-metadata"); }, afterLockCreate() { block("after-create"); },
          afterLockAttestation() { block("after-attestation"); }, beforeLockRelease() { block("before-release"); },
        } });
        writer.coordinate({ validate: validateTaskLedger, use() { block("during-critical"); } });
      `);
      const child = spawn(process.execPath, [script], { stdio: "ignore" });
      try {
        await waitFor(ready);
        child.kill("SIGKILL");
        await new Promise((resolveExit) => child.once("exit", resolveExit));
        const lockPath = join(x.root, ".guardian", "plan-write.lock");
        if (seam === "after-metadata") {
          assert.equal((await x.runner.takeoverFromCommand(x.ctx)).state, "HUMAN_TAKEOVER", "an unpublished temp is not an existing coordination lock");
          assert.equal(existsSync(lockPath), false);
        } else {
          const before = lockSnapshot(lockPath);
          await assert.rejects(() => x.runner.takeoverFromCommand(x.ctx), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
          assert.equal(sameLockSnapshot(lockPath, before), true);
          assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
        }
        assert.equal(existsSync(join(x.root, ".guardian", "plan-write.lock.recovery")), false);
      } finally { if (child.exitCode === null) child.kill("SIGKILL"); x.close(); }
    });
  }
});

test("R1-M-07 malformed and unknown lock metadata fails closed without latch mutation", async (t) => {
  const attacks = [
    ["empty", () => ""],
    ["partial", () => "{\"schema\":"],
    ["unknown schema", (x) => lockMetadata(x.planPath, { pid: 999, identity: "unknown", schema: "aiopago.plan-write-lock/future" })],
    ["bad pid", (x) => lockMetadata(x.planPath, { pid: -1, identity: "bad" })],
    ["bad owner identity", (x) => lockMetadata(x.planPath, { pid: 999, identity: "" })],
    ["wrong plan path", (x) => lockMetadata(join(x.root, "OTHER_PLAN.md"), { pid: 999, identity: "old" })],
    ["unexpected field", (x) => {
      const value = JSON.parse(lockMetadata(x.planPath, { pid: 999, identity: "old" })); value.extra = true; return `${JSON.stringify(value)}\n`;
    }],
    ["bad timestamp", (x) => {
      const value = JSON.parse(lockMetadata(x.planPath, { pid: 999, identity: "old" })); value.created_at = "not-a-time"; return `${JSON.stringify(value)}\n`;
    }],
  ];
  for (const [name, attack] of attacks) await t.test(name, async () => {
    const x = fixture();
    const lockPath = join(x.root, ".guardian", "plan-write.lock");
    const bytes = attack(x);
    try {
      writeFileSync(lockPath, bytes);
      await assert.rejects(() => x.runner.takeoverFromCommand(x.ctx), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
      assert.equal(readFileSync(lockPath, "utf8"), bytes);
      assert.equal(x.storage.getLatch("TASK-TAKEOVER").state, "RELEASED");
    } finally { x.close(); }
  });
});

test("R1-M-07 process-start identity handles PID reuse and unknown proof without PID-only theft", () => {
  const x = fixture();
  const lockPath = join(x.root, ".guardian", "plan-write.lock");
  try {
    writeFileSync(lockPath, lockMetadata(x.planPath, { pid: process.ppid, identity: "old-process-start" }));
    const unknown = new PlanRevisionWriter(x.planPath, { processIdentityProbe: (pid) => pid === process.pid
      ? ({ status: "LIVE", identity: "current-process-start" })
      : ({ status: "UNKNOWN", identity: null }) });
    assert.throws(() => unknown.coordinate({ validate: validateTaskLedger, use() {} }), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
    assert.equal(existsSync(lockPath), true, "PID existence alone cannot authorize cleanup");

    writeFileSync(lockPath, lockMetadata(x.planPath, { pid: process.ppid, identity: "old-process-start" }));
    const reused = new PlanRevisionWriter(x.planPath, { processIdentityProbe(pid) {
      return pid === process.ppid ? { status: "LIVE", identity: "new-unrelated-process-start" } : { status: "LIVE", identity: "current-process-start" };
    } });
    assert.throws(() => reused.coordinate({ validate: validateTaskLedger, use: () => "forbidden" }), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
    assert.equal(existsSync(lockPath), true, "a live reused PID with different start identity remains conservative UNKNOWN");
  } finally { x.close(); }
});

test("R1-M-07 historical recovery marker and replacement lock both require manual reconciliation", () => {
  const x = fixture();
  const lockPath = join(x.root, ".guardian", "plan-write.lock");
  const recoveryPath = `${lockPath}.recovery`;
  try {
    const stale = lockMetadata(x.planPath, { pid: 999, identity: "dead-start", nonce: "b".repeat(64) });
    const replacement = lockMetadata(x.planPath, { pid: 1000, identity: "live-start", nonce: "c".repeat(64) });
    writeFileSync(lockPath, stale);
    linkSync(lockPath, recoveryPath);
    unlinkSync(lockPath);
    writeFileSync(lockPath, replacement);
    const writer = new PlanRevisionWriter(x.planPath, { processIdentityProbe(pid) {
      if (pid === 999) return { status: "DEAD", identity: null };
      if (pid === 1000) return { status: "LIVE", identity: "live-start" };
      return { status: "LIVE", identity: "current-start" };
    } });
    const markerBefore = lockSnapshot(recoveryPath);
    const lockBefore = lockSnapshot(lockPath);
    assert.throws(() => writer.coordinate({ validate: validateTaskLedger, use() {} }), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
    assert.equal(sameLockSnapshot(lockPath, lockBefore), true, "the replacement lock remains byte-exact");
    assert.equal(sameLockSnapshot(recoveryPath, markerBefore), true, "the historical recovery marker remains byte-exact");
  } finally { x.close(); }
});
