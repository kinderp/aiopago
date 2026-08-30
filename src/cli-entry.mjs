const MINIMUM_NODE_VERSION = [22, 19, 0];

function isSupportedNode() {
  const current = process.versions.node.split(".").map(Number);
  return current.some((value, index) => value > MINIMUM_NODE_VERSION[index]
    && current.slice(0, index).every((part, prior) => part === MINIMUM_NODE_VERSION[prior]))
    || current.every((value, index) => value === MINIMUM_NODE_VERSION[index]);
}

// This function is deliberately not invoked by the shipped module. The package
// build retains its lexical body but removes the source-only invocation below.
// A bin bootstrap asks a fresh sanitized Node process to read the exact physical
// bundle and invoke it there. Consequently importing this file, or selecting it
// as a Worker entry, can only define dormant lexical code: no JavaScript oracle
// in the caller's process decides whether privileged initialization may run.
async function aiopagoOperationalEntrypoint() {
  const deprecated = process.env.AIOPAGO_OPERATIONAL_COMMAND_NAME === "legacy";
  const commandName = deprecated ? ["e", "i", "o"].join("") : "aio";
  if (deprecated) console.error("eio is deprecated; use aio instead.");
  if (!isSupportedNode()) {
    console.error(`${commandName}: NODE_VERSION_UNSUPPORTED: Node ${process.versions.node} is unsupported; expected >=22.19.0`);
    process.exitCode = 1;
  } else {
    const { formatCliError, runCli } = await import("./cli.mjs");
    try { await runCli(); }
    catch (error) {
      console.error(formatCliError(error, commandName));
      process.exitCode = 1;
    }
  }
}

// @package-operational-invocation — removed from dist/cli-entry.mjs by the
// deterministic package build; retained in source for direct source execution.
await aiopagoOperationalEntrypoint();
