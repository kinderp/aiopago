import { initializeRepository, checkPortableEnvironment } from "./bootstrap.mjs";
import { GuardianError } from "./errors.mjs";
import { loadRepositoryContext } from "./repository.mjs";

export const AIO_VERSION = "0.1.0";

const HELP = `Aiopago portable alpha

Usage:
  aio init [target]
  aio init --target <path>
  aio [--target <path>]
  aio status [--target <path>]
  aio why [--target <path>]
  aio next [--target <path>]
  aio plan [--raw | --check | --technical] [--target <path>]
  aio --help | --version

Commands:
  init    Initialize Aiopago state non-destructively in a Git worktree
  status  Show plan context and the runtime observation boundary without starting Pi
  why     Explain the current plan/runtime observation boundary
  next    Show bounded guidance without changing or launching runtime state
  plan    Inspect or validate the authoritative TASK_PLAN.md read-only

Without a command, aio starts Pi under the Aiopago Runner. Run init first.`;

const COMMANDS = new Set(["init", "status", "why", "next", "plan"]);
const READ_ONLY_COMMANDS = new Set(["status", "why", "next", "plan"]);
const PLAN_OPTIONS = new Set(["--raw", "--check", "--technical"]);

function parse(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (argv.includes("--version") || argv.includes("-v")) return { version: true };
  const values = [...argv];
  const command = COMMANDS.has(values[0]) ? values.shift() : null;
  let target = null;
  const targetIndex = values.indexOf("--target");
  if (targetIndex >= 0) {
    if (!values[targetIndex + 1]) throw new GuardianError("CLI_ARGUMENT_INVALID", "--target requires a path");
    target = values[targetIndex + 1];
    values.splice(targetIndex, 2);
  }
  if (command === "init" && values.length === 1 && target === null) target = values.shift();
  let planOption = null;
  if (command === "plan") {
    const options = values.filter((value) => PLAN_OPTIONS.has(value));
    if (options.length > 1) throw new GuardianError("CLI_ARGUMENT_INVALID", "aio plan accepts only one of --raw, --check, or --technical");
    if (options.length === 1) {
      planOption = options[0].slice(2);
      values.splice(values.indexOf(options[0]), 1);
    }
  }
  if (values.length > 0) throw new GuardianError("CLI_ARGUMENT_INVALID", `Unexpected argument: ${values[0]}`);
  return { command, planOption, target: target ?? process.cwd() };
}

function lineList(label, values) {
  return values.length > 0 ? [`${label}:`, ...values.map((value) => `  - ${value}`)] : [`${label}: none`];
}

export function formatInitSummary(result) {
  return [
    "Aiopago init complete",
    `Target root: ${result.targetRoot}`,
    `Installation root: ${result.installationRoot}`,
    `Config root: ${result.configRoot}`,
    `Runtime root: ${result.runtimeRoot}`,
    `Artifact root: ${result.artifactRoot}`,
    `Environment: Node ${result.environment.node}; ${result.environment.git}; Pi ${result.environment.pi}`,
    ...lineList("Created", result.actions.created),
    ...lineList("Updated", result.actions.updated),
    ...lineList("Preserved", result.actions.preserved),
    "Next: review TASK_PLAN.md, then run aio from this worktree.",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? ((text) => console.log(text));
  const rawStdout = options.rawStdout ?? (options.stdout ? options.stdout : ((text) => process.stdout.write(text)));
  const parsed = parse(argv);
  if (parsed.help) { stdout(HELP); return { action: "help" }; }
  if (parsed.version) { stdout(AIO_VERSION); return { action: "version" }; }
  if (parsed.command === "init") {
    const result = await (options.initializeRepository ?? initializeRepository)(parsed.target, options.bootstrapOptions);
    stdout(formatInitSummary(result));
    return { action: "init", result };
  }
  if (READ_ONLY_COMMANDS.has(parsed.command)) {
    const workflow = await import("./human-workflow.mjs");
    const observation = await (options.observeHumanWorkflow ?? workflow.observeHumanWorkflow)(parsed.target, {
      ...options.workflowOptions,
      includeRuntime: parsed.command !== "plan",
      planMode: parsed.command === "plan" && parsed.planOption === "raw" ? "raw" : "validated",
    });
    if (parsed.command === "plan") {
      if (!observation.initialized) throw new GuardianError("REPOSITORY_NOT_INITIALIZED", `Aiopago is not initialized in ${observation.targetRoot}; run 'aio init' first`);
      if (parsed.planOption === "raw") {
        if (!observation.plan?.exists || observation.plan?.error || typeof observation.plan?.text !== "string") throw observation.plan?.error?.source ?? new GuardianError("LEDGER_NOT_FOUND", "Authoritative TASK_PLAN.md is unavailable");
        rawStdout(observation.plan.text);
      } else if (parsed.planOption === "check") {
        if (!observation.plan?.valid) throw observation.plan?.error?.source ?? new GuardianError("LEDGER_READ_FAILED", "TASK_PLAN.md is invalid");
        stdout(`TASK_PLAN.md valido — revisione ${observation.plan.plan.plan_revision_id}`);
      } else if (parsed.planOption === "technical") stdout(workflow.formatPlanTechnical(observation));
      else stdout(workflow.formatPlan(observation));
      return { action: "plan", mode: parsed.planOption ?? "summary", observation };
    }
    const view = workflow.projectHumanWorkflow(observation);
    const format = parsed.command === "status" ? workflow.formatHumanStatus : parsed.command === "why" ? workflow.formatHumanWhy : workflow.formatHumanNext;
    stdout(format(view));
    return { action: parsed.command, observation, view };
  }

  await (options.checkEnvironment ?? checkPortableEnvironment)({ searchRoot: parsed.target });
  const repository = (options.loadRepositoryContext ?? loadRepositoryContext)(parsed.target);
  const createRunner = options.createRunner ?? (await import("./runner.mjs")).GuardianRunner.create;
  const runner = await createRunner({ repository });
  try { await runner.runInteractive(); }
  finally { await runner.dispose(); }
  return { action: "launch", repository };
}

export function formatCliError(error, commandName = "aio") {
  const code = error?.code ? `${error.code}: ` : "";
  return `${commandName}: ${code}${error?.message ?? String(error)}`;
}
