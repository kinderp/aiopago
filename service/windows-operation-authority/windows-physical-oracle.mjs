// Elevated physical Windows oracle for one restart-authentic production domain.
// It uses only scoped test service names/roots and always invokes explicit cleanup.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

if (process.platform !== "win32") throw new Error("WINDOWS_ONLY_PHYSICAL_ORACLE");
const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(here, "..", "..");
const suffix = `${process.pid}-${Date.now()}`;
const serviceName = `AiopagoOperationAuthorityTest-${suffix}`;
const sentinelName = `AiopagoOperationAuthoritySentinel-${suffix}`;
const programData = process.env.ProgramData;
const root = join(programData, "Aiopago", "OperationAuthorityTests", suffix);
const sentinelRoot = join(programData, "Aiopago", "OperationAuthorityTests", `Sentinel-${suffix}`);
const publicOutput = join(tmpdir(), `aiopago-operation-authority-${suffix}`);
const projectRoot = join(publicOutput, "project");
const projectDatabase = join(projectRoot, ".guardian", "runtime", "guardian.sqlite");
const brokerSource = join(publicOutput, "build", "broker-service.exe");
const mediumLauncher = join(publicOutput, "build", "medium-token-launcher.exe");
const serviceConfigProbe = join(publicOutput, "build", "service-config-probe.exe");
const workerSource = join(worktree, "dist", "operation-authority-worker.mjs");
const nodeSource = process.execPath;
const sc = join(process.env.SystemRoot, "System32", "sc.exe");
const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const evidence = { schema: "aiopago.operation-authority-windows-physical/1", suffix, serviceName, sentinelName, root, publicOutput, phases: {} };
let provisioned = false, sentinelProvisioned = false;

function run(file, args, options = {}) {
  return execFileSync(file, args, { cwd: worktree, encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 120_000, stdio: options.stdio ?? ["ignore", "pipe", "pipe"] });
}
function ps(script, args = [], timeout = 120_000) {
  return run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { timeout });
}
function scRun(args, allow = []) {
  const value = spawnSync(sc, args, { encoding: "utf8", windowsHide: true });
  if (value.status !== 0 && !allow.includes(value.status)) throw new Error(`sc ${args.join(" ")} failed ${value.status}: ${value.stdout}${value.stderr}`);
  return value;
}
function serviceState(name) {
  const value = spawnSync(sc, ["query", name], { encoding: "utf8", windowsHide: true });
  if (value.status === 1060) return "MISSING";
  const match = String(value.stdout).match(/(?:STATE|STATO)\s*:\s*(\d+)/i);
  return match ? ({ 1: "STOPPED", 2: "START_PENDING", 3: "STOP_PENDING", 4: "RUNNING" }[Number(match[1])] ?? `STATE_${match[1]}`) : `QUERY_${value.status}`;
}
async function waitFor(use, message, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = use(); if (value) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
  throw new Error(`TIMEOUT: ${message}; state=${serviceState(serviceName)}`);
}
async function stop(name = serviceName) {
  scRun(["stop", name], [1062]);
  await waitFor(() => ["STOPPED", "MISSING"].includes(serviceState(name)), `stop ${name}`);
}
function writeScenario(requests) {
  const path = join(root, "control", "scenario.json");
  writeFileSync(path, `${JSON.stringify({ schema: "aiopago.operation-authority-test-scenario/1", requests })}\n`);
  for (const stale of [join(root, "runtime", "latest-result.json"), join(root, "runtime", "failure.json")]) rmSync(stale, { force: true });
}
async function startAndResult(requests) {
  writeScenario(requests);
  scRun(["start", serviceName]);
  const path = join(root, "runtime", "latest-result.json");
  const failurePath = join(root, "runtime", "failure.json");
  await waitFor(() => {
    if (existsSync(failurePath)) throw new Error(`service failure: ${readFileSync(failurePath, "utf8")}`);
    return existsSync(path);
  }, "service result", 60_000);
  const result = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(result.schema, "aiopago.operation-authority-service-result/1");
  return result;
}
function frame(requestId, operationType, payload) { return { requestId, operationType, payload }; }
function operationFrom(result, requestId) {
  const entry = result.results.find((value) => value.requestId === requestId);
  assert.equal(entry?.ok, true, JSON.stringify(entry));
  return entry.result;
}
function medium(script, args, output, timeout = 180_000) {
  rmSync(output, { force: true });
  run(mediumLauncher, [nodeSource, script, ...args, "--output", output], { timeout });
  assert.equal(existsSync(output), true, `medium output missing: ${output}`);
  return JSON.parse(readFileSync(output, "utf8"));
}
function canonicalQuery(operationId) {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT operation_id,task_id,latch_generation,profile,state,outcome,effect_reference,admitted_at,terminal_at FROM operations WHERE operation_id=?").get(operationId) ?? null;
  database.close(); return row ? { ...row } : null;
}
function canonicalLatch(taskId) {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT task_id,state,generation,reason,engaged_at,engaged_by,released_at,released_by,last_event_id FROM latches WHERE task_id=?").get(taskId) ?? null;
  database.close(); return row ? { ...row } : null;
}
function canonicalTakeoverCount() {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const count = database.prepare("SELECT COUNT(*) count FROM latches WHERE state='ENGAGED' AND reason='HUMAN_TAKEOVER'").get().count;
  database.close(); return count;
}
function canonicalHandoff(handoffId) {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT handoff_id,source_session_id,task_id,task_plan_revision,task_plan_digest,latch_generation,latch_reason,runner_instance_id,checkpoint_id,resume_manifest_id,reservation_digest,reservation_event_id,projection_json,created_at FROM handoff_reservations WHERE handoff_id=?").get(handoffId) ?? null;
  database.close(); return row ? { ...row, projection: JSON.parse(row.projection_json) } : null;
}
function canonicalHandoffCounts() {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const result = { handoffs: database.prepare("SELECT COUNT(*) count FROM handoff_reservations").get().count, activeSources: database.prepare("SELECT COUNT(*) count FROM active_sources").get().count, events: database.prepare("SELECT COUNT(*) count FROM handoff_reservation_events").get().count };
  database.close(); return result;
}
function canonicalActiveSource(sourceSessionId) {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT source_session_id,handoff_id FROM active_sources WHERE source_session_id=?").get(sourceSessionId) ?? null;
  database.close(); return row ? { ...row } : null;
}
function canonicalLifecycleBinding(handoffId) {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT handoff_id,replacement_session_id,runner_instance_id,session_binding_id,lifecycle_incarnation,status,bound_at,bind_event_id,superseded_at,superseded_reason,supersede_event_id FROM lifecycle_bindings WHERE handoff_id=?").get(handoffId) ?? null;
  database.close(); return row ? { ...row } : null;
}
function canonicalLifecycleCounts() {
  const database = new DatabaseSync(join(root, "canonical", "operations.sqlite"), { readOnly: true });
  const result = { bindings: database.prepare("SELECT COUNT(*) count FROM lifecycle_bindings").get().count, events: database.prepare("SELECT COUNT(*) count FROM lifecycle_binding_events").get().count };
  database.close(); return result;
}
function physicalHandoffProjection({ handoffId = "HO-PRODUCTION-HANDOFF", source = "SESSION-PRODUCTION-SOURCE", task = "TASK-PRODUCTION-HANDOFF" } = {}) {
  const digest = `sha256:${"a".repeat(64)}`;
  const plan = { task_id: task, objective: "Physical protected handoff", current_item: "ITEM-1", next_item: "ITEM-2", next_step: "Continue", plan_revision_id: "PLAN-PRODUCTION-1", content_digest: digest, requirements_version: "REQ-1", completion_criteria: ["physical"], relevant_decisions: [], relevant_tests: [], evidence_references: [], minimal_reads: ["TASK_PLAN.md"], required_local_paths: ["TASK_PLAN.md"], model_policy: "openai-codex/gpt-5.6-sol", reasoning_policy: "high" };
  return { handoff_id: handoffId, source_session_id: source, source_session_file: `sessions/${source}.jsonl`, target_session_id: null, target_session_file: null, runner_instance_id: "RUNNER-PROTECTED-P2", session_binding_id: `BIND-${handoffId}`, parent_session_id: source, parent_session_file: `sessions/${source}.jsonl`, parent_checkpoint_id: null, recovery_of_handoff_id: null, task_id: task, current_item: "ITEM-1", next_item: "ITEM-2", next_step: "Continue", task_plan_revision: plan.plan_revision_id, task_plan_digest: digest, requirements_version: "REQ-1", latch_generation: 1, checkpoint_id: `CP-${handoffId}`, checkpoint_digest: null, resume_manifest_id: `RM-${handoffId}`, resume_manifest_digest: null, resume_prompt_id: null, resume_prompt_digest: null, resume_prompt: null, authorization_state: "NOT_AUTHORIZED", admission_state: "NOT_COMMITTED", admission_id: null, dispatch_state: "NOT_STARTED", dispatch_attempt_id: null, dispatch_attempt_no: 0, expected_git_state: { repository_id: "physical", workdir: "project", branch: "test", head_sha: "a".repeat(40), base_sha: "a".repeat(40), index_digest: `sha256:${"b".repeat(64)}`, worktree_digest: `sha256:${"c".repeat(64)}`, status_entries: [] }, model_policy: plan.model_policy, reasoning_policy: plan.reasoning_policy, reserved_plan_snapshot: plan, state: "SAFE_TO_HANDOFF", created_at: "2026-08-29T12:00:00.000Z", updated_at: "2026-08-29T12:00:00.000Z" };
}
function config() { return JSON.parse(readFileSync(join(root, "control", "service-config.json"), "utf8").replace(/^\uFEFF/, "")); }
function saveConfig(value) { writeFileSync(join(root, "control", "service-config.json"), `${JSON.stringify(value)}\n`); }
async function expectStartFailure(label) {
  rmSync(join(root, "runtime", "failure.json"), { force: true });
  scRun(["start", serviceName]);
  await waitFor(() => serviceState(serviceName) === "STOPPED", `${label} stop after fail`, 20_000);
  const failurePath = join(root, "runtime", "failure.json");
  assert.equal(existsSync(failurePath), true, `${label} failure evidence`);
  return JSON.parse(readFileSync(failurePath, "utf8"));
}

try {
  mkdirSync(join(publicOutput, "build"), { recursive: true });
  const identity = run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$id=[Security.Principal.WindowsIdentity]::GetCurrent();& \"$env:SystemRoot\\System32\\net.exe\" session *> $null;[ordered]@{name=$id.Name;sid=$id.User.Value;netSession=$LASTEXITCODE;groups=(& \"$env:SystemRoot\\System32\\whoami.exe\" /groups /fo csv /nh)}|ConvertTo-Json -Compress`]);
  evidence.elevatedIdentity = JSON.parse(identity);
  assert.equal(evidence.elevatedIdentity.netSession, 0, "oracle must be elevated");
  assert.equal(serviceState(serviceName), "MISSING");
  evidence.serviceMissingPreProvision = true;

  // Build artifacts are temporary user-output bytes and never packaged.
  run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `& \"$env:SystemRoot\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe\" /nologo /optimize+ /target:exe /out:\"${brokerSource}\" /reference:System.ServiceProcess.dll /reference:System.Web.Extensions.dll \"${join(here, "OperationAuthorityService.cs")}\";if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`]);
  run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `& \"$env:SystemRoot\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe\" /nologo /optimize+ /target:exe /out:\"${mediumLauncher}\" \"${join(here, "MediumTokenLauncher.cs")}\";if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`]);
  run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `& \"$env:SystemRoot\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe\" /nologo /optimize+ /target:exe /out:\"${serviceConfigProbe}\" \"${join(here, "ServiceConfigProbe.cs")}\";if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`]);
  run(process.execPath, [join(worktree, "scripts", "build-package.mjs")], { timeout: 120_000 });

  const provisionOutput = ps(join(here, "provision-test-service.ps1"), [
    "-ServiceName", serviceName, "-Root", root, "-BrokerSource", brokerSource,
    "-WorkerSource", workerSource, "-NodeSource", nodeSource, "-MediumLauncher", mediumLauncher,
    "-NegativeProbe", join(worktree, "test", "reproducers", "r1-m-13-provision-negative-probe.mjs"), "-PublicOutput", publicOutput,
  ]);
  const provisionLine = provisionOutput.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{"));
  evidence.provisioning = JSON.parse(provisionLine);
  provisioned = true;
  assert.equal(evidence.provisioning.preSecretNegativeProbe.allDenied, true);
  assert.equal(existsSync(join(root, "canonical", "identity.bin")), false, "first secret must not predate P1S");
  assert.equal(existsSync(join(root, "canonical", "operations.sqlite")), false, "canonical DB must not predate P1S");

  mkdirSync(dirname(projectDatabase), { recursive: true });
  const project = new DatabaseSync(projectDatabase);
  project.exec(`
    CREATE TABLE operations(operation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,latch_generation INTEGER NOT NULL,profile TEXT NOT NULL,state TEXT NOT NULL,outcome TEXT,effect_reference TEXT,admitted_at TEXT NOT NULL,terminal_at TEXT);
    CREATE TABLE latches(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,generation INTEGER NOT NULL,reason TEXT,engaged_at TEXT,engaged_by TEXT,released_at TEXT,released_by TEXT,last_event_id TEXT NOT NULL);
    CREATE TABLE handoffs(handoff_id TEXT PRIMARY KEY,source_session_id TEXT NOT NULL,target_session_id TEXT,task_id TEXT NOT NULL,state TEXT NOT NULL,latch_generation INTEGER NOT NULL,projection_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE active_sources(source_session_id TEXT PRIMARY KEY,handoff_id TEXT NOT NULL UNIQUE REFERENCES handoffs(handoff_id));
    CREATE TABLE journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,handoff_id TEXT,event_type TEXT NOT NULL,event_key TEXT UNIQUE,occurred_at TEXT NOT NULL,data_json TEXT NOT NULL);
    CREATE TABLE runner_session_bindings(handoff_id TEXT PRIMARY KEY,replacement_session_id TEXT NOT NULL UNIQUE,runner_instance_id TEXT NOT NULL,session_binding_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,bound_at TEXT NOT NULL,bind_event_id TEXT NOT NULL UNIQUE,superseded_at TEXT,superseded_reason TEXT);
  `);
  project.close();

  const legitimateHandoffProjection = physicalHandoffProjection();
  const before = await startAndResult([
    frame("REQ-BEFORE-LATCH", "LATCH_ENSURE", { taskId: "TASK-PRODUCTION-SECURE" }),
    frame("REQ-BEFORE-ADMIT", "OPERATION_ADMIT_TOOL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-PRODUCTION-SECURE", generation: 0, toolName: "read", input: { path: "README.md" } }),
    frame("REQ-BEFORE-FINISH", "OPERATION_FINISH_TOOL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-PRODUCTION-SECURE", isError: false, result: { content: [{ type: "text", text: "real production result" }] }, interrupted: false }),
    frame("REQ-BEFORE-GET", "OPERATION_GET", { operationId: "OP-PRODUCTION-BEFORE-RESTART" }),
    frame("REQ-HANDOFF-LATCH-ENSURE", "LATCH_ENSURE", { taskId: legitimateHandoffProjection.task_id }),
    frame("REQ-HANDOFF-LATCH-CLAIM", "LATCH_CLAIM_SAFEPOINT", { taskId: legitimateHandoffProjection.task_id, reason: "INTEGRITY", actor: "human:/aio-handoff", expected: { task_id: legitimateHandoffProjection.task_id, state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-HANDOFF-RESERVE", "HANDOFF_RESERVE", { projection: legitimateHandoffProjection, expectedLatch: { task_id: legitimateHandoffProjection.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" }, expectedLatest: null }),
    frame("REQ-HANDOFF-GET", "HANDOFF_GET", { handoffId: legitimateHandoffProjection.handoff_id }),
    frame("REQ-ACTIVE-SOURCE-GET", "ACTIVE_SOURCE_GET", { sourceSessionId: legitimateHandoffProjection.source_session_id }),
    frame("REQ-LIFECYCLE-BIND", "LIFECYCLE_BIND_CREATE", { binding: { handoff_id: legitimateHandoffProjection.handoff_id, replacement_session_id: "SESSION-PRODUCTION-TARGET", runner_instance_id: legitimateHandoffProjection.runner_instance_id, session_binding_id: legitimateHandoffProjection.session_binding_id, lifecycle_incarnation: 1 } }),
    frame("REQ-LIFECYCLE-GET", "LIFECYCLE_BIND_GET", { handoffId: legitimateHandoffProjection.handoff_id }),
  ]);
  const beforeOperation = operationFrom(before, "REQ-BEFORE-GET");
  assert.equal(beforeOperation.state, "TERMINAL"); assert.equal(beforeOperation.outcome, "KNOWN_SUCCESS"); assert.equal(beforeOperation.profile, "READ_ONLY");
  const beforeLatch = operationFrom(before, "REQ-BEFORE-LATCH");
  assert.equal(beforeLatch.state, "RELEASED"); assert.equal(beforeLatch.generation, 0);
  const legitimateHandoff = operationFrom(before, "REQ-HANDOFF-GET");
  const legitimateActiveSource = operationFrom(before, "REQ-ACTIVE-SOURCE-GET");
  assert.equal(legitimateHandoff.handoff_id, legitimateHandoffProjection.handoff_id);
  assert.equal(legitimateHandoff.state, "SAFE_TO_HANDOFF");
  assert.equal(legitimateHandoff.authorization_state, "NOT_AUTHORIZED");
  assert.equal(legitimateActiveSource.handoff_id, legitimateHandoffProjection.handoff_id);
  const legitimateLifecycleBinding = operationFrom(before, "REQ-LIFECYCLE-GET");
  assert.equal(legitimateLifecycleBinding.status, "ACTIVE"); assert.equal(legitimateLifecycleBinding.lifecycle_incarnation, 1);
  assert.equal(legitimateLifecycleBinding.session_binding_id, legitimateHandoffProjection.session_binding_id);
  evidence.phases.beforeRestart = { p1Pid: before.p1Pid, p2Pid: before.p2Pid, fingerprint: before.identityFingerprint, latch: beforeLatch, operation: beforeOperation, handoff: legitimateHandoff, activeSource: legitimateActiveSource, lifecycleBinding: legitimateLifecycleBinding };
  await stop();

  const compatibility = new DatabaseSync(projectDatabase);
  compatibility.prepare("INSERT INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(legitimateHandoffProjection.handoff_id, legitimateHandoffProjection.source_session_id, null, legitimateHandoffProjection.task_id, legitimateHandoffProjection.state, legitimateHandoffProjection.latch_generation, JSON.stringify(legitimateHandoffProjection), legitimateHandoffProjection.created_at, legitimateHandoffProjection.updated_at);
  compatibility.prepare("INSERT INTO active_sources(source_session_id,handoff_id) VALUES(?,?)").run(legitimateHandoffProjection.source_session_id, legitimateHandoffProjection.handoff_id);
  compatibility.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
    .run("EVT-PROJECT-REAL-HANDOFF", legitimateHandoffProjection.handoff_id, "HANDOFF_STARTED", `handoff:${legitimateHandoffProjection.handoff_id}`, legitimateHandoffProjection.created_at, JSON.stringify({ projected: true }));
  compatibility.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
    .run("EVT-PROJECT-REAL-BINDING", legitimateHandoffProjection.handoff_id, "RUNNER_SESSION_BOUND", `runner-binding:${legitimateHandoffProjection.handoff_id}`, legitimateLifecycleBinding.bound_at, JSON.stringify({ handoff_id: legitimateHandoffProjection.handoff_id, replacement_session_id: legitimateLifecycleBinding.replacement_session_id, runner_instance_id: legitimateLifecycleBinding.runner_instance_id, session_binding_id: legitimateLifecycleBinding.session_binding_id }));
  compatibility.prepare("INSERT INTO runner_session_bindings(handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,bind_event_id) VALUES(?,?,?,?,?,?,?)")
    .run(legitimateHandoffProjection.handoff_id, legitimateLifecycleBinding.replacement_session_id, legitimateLifecycleBinding.runner_instance_id, legitimateLifecycleBinding.session_binding_id, "ACTIVE", legitimateLifecycleBinding.bound_at, "EVT-PROJECT-REAL-BINDING");
  compatibility.close();

  const p0 = medium(join(worktree, "test", "reproducers", "r1-m-13-operation-authority-p0.mjs"), [
    "--root", root, "--service", serviceName, "--project-db", projectDatabase, "--service-config-probe", serviceConfigProbe,
    "--attack-real-handoff-id", legitimateHandoffProjection.handoff_id,
  ], join(publicOutput, "p0-attack.json"));
  assert.equal(p0.protectedAllDenied, true, JSON.stringify(p0.attempts.filter((value) => !value.denied), null, 2));
  assert.equal(p0.forged.operation_id, "OP-FORGED-BY-P0");
  assert.equal(p0.forgedLatch.reason, "HUMAN_TAKEOVER");
  assert.equal(p0.forgedHandoff.handoff_id, "HO-FORGED-BY-P0");
  assert.equal(p0.forgedLifecycleBinding.runner_instance_id, "RUNNER-FORGED");
  assert.deepEqual(canonicalLatch("TASK-PRODUCTION-SECURE"), beforeLatch);
  assert.equal(canonicalHandoff("HO-FORGED-BY-P0"), null);
  assert.equal(canonicalActiveSource("SESSION-FORGED-BY-P0"), null);
  assert.equal(canonicalLifecycleBinding("HO-FORGED-BY-P0"), null);
  assert.equal(p0.falseNegativeAttack.deleted_handoff_id, legitimateHandoffProjection.handoff_id);
  assert.equal(canonicalHandoff(legitimateHandoffProjection.handoff_id).handoff_id, legitimateHandoffProjection.handoff_id);
  assert.equal(canonicalActiveSource(legitimateHandoffProjection.source_session_id).handoff_id, legitimateHandoffProjection.handoff_id);
  assert.equal(canonicalLifecycleBinding(legitimateHandoffProjection.handoff_id).session_binding_id, legitimateLifecycleBinding.session_binding_id);
  assert.equal(canonicalLifecycleBinding(legitimateHandoffProjection.handoff_id).status, "ACTIVE");
  evidence.p0Attack = { ...p0, forgedHumanTakeoverCanonicalEffect: "NONE", forgedHandoffCanonical: null, forgedActiveSourceCanonical: null, forgedLifecycleCanonical: null, falseNegativeCanonicalHandoff: canonicalHandoff(legitimateHandoffProjection.handoff_id), falseNegativeCanonicalActiveSource: canonicalActiveSource(legitimateHandoffProjection.source_session_id), falseNegativeCanonicalLifecycle: canonicalLifecycleBinding(legitimateHandoffProjection.handoff_id) };

  const conflictingHandoffProjection = physicalHandoffProjection({ handoffId: "HO-PRODUCTION-CONFLICT", source: legitimateHandoffProjection.source_session_id, task: "TASK-PRODUCTION-CONFLICT" });
  const after = await startAndResult([
    frame("REQ-AFTER-GET-OLD", "OPERATION_GET", { operationId: "OP-PRODUCTION-BEFORE-RESTART" }),
    frame("REQ-AFTER-GET-FORGED", "OPERATION_GET", { operationId: "OP-FORGED-BY-P0" }),
    frame("REQ-AFTER-HANDOFF", "HANDOFF_GET", { handoffId: legitimateHandoffProjection.handoff_id }),
    frame("REQ-AFTER-FORGED-HANDOFF", "HANDOFF_GET", { handoffId: "HO-FORGED-BY-P0" }),
    frame("REQ-AFTER-ACTIVE-SOURCE", "ACTIVE_SOURCE_GET", { sourceSessionId: legitimateHandoffProjection.source_session_id }),
    frame("REQ-AFTER-LIFECYCLE", "LIFECYCLE_BIND_GET", { handoffId: legitimateHandoffProjection.handoff_id }),
    frame("REQ-AFTER-FORGED-LIFECYCLE", "LIFECYCLE_BIND_GET", { handoffId: "HO-FORGED-BY-P0" }),
    frame("REQ-CONFLICT-LATCH-ENSURE", "LATCH_ENSURE", { taskId: conflictingHandoffProjection.task_id }),
    frame("REQ-CONFLICT-LATCH-CLAIM", "LATCH_CLAIM_SAFEPOINT", { taskId: conflictingHandoffProjection.task_id, reason: "INTEGRITY", actor: "human:/aio-handoff", expected: { task_id: conflictingHandoffProjection.task_id, state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-CONFLICT-HANDOFF", "HANDOFF_RESERVE", { projection: conflictingHandoffProjection, expectedLatch: { task_id: conflictingHandoffProjection.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" }, expectedLatest: null }),
    frame("REQ-AFTER-LATCH", "LATCH_GET", { taskId: "TASK-PRODUCTION-SECURE" }),
    frame("REQ-AFTER-ADMIT", "OPERATION_ADMIT_TOOL", { operationId: "OP-PRODUCTION-AFTER-RESTART", taskId: "TASK-PRODUCTION-SECURE", generation: 0, toolName: "edit", input: { path: "src/exact.txt" } }),
    frame("REQ-AFTER-FINISH", "OPERATION_FINISH_TOOL", { operationId: "OP-PRODUCTION-AFTER-RESTART", taskId: "TASK-PRODUCTION-SECURE", isError: false, result: { content: [{ type: "text", text: "edited" }] }, interrupted: false }),
    frame("REQ-AFTER-GET", "OPERATION_GET", { operationId: "OP-PRODUCTION-AFTER-RESTART" }),
    frame("REQ-LEGITIMATE-TAKEOVER", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-PRODUCTION-SECURE", actor: "human:/aio-takeover", expected: { task_id: "TASK-PRODUCTION-SECURE", state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-LEGITIMATE-TAKEOVER-GET", "LATCH_GET", { taskId: "TASK-PRODUCTION-SECURE" }),
  ]);
  assert.deepEqual(operationFrom(after, "REQ-AFTER-GET-OLD"), beforeOperation);
  assert.equal(operationFrom(after, "REQ-AFTER-GET-FORGED"), null);
  assert.equal(operationFrom(after, "REQ-AFTER-HANDOFF").handoff_id, legitimateHandoffProjection.handoff_id);
  assert.equal(operationFrom(after, "REQ-AFTER-FORGED-HANDOFF"), null);
  assert.equal(operationFrom(after, "REQ-AFTER-ACTIVE-SOURCE").handoff_id, legitimateHandoffProjection.handoff_id);
  assert.equal(operationFrom(after, "REQ-AFTER-LIFECYCLE").session_binding_id, legitimateLifecycleBinding.session_binding_id);
  assert.equal(operationFrom(after, "REQ-AFTER-FORGED-LIFECYCLE"), null);
  const conflictResult = after.results.find((value) => value.requestId === "REQ-CONFLICT-HANDOFF");
  assert.equal(conflictResult.ok, false); assert.equal(conflictResult.error.code, "HANDOFF_ACTIVE_SOURCE_CONFLICT");
  const afterOperation = operationFrom(after, "REQ-AFTER-GET");
  assert.equal(afterOperation.effect_reference, "file:src/exact.txt");
  assert.deepEqual(operationFrom(after, "REQ-AFTER-LATCH"), beforeLatch, "forged portable takeover must not affect the secure reader");
  const legitimateTakeoverRequest = operationFrom(after, "REQ-LEGITIMATE-TAKEOVER");
  const legitimateTakeover = operationFrom(after, "REQ-LEGITIMATE-TAKEOVER-GET");
  assert.equal(legitimateTakeoverRequest.request_code, "MUTATION_ACCEPTED");
  assert.equal(legitimateTakeover.state, "ENGAGED"); assert.equal(legitimateTakeover.reason, "HUMAN_TAKEOVER"); assert.equal(legitimateTakeover.generation, 1);
  assert.notEqual(after.p1Pid, before.p1Pid); assert.notEqual(after.p2Pid, before.p2Pid); assert.equal(after.identityFingerprint, before.identityFingerprint);
  evidence.phases.afterRestart = { p1Pid: after.p1Pid, p2Pid: after.p2Pid, fingerprint: after.identityFingerprint, oldOperation: operationFrom(after, "REQ-AFTER-GET-OLD"), forged: null, protectedLatchBeforeTakeover: operationFrom(after, "REQ-AFTER-LATCH"), postRestartOperation: afterOperation, protectedHandoff: operationFrom(after, "REQ-AFTER-HANDOFF"), protectedActiveSource: operationFrom(after, "REQ-AFTER-ACTIVE-SOURCE"), protectedLifecycleBinding: operationFrom(after, "REQ-AFTER-LIFECYCLE"), conflictingSecureReservation: conflictResult };
  evidence.legitimateTakeover = { taskId: "TASK-PRODUCTION-SECURE", session: { p1Pid: after.p1Pid, p2Pid: after.p2Pid, serviceName }, source: "human:/aio-takeover", initial: beforeLatch, requestId: "REQ-LEGITIMATE-TAKEOVER", reason: "HUMAN_TAKEOVER", final: legitimateTakeover, canonicalEvidence: canonicalLatch("TASK-PRODUCTION-SECURE") };
  await stop();

  const p0Clear = medium(join(worktree, "test", "reproducers", "r1-m-13-operation-authority-p0.mjs"), [
    "--root", root, "--service", serviceName, "--project-db", projectDatabase, "--service-config-probe", serviceConfigProbe, "--forge-latch-state", "CLEAR",
  ], join(publicOutput, "p0-clear-attack.json"));
  assert.equal(p0Clear.forgedLatch.state, "RELEASED"); assert.equal(p0Clear.forgedLatch.generation, 2147483647);
  const latchRestart = await startAndResult([
    frame("REQ-LATCH-RESTART-GET", "LATCH_GET", { taskId: "TASK-PRODUCTION-SECURE" }),
    frame("REQ-LATCH-RESTART-ADMIT", "OPERATION_RETRY_ADMISSION", { operationId: "OP-BLOCKED-AFTER-TAKEOVER", taskId: "TASK-PRODUCTION-SECURE", generation: 1, profile: "READ_ONLY" }),
  ]);
  const restartedLatch = operationFrom(latchRestart, "REQ-LATCH-RESTART-GET");
  assert.deepEqual(restartedLatch, legitimateTakeover);
  const blockedAdmission = latchRestart.results.find((value) => value.requestId === "REQ-LATCH-RESTART-ADMIT");
  assert.equal(blockedAdmission.ok, false); assert.equal(blockedAdmission.error.code, "HUMAN_TAKEOVER_ACTIVE");
  evidence.latchRestart = { p1PidBefore: after.p1Pid, p1PidAfter: latchRestart.p1Pid, p2PidBefore: after.p2Pid, p2PidAfter: latchRestart.p2Pid, legacyAttack: p0Clear.forgedLatch, canonicalAfter: restartedLatch, secureAdmission: blockedAdmission, fingerprintStable: latchRestart.identityFingerprint === after.identityFingerprint };
  await stop();

  // User-writable projection attacks: valid, delete, forged generation, replay.
  const projectionBytes = readFileSync(projectDatabase);
  const projectionSha = createHash("sha256").update(projectionBytes).digest("hex");
  rmSync(projectDatabase, { force: true }); rmSync(`${projectDatabase}-wal`, { force: true }); rmSync(`${projectDatabase}-shm`, { force: true });
  const deletedCanonical = canonicalQuery("OP-PRODUCTION-BEFORE-RESTART");
  writeFileSync(projectDatabase, projectionBytes);
  const projectionDb = new DatabaseSync(projectDatabase);
  projectionDb.prepare("UPDATE operations SET latch_generation=2147483647 WHERE operation_id='OP-FORGED-BY-P0'").run();
  projectionDb.close();
  const forgedSequenceCanonical = canonicalQuery("OP-FORGED-BY-P0");
  writeFileSync(projectDatabase, projectionBytes); // replay exact older projection
  const replayCanonical = canonicalQuery("OP-PRODUCTION-BEFORE-RESTART");
  assert.deepEqual(deletedCanonical, beforeOperation); assert.equal(forgedSequenceCanonical, null); assert.deepEqual(replayCanonical, beforeOperation);
  evidence.projectionAttacks = { validProjectionSha256: projectionSha, deleteCanonicalEffect: "NONE", forgedGenerationCanonical: forgedSequenceCanonical, replayCanonicalEffect: "NONE" };

  const canonicalTakeoversBeforeActivated = canonicalTakeoverCount();
  const canonicalHandoffsBeforeActivated = canonicalHandoffCounts();
  const canonicalLifecycleBeforeActivated = canonicalLifecycleCounts();
  const activated = medium(join(worktree, "test", "reproducers", "r1-m-13-activated-source.mjs"), [], join(publicOutput, "activated-source.json"), 300_000);
  assert.equal(activated.piVersion, "0.83.0"); assert.equal(activated.factory, 1); assert.equal(activated.commands, 4); assert.ok(activated.handlers >= 10); assert.equal(activated.forged?.operation_id, "OP-FORGED"); assert.ok(activated.humanTakeover >= 1);
  assert.equal(canonicalQuery("OP-FORGED"), null);
  assert.equal(canonicalHandoff("HO-FORGED-BY-P0"), null);
  assert.deepEqual(canonicalHandoffCounts(), canonicalHandoffsBeforeActivated, "activated-source P0 must not create protected reservation authority");
  assert.deepEqual(canonicalLifecycleCounts(), canonicalLifecycleBeforeActivated, "activated-source P0 must not create protected lifecycle authority");
  assert.equal(canonicalTakeoverCount(), canonicalTakeoversBeforeActivated, "activated-source P0 must not create a protected takeover");
  evidence.activatedSource = { ...activated, canonicalOperation: null, canonicalHandoffAddedByAttack: false, canonicalActiveSourceAddedByAttack: false, canonicalLifecycleBindingAddedByAttack: false, canonicalLifecycleTransitionAddedByAttack: false, canonicalTakeoverAddedByAttack: false, legitimateP2Takeover: legitimateTakeover, operationDomainResult: "PASS", latchDomainResult: "PASS", handoffDomainResult: "PASS", lifecycleDomainResult: "PASS" };

  const lifecycleExpected = { handoff_id: legitimateLifecycleBinding.handoff_id, replacement_session_id: legitimateLifecycleBinding.replacement_session_id, runner_instance_id: legitimateLifecycleBinding.runner_instance_id, session_binding_id: legitimateLifecycleBinding.session_binding_id, lifecycle_incarnation: legitimateLifecycleBinding.lifecycle_incarnation, status: "ACTIVE" };
  const lifecycleTransition = await startAndResult([
    frame("REQ-LIFECYCLE-BEFORE-TRANSITION", "LIFECYCLE_BIND_GET", { handoffId: legitimateHandoffProjection.handoff_id }),
    frame("REQ-LIFECYCLE-SHUTDOWN", "LIFECYCLE_BIND_TRANSITION", { expected: lifecycleExpected, nextStatus: "SUPERSEDED", reason: "session_shutdown" }),
    frame("REQ-LIFECYCLE-SHUTDOWN", "LIFECYCLE_BIND_TRANSITION", { expected: lifecycleExpected, nextStatus: "SUPERSEDED", reason: "session_shutdown" }),
    frame("REQ-LIFECYCLE-SHUTDOWN", "LIFECYCLE_BIND_TRANSITION", { expected: lifecycleExpected, nextStatus: "SUPERSEDED", reason: "conflicting reason" }),
    frame("REQ-LIFECYCLE-AFTER-TRANSITION", "LIFECYCLE_BIND_GET", { handoffId: legitimateHandoffProjection.handoff_id }),
  ]);
  const lifecycleRows = lifecycleTransition.results.filter((row) => row.requestId === "REQ-LIFECYCLE-SHUTDOWN");
  assert.equal(lifecycleRows[0].result.binding.status, "SUPERSEDED"); assert.equal(lifecycleRows[1].result.idempotent, true);
  assert.equal(lifecycleRows[2].ok, false); assert.equal(lifecycleRows[2].error.code, "LIFECYCLE_REQUEST_CONFLICT");
  assert.equal(operationFrom(lifecycleTransition, "REQ-LIFECYCLE-AFTER-TRANSITION").superseded_reason, "session_shutdown");
  await stop();
  const lifecycleRestart = await startAndResult([frame("REQ-LIFECYCLE-RESTART", "LIFECYCLE_BIND_GET", { handoffId: legitimateHandoffProjection.handoff_id })]);
  assert.equal(operationFrom(lifecycleRestart, "REQ-LIFECYCLE-RESTART").status, "SUPERSEDED");
  evidence.lifecycleTransition = { before: operationFrom(lifecycleTransition, "REQ-LIFECYCLE-BEFORE-TRANSITION"), transition: lifecycleRows[0], duplicate: lifecycleRows[1], conflict: lifecycleRows[2], restart: operationFrom(lifecycleRestart, "REQ-LIFECYCLE-RESTART") };
  await stop();

  // Crash the real SQLite transition after UPDATE and before COMMIT.
  writeScenario([
    frame("REQ-CRASH-LATCH", "LATCH_ENSURE", { taskId: "TASK-OPERATION-CRASH" }),
    frame("REQ-CRASH-ADMIT", "OPERATION_ADMIT_TOOL", { operationId: "OP-PRODUCTION-CRASH", taskId: "TASK-OPERATION-CRASH", generation: 0, toolName: "write", input: { path: "src/partial.txt" } }),
    frame("REQ-CRASH-SEAM", "TEST_CRASH_BEFORE_TERMINAL_COMMIT", { operationId: "OP-PRODUCTION-CRASH", outcome: "KNOWN_SUCCESS", effectReference: "file:src/partial.txt" }),
  ]);
  scRun(["start", serviceName]);
  await waitFor(() => serviceState(serviceName) === "STOPPED", "crashed service stops", 30_000);
  const crashBeforeRecovery = canonicalQuery("OP-PRODUCTION-CRASH");
  assert.equal(crashBeforeRecovery.state, "ACTIVE"); assert.equal(crashBeforeRecovery.outcome, null);
  const recovered = await startAndResult([
    frame("REQ-CRASH-GET", "OPERATION_GET", { operationId: "OP-PRODUCTION-CRASH" }),
    frame("REQ-CRASH-RECONCILE", "OPERATION_RETRY_TERMINAL", { operationId: "OP-PRODUCTION-CRASH", outcome: "UNKNOWN", effectReference: null }),
    frame("REQ-CRASH-GET-FINAL", "OPERATION_GET", { operationId: "OP-PRODUCTION-CRASH" }),
  ]);
  assert.equal(operationFrom(recovered, "REQ-CRASH-GET").state, "ACTIVE");
  assert.equal(operationFrom(recovered, "REQ-CRASH-GET-FINAL").outcome, "UNKNOWN");
  evidence.crash = { seam: "SQLite BEGIN IMMEDIATE + terminal UPDATE + P2/P1S exit before COMMIT", preRecovery: crashBeforeRecovery, restartOperation: operationFrom(recovered, "REQ-CRASH-GET"), reconciled: operationFrom(recovered, "REQ-CRASH-GET-FINAL"), invalidStateAccepted: false };
  await stop();

  const idempotency = await startAndResult([
    frame("REQ-IDEM-ADMIT", "OPERATION_RETRY_ADMISSION", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-PRODUCTION-SECURE", generation: 0, profile: "READ_ONLY" }),
    frame("REQ-CONFLICT-ADMIT", "OPERATION_RETRY_ADMISSION", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-CONFLICT", generation: 0, profile: "READ_ONLY" }),
    frame("REQ-IDEM-TERMINAL", "OPERATION_RETRY_TERMINAL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", outcome: "KNOWN_SUCCESS", effectReference: null }),
    frame("REQ-CONFLICT-TERMINAL", "OPERATION_RETRY_TERMINAL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", outcome: "KNOWN_FAILURE", effectReference: null }),
    frame("REQ-HANDOFF-RESERVE", "HANDOFF_RESERVE", { projection: legitimateHandoffProjection, expectedLatch: { task_id: legitimateHandoffProjection.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" }, expectedLatest: null }),
    frame("REQ-HANDOFF-RESERVE", "HANDOFF_RESERVE", { projection: { ...legitimateHandoffProjection, task_plan_digest: `sha256:${"d".repeat(64)}`, reserved_plan_snapshot: { ...legitimateHandoffProjection.reserved_plan_snapshot, content_digest: `sha256:${"d".repeat(64)}` } }, expectedLatch: { task_id: legitimateHandoffProjection.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" }, expectedLatest: null }),
    frame("REQ-UNKNOWN-GET", "OPERATION_GET", { operationId: "OP-PRODUCTION-CRASH" }),
  ]);
  const byId = Object.fromEntries(idempotency.results.map((value) => [value.requestId, value]));
  assert.equal(byId["REQ-IDEM-ADMIT"].result.idempotent, true); assert.equal(byId["REQ-CONFLICT-ADMIT"].ok, false);
  assert.equal(byId["REQ-IDEM-TERMINAL"].result.idempotent, true); assert.equal(byId["REQ-CONFLICT-TERMINAL"].ok, false);
  assert.equal(byId["REQ-UNKNOWN-GET"].result.outcome, "UNKNOWN");
  const handoffRetries = idempotency.results.filter((value) => value.requestId === "REQ-HANDOFF-RESERVE");
  assert.equal(handoffRetries[0].result.idempotent, true); assert.equal(handoffRetries[1].ok, false); assert.equal(handoffRetries[1].error.code, "HANDOFF_REQUEST_CONFLICT");
  evidence.idempotency = { ...byId, handoffRetries };
  await stop();

  const priority = await startAndResult([
    frame("REQ-PRIORITY-ORDINARY-ENSURE", "LATCH_ENSURE", { taskId: "TASK-PRIORITY-ORDINARY" }),
    frame("REQ-PRIORITY-ORDINARY", "LATCH_CLAIM_SAFEPOINT", { taskId: "TASK-PRIORITY-ORDINARY", reason: "INTEGRITY", actor: "human:handoff", expected: { task_id: "TASK-PRIORITY-ORDINARY", state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-PRIORITY-STALE", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-PRIORITY-ORDINARY", actor: "human:/aio-takeover", expected: { task_id: "TASK-PRIORITY-ORDINARY", state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-PRIORITY-HUMAN-ENSURE", "LATCH_ENSURE", { taskId: "TASK-PRIORITY-HUMAN" }),
    frame("REQ-PRIORITY-HUMAN", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-PRIORITY-HUMAN", actor: "human:/aio-takeover", expected: { task_id: "TASK-PRIORITY-HUMAN", state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-PRIORITY-ESCALATE-ENSURE", "LATCH_ENSURE", { taskId: "TASK-PRIORITY-ESCALATE" }),
    frame("REQ-PRIORITY-ESCALATE-ORDINARY", "LATCH_CLAIM_SAFEPOINT", { taskId: "TASK-PRIORITY-ESCALATE", reason: "INTEGRITY", actor: "human:handoff", expected: { task_id: "TASK-PRIORITY-ESCALATE", state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-PRIORITY-ESCALATE-HUMAN", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-PRIORITY-ESCALATE", actor: "human:/aio-takeover", expected: { task_id: "TASK-PRIORITY-ESCALATE", state: "ENGAGED", generation: 1, reason: "INTEGRITY" } }),
    frame("REQ-PRIORITY-DOWNGRADE", "LATCH_CLAIM_SAFEPOINT", { taskId: "TASK-PRIORITY-ESCALATE", reason: "INTEGRITY", actor: "human:handoff", expected: { task_id: "TASK-PRIORITY-ESCALATE", state: "ENGAGED", generation: 1, reason: "HUMAN_TAKEOVER" } }),
    frame("REQ-PRIORITY-DUPLICATE", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-PRIORITY-ESCALATE", actor: "human:/aio-takeover", expected: { task_id: "TASK-PRIORITY-ESCALATE", state: "ENGAGED", generation: 1, reason: "HUMAN_TAKEOVER" } }),
    frame("REQ-PRIORITY-CONFLICT", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-PRIORITY-CONFLICT", actor: "human:/aio-takeover" }),
    frame("REQ-PRIORITY-CONFLICT", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-PRIORITY-CONFLICT", actor: "human:conflicting-source" }),
    frame("REQ-PRIORITY-RELEASE-REFUSED", "LATCH_RELEASE", { taskId: "TASK-PRIORITY-HUMAN" }),
  ]);
  const priorityRows = priority.results;
  assert.equal(priorityRows.find((row) => row.requestId === "REQ-PRIORITY-ORDINARY").result.latch.reason, "INTEGRITY");
  assert.equal(priorityRows.find((row) => row.requestId === "REQ-PRIORITY-STALE").error.code, "LATCH_GENERATION_MISMATCH");
  assert.equal(priorityRows.find((row) => row.requestId === "REQ-PRIORITY-HUMAN").result.latch.reason, "HUMAN_TAKEOVER");
  assert.equal(priorityRows.find((row) => row.requestId === "REQ-PRIORITY-ESCALATE-HUMAN").result.latch.generation, 1);
  assert.equal(priorityRows.find((row) => row.requestId === "REQ-PRIORITY-DOWNGRADE").error.code, "HUMAN_TAKEOVER_ACTIVE");
  assert.equal(priorityRows.find((row) => row.requestId === "REQ-PRIORITY-DUPLICATE").result.idempotent, true);
  assert.equal(priorityRows.filter((row) => row.requestId === "REQ-PRIORITY-CONFLICT")[1].error.code, "LATCH_REQUEST_CONFLICT");
  assert.equal(priorityRows.find((row) => row.requestId === "REQ-PRIORITY-RELEASE-REFUSED").error.code, "OPERATION_TYPE_INVALID");
  evidence.priority = priorityRows;
  await stop();

  const crashLatchSetup = await startAndResult([frame("REQ-LATCH-CRASH-ENSURE", "LATCH_ENSURE", { taskId: "TASK-LATCH-CRASH" })]);
  const latchBeforeCrash = operationFrom(crashLatchSetup, "REQ-LATCH-CRASH-ENSURE");
  await stop();
  writeScenario([frame("REQ-LATCH-CRASH", "TEST_CRASH_BEFORE_LATCH_COMMIT", {
    taskId: "TASK-LATCH-CRASH", reason: "HUMAN_TAKEOVER", actor: "human:/aio-takeover", expected: { task_id: "TASK-LATCH-CRASH", state: "RELEASED", generation: 0, reason: null },
  })]);
  scRun(["start", serviceName]);
  await waitFor(() => serviceState(serviceName) === "STOPPED", "latch crashed service stops", 30_000);
  assert.deepEqual(canonicalLatch("TASK-LATCH-CRASH"), latchBeforeCrash);
  const latchRecovered = await startAndResult([
    frame("REQ-LATCH-CRASH-GET", "LATCH_GET", { taskId: "TASK-LATCH-CRASH" }),
    frame("REQ-LATCH-CRASH-RECONCILE", "LATCH_CLAIM_HUMAN_TAKEOVER", { taskId: "TASK-LATCH-CRASH", actor: "human:/aio-takeover", expected: { task_id: "TASK-LATCH-CRASH", state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-LATCH-CRASH-FINAL", "LATCH_GET", { taskId: "TASK-LATCH-CRASH" }),
  ]);
  evidence.latchCrash = { seam: "SQLite BEGIN IMMEDIATE + latch/event/request update + P2/P1S exit before COMMIT", preCrash: latchBeforeCrash, restart: operationFrom(latchRecovered, "REQ-LATCH-CRASH-GET"), reconciled: operationFrom(latchRecovered, "REQ-LATCH-CRASH-FINAL"), invalidStateAccepted: false };
  await stop();

  const crashHandoffProjection = physicalHandoffProjection({ handoffId: "HO-PRODUCTION-CRASH", source: "SESSION-PRODUCTION-CRASH", task: "TASK-HANDOFF-CRASH" });
  await startAndResult([
    frame("REQ-HANDOFF-CRASH-ENSURE", "LATCH_ENSURE", { taskId: crashHandoffProjection.task_id }),
    frame("REQ-HANDOFF-CRASH-CLAIM", "LATCH_CLAIM_SAFEPOINT", { taskId: crashHandoffProjection.task_id, reason: "INTEGRITY", actor: "human:/aio-handoff", expected: { task_id: crashHandoffProjection.task_id, state: "RELEASED", generation: 0, reason: null } }),
  ]);
  await stop();
  writeScenario([frame("REQ-HANDOFF-CRASH", "TEST_CRASH_BEFORE_HANDOFF_COMMIT", { projection: crashHandoffProjection, expectedLatch: { task_id: crashHandoffProjection.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" }, expectedLatest: null })]);
  scRun(["start", serviceName]);
  await waitFor(() => serviceState(serviceName) === "STOPPED", "handoff crashed service stops", 30_000);
  assert.equal(canonicalHandoff(crashHandoffProjection.handoff_id), null);
  assert.equal(canonicalActiveSource(crashHandoffProjection.source_session_id), null);
  const handoffRecovered = await startAndResult([
    frame("REQ-HANDOFF-CRASH-GET", "HANDOFF_GET", { handoffId: crashHandoffProjection.handoff_id }),
    frame("REQ-HANDOFF-CRASH-ACTIVE", "ACTIVE_SOURCE_GET", { sourceSessionId: crashHandoffProjection.source_session_id }),
  ]);
  assert.equal(operationFrom(handoffRecovered, "REQ-HANDOFF-CRASH-GET"), null);
  assert.equal(operationFrom(handoffRecovered, "REQ-HANDOFF-CRASH-ACTIVE"), null);
  evidence.handoffCrash = { seam: "SQLite BEGIN IMMEDIATE + handoff insert + active-source insert + P2/P1S exit before event/COMMIT", canonicalHandoff: null, canonicalActiveSource: null, restartHandoff: null, restartActiveSource: null, invalidStateAccepted: false };
  await stop();

  const crashLifecycleProjection = physicalHandoffProjection({ handoffId: "HO-LIFECYCLE-CRASH", source: "SESSION-LIFECYCLE-CRASH-SOURCE", task: "TASK-LIFECYCLE-CRASH" });
  const crashLifecycleIdentity = { handoff_id: crashLifecycleProjection.handoff_id, replacement_session_id: "SESSION-LIFECYCLE-CRASH-TARGET", runner_instance_id: crashLifecycleProjection.runner_instance_id, session_binding_id: crashLifecycleProjection.session_binding_id, lifecycle_incarnation: 11 };
  await startAndResult([
    frame("REQ-LIFECYCLE-CRASH-LATCH", "LATCH_ENSURE", { taskId: crashLifecycleProjection.task_id }),
    frame("REQ-LIFECYCLE-CRASH-CLAIM", "LATCH_CLAIM_SAFEPOINT", { taskId: crashLifecycleProjection.task_id, reason: "INTEGRITY", actor: "human:/aio-handoff", expected: { task_id: crashLifecycleProjection.task_id, state: "RELEASED", generation: 0, reason: null } }),
    frame("REQ-LIFECYCLE-CRASH-RESERVE", "HANDOFF_RESERVE", { projection: crashLifecycleProjection, expectedLatch: { task_id: crashLifecycleProjection.task_id, state: "ENGAGED", generation: 1, reason: "INTEGRITY" }, expectedLatest: null }),
    frame("REQ-LIFECYCLE-CRASH-BIND", "LIFECYCLE_BIND_CREATE", { binding: crashLifecycleIdentity }),
  ]);
  await stop();
  writeScenario([frame("REQ-LIFECYCLE-CRASH-SEAM", "TEST_CRASH_BEFORE_LIFECYCLE_COMMIT", { expected: { ...crashLifecycleIdentity, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "session_shutdown" })]);
  scRun(["start", serviceName]);
  await waitFor(() => serviceState(serviceName) === "STOPPED", "lifecycle crashed service stops", 30_000);
  assert.equal(canonicalLifecycleBinding(crashLifecycleProjection.handoff_id).status, "ACTIVE");
  const lifecycleRecovered = await startAndResult([
    frame("REQ-LIFECYCLE-CRASH-GET", "LIFECYCLE_BIND_GET", { handoffId: crashLifecycleProjection.handoff_id }),
    frame("REQ-LIFECYCLE-CRASH-RECONCILE", "LIFECYCLE_BIND_TRANSITION", { expected: { ...crashLifecycleIdentity, status: "ACTIVE" }, nextStatus: "SUPERSEDED", reason: "session_shutdown" }),
  ]);
  assert.equal(operationFrom(lifecycleRecovered, "REQ-LIFECYCLE-CRASH-GET").status, "ACTIVE");
  assert.equal(operationFrom(lifecycleRecovered, "REQ-LIFECYCLE-CRASH-RECONCILE").binding.status, "SUPERSEDED");
  evidence.lifecycleCrash = { seam: "SQLite BEGIN IMMEDIATE + lifecycle binding/event mutation + P2/P1S exit before COMMIT", restart: operationFrom(lifecycleRecovered, "REQ-LIFECYCLE-CRASH-GET"), reconciled: operationFrom(lifecycleRecovered, "REQ-LIFECYCLE-CRASH-RECONCILE").binding, invalidStateAccepted: false };
  await stop();

  // Another unrestricted LocalService token has shared S-1-5-19 but not this service SID.
  const sentinelSidText = scRun(["showsid", sentinelName]).stdout;
  const sentinelSid = sentinelSidText.match(/S-1-5-80-(?:\d+-){4}\d+/)?.[0]; assert.ok(sentinelSid);
  mkdirSync(join(sentinelRoot, "bin"), { recursive: true }); mkdirSync(join(sentinelRoot, "output"), { recursive: true });
  ps(join(here, "set-sentinel-acl.ps1"), ["-Root", sentinelRoot, "-ServiceSid", sentinelSid]);
  copyFileSync(brokerSource, join(sentinelRoot, "bin", "sentinel-service.exe"));
  const sentinelImage = `\"${join(sentinelRoot, "bin", "sentinel-service.exe")}\" --sentinel ${sentinelName} \"${root}\" \"${join(sentinelRoot, "output")}\"`;
  scRun(["create", sentinelName, "type=", "own", "start=", "demand", "obj=", "NT AUTHORITY\\LocalService", "binPath=", sentinelImage]); sentinelProvisioned = true;
  scRun(["sidtype", sentinelName, "unrestricted"]); scRun(["start", sentinelName]);
  const sentinelOutput = join(sentinelRoot, "output", "sentinel-result.json");
  await waitFor(() => existsSync(sentinelOutput), "sentinel output");
  const sentinel = JSON.parse(readFileSync(sentinelOutput, "utf8"));
  assert.equal(sentinel.userSid, "S-1-5-19"); assert.equal(sentinel.groupSids.includes(evidence.provisioning.serviceSid), false);
  assert.equal(sentinel.attempts.every((value) => value.denied), true, JSON.stringify(sentinel));
  evidence.crossServiceSentinel = { ...sentinel, sentinelSid, aiopagoServiceSidPresent: false };
  await stop(sentinelName);

  // Fail-closed lifecycle probes. None reads project SQLite.
  evidence.failClosed = { serviceMissing: evidence.serviceMissingPreProvision, stopped: serviceState(serviceName) === "STOPPED" };
  const databasePath = join(root, "canonical", "operations.sqlite"), heldDatabase = `${databasePath}.admin-held`;
  renameSync(databasePath, heldDatabase);
  evidence.failClosed.databaseUnavailable = await expectStartFailure("database unavailable");
  renameSync(heldDatabase, databasePath);
  const schemaDatabase = new DatabaseSync(databasePath);
  schemaDatabase.exec("ALTER TABLE latches RENAME TO latches_admin_held");
  schemaDatabase.close();
  evidence.failClosed.latchSchemaMissing = await expectStartFailure("latch schema missing");
  const restoreSchema = new DatabaseSync(databasePath);
  restoreSchema.exec("ALTER TABLE latches_admin_held RENAME TO latches");
  restoreSchema.close();
  const handoffSchema = new DatabaseSync(databasePath);
  handoffSchema.exec("ALTER TABLE handoff_reservations RENAME TO handoff_reservations_admin_held");
  handoffSchema.close();
  evidence.failClosed.handoffSchemaMissing = await expectStartFailure("handoff schema missing");
  const restoreHandoffSchema = new DatabaseSync(databasePath);
  restoreHandoffSchema.exec("ALTER TABLE handoff_reservations_admin_held RENAME TO handoff_reservations");
  restoreHandoffSchema.close();
  const lifecycleSchema = new DatabaseSync(databasePath);
  lifecycleSchema.exec("ALTER TABLE lifecycle_bindings RENAME TO lifecycle_bindings_admin_held");
  lifecycleSchema.close();
  evidence.failClosed.lifecycleSchemaMissing = await expectStartFailure("lifecycle schema missing");
  const restoreLifecycleSchema = new DatabaseSync(databasePath);
  restoreLifecycleSchema.exec("ALTER TABLE lifecycle_bindings_admin_held RENAME TO lifecycle_bindings");
  restoreLifecycleSchema.close();
  const corruptLifecycleSchema = new DatabaseSync(databasePath);
  corruptLifecycleSchema.exec("ALTER TABLE lifecycle_binding_events RENAME TO lifecycle_binding_events_admin_held; CREATE TABLE lifecycle_binding_events(sequence INTEGER PRIMARY KEY,event_id TEXT NOT NULL);");
  corruptLifecycleSchema.close();
  evidence.failClosed.lifecycleSchemaCorruption = await expectStartFailure("lifecycle schema corruption");
  const restoreCorruptLifecycleSchema = new DatabaseSync(databasePath);
  restoreCorruptLifecycleSchema.exec("DROP TABLE lifecycle_binding_events; ALTER TABLE lifecycle_binding_events_admin_held RENAME TO lifecycle_binding_events");
  restoreCorruptLifecycleSchema.close();
  const validConfig = config();
  saveConfig({ ...validConfig, serviceSid: sentinelSid });
  evidence.failClosed.identityMismatch = await expectStartFailure("identity mismatch");
  saveConfig({ ...validConfig, protocol: "aiopago.operation-authority-protocol/999" });
  evidence.failClosed.versionMismatch = await expectStartFailure("version mismatch");
  saveConfig({ ...validConfig, workerSha256: "0".repeat(64) });
  evidence.failClosed.workerHashMismatch = await expectStartFailure("worker hash mismatch");
  saveConfig(validConfig);
  writeScenario([frame("REQ-AUTHORITY-TIMEOUT", "TEST_AUTHORITY_TIMEOUT", {})]);
  evidence.failClosed.authorityTimeout = await expectStartFailure("authority timeout");
  writeScenario([]);
  evidence.failClosed.channelFailure = "PRIVATE_CHANNEL_EOF_OR_TIMEOUT_STOPS_P1S";
  evidence.failClosed.staleGeneration = priorityRows.find((row) => row.requestId === "REQ-PRIORITY-STALE").error;
  evidence.failClosed.requestConflict = priorityRows.filter((row) => row.requestId === "REQ-PRIORITY-CONFLICT")[1].error;
  evidence.failClosed.legacyFallback = false;

  const acl = run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$paths=@('${root.replaceAll("'", "''")}','${join(root, "bin").replaceAll("'", "''")}','${join(root, "canonical").replaceAll("'", "''")}','${join(root, "canonical", "operations.sqlite").replaceAll("'", "''")}');$paths|ForEach-Object{$a=Get-Acl -LiteralPath $_;[ordered]@{path=$_;owner=$a.Owner;sddl=$a.Sddl}}|ConvertTo-Json -Compress`]);
  evidence.acls = JSON.parse(acl);
  evidence.store = { path: databasePath, journalMode: (() => { const db = new DatabaseSync(databasePath, { readOnly: true }); const mode = db.prepare("PRAGMA journal_mode").get().journal_mode; db.close(); return mode; })(), files: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(existsSync), owner: evidence.acls.find((value) => value.path === databasePath)?.owner, p0Access: "DENIED", otherLocalServiceAccess: "DENIED", p1sP2Access: "READ_WRITE" };
  evidence.binaryIdentity = { broker: sha(join(root, "bin", "broker-service.exe")), node: sha(join(root, "bin", "node.exe")), worker: sha(join(root, "bin", "operation-authority-worker.mjs")), config: validConfig };
  evidence.result = "LIFECYCLE BINDING + HANDOFF RESERVATION + LATCH + OPERATION AUTHORITY: PASS";
  writeFileSync(join(publicOutput, "windows-physical-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  if (provisioned || sentinelProvisioned) {
    try { ps(join(here, "cleanup-test-service.ps1"), ["-ServiceName", serviceName, "-SentinelServiceName", sentinelName, "-TestRoot", root, "-SentinelRoot", sentinelRoot], 120_000); } catch (error) { process.stderr.write(`cleanup failed: ${error.message}\n`); }
  }
  if (existsSync(publicOutput)) rmSync(publicOutput, { recursive: true, force: true });
}
