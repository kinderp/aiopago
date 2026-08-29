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
const attackRealHandoffId = option("--attack-real-handoff-id");
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

let forged, forgedLatch, forgedHandoff, forgedActiveSource, forgedHandoffEvent, forgedLifecycleBinding, falseNegativeAttack = null;
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
  const handoffProjection = {
    handoff_id: "HO-FORGED-BY-P0", source_session_id: "SESSION-FORGED-BY-P0", target_session_id: "SESSION-FORGED-TARGET",
    task_id: "TASK-PRODUCTION-HANDOFF", state: "RESUMED", latch_generation: 999999,
    task_plan_revision: "PLAN-FORGED", task_plan_digest: `sha256:${"f".repeat(64)}`,
    runner_instance_id: "RUNNER-FORGED", checkpoint_id: "CP-FORGED", resume_manifest_id: "RM-FORGED",
    authorization_state: "AUTHORIZED", admission_state: "COMMITTED", dispatch_state: "ACKNOWLEDGED",
  };
  database.prepare("INSERT OR REPLACE INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(handoffProjection.handoff_id, handoffProjection.source_session_id, handoffProjection.target_session_id, handoffProjection.task_id, handoffProjection.state, handoffProjection.latch_generation, JSON.stringify(handoffProjection), "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.001Z");
  database.prepare("INSERT OR REPLACE INTO active_sources(source_session_id,handoff_id) VALUES(?,?)")
    .run(handoffProjection.source_session_id, handoffProjection.handoff_id);
  database.prepare("INSERT OR REPLACE INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
    .run("EVT-FORGED-HANDOFF", handoffProjection.handoff_id, "HANDOFF_STARTED", "handoff:forged-p0", "2099-01-01T00:00:00.000Z", JSON.stringify({ latch_generation: 999999, forged: true }));
  forgedHandoff = database.prepare("SELECT handoff_id,source_session_id,target_session_id,task_id,state,latch_generation FROM handoffs WHERE handoff_id='HO-FORGED-BY-P0'").get();
  forgedActiveSource = database.prepare("SELECT source_session_id,handoff_id FROM active_sources WHERE source_session_id='SESSION-FORGED-BY-P0'").get();
  forgedHandoffEvent = database.prepare("SELECT event_id,handoff_id,event_type,event_key FROM journal WHERE event_id='EVT-FORGED-HANDOFF'").get();
  database.prepare("INSERT OR REPLACE INTO runner_session_bindings(handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,bind_event_id,superseded_at,superseded_reason) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(handoffProjection.handoff_id, handoffProjection.target_session_id, "RUNNER-FORGED", "BIND-FORGED-BY-P0", "ACTIVE", "2099-01-01T00:00:00.000Z", "EVT-FORGED-HANDOFF", null, null);
  forgedLifecycleBinding = database.prepare("SELECT handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,superseded_at,superseded_reason FROM runner_session_bindings WHERE handoff_id='HO-FORGED-BY-P0'").get();
  if (attackRealHandoffId) {
    database.prepare("DELETE FROM active_sources WHERE handoff_id=? OR source_session_id=?").run(attackRealHandoffId, "SESSION-PRODUCTION-SOURCE");
    database.prepare("DELETE FROM runner_session_bindings WHERE handoff_id=?").run(attackRealHandoffId);
    database.prepare("DELETE FROM journal WHERE handoff_id=?").run(attackRealHandoffId);
    database.prepare("DELETE FROM handoffs WHERE handoff_id=?").run(attackRealHandoffId);
    database.prepare("INSERT OR REPLACE INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("HO-FALSE-NEGATIVE-FAKE", "SESSION-PRODUCTION-SOURCE", "SESSION-FAKE-REPLACEMENT", "TASK-FAKE", "RESUMED", 2147483647, JSON.stringify({ handoff_id: "HO-FALSE-NEGATIVE-FAKE", source_session_id: "SESSION-PRODUCTION-SOURCE", state: "RESUMED" }), "2099-01-01T00:02:00.000Z", "2099-01-01T00:02:00.001Z");
    database.prepare("INSERT OR REPLACE INTO active_sources(source_session_id,handoff_id) VALUES(?,?)").run("SESSION-PRODUCTION-SOURCE", "HO-FALSE-NEGATIVE-FAKE");
    database.prepare("INSERT OR REPLACE INTO runner_session_bindings(handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,bind_event_id,superseded_at,superseded_reason) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("HO-FALSE-NEGATIVE-FAKE", "SESSION-FAKE-REPLACEMENT", "RUNNER-P0-NEWER", "BIND-P0-NEWER", "SUPERSEDED", "2099-01-01T00:02:00.000Z", "EVT-FORGED-HANDOFF", "2099-01-01T00:03:00.000Z", "forged newer lifecycle");
    falseNegativeAttack = { deleted_handoff_id: attackRealHandoffId, fake_active_source: database.prepare("SELECT source_session_id,handoff_id FROM active_sources WHERE source_session_id='SESSION-PRODUCTION-SOURCE'").get(), fake_binding: database.prepare("SELECT handoff_id,replacement_session_id,runner_instance_id,session_binding_id,status,bound_at,superseded_at,superseded_reason FROM runner_session_bindings WHERE handoff_id='HO-FALSE-NEGATIVE-FAKE'").get() };
  }
  database.close();
}

writeFileSync(output, `${JSON.stringify({
  schema: "aiopago.operation-latch-authority-p0-attack/2", pid: process.pid, ppid: process.ppid,
  identity, root, service, canonical, key, broker, attempts, forged, forgedLatch, forgedHandoff, forgedActiveSource, forgedHandoffEvent, forgedLifecycleBinding, falseNegativeAttack,
  protectedAllDenied: attempts.every((entry) => entry.denied === true),
}, null, 2)}\n`);
