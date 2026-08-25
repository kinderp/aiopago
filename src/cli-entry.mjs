const MINIMUM_NODE_VERSION = [22, 19, 0];

function isSupportedNode() {
  const current = process.versions.node.split(".").map(Number);
  return current.some((value, index) => value > MINIMUM_NODE_VERSION[index]
    && current.slice(0, index).every((part, prior) => part === MINIMUM_NODE_VERSION[prior]))
    || current.every((value, index) => value === MINIMUM_NODE_VERSION[index]);
}

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
