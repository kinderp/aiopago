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
  await waitFor(() => existsSync(path), "service result", 60_000);
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
  project.exec(`CREATE TABLE operations(operation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,latch_generation INTEGER NOT NULL,profile TEXT NOT NULL,state TEXT NOT NULL,outcome TEXT,effect_reference TEXT,admitted_at TEXT NOT NULL,terminal_at TEXT);`);
  project.close();

  const before = await startAndResult([
    frame("REQ-BEFORE-ADMIT", "OPERATION_ADMIT_TOOL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-PRODUCTION-SECURE", generation: 11, toolName: "read", input: { path: "README.md" } }),
    frame("REQ-BEFORE-FINISH", "OPERATION_FINISH_TOOL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-PRODUCTION-SECURE", isError: false, result: { content: [{ type: "text", text: "real production result" }] }, interrupted: false }),
    frame("REQ-BEFORE-GET", "OPERATION_GET", { operationId: "OP-PRODUCTION-BEFORE-RESTART" }),
  ]);
  const beforeOperation = operationFrom(before, "REQ-BEFORE-GET");
  assert.equal(beforeOperation.state, "TERMINAL"); assert.equal(beforeOperation.outcome, "KNOWN_SUCCESS"); assert.equal(beforeOperation.profile, "READ_ONLY");
  evidence.phases.beforeRestart = { p1Pid: before.p1Pid, p2Pid: before.p2Pid, fingerprint: before.identityFingerprint, operation: beforeOperation };
  await stop();

  const p0 = medium(join(worktree, "test", "reproducers", "r1-m-13-operation-authority-p0.mjs"), [
    "--root", root, "--service", serviceName, "--project-db", projectDatabase, "--service-config-probe", serviceConfigProbe,
  ], join(publicOutput, "p0-attack.json"));
  assert.equal(p0.protectedAllDenied, true, JSON.stringify(p0.attempts.filter((value) => !value.denied), null, 2));
  assert.equal(p0.forged.operation_id, "OP-FORGED-BY-P0");
  evidence.p0Attack = p0;

  const after = await startAndResult([
    frame("REQ-AFTER-GET-OLD", "OPERATION_GET", { operationId: "OP-PRODUCTION-BEFORE-RESTART" }),
    frame("REQ-AFTER-GET-FORGED", "OPERATION_GET", { operationId: "OP-FORGED-BY-P0" }),
    frame("REQ-AFTER-ADMIT", "OPERATION_ADMIT_TOOL", { operationId: "OP-PRODUCTION-AFTER-RESTART", taskId: "TASK-PRODUCTION-SECURE", generation: 12, toolName: "edit", input: { path: "src/exact.txt" } }),
    frame("REQ-AFTER-FINISH", "OPERATION_FINISH_TOOL", { operationId: "OP-PRODUCTION-AFTER-RESTART", taskId: "TASK-PRODUCTION-SECURE", isError: false, result: { content: [{ type: "text", text: "edited" }] }, interrupted: false }),
    frame("REQ-AFTER-GET", "OPERATION_GET", { operationId: "OP-PRODUCTION-AFTER-RESTART" }),
  ]);
  assert.deepEqual(operationFrom(after, "REQ-AFTER-GET-OLD"), beforeOperation);
  assert.equal(operationFrom(after, "REQ-AFTER-GET-FORGED"), null);
  const afterOperation = operationFrom(after, "REQ-AFTER-GET");
  assert.equal(afterOperation.effect_reference, "file:src/exact.txt");
  assert.notEqual(after.p1Pid, before.p1Pid); assert.notEqual(after.p2Pid, before.p2Pid); assert.equal(after.identityFingerprint, before.identityFingerprint);
  evidence.phases.afterRestart = { p1Pid: after.p1Pid, p2Pid: after.p2Pid, fingerprint: after.identityFingerprint, oldOperation: operationFrom(after, "REQ-AFTER-GET-OLD"), forged: null, postRestartOperation: afterOperation };
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

  const activated = medium(join(worktree, "test", "reproducers", "r1-m-13-activated-source.mjs"), [], join(publicOutput, "activated-source.json"), 300_000);
  assert.equal(activated.piVersion, "0.83.0"); assert.equal(activated.factory, 1); assert.ok(activated.handlers >= 10); assert.equal(activated.forged?.operation_id, "OP-FORGED");
  assert.equal(canonicalQuery("OP-FORGED"), null);
  evidence.activatedSource = { ...activated, canonicalOperation: null, operationDomainResult: "PASS", unmigratedHumanTakeoverEvents: activated.humanTakeover };

  // Crash the real SQLite transition after UPDATE and before COMMIT.
  writeScenario([
    frame("REQ-CRASH-ADMIT", "OPERATION_ADMIT_TOOL", { operationId: "OP-PRODUCTION-CRASH", taskId: "TASK-PRODUCTION-SECURE", generation: 13, toolName: "write", input: { path: "src/partial.txt" } }),
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
    frame("REQ-IDEM-ADMIT", "OPERATION_RETRY_ADMISSION", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-PRODUCTION-SECURE", generation: 11, profile: "READ_ONLY" }),
    frame("REQ-CONFLICT-ADMIT", "OPERATION_RETRY_ADMISSION", { operationId: "OP-PRODUCTION-BEFORE-RESTART", taskId: "TASK-CONFLICT", generation: 11, profile: "READ_ONLY" }),
    frame("REQ-IDEM-TERMINAL", "OPERATION_RETRY_TERMINAL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", outcome: "KNOWN_SUCCESS", effectReference: null }),
    frame("REQ-CONFLICT-TERMINAL", "OPERATION_RETRY_TERMINAL", { operationId: "OP-PRODUCTION-BEFORE-RESTART", outcome: "KNOWN_FAILURE", effectReference: null }),
    frame("REQ-UNKNOWN-GET", "OPERATION_GET", { operationId: "OP-PRODUCTION-CRASH" }),
  ]);
  const byId = Object.fromEntries(idempotency.results.map((value) => [value.requestId, value]));
  assert.equal(byId["REQ-IDEM-ADMIT"].result.idempotent, true); assert.equal(byId["REQ-CONFLICT-ADMIT"].ok, false);
  assert.equal(byId["REQ-IDEM-TERMINAL"].result.idempotent, true); assert.equal(byId["REQ-CONFLICT-TERMINAL"].ok, false);
  assert.equal(byId["REQ-UNKNOWN-GET"].result.outcome, "UNKNOWN");
  evidence.idempotency = byId;
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
  const validConfig = config();
  saveConfig({ ...validConfig, serviceSid: sentinelSid });
  evidence.failClosed.identityMismatch = await expectStartFailure("identity mismatch");
  saveConfig({ ...validConfig, protocol: "aiopago.operation-authority-protocol/999" });
  evidence.failClosed.versionMismatch = await expectStartFailure("version mismatch");
  saveConfig(validConfig);
  evidence.failClosed.legacyFallback = false;

  const acl = run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$paths=@('${root.replaceAll("'", "''")}','${join(root, "bin").replaceAll("'", "''")}','${join(root, "canonical").replaceAll("'", "''")}','${join(root, "canonical", "operations.sqlite").replaceAll("'", "''")}');$paths|ForEach-Object{$a=Get-Acl -LiteralPath $_;[ordered]@{path=$_;owner=$a.Owner;sddl=$a.Sddl}}|ConvertTo-Json -Compress`]);
  evidence.acls = JSON.parse(acl);
  evidence.store = { path: databasePath, journalMode: (() => { const db = new DatabaseSync(databasePath, { readOnly: true }); const mode = db.prepare("PRAGMA journal_mode").get().journal_mode; db.close(); return mode; })(), files: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(existsSync), owner: evidence.acls.find((value) => value.path === databasePath)?.owner, p0Access: "DENIED", otherLocalServiceAccess: "DENIED", p1sP2Access: "READ_WRITE" };
  evidence.binaryIdentity = { broker: sha(join(root, "bin", "broker-service.exe")), node: sha(join(root, "bin", "node.exe")), worker: sha(join(root, "bin", "operation-authority-worker.mjs")), config: validConfig };
  evidence.result = "PRODUCTION OPERATION AUTHORITY: PASS";
  writeFileSync(join(publicOutput, "windows-physical-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  if (provisioned || sentinelProvisioned) {
    try { ps(join(here, "cleanup-test-service.ps1"), ["-ServiceName", serviceName, "-SentinelServiceName", sentinelName, "-TestRoot", root, "-SentinelRoot", sentinelRoot], 120_000); } catch (error) { process.stderr.write(`cleanup failed: ${error.message}\n`); }
  }
  if (existsSync(publicOutput)) rmSync(publicOutput, { recursive: true, force: true });
}
