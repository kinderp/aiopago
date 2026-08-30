#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (import.meta.main) {
  const operationalEntry = realpathSync(fileURLToPath(new URL("../dist/cli-entry.mjs", import.meta.url)));
  const env = { ...process.env, AIOPAGO_OPERATIONAL_COMMAND_NAME: "aio" };
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "PI_CODING_AGENT_ROOT"]) delete env[name];

  // The on-disk operational bundle is deliberately dormant. Only this fresh,
  // sanitized process reads its exact physical bytes and adds the lexical call
  // that constructs privileged runtime authority. No shipped JavaScript entry
  // can select that call through argv, environment, Worker state, or globals.
  const launcher = [
    'import { readFile } from "node:fs/promises";',
    'import { pathToFileURL } from "node:url";',
    'const entry = process.argv[1];',
    'const source = await readFile(entry, "utf8");',
    'const marker = "const __AIOPAGO_OPERATIONAL_ENTRY_URL__ = import.meta.url;";',
    'if (source.split(marker).length !== 2) throw new Error("OPERATIONAL_LOCATION_MARKER_INVALID");',
    'const physical = "const __AIOPAGO_OPERATIONAL_ENTRY_URL__ = " + JSON.stringify(pathToFileURL(entry).href) + ";";',
    'const activated = source.replace(marker, physical) + "\\nawait aiopagoOperationalEntrypoint();\\n";',
    'await import("data:text/javascript;base64," + Buffer.from(activated).toString("base64"));',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", launcher, operationalEntry, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  if (child.error) {
    console.error(`aio: CLI_BOOTSTRAP_FAILED: ${child.error.message}`);
    process.exitCode = 1;
  } else if (child.status !== null) process.exitCode = child.status;
  else process.exitCode = 1;
}
