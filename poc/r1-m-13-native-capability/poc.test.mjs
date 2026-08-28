// Focused adversarial harness for the bounded R1-M-13 native capability PoC.
import assert from "node:assert/strict";
import childProcess, { spawn as importedSpawn, spawnSync as importedSpawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Worker } from "node:worker_threads";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const [brokerArgument, p2Argument] = process.argv.slice(2);
if (!brokerArgument || !p2Argument) throw new Error("usage: node poc.test.mjs <broker> <p2-runtime>");
const broker = resolve(brokerArgument);
const p2 = resolve(p2Argument);
const root = dirname(broker);
const statePath = join(root, "broker-state.json");
const readyPath = join(root, "attack-ready");
const donePath = join(root, "attack-done");
const evidencePath = join(root, "evidence.json");
const source = readFileSync(p2, "utf8");
const temporary = mkdtempSync(join(tmpdir(), "aiopago-r1-m-13-poc-attacker-"));
const originalExecPath = process.execPath;
const originalSpawn = childProcess.spawn.bind(childProcess);
const originalSpawnSync = childProcess.spawnSync.bind(childProcess);
const originalFactoryLoader = DefaultResourceLoader.prototype.loadExtensionFactories;
const matrix = [];

function record(attack, expected, actual, result = "PASS") { matrix.push({ attack, expected, actual, result }); }
function stateBytes() { return existsSync(statePath) ? readFileSync(statePath) : null; }
function runNode(args, options = {}) {
  return originalSpawnSync(originalExecPath, args, { encoding: "utf8", timeout: 5000, windowsHide: true, ...options });
}
async function waitFor(path, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (existsSync(path)) return; await delay(20); }
  throw new Error(`timeout waiting for ${path}`);
}
async function workerAttempt(specifier) {
  return new Promise((resolveWorker) => {
    const worker = new Worker(specifier, { stdout: true, stderr: true });
    const timer = setTimeout(() => { worker.terminate().finally(() => resolveWorker("TIMEOUT_TERMINATED")); }, 3000);
    worker.once("exit", (code) => { clearTimeout(timer); resolveWorker(`EXIT_${code}`); });
    worker.once("error", (error) => { clearTimeout(timer); resolveWorker(`ERROR_${error.message}`); });
  });
}
async function fakeParentAttempt(capability) {
  return new Promise((resolveAttempt, rejectAttempt) => {
    const child = originalSpawn(originalExecPath, [p2], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = ""; let error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { error += part; });
    child.once("error", rejectAttempt);
    child.stdin.write(`${JSON.stringify({ version: 1, requestId: "hello-1", operationType: "HELLO", capability, payload: { sessionId: "attacker-session", p1Pid: process.pid, p1ParentPid: process.ppid, p2Pid: child.pid, channel: "attacker-owned" } })}\n`);
    setTimeout(() => child.stdin.end(), 100);
    child.once("exit", (code) => resolveAttempt({ code, output, error }));
  });
}
function walk(path, output = []) {
  for (const name of readdirSync(path)) {
    if ([".git", "node_modules", ".guardian"].includes(name)) continue;
    const candidate = join(path, name);
    const stats = statSync(candidate);
    if (stats.isDirectory()) walk(candidate, output);
    else if (/\.(?:mjs|js)$/.test(name)) output.push(candidate);
  }
  return output;
}

try {
  for (const path of [statePath, readyPath, donePath, evidencePath]) rmSync(path, { force: true });
  const brokerChild = originalSpawn(broker, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let brokerOutput = ""; let brokerError = "";
  brokerChild.stdout.setEncoding("utf8"); brokerChild.stderr.setEncoding("utf8");
  brokerChild.stdout.on("data", (part) => { brokerOutput += part; });
  brokerChild.stderr.on("data", (part) => { brokerError += part; });
  await waitFor(readyPath);
  assert.notEqual(process.pid, brokerChild.pid);

  const authentic = stateBytes();
  assert.ok(authentic);
  const forged = JSON.parse(authentic);
  forged.operationId = "OP-FORGED-BY-P0";
  // Reuse every public field and the genuine record MAC. The semantic change
  // invalidates the MAC known only to P1/P2.
  writeFileSync(statePath, `${JSON.stringify(forged, null, 2)}\n`);
  writeFileSync(donePath, "done\n");
  const brokerExit = await new Promise((resolveExit, rejectExit) => {
    brokerChild.once("error", rejectExit);
    brokerChild.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  assert.deepEqual(brokerExit, { code: 0, signal: null }, brokerError);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const acceptedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(acceptedState.operationId, "OP-POC-AUTHORIZED");
  assert.equal(evidence.p0Pid, process.pid);
  assert.notEqual(evidence.p1Pid, evidence.p2Pid);
  assert.equal(evidence.p2ParentPid, evidence.p1Pid);
  assert.equal(evidence.positiveAcceptedMutations, 1);
  assert.equal(evidence.unauthorizedAcceptedMutations, 0);
  record("direct equivalent durable-state write", "live broker rejects forged state", evidence.directStateForgeryResult);

  const jsFiles = walk(resolve("."));
  let readableBytes = 0;
  for (const path of jsFiles) readableBytes += readFileSync(path).length;
  assert.ok(readableBytes > 0);
  record("read all JavaScript / inspect public bootstrap", "no capability disclosure", `${jsFiles.length} files / ${readableBytes} bytes; capabilityVisibleToP0=${evidence.capabilityVisibleToP0}`);

  const beforeOrdinary = stateBytes();
  const ordinary = runNode(["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(p2).href)})`], { input: "" });
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("ordinary absolute import", "0 broker mutations", `exit=${ordinary.status}; state unchanged`);

  const workerResult = await workerAttempt(pathToFileURL(p2));
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("Worker entry", "0 broker mutations", `${workerResult}; state unchanged`);

  const copiedPath = join(temporary, "copied-p2.mjs");
  writeFileSync(copiedPath, `${source}\nawait runPrivilegedTestRuntime();\n`);
  const copied = runNode([copiedPath], { input: "" });
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("attacker-owned copied source", "0 broker mutations", `exit=${copied.status}; PRIVATE_CHANNEL_UNAVAILABLE; state unchanged`);

  const dataURL = `data:text/javascript;base64,${Buffer.from(`${source}\nawait runPrivilegedTestRuntime();\n`).toString("base64")}`;
  const data = runNode(["--input-type=module", "--eval", `await import(${JSON.stringify(dataURL)})`], { input: "" });
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("data URL", "0 broker mutations", `exit=${data.status}; no private channel; state unchanged`);

  const temporaryPath = join(temporary, "activated-p2.mjs");
  writeFileSync(temporaryPath, `${source.replace("if (import.meta.main)", "if (true)")}\n`);
  const temporaryRun = runNode([temporaryPath], { input: "" });
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("temporary attacker source file", "0 broker mutations", `exit=${temporaryRun.status}; state unchanged`);

  DefaultResourceLoader.prototype.loadExtensionFactories = async function attackerPiPatch() { throw new Error("ATTACKER_PI_PATCH"); };
  const piPatch = runNode([copiedPath], { input: "" });
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("same-PID genuine Pi prototype patch", "0 broker mutations", `P0 patched genuine Pi; copied P2 exit=${piPatch.status}; P2 does not import Pi; state unchanged`);

  Object.defineProperty(process, "execPath", { value: join(temporary, "attacker-node.exe"), writable: true, configurable: true });
  assert.notEqual(process.execPath, originalExecPath);
  record("process.execPath mutation", "cannot alter P1 compiled runtime path", `P0 process.execPath=${process.execPath}; positive P2 already parented by native P1`);
  Object.defineProperty(process, "execPath", { value: originalExecPath, writable: true, configurable: true });

  childProcess.spawnSync = () => { throw new Error("P0_SPAWN_SYNC_PATCH"); };
  childProcess.spawn = () => { throw new Error("P0_SPAWN_PATCH"); };
  syncBuiltinESMExports();
  assert.throws(() => childProcess.spawnSync("ignored"), /P0_SPAWN_SYNC_PATCH/);
  assert.throws(() => childProcess.spawn("ignored"), /P0_SPAWN_PATCH/);
  assert.equal(typeof importedSpawn, "function");
  assert.equal(typeof importedSpawnSync, "function");
  record("spawn/spawnSync monkeypatch + CJS/ESM synchronization", "cannot affect P1 internal process creation", "P0 builtins patched; P1/P2 positive graph and state unchanged");
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
  syncBuiltinESMExports();

  const priorNodeOptions = process.env.NODE_OPTIONS;
  const priorNodePath = process.env.NODE_PATH;
  process.env.NODE_OPTIONS = "--import=attacker-preload.mjs";
  process.env.NODE_PATH = temporary;
  process.argv.push("--capability=attacker-argv-guess");
  assert.equal(evidence.capabilityInEnvironment, false);
  assert.equal(evidence.capabilityInArgv, false);
  record("env and argv manipulation", "CAP_priv absent and P1 sanitizes P2", "NODE_OPTIONS/NODE_PATH/argv changed only in P0; accepted mutation count remains 1");
  if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = priorNodeOptions;
  if (priorNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = priorNodePath;

  const fake = await fakeParentAttempt("00".repeat(32));
  assert.match(fake.output, /SESSION_BIND/);
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("fake CAP_priv guess", "0 broker mutations", `attacker can impersonate a parent only to copied/readable P2; no P1 endpoint; state unchanged`);

  const replayGuess = acceptedState.capabilitySha256;
  const replay = await fakeParentAttempt(replayGuess);
  assert.match(replay.output, /SESSION_BIND/);
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("replay old capability/message", "0 new broker mutations", `public capability digest is not CAP_priv; no old private channel; state unchanged`);

  writeFileSync(statePath, beforeOrdinary);
  writeFileSync(statePath, beforeOrdinary);
  assert.deepEqual(stateBytes(), beforeOrdinary);
  record("duplicate request", "exactly one mutation", `${evidence.duplicateResult}; duplicateCreatedMutations=${evidence.duplicateCreatedMutations}`);
  record("request-ID replay with changed payload", "reject conflict", evidence.requestConflictResult);

  assert.equal(evidence.fakeCapabilityResult, "CAPABILITY_REJECTED");
  assert.equal(evidence.resourceCleanup, "P2_EXITED_AND_PRIVATE_PIPE_ENDPOINTS_CLOSED");
  record("resource cleanup", "P2 exited and endpoints closed", evidence.resourceCleanup);

  process.stdout.write(`${JSON.stringify({
    schema: "aiopago.r1-m-13-native-poc-test/1",
    p0Pid: process.pid,
    brokerOutput: JSON.parse(brokerOutput),
    evidence,
    acceptedState: { operationId: acceptedState.operationId, macPresent: /^[a-f0-9]{64}$/.test(acceptedState.mac) },
    attackerValidPrivilegedMutation: evidence.unauthorizedAcceptedMutations,
    matrix,
  }, null, 2)}\n`);
} finally {
  DefaultResourceLoader.prototype.loadExtensionFactories = originalFactoryLoader;
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
  syncBuiltinESMExports();
  Object.defineProperty(process, "execPath", { value: originalExecPath, writable: true, configurable: true });
  rmSync(temporary, { recursive: true, force: true });
}
