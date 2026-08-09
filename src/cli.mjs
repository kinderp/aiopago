import { initializeRepository, checkPortableEnvironment } from "./bootstrap.mjs";
import { GuardianError } from "./errors.mjs";
import { loadRepositoryContext } from "./repository.mjs";

export const EIO_VERSION = "0.1.0";

const HELP = `Eiopago portable alpha

Usage:
  eio init [target]
  eio init --target <path>
  eio [--target <path>]
  eio --help | --version

Commands:
  init    Initialize Eiopago state non-destructively in a Git worktree

Without a command, eio starts Pi under the Eiopago Runner. Run init first.`;

function parse(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (argv.includes("--version") || argv.includes("-v")) return { version: true };
  const values = [...argv];
  const command = values[0] === "init" ? values.shift() : null;
  let target = null;
  const targetIndex = values.indexOf("--target");
  if (targetIndex >= 0) {
    if (!values[targetIndex + 1]) throw new GuardianError("CLI_ARGUMENT_INVALID", "--target requires a path");
    target = values[targetIndex + 1];
    values.splice(targetIndex, 2);
  }
  if (command === "init" && values.length === 1 && target === null) target = values.shift();
  if (values.length > 0) throw new GuardianError("CLI_ARGUMENT_INVALID", `Unexpected argument: ${values[0]}`);
  return { command, target: target ?? process.cwd() };
}

function lineList(label, values) {
  return values.length > 0 ? [`${label}:`, ...values.map((value) => `  - ${value}`)] : [`${label}: none`];
}

export function formatInitSummary(result) {
  return [
    "Eiopago init complete",
    `Target root: ${result.targetRoot}`,
    `Installation root: ${result.installationRoot}`,
    `Config root: ${result.configRoot}`,
    `Runtime root: ${result.runtimeRoot}`,
    `Artifact root: ${result.artifactRoot}`,
    `Environment: Node ${result.environment.node}; ${result.environment.git}; Pi ${result.environment.pi}`,
    ...lineList("Created", result.actions.created),
    ...lineList("Updated", result.actions.updated),
    ...lineList("Preserved", result.actions.preserved),
    "Next: review TASK_PLAN.md, then run eio from this worktree.",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? ((text) => console.log(text));
  const parsed = parse(argv);
  if (parsed.help) { stdout(HELP); return { action: "help" }; }
  if (parsed.version) { stdout(EIO_VERSION); return { action: "version" }; }
  if (parsed.command === "init") {
    const result = await (options.initializeRepository ?? initializeRepository)(parsed.target, options.bootstrapOptions);
    stdout(formatInitSummary(result));
    return { action: "init", result };
  }

  await (options.checkEnvironment ?? checkPortableEnvironment)({ searchRoot: parsed.target });
  const repository = (options.loadRepositoryContext ?? loadRepositoryContext)(parsed.target);
  const createRunner = options.createRunner ?? (await import("./runner.mjs")).GuardianRunner.create;
  const runner = await createRunner({ repository });
  try { await runner.runInteractive(); }
  finally { await runner.dispose(); }
  return { action: "launch", repository };
}

export function formatCliError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `eio: ${code}${error?.message ?? String(error)}`;
}
