import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { GuardianError, invariant } from "./errors.mjs";
import { TaskLedger } from "./ledger.mjs";
import { inspectPi } from "./pi-loader.mjs";
import {
  DEFAULT_REPOSITORY_CONFIG,
  REPOSITORY_CONFIG_FILE,
  discoverTargetRepository,
  readRepositoryConfig,
  validateRepositoryConfig,
  validateRepositoryStateBoundaries,
} from "./repository.mjs";

export const MINIMUM_NODE_VERSION = "22.19.0";
export const GITIGNORE_START = "# Aiopago local state (managed by aio init)";
export const GITIGNORE_END = "# End Aiopago local state";
export const LEGACY_GITIGNORE_START = "# Eiopago local state (managed by eio init)";
export const LEGACY_GITIGNORE_END = "# End Eiopago local state";
const MANAGED_GITIGNORE_BODY = [
  "!.guardian/",
  ".guardian/*",
  ".guardian/runtime/",
  ".guardian/checkpoints/",
  ".guardian/manifests/",
  ".guardian/test-runs/",
  ".guardian/calibration/",
  "!.guardian/config.json",
  "!TASK_PLAN.md",
];
const GITIGNORE_LINES = [GITIGNORE_START, ...MANAGED_GITIGNORE_BODY, GITIGNORE_END];
const LEGACY_GITIGNORE_LINES = [LEGACY_GITIGNORE_START, ...MANAGED_GITIGNORE_BODY, LEGACY_GITIGNORE_END];

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? match.slice(1).map(Number) : null;
}

export function isSupportedNodeVersion(version) {
  const value = parseVersion(version);
  const minimum = parseVersion(MINIMUM_NODE_VERSION);
  if (!value) return false;
  for (let index = 0; index < 3; index += 1) {
    if (value[index] > minimum[index]) return true;
    if (value[index] < minimum[index]) return false;
  }
  return true;
}

function gitVersion(execFile = execFileSync) {
  try { return String(execFile("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim(); }
  catch (error) {
    if (error?.code === "ENOENT") throw new GuardianError("GIT_UNAVAILABLE", "Git is required but was not found on PATH");
    throw new GuardianError("GIT_UNAVAILABLE", `Cannot execute Git: ${error.message}`);
  }
}

export async function checkPortableEnvironment(options = {}) {
  const nodeVersion = options.nodeVersion ?? process.version;
  invariant(isSupportedNodeVersion(nodeVersion), "NODE_VERSION_UNSUPPORTED", `Node ${nodeVersion} is unsupported; expected >=${MINIMUM_NODE_VERSION}`);
  const git = gitVersion(options.execFile);
  const pi = await (options.piInspector ?? inspectPi)({ searchRoot: options.searchRoot });
  return Object.freeze({ node: nodeVersion.replace(/^v/, ""), git, pi: pi.version, piRoot: pi.root });
}

function taskId(root) {
  const name = basename(root).normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase() || "REPOSITORY";
  return `TASK-${name}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function createLedgerTemplate(targetRoot, now = new Date().toISOString()) {
  const id = taskId(targetRoot);
  const itemId = "ITEM-1";
  const task = {
    schema_version: "0.1.0",
    task_id: id,
    title: `Aiopago task ledger — ${basename(targetRoot)}`,
    objective: "Describe the current repository task and preserve bounded evidence across Aiopago handoffs.",
    requirements_version: "REQ-INITIAL-1",
    plan_revision_id: "PLAN-INITIAL-1",
    status: "IN_PROGRESS",
    completion_criteria: ["Replace this criterion with repository-specific acceptance criteria"],
    risk: "MEDIUM",
    created_at: now,
    updated_at: now,
    current_item: itemId,
    next_item: null,
    next_step: "Edit this Ledger with the bounded current task before starting work.",
    evidence: ["Created non-destructively by aio init"],
    model_policy: null,
    reasoning_policy: "high",
    minimal_reads: ["TASK_PLAN.md"],
    task_items: [{
      task_item_id: itemId,
      task_id: id,
      title: "Define the first bounded task",
      description: "Replace this template item with the first bounded repository task.",
      status: "IN_PROGRESS",
      depends_on: [],
      completion_criteria: ["Task scope and acceptance evidence are explicit"],
      evidence: [],
      requirements_refs: [],
      risk: "MEDIUM",
      milestone: "LOCAL",
      last_updated_at: now,
      last_updated_by: "human:aio-init",
    }],
  };
  return `# Aiopago Task Ledger\n\n**Schema:** \`aiopago.task-ledger/0.1.0\`\n\n## Ledger lifecycle contract\n\n- Allowed statuses: \`PLANNED\`, \`IN_PROGRESS\`, \`BLOCKED\`, \`DONE\`, \`DROPPED\`, \`SUPERSEDED\`. Future items use \`PLANNED\`, never \`PENDING\`.\n- Active work: task and item are \`IN_PROGRESS\`; \`current_item\` references that sole item. For the final active item, \`next_item\` is \`null\`.\n- Externally blocked work: task and item are \`BLOCKED\`; \`current_item\` is \`null\`; \`next_item\` references the blocked item. \`next_step\` names the blocker, unblock condition, and item to resume.\n- \`current_item\` is \`null\` or the sole \`IN_PROGRESS\` item; it never references \`PLANNED\`, \`BLOCKED\`, or \`DONE\`.\n- \`next_item\` is \`null\` or a \`PLANNED\`/\`BLOCKED\` item, and must differ from \`current_item\`.\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`;
}

function validateExistingState(targetRoot) {
  const configPath = join(targetRoot, REPOSITORY_CONFIG_FILE);
  const ledgerPath = join(targetRoot, "TASK_PLAN.md");
  const gitignorePath = join(targetRoot, ".gitignore");
  validateRepositoryStateBoundaries(targetRoot);
  if (existsSync(configPath)) readRepositoryConfig(targetRoot);
  if (existsSync(ledgerPath)) {
    try {
      const text = readFileSync(ledgerPath, "utf8");
      invariant(text.split("```json task-ledger").length - 1 === 1, "LEDGER_FORMAT_AMBIGUOUS", "TASK_PLAN.md must contain exactly one json task-ledger block");
      new TaskLedger(ledgerPath).read();
    } catch (error) { throw new GuardianError("TASK_PLAN_NOT_AIOPAGO_LEDGER", `Existing TASK_PLAN.md is not a compatible Aiopago Ledger; preserved without changes (${error.code ?? error.message})`); }
  }
  if (existsSync(gitignorePath)) {
    const text = readFileSync(gitignorePath, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const blocks = [
      { start: GITIGNORE_START, end: GITIGNORE_END, lines: GITIGNORE_LINES },
      { start: LEGACY_GITIGNORE_START, end: LEGACY_GITIGNORE_END, lines: LEGACY_GITIGNORE_LINES },
    ];
    let present = 0;
    for (const block of blocks) {
      const startCount = text.split(block.start).length - 1;
      const endCount = text.split(block.end).length - 1;
      invariant(startCount === endCount && startCount <= 1, "GITIGNORE_AIO_BLOCK_INVALID", "Existing .gitignore contains partial or duplicate Aiopago managed blocks; repair it explicitly before re-running init");
      if (startCount === 1) {
        present += 1;
        invariant(text.includes(block.lines.join(eol)), "GITIGNORE_AIO_BLOCK_INVALID", "Existing Aiopago .gitignore block differs from a supported canonical or legacy block; review it explicitly");
      }
    }
    invariant(present <= 1, "GITIGNORE_AIO_BLOCK_CONFLICT", "Existing .gitignore contains both Aiopago and legacy Eiopago managed blocks; resolve the conflict explicitly");
  }
}

function ensureGitignore(targetRoot, actions) {
  const path = join(targetRoot, ".gitignore");
  const existed = existsSync(path);
  const prior = existed ? readFileSync(path, "utf8") : "";
  if (prior.includes(GITIGNORE_START)) {
    actions.preserved.push(".gitignore (Aiopago block already present)");
    return;
  }
  if (prior.includes(LEGACY_GITIGNORE_START)) {
    actions.preserved.push(".gitignore (legacy Eiopago block retained compatibly)");
    return;
  }
  const eol = prior.includes("\r\n") ? "\r\n" : "\n";
  const prefix = prior.length === 0 || prior.endsWith("\n") ? "" : eol;
  const block = `${prefix}${prior.length > 0 ? eol : ""}${GITIGNORE_LINES.join(eol)}${eol}`;
  if (existed) {
    appendFileSync(path, block, "utf8");
    actions.updated.push(".gitignore (appended bounded Aiopago block)");
  } else {
    writeFileSync(path, block, { encoding: "utf8", flag: "wx" });
    actions.created.push(".gitignore");
  }
}

export async function initializeRepository(input = process.cwd(), options = {}) {
  const environment = await checkPortableEnvironment({
    nodeVersion: options.nodeVersion,
    execFile: options.execFile,
    piInspector: options.piInspector,
    searchRoot: options.searchRoot,
  });
  const targetRoot = discoverTargetRepository(input, { baseDirectory: options.baseDirectory, execFile: options.execFile });
  validateExistingState(targetRoot);

  const actions = { created: [], updated: [], preserved: [] };
  const guardianRoot = join(targetRoot, ".guardian");
  const configPath = join(targetRoot, REPOSITORY_CONFIG_FILE);
  const ledgerPath = join(targetRoot, "TASK_PLAN.md");
  const runtimeRoot = join(guardianRoot, "runtime");

  if (!existsSync(guardianRoot)) { mkdirSync(guardianRoot, { recursive: true }); actions.created.push(".guardian/"); }
  else actions.preserved.push(".guardian/");

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_REPOSITORY_CONFIG, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    actions.created.push(REPOSITORY_CONFIG_FILE);
  } else actions.preserved.push(REPOSITORY_CONFIG_FILE);

  if (!existsSync(ledgerPath)) {
    writeFileSync(ledgerPath, createLedgerTemplate(targetRoot, options.now), { encoding: "utf8", flag: "wx" });
    new TaskLedger(ledgerPath).read();
    actions.created.push("TASK_PLAN.md");
  } else actions.preserved.push("TASK_PLAN.md (valid Aiopago Ledger)");

  if (!existsSync(runtimeRoot)) { mkdirSync(runtimeRoot, { recursive: true }); actions.created.push(".guardian/runtime/"); }
  else actions.preserved.push(".guardian/runtime/ (existing state retained)");

  ensureGitignore(targetRoot, actions);
  const context = validateRepositoryConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : DEFAULT_REPOSITORY_CONFIG, targetRoot);
  return Object.freeze({ ...context, environment, actions: Object.freeze(actions) });
}
