import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invariant } from "./errors.mjs";

export const REPOSITORY_CONFIG_SCHEMA = "aiopago.repository/1.0.0";
export const LEGACY_REPOSITORY_CONFIG_SCHEMA = "eiopago.repository/1.0.0";
export const REPOSITORY_CONFIG_FILE = ".guardian/config.json";
export const INSTALLATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_REPOSITORY_CONFIG = Object.freeze({
  schema_version: REPOSITORY_CONFIG_SCHEMA,
  task_ledger: "TASK_PLAN.md",
  runtime_root: ".guardian/runtime",
  artifact_root: ".guardian",
});

const GIT_FAILURE_INSPECTION_LIMIT = 64 * 1024;

function boundedErrorText(value) {
  if (typeof value === "string") return value.slice(0, GIT_FAILURE_INSPECTION_LIMIT);
  if (Buffer.isBuffer(value)) return value.subarray(0, GIT_FAILURE_INSPECTION_LIMIT).toString("utf8");
  return "";
}

function dubiousOwnershipTarget(error) {
  if (error?.status !== 128) return null;
  const diagnostic = [boundedErrorText(error?.stderr), boundedErrorText(error?.message)].filter(Boolean).join("\n");
  const ownership = /^fatal:\s*detected dubious ownership in repository at '(.+)'\r?$/im.exec(diagnostic);
  if (!ownership || !/^[ \t]*git config --global --add safe\.directory[ \t]+\S.*\r?$/im.test(diagnostic)) return null;
  return ownership[1];
}

function gitCompatiblePath(path) {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function commandArgument(path) {
  return /^[A-Za-z0-9_./:+-]+$/.test(path) ? path : JSON.stringify(path);
}

function runGit(cwd, args, execFile = execFileSync) {
  try {
    return execFile("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (error?.code === "ENOENT") invariant(false, "GIT_UNAVAILABLE", "Git is required but was not found on PATH");
    const ownershipTarget = dubiousOwnershipTarget(error);
    if (ownershipTarget) {
      const target = gitCompatiblePath(ownershipTarget);
      const command = `git config --global --add safe.directory ${commandArgument(target)}`;
      invariant(false, "GIT_SAFE_DIRECTORY_REQUIRED", `Git requires explicit trust for this worktree:\n${target}\n\nIf you trust this repository, run manually:\n\n${command}\n\nAiopago does not modify Git global configuration automatically.`);
    }
    invariant(false, "TARGET_NOT_GIT_WORKTREE", `Target is not a supported Git worktree: ${cwd}`);
  }
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realDirectory(path) {
  const absolute = resolve(path);
  invariant(existsSync(absolute), "TARGET_PATH_NOT_FOUND", `Target path does not exist: ${absolute}`);
  invariant(statSync(absolute).isDirectory(), "TARGET_PATH_NOT_DIRECTORY", `Target path is not a directory: ${absolute}`);
  return realpathSync(absolute);
}

function inspectReservedPath(path, expectedType) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  invariant(!stat.isSymbolicLink(), "REPOSITORY_STATE_PATH_REDIRECTED", `Refusing redirected Aiopago state path: ${path}`);
  invariant(expectedType === "directory" ? stat.isDirectory() : stat.isFile(), "REPOSITORY_STATE_PATH_TYPE_INVALID", `${path} must be a ${expectedType}`);
  invariant(samePath(realpathSync(path), path), "REPOSITORY_STATE_PATH_REDIRECTED", `Refusing redirected Aiopago state path: ${path}`);
}

export function validateRepositoryStateBoundaries(targetRoot) {
  const reserved = [
    [".guardian", "directory"],
    [REPOSITORY_CONFIG_FILE, "file"],
    [".guardian/runtime", "directory"],
    [".guardian/runtime/guardian.sqlite", "file"],
    [".guardian/runtime/guardian.sqlite-wal", "file"],
    [".guardian/runtime/guardian.sqlite-shm", "file"],
    [".guardian/checkpoints", "directory"],
    [".guardian/manifests", "directory"],
    [".guardian/plan-proposals", "directory"],
    [".guardian/plan-history", "directory"],
    [".guardian/plan-write.lock", "file"],
    [".guardian/test-runs", "directory"],
    [".guardian/calibration", "directory"],
    ["TASK_PLAN.md", "file"],
    [".gitignore", "file"],
  ];
  for (const [localPath, expectedType] of reserved) inspectReservedPath(join(targetRoot, localPath), expectedType);
}

export function discoverTargetRepository(input = process.cwd(), options = {}) {
  const startPath = realDirectory(resolve(options.baseDirectory ?? process.cwd(), input));
  const inside = runGit(startPath, ["rev-parse", "--is-inside-work-tree"], options.execFile);
  invariant(inside === "true", "TARGET_NOT_GIT_WORKTREE", `Target is not inside a Git worktree: ${startPath}`);
  const gitRoot = runGit(startPath, ["rev-parse", "--show-toplevel"], options.execFile);
  const targetRoot = realDirectory(gitRoot);
  const observedAgain = runGit(targetRoot, ["rev-parse", "--show-toplevel"], options.execFile);
  invariant(samePath(realDirectory(observedAgain), targetRoot), "GIT_WORKTREE_MISMATCH", `Git root changed while discovering target: ${targetRoot}`);
  return targetRoot;
}

function resolveInside(targetRoot, configuredPath, field) {
  invariant(typeof configuredPath === "string" && configuredPath.length > 0 && !isAbsolute(configuredPath), "REPOSITORY_CONFIG_PATH_INVALID", `${field} must be a non-empty relative path`);
  const absolute = resolve(targetRoot, configuredPath);
  const rel = relative(targetRoot, absolute);
  invariant(rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel), "REPOSITORY_CONFIG_PATH_ESCAPE", `${field} escapes the target repository`);
  return absolute;
}

export function validateRepositoryConfig(config, targetRoot) {
  invariant(config && typeof config === "object" && !Array.isArray(config), "REPOSITORY_CONFIG_INVALID", "Aiopago repository config must be a JSON object");
  invariant([REPOSITORY_CONFIG_SCHEMA, LEGACY_REPOSITORY_CONFIG_SCHEMA].includes(config.schema_version), "REPOSITORY_CONFIG_SCHEMA_UNSUPPORTED", `Expected ${REPOSITORY_CONFIG_SCHEMA} or legacy ${LEGACY_REPOSITORY_CONFIG_SCHEMA}`);
  const expectedFields = Object.keys(DEFAULT_REPOSITORY_CONFIG).sort();
  invariant(JSON.stringify(Object.keys(config).sort()) === JSON.stringify(expectedFields), "REPOSITORY_CONFIG_FIELDS_INVALID", `Supported fields: ${expectedFields.join(", ")}`);
  const taskLedgerPath = resolveInside(targetRoot, config.task_ledger, "task_ledger");
  const runtimeRoot = resolveInside(targetRoot, config.runtime_root, "runtime_root");
  const artifactRoot = resolveInside(targetRoot, config.artifact_root, "artifact_root");
  for (const field of ["task_ledger", "runtime_root", "artifact_root"]) invariant(config[field] === DEFAULT_REPOSITORY_CONFIG[field], "REPOSITORY_CONFIG_LAYOUT_UNSUPPORTED", `${field} must be ${DEFAULT_REPOSITORY_CONFIG[field]} in this alpha`);
  const configRoot = join(targetRoot, ".guardian");
  invariant(runtimeRoot !== configRoot && runtimeRoot !== targetRoot, "REPOSITORY_CONFIG_ROOT_INVALID", "runtime_root must be separate from config and target roots");
  invariant(artifactRoot !== targetRoot, "REPOSITORY_CONFIG_ROOT_INVALID", "artifact_root must not be the target root");
  return Object.freeze({
    installationRoot: INSTALLATION_ROOT,
    targetRoot,
    configRoot,
    configPath: join(targetRoot, REPOSITORY_CONFIG_FILE),
    runtimeRoot,
    artifactRoot,
    taskLedgerPath,
    config: Object.freeze(structuredClone(config)),
  });
}

export function readRepositoryConfig(targetRoot) {
  validateRepositoryStateBoundaries(targetRoot);
  const path = join(targetRoot, REPOSITORY_CONFIG_FILE);
  invariant(existsSync(path), "REPOSITORY_NOT_INITIALIZED", `Aiopago is not initialized in ${targetRoot}; run 'aio init' first`);
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { invariant(false, "REPOSITORY_CONFIG_JSON_INVALID", `${path}: ${error.message}`); }
  return validateRepositoryConfig(config, targetRoot);
}

export function loadRepositoryContext(input = process.cwd(), options = {}) {
  return readRepositoryConfig(discoverTargetRepository(input, options));
}
