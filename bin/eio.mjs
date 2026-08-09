#!/usr/bin/env node

const minimum = [22, 19, 0];
const current = process.versions.node.split(".").map(Number);
const supported = current.some((value, index) => value > minimum[index] && current.slice(0, index).every((part, prior) => part === minimum[prior]))
  || current.every((value, index) => value === minimum[index]);
if (!supported) {
  console.error(`eio: NODE_VERSION_UNSUPPORTED: Node ${process.versions.node} is unsupported; expected >=22.19.0`);
  process.exitCode = 1;
} else {
  const { formatCliError, runCli } = await import("../src/cli.mjs");
  try { await runCli(); }
  catch (error) {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
}
