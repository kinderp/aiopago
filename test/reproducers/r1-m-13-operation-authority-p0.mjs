// Physical medium-integrity P0 attack probe for the production operation domain.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
const root = option("--root");
const service = option("--service");
const projectDatabase = option("--project-db");
const output = option("--output");
const serviceConfigProbe = option("--service-config-probe");
const forgedLatchState = option("--forge-latch-state") ?? "HUMAN_TAKEOVER";
if (!root || !service || !projectDatabase || !output || !serviceConfigProbe) throw new Error("ROOT_SERVICE_PROJECT_DB_OUTPUT_PROBE_REQUIRED");
if (!["HUMAN_TAKEOVER", "CLEAR"].includes(forgedLatchState)) throw new Error("FORGED_LATCH_STATE_INVALID");
const system32 = join(process.env.SystemRoot, "System32");
const canonical = join(root, "canonical", "operations.sqlite");
const key = join(root, "canonical", "identity.bin");
const broker = join(root, "bin", "broker-service.exe");
const bin = join(root, "bin");
const attempts = [];

function attempt(name, operation) {
  try { operation(); attempts.push({ name, denied: false, error: null }); }
  catch (error) { attempts.push({ name, denied: ["EACCES", "EPERM"].includes(error?.code) || /denied|accesso negato/i.test(error?.message ?? ""), error: `${error?.code ?? error?.name}: ${error?.message}` }); }
}
function native(name, file, args) {
  const value = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  attempts.push({ name, denied: value.status === 5 || /access is denied|accesso negato/i.test(`${value.stdout}${value.stderr}`), exitCode: value.status, stdout: String(value.stdout).trim(), stderr: String(value.stderr).trim() });
}

const identity = execFileSync(join(system32, "whoami.exe"), ["/all", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
attempt("canonical_read", () => readFileSync(canonical));
attempt("canonical_open_write", () => { const fd = openSync(canonical, "r+"); closeSync(fd); });
attempt("canonical_copy", () => copyFileSync(canonical, join(process.env.TEMP, `aiopago-p0-canonical-${process.pid}.sqlite`)));
attempt("canonical_rename", () => { const moved = `${canonical}.p0`; renameSync(canonical, moved); renameSync(moved, canonical); });
attempt("key_read", () => readFileSync(key));
attempt("key_open_write", () => { const fd = openSync(key, "r+"); closeSync(fd); });
attempt("broker_open_write", () => { const fd = openSync(broker, "r+"); closeSync(fd); });
attempt("broker_rename", () => { const moved = `${broker}.p0`; renameSync(broker, moved); renameSync(moved, broker); });
attempt("bin_create", () => { const path = join(bin, `p0-${process.pid}.txt`); writeFileSync(path, "forged"); rmSync(path); });
native("canonical_acl_change", join(system32, "icacls.exe"), [canonical, "/grant", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`]);
native("root_acl_change", join(system32, "icacls.exe"), [root, "/grant", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)(F)`]);
native("service_binary_path_change", serviceConfigProbe, [service]);
native("service_account_change", join(system32, "sc.exe"), ["config", service, "obj=", "LocalSystem"]);
native("service_sid_change", join(system32, "sc.exe"), ["sidtype", service, "none"]);
native("service_delete", join(system32, "sc.exe"), ["delete", service]);

let forged, forgedLatch;
{
  const database = new DatabaseSync(projectDatabase);
  database.prepare("INSERT OR REPLACE INTO operations(operation_id,task_id,latch_generation,profile,state,outcome,effect_reference,admitted_at,terminal_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("OP-FORGED-BY-P0", "TASK-PRODUCTION-SECURE", 999999, "READ_ONLY", "TERMINAL", "KNOWN_SUCCESS", null, "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.001Z");
  forged = database.prepare("SELECT operation_id,task_id,latch_generation,profile,state,outcome,effect_reference FROM operations WHERE operation_id='OP-FORGED-BY-P0'").get();
  if (forgedLatchState === "HUMAN_TAKEOVER") {
    database.prepare("INSERT OR REPLACE INTO latches(task_id,state,generation,reason,engaged_at,engaged_by,released_at,released_by,last_event_id) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("TASK-PRODUCTION-SECURE", "ENGAGED", 999999, "HUMAN_TAKEOVER", "2099-01-01T00:00:00.000Z", "human:/aio-takeover", null, null, "EVT-PLAUSIBLE-P0-TAKEOVER");
  } else {
    database.prepare("INSERT OR REPLACE INTO latches(task_id,state,generation,reason,engaged_at,engaged_by,released_at,released_by,last_event_id) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("TASK-PRODUCTION-SECURE", "RELEASED", 2147483647, null, null, null, "2099-01-01T00:01:00.000Z", "attacker:P0", "EVT-PLAUSIBLE-P0-CLEAR");
  }
  forgedLatch = database.prepare("SELECT task_id,state,generation,reason,engaged_at,engaged_by,released_at,released_by,last_event_id FROM latches WHERE task_id='TASK-PRODUCTION-SECURE'").get();
  database.close();
}

writeFileSync(output, `${JSON.stringify({
  schema: "aiopago.operation-latch-authority-p0-attack/2", pid: process.pid, ppid: process.ppid,
  identity, root, service, canonical, key, broker, attempts, forged, forgedLatch,
  protectedAllDenied: attempts.every((entry) => entry.denied === true),
}, null, 2)}\n`);
