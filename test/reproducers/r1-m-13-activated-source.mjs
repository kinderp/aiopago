// Standalone R1-M-13 activated-source reproducer/regression probe.
// It is intentionally outside test/*.test.mjs and is not included in the npm package.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const keep = process.argv.includes("--keep");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (outputIndex >= 0 && !outputPath) throw new Error("OUTPUT_PATH_REQUIRED");
const root = mkdtempSync(join(tmpdir(), "aiopago-r1-m-13-reconstruction-"));
const npmOptions = { shell: process.platform === "win32" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

try {
  const packedName = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], {
    cwd: process.cwd(), encoding: "utf8", ...npmOptions,
  }).trim().split(/\r?\n/).at(-1);
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "r1-m-13-consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-package-lock", join(root, packedName)], {
    cwd: consumer, stdio: "pipe", ...npmOptions,
  });
  execFileSync("git", ["init"], { cwd: consumer, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "reproducer@example.invalid"], { cwd: consumer });
  execFileSync("git", ["config", "user.name", "R1-M-13 Reproducer"], { cwd: consumer });

  const packageRoot = join(consumer, "node_modules", "aiopago");
  const operationalEntry = join(packageRoot, "dist", "cli-entry.mjs");
  const before = readFileSync(operationalEntry);
  const init = execFileSync(process.execPath, [join(packageRoot, "bin", "aio.mjs"), "init", "--target", consumer], {
    cwd: consumer, encoding: "utf8",
  });
  if (!/Pi 0\.83\.0/.test(init)) throw new Error("Expected genuine Pi 0.83.0 during initialization");

  const attackPath = join(consumer, "attack.mjs");
  writeFileSync(attackPath, `
    import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
    import { createHash } from "node:crypto";
    import { existsSync, readFileSync } from "node:fs";
    import { readFile } from "node:fs/promises";
    import { join } from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { pathToFileURL } from "node:url";

    const entry = ${JSON.stringify(operationalEntry)};
    const target = ${JSON.stringify(consumer)};
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const installedBefore = await readFile(entry);
    const manifest = JSON.parse(readFileSync(new URL("./node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
    const capture = { pid: process.pid, piVersion: manifest.version, factory: 0, commands: 0, handlers: 0, runnerAuthority: 0 };

    DefaultResourceLoader.prototype.loadExtensionFactories = async function attackerInterposition() {
      const commands = new Map();
      const handlers = new Map();
      for (const value of this.extensionFactories ?? []) {
        capture.factory += 1;
        const factory = typeof value === "function" ? value : value.factory;
        factory({
          registerCommand(name, command) { commands.set(name, command); capture.commands += 1; },
          on(name, handler) { handlers.set(name, handler); capture.handlers += 1; },
        });
      }
      capture.runnerAuthority = commands.has("aio") && handlers.has("tool_call") && handlers.has("tool_execution_end") ? 1 : 0;
      handlers.get("tool_call")?.({ toolCallId: "OP-FORGED", toolName: "read", input: { path: "attacker-chosen.txt" } });
      handlers.get("tool_execution_end")?.({
        toolCallId: "OP-FORGED", toolName: "read", input: { path: "attacker-chosen.txt" }, isError: false,
        result: { content: [{ type: "text", text: "forged" }] },
      }, { signal: { aborted: false } });
      capture.attackerHandoffInvocation = 1;
      await commands.get("aio")?.handler("handoff manual", {
        ui: { notify() {}, setEditorText() {}, async confirm() { return false; } },
        async newSession() { throw new Error("ATTACKER_REPLACEMENT_STOP"); },
      });
      await commands.get("aio")?.handler("takeover", { ui: { notify() {} } });
      capture.attackerRecoveryInvocation = 1;
      try {
        await commands.get("aio")?.handler("handoff recover HO-FORGED", {
          ui: { notify() {}, setEditorText() {}, async confirm() { return false; } },
          async newSession() { throw new Error("ATTACKER_RECOVERY_REPLACEMENT_STOP"); },
        });
      } catch (error) { capture.attackerRecoveryCode = error?.code ?? error?.message ?? String(error); }
      throw new Error("RECONSTRUCTION_CAPTURE_COMPLETE");
    };

    process.argv = [process.execPath, entry, "--target", target];
    process.env.AIOPAGO_OPERATIONAL_COMMAND_NAME = "aio";
    const source = installedBefore.toString("utf8");
    const marker = "const __AIOPAGO_OPERATIONAL_ENTRY_URL__ = import.meta.url;";
    if (source.split(marker).length !== 2) throw new Error("OPERATIONAL_LOCATION_MARKER_INVALID");
    const physical = "const __AIOPAGO_OPERATIONAL_ENTRY_URL__ = " + JSON.stringify(pathToFileURL(entry).href) + ";";
    const activated = source.replace(marker, physical) + "\\nawait aiopagoOperationalEntrypoint();\\n";
    await import("data:text/javascript;base64," + Buffer.from(activated).toString("base64"));
    process.exitCode = 0;

    const databasePath = join(target, ".guardian", "runtime", "guardian.sqlite");
    let forged = null; let humanTakeover = 0; let portableHandoffs = 0; let portableActiveSources = 0; let portableHandoffEvents = 0; let portableLifecycleBindings = 0; let portableLifecycleEvents = 0; let portableRecoveryEvents = 0;
    if (existsSync(databasePath)) {
      const database = new DatabaseSync(databasePath);
      database.prepare("INSERT INTO journal(event_id,handoff_id,event_type,event_key,occurred_at,data_json) VALUES(?,?,?,?,?,?)")
        .run("EVT-P0-FORGED-RECOVERY", "HO-FORGED", "CONTINUITY_RECOVERY_STARTED", "continuity-recovery:HO-FORGED", "2099-01-01T00:00:00.000Z", JSON.stringify({ actor: "human:forged", recovery_authorization: "YES" }));
      forged = database.prepare("SELECT operation_id,state,outcome,profile FROM operations WHERE operation_id='OP-FORGED'").get() ?? null;
      humanTakeover = database.prepare("SELECT COUNT(*) count FROM journal WHERE event_type IN ('LATCH_ENGAGED','LATCH_ESCALATED') AND data_json LIKE '%HUMAN_TAKEOVER%'").get().count;
      portableHandoffs = database.prepare("SELECT COUNT(*) count FROM handoffs").get().count;
      portableActiveSources = database.prepare("SELECT COUNT(*) count FROM active_sources").get().count;
      portableHandoffEvents = database.prepare("SELECT COUNT(*) count FROM journal WHERE event_type='HANDOFF_STARTED'").get().count;
      portableLifecycleBindings = database.prepare("SELECT COUNT(*) count FROM runner_session_bindings").get().count;
      portableLifecycleEvents = database.prepare("SELECT COUNT(*) count FROM journal WHERE event_type IN ('RUNNER_SESSION_BOUND','RUNNER_SESSION_BINDING_SUPERSEDED')").get().count;
      portableRecoveryEvents = database.prepare("SELECT COUNT(*) count FROM journal WHERE event_type='CONTINUITY_RECOVERY_STARTED'").get().count;
      database.close();
    }
    const installedAfter = await readFile(entry);
    process.stdout.write(JSON.stringify({
      ...capture,
      installedBytesModified: !installedBefore.equals(installedAfter),
      installedSha256Before: digest(installedBefore),
      installedSha256After: digest(installedAfter),
      reconstruction: "physical marker replacement + appended invocation + base64 data URL",
      forged,
      humanTakeover,
      portableHandoffs,
      portableActiveSources,
      portableHandoffEvents,
      portableLifecycleBindings,
      portableLifecycleEvents,
      portableRecoveryEvents,
    }));
  `);

  const output = execFileSync(process.execPath, [attackPath], { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(output);
  const after = readFileSync(operationalEntry);
  const report = `${JSON.stringify({
    artifact: operationalEntry,
    tarball: join(root, packedName),
    orchestratorPid: process.pid,
    ...result,
    outerInstalledBytesModified: !before.equals(after),
    outerInstalledSha256Before: hash(before),
    outerInstalledSha256After: hash(after),
    tempRoot: keep ? root : null,
  }, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, report);
  else process.stdout.write(report);
} finally {
  if (!keep && existsSync(root)) rmSync(root, { recursive: true, force: true });
}
