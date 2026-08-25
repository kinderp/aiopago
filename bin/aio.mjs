#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const operationalEntry = realpathSync(fileURLToPath(new URL("../dist/cli-entry.mjs", import.meta.url)));
const env = { ...process.env, AIOPAGO_OPERATIONAL_COMMAND_NAME: "aio" };
for (const name of ["NODE_OPTIONS", "NODE_PATH", "PI_CODING_AGENT_ROOT"]) delete env[name];

const child = spawnSync(process.execPath, [operationalEntry, ...process.argv.slice(2)], {
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
