const MINIMUM_NODE_VERSION = [22, 19, 0];

function isSupportedNode() {
  const current = process.versions.node.split(".").map(Number);
  return current.some((value, index) => value > MINIMUM_NODE_VERSION[index]
    && current.slice(0, index).every((part, prior) => part === MINIMUM_NODE_VERSION[prior]))
    || current.every((value, index) => value === MINIMUM_NODE_VERSION[index]);
}

// `import.meta.main` is assigned by Node's ESM loader from the process entry
// module; unlike argv, environment variables, globals, or module exports, an
// importing consumer cannot set this module-local value. The bin bootstrap
// executes this file as the entry module in a sanitized fresh Node process.
// Absolute/deep imports therefore evaluate an inert module and cannot construct
// Runner, Pi extension, handler, storage, or mutation authority in the caller.
if (import.meta.main) {
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
