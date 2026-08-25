const __AIOPAGO_OPERATIONAL_ENTRY_URL__ = import.meta.url;

// src/canonical.mjs
import { createHash, randomUUID } from "node:crypto";
var MAX_JSON_DEPTH = 128;
var MAX_JSON_NODES = 1e5;
function strictJsonClone(value, { code = "STRICT_JSON_DOMAIN_INVALID", field = "value", clone = true } = {}) {
  const ancestors = /* @__PURE__ */ new Set();
  let nodes = 0;
  const fail2 = (message) => {
    const error = new TypeError(`${field} is outside the strict JSON domain: ${message}`);
    error.code = code;
    throw error;
  };
  const visit = (current, path, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) fail2(`more than ${MAX_JSON_NODES} values`);
    if (depth > MAX_JSON_DEPTH) fail2(`nesting exceeds ${MAX_JSON_DEPTH} at ${path}`);
    if (current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail2(`non-finite number at ${path}`);
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object") fail2(`${typeof current} at ${path}`);
    if (ancestors.has(current)) fail2(`cycle at ${path}`);
    const prototype = Object.getPrototypeOf(current);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) fail2(`array with a custom prototype at ${path}`);
      if (current.length > MAX_JSON_NODES) fail2(`array is too large at ${path}`);
      const keys2 = Reflect.ownKeys(current);
      if (keys2.some((key) => typeof key === "symbol")) fail2(`symbol-keyed array property at ${path}`);
      const expected = /* @__PURE__ */ new Set(["length", ...Array.from({ length: current.length }, (_, index) => String(index))]);
      if (keys2.some((key) => !expected.has(key)) || keys2.length !== expected.size) fail2(`sparse array or extra array property at ${path}`);
      ancestors.add(current);
      const result2 = clone ? [] : current;
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail2(`accessor or hidden array element at ${path}[${index}]`);
        const child = visit(descriptor.value, `${path}[${index}]`, depth + 1);
        if (clone) result2.push(child);
      }
      ancestors.delete(current);
      return result2;
    }
    if (prototype !== Object.prototype && prototype !== null) fail2(`non-plain object at ${path}`);
    const keys = Reflect.ownKeys(current);
    if (keys.some((key) => typeof key === "symbol")) fail2(`symbol-keyed property at ${path}`);
    ancestors.add(current);
    const result = clone ? {} : current;
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail2(`accessor or hidden property at ${path}.${key}`);
      const child = visit(descriptor.value, `${path}.${key}`, depth + 1);
      if (clone) Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(current);
    return result;
  };
  return visit(value, "$", 0);
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (value === void 0) throw new TypeError("undefined is not canonical JSON");
  return JSON.stringify(value);
}
function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function digestObject(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}
function stableId(prefix, ...parts) {
  return `${prefix}-${createHash("sha256").update(parts.join("")).digest("hex").slice(0, 24)}`;
}
function opaqueId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
function utcNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function jsonClone(value) {
  return structuredClone(value);
}

// src/errors.mjs
var GuardianError = class extends Error {
  constructor(code, message = code, details = void 0) {
    super(message);
    this.name = "GuardianError";
    this.code = code;
    this.details = details;
  }
};
function fail(code, message = code, details) {
  throw new GuardianError(code, message, details);
}
function invariant(condition, code, message = code, details) {
  if (!condition) fail(code, message, details);
}

// src/context-advisor.mjs
var DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT = 50;
var CONTEXT_HANDOFF_THRESHOLD_ENV = "AIOPAGO_CONTEXT_HANDOFF_THRESHOLD_PERCENT";
var LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV = "EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT";
function contextHandoffThresholdEnvironment(env = process.env, { warn = (message) => console.error(message) } = {}) {
  const canonical = env[CONTEXT_HANDOFF_THRESHOLD_ENV];
  const legacy = env[LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV];
  if (canonical !== void 0 && legacy !== void 0) {
    invariant(String(canonical) === String(legacy), "CONTEXT_HANDOFF_THRESHOLD_ENV_CONFLICT", `${CONTEXT_HANDOFF_THRESHOLD_ENV} conflicts with deprecated ${LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV}`);
  }
  if (legacy !== void 0) warn(`${LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV} is deprecated; use ${CONTEXT_HANDOFF_THRESHOLD_ENV}`);
  return canonical ?? legacy;
}
function contextHandoffThreshold(value = void 0) {
  if (value === void 0 || value === null || value === "") return DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT;
  const threshold = typeof value === "number" ? value : Number(value);
  invariant(Number.isFinite(threshold) && threshold > 0 && threshold <= 100, "CONTEXT_HANDOFF_THRESHOLD_INVALID", `${CONTEXT_HANDOFF_THRESHOLD_ENV} must be greater than 0 and at most 100`);
  return threshold;
}
var ContextHandoffAdvisor = class {
  constructor({ thresholdPercent = void 0 } = {}) {
    this.thresholdPercent = contextHandoffThreshold(thresholdPercent);
    this.notifiedAboveThreshold = false;
  }
  reset() {
    this.notifiedAboveThreshold = false;
  }
  observe(usage) {
    const percent = usage?.percent;
    if (percent === null || percent === void 0 || !Number.isFinite(percent)) return null;
    if (percent < this.thresholdPercent) {
      this.notifiedAboveThreshold = false;
      return null;
    }
    if (this.notifiedAboveThreshold) return null;
    this.notifiedAboveThreshold = true;
    return Object.freeze({
      percent,
      tokens: usage.tokens ?? null,
      contextWindow: usage.contextWindow ?? null,
      thresholdPercent: this.thresholdPercent
    });
  }
};

// src/git-state.mjs
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
function git(cwd, args, { optional = false } = {}) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", optional ? "ignore" : "pipe"] }).trim();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}
function gitBytes(cwd, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}
function worktreeDigest(workdir) {
  const paths = gitBytes(workdir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort();
  const records = [];
  for (const path of paths) {
    const absolute = resolve(workdir, path);
    let kind = "missing";
    let mode = 0;
    let bytes = Buffer.alloc(0);
    try {
      const stat = lstatSync(absolute);
      mode = stat.mode & 73;
      if (stat.isSymbolicLink()) {
        kind = "symlink";
        bytes = Buffer.from(readlinkSync(absolute), "utf8");
      } else if (stat.isFile()) {
        kind = "file";
        bytes = readFileSync(absolute);
      } else if (stat.isDirectory()) {
        kind = "directory";
      } else {
        kind = "other";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    records.push({ path, kind, mode, content_digest: sha256(bytes) });
  }
  return sha256(Buffer.from(JSON.stringify(records), "utf8"));
}
function observeGitState(cwd = process.cwd()) {
  const workdir = realpathSync(resolve(cwd)).replaceAll("\\", "/");
  const root = git(workdir, ["rev-parse", "--show-toplevel"]).replaceAll("\\", "/");
  invariant(root.toLowerCase() === workdir.toLowerCase(), "GIT_WORKTREE_MISMATCH", `Expected repository root ${workdir}, observed ${root}`);
  const head = git(workdir, ["rev-parse", "HEAD"], { optional: true });
  const upstream = git(workdir, ["rev-parse", "@{upstream}"], { optional: true });
  const base = upstream && head ? git(workdir, ["merge-base", "HEAD", "@{upstream}"], { optional: true }) : head;
  const porcelain = gitBytes(workdir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const statusEntries = porcelain.toString("utf8").split("\0").filter(Boolean).sort();
  return {
    repository_id: root,
    workdir,
    branch: git(workdir, ["branch", "--show-current"]),
    head_sha: head,
    base_sha: base,
    commit_shas: head ? [head] : [],
    index_digest: sha256(gitBytes(workdir, ["ls-files", "--stage", "-z"])),
    worktree_digest: worktreeDigest(workdir),
    status_entries: statusEntries,
    observed_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function sameGitState(expected, actual) {
  const digest = /^sha256:[a-f0-9]{64}$/;
  if (![expected?.index_digest, expected?.worktree_digest, actual?.index_digest, actual?.worktree_digest].every((value) => digest.test(value))) return false;
  const identity = ["repository_id", "workdir", "branch", "head_sha", "base_sha", "index_digest", "worktree_digest"];
  return identity.every((key) => expected[key] === actual[key]) && JSON.stringify(expected.status_entries) === JSON.stringify(actual.status_entries);
}

// src/human-workflow.mjs
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
import { join as join3 } from "node:path";

// src/handoff-consent.mjs
var IDENTITY_KEYS = Object.freeze([
  "taskId",
  "planRevisionId",
  "contentDigest",
  "sessionId",
  "runnerInstanceId",
  "latch",
  "handoff"
]);
var LATCH_KEYS = Object.freeze(["state", "generation", "reason"]);
var HANDOFF_KEYS = Object.freeze([
  "handoffId",
  "state",
  "sourceSessionId",
  "targetSessionId",
  "runnerInstanceId",
  "taskPlanRevision",
  "taskPlanDigest",
  "latchGeneration",
  "authorizationState",
  "admissionState",
  "dispatchState",
  "failure"
]);
var FAILURE_KEYS = Object.freeze(["code", "message"]);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function handoffConsentIdentity(handoff) {
  if (!handoff) return null;
  return {
    handoffId: handoff.handoff_id,
    state: handoff.state,
    sourceSessionId: handoff.source_session_id,
    targetSessionId: handoff.target_session_id ?? null,
    runnerInstanceId: handoff.runner_instance_id,
    taskPlanRevision: handoff.task_plan_revision,
    taskPlanDigest: handoff.task_plan_digest,
    latchGeneration: handoff.latch_generation,
    authorizationState: handoff.authorization_state ?? null,
    admissionState: handoff.admission_state ?? null,
    dispatchState: handoff.dispatch_state ?? null,
    failure: handoff.failure ? { code: handoff.failure.code, message: handoff.failure.message } : null
  };
}
function guidedHandoffEligibilityIdentityFromAuthority({ plan: plan2, sessionId, runnerInstanceId, latch, handoff }) {
  return freeze({
    taskId: plan2.task_id,
    planRevisionId: plan2.plan_revision_id,
    contentDigest: plan2.content_digest,
    sessionId,
    runnerInstanceId,
    latch: { state: latch.state, generation: latch.generation, reason: latch.reason ?? null },
    handoff: handoffConsentIdentity(handoff)
  });
}
function sameGuidedHandoffEligibility(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

// src/ledger.mjs
import { resolve as resolve3 } from "node:path";

// src/handoff-plan-internal.mjs
var handoffPlanCapabilities = /* @__PURE__ */ new WeakMap();
function registerTrustedHandoffPlanCapability(ledger, capability) {
  invariant(ledger && typeof capability?.attest === "function" && typeof capability?.attestRecovery === "function" && typeof capability?.attestResume === "function" && typeof capability?.attestCurrentTakeover === "function" && typeof capability?.satisfyOwnerGate === "function", "HANDOFF_PLAN_CAPABILITY_INVALID");
  invariant(!handoffPlanCapabilities.has(ledger), "HANDOFF_PLAN_CAPABILITY_DUPLICATE");
  handoffPlanCapabilities.set(ledger, Object.freeze({
    attest: capability.attest,
    attestRecovery: capability.attestRecovery,
    attestResume: capability.attestResume,
    attestCurrentTakeover: capability.attestCurrentTakeover,
    satisfyOwnerGate: capability.satisfyOwnerGate
  }));
}

// src/owner-gate-internal.mjs
var COMMAND_TOKEN_WHITESPACE = /\s/u;
var HANDOFF_CONFIRM_CANONICAL_COMMAND = "/aio handoff confirm";
function isCommandTokenWhitespace(character) {
  return character !== void 0 && COMMAND_TOKEN_WHITESPACE.test(character);
}
function commandTokens(value) {
  if (typeof value !== "string") return null;
  const tokens = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && !isCommandTokenWhitespace(value[index])) {
      if (start === -1) start = index;
    } else if (start !== -1) {
      tokens.push(value.slice(start, index));
      start = -1;
    }
  }
  return tokens;
}
function canonicalOwnerCommand(value) {
  const tokens = commandTokens(value);
  if (tokens === null) return null;
  if (["/eio", "/eiopago"].includes(tokens[0])) tokens[0] = "/aio";
  const canonical = tokens.join(" ");
  return canonical === HANDOFF_CONFIRM_CANONICAL_COMMAND ? canonical : null;
}
function assertExactSatisfiedOwnerGateTransition(base, candidate, actor, now) {
  const code = "OWNER_GATE_TRANSITION_INVALID";
  let expected;
  try {
    expected = strictJsonClone(base, { code, field: "Base owner-gate transition" });
    expected.owner_gate.status = "SATISFIED";
    expected.owner_gate.satisfied_at = now;
    expected.owner_gate.satisfied_by = actor;
    expected.plan_revision_id = expected.owner_gate.satisfied_plan_revision_id;
    expected.status = "IN_PROGRESS";
    expected.updated_at = now;
    expected.current_item = expected.owner_gate.item_id;
    expected.next_item = expected.owner_gate.satisfied_next_item ?? null;
    expected.next_step = expected.owner_gate.satisfied_next_step;
    const protectedItem = expected.task_items.find((item) => item.task_item_id === expected.owner_gate.item_id);
    invariant(protectedItem, code, "The protected TaskItem is absent from the expected owner-gate transition");
    protectedItem.status = "IN_PROGRESS";
    protectedItem.last_updated_at = now;
    protectedItem.last_updated_by = actor;
    strictJsonClone(candidate, { code, field: "Candidate owner-gate transition", clone: false });
  } catch (error) {
    if (error?.code === code) throw error;
    invariant(false, code, "The owner-gate transition is outside the strict JSON domain");
  }
  invariant(canonicalJson(candidate) === canonicalJson(expected), code, "Owner-gate satisfaction contains an unauthorized transition delta");
  return candidate;
}

// src/plan-store.mjs
import { randomBytes } from "node:crypto";
import { execFileSync as execFileSync2, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync as lstatSync2,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  readdirSync,
  realpathSync as realpathSync2,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve as resolve2 } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
var TASK_LEDGER_SCHEMA = "aiopago.task-ledger/0.1.0";
var LEGACY_TASK_LEDGER_SCHEMA = "eiopago.task-ledger/0.1.0";
var LEDGER_BLOCK = /```json task-ledger[^\S\r\n]*(\r?\n)([\s\S]*?)(\r?\n)```/;
var SCHEMA_HEADER = /^\*\*Schema:\*\*[ \t]*`([^`]+)`[ \t]*$/gm;
var MAX_PLAN_BYTES = 32 * 1024 * 1024;
var MAX_PLAN_STATE_BYTES = 128 * 1024 * 1024;
var LOCK_SCHEMA = "aiopago.plan-write-lock/0.3.0";
var LOCK_METADATA_KEYS = Object.freeze([
  "schema",
  "ownership_nonce",
  "pid",
  "process_identity",
  "created_at",
  "plan_path",
  "guardian_root"
]);
var DEFAULT_IO = Object.freeze({
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync: lstatSync2,
  mkdirSync,
  openSync,
  readFileSync: readFileSync2,
  readdirSync,
  realpathSync: realpathSync2,
  renameSync,
  unlinkSync,
  writeFileSync
});
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GuardianError("LEDGER_JSON_INVALID", error.message);
  }
}
function parseTaskPlanBytes(bytes, { requireSingleBlock = false } = {}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(source);
  } catch {
    throw new GuardianError("PLAN_UTF8_INVALID", "TASK_PLAN.md must contain well-formed UTF-8 bytes");
  }
  const text = source.toString("utf8");
  const block = LEDGER_BLOCK.exec(text);
  invariant(block, "LEDGER_FORMAT_INVALID", "TASK_PLAN.md must contain one json task-ledger block");
  if (requireSingleBlock) {
    const remainder = text.slice(block.index + block[0].length);
    invariant(!LEDGER_BLOCK.test(remainder), "LEDGER_FORMAT_AMBIGUOUS", "TASK_PLAN.md must contain exactly one json task-ledger block");
  }
  const schemaMatches = [...text.matchAll(SCHEMA_HEADER)];
  return Object.freeze({
    bytes: source,
    text,
    task: parseJson(block[2]),
    block: Object.freeze({
      full: block[0],
      json: block[2],
      index: block.index,
      jsonIndex: block.index + block[0].indexOf(block[2]),
      lineEnding: block[1]
    }),
    ledgerSchema: schemaMatches.length === 1 ? schemaMatches[0][1] : null,
    schemaHeaderCount: schemaMatches.length,
    contentDigest: sha256(source)
  });
}
function closeQuietly(io, fd) {
  if (fd === void 0) return;
  try {
    io.closeSync(fd);
  } catch {
  }
}
function directorySyncUnsupported(error, phase) {
  if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error?.code)) return true;
  if (process.platform !== "win32") return false;
  const windowsUnsupported = phase === "open" ? ["EPERM", "EINVAL", "EISDIR"] : ["EPERM", "EINVAL", "EBADF"];
  return windowsUnsupported.includes(error?.code);
}
function syncDirectory(io, path) {
  let fd;
  try {
    try {
      fd = io.openSync(path, "r");
    } catch (error) {
      if (directorySyncUnsupported(error, "open")) return false;
      throw error;
    }
    try {
      io.fsyncSync(fd);
    } catch (error) {
      if (!directorySyncUnsupported(error, "fsync")) throw error;
      io.closeSync(fd);
      fd = void 0;
      return false;
    }
    io.closeSync(fd);
    fd = void 0;
    return true;
  } finally {
    closeQuietly(io, fd);
  }
}
function samePath(left, right) {
  const a = resolve2(left);
  const b = resolve2(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function statValue(stat, field) {
  return typeof stat[field] === "bigint" ? stat[field].toString() : String(stat[field]);
}
function fileIdentity(stat) {
  return Object.freeze({ device: statValue(stat, "dev"), inode: statValue(stat, "ino") });
}
function timestampValue(stat, nanoseconds, milliseconds) {
  if (stat[nanoseconds] !== void 0) return statValue(stat, nanoseconds);
  return String(Math.trunc(Number(stat[milliseconds]) * 1e6));
}
function stableFileFingerprint(stat) {
  return Object.freeze({
    ...fileIdentity(stat),
    size: statValue(stat, "size"),
    nlink: statValue(stat, "nlink"),
    mtimeNs: timestampValue(stat, "mtimeNs", "mtimeMs"),
    ctimeNs: timestampValue(stat, "ctimeNs", "ctimeMs"),
    regular: stat.isFile()
  });
}
function sameFileFingerprint(left, right) {
  return Boolean(left && right) && left.device === right.device && left.inode === right.inode && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.regular === right.regular;
}
function sameFilesystemIdentity(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}
function randomToken() {
  return randomBytes(32).toString("hex");
}
var PROCESS_LIVE = (identity) => Object.freeze({ status: "LIVE", identity });
var PROCESS_DEAD = Object.freeze({ status: "DEAD", identity: null });
var PROCESS_UNKNOWN = Object.freeze({ status: "UNKNOWN", identity: null });
var WINDOWS_LIVE_SENTINEL = "AIOPAGO_PROCESS_LIVE_V1:";
var WINDOWS_UNKNOWN_SENTINEL = "AIOPAGO_PROCESS_UNKNOWN_V1";
function processAbsenceDiagnostic(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH" ? true : null;
  }
}
function windowsProcessIdentityProbe(pid, { timeoutMs = 5e3, spawn = spawnSync, kill } = {}) {
  const absence = processAbsenceDiagnostic(pid, kill);
  if (absence === true) return PROCESS_DEAD;
  if (absence === null) return PROCESS_UNKNOWN;
  const command = [
    "$ErrorActionPreference='Stop'",
    "$probeErrors=@()",
    `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue -ErrorVariable +probeErrors`,
    "if ($null -eq $p) {",
    `  [Console]::Out.Write('${WINDOWS_UNKNOWN_SENTINEL}'); exit 4`,
    "}",
    "try {",
    `  [Console]::Out.Write('${WINDOWS_LIVE_SENTINEL}'+$p.StartTime.ToUniversalTime().Ticks); exit 0`,
    "} catch {",
    `  [Console]::Out.Write('${WINDOWS_UNKNOWN_SENTINEL}'); exit 4`,
    "}"
  ].join(";");
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.max(1, Math.floor(timeoutMs)),
    windowsHide: true
  });
  if (result?.error) return PROCESS_UNKNOWN;
  const stdout = String(result?.stdout ?? "").trim();
  if (result?.status === 0 && stdout.startsWith(WINDOWS_LIVE_SENTINEL)) {
    const ticks = stdout.slice(WINDOWS_LIVE_SENTINEL.length);
    return /^\d+$/.test(ticks) ? PROCESS_LIVE(`win32:${ticks}`) : PROCESS_UNKNOWN;
  }
  return PROCESS_UNKNOWN;
}
function processIdentityProbe(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return PROCESS_UNKNOWN;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5e3;
  if (process.platform === "linux") {
    let stat;
    try {
      stat = (options.readFileSync ?? readFileSync2)(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      return error?.code === "ENOENT" ? PROCESS_DEAD : PROCESS_UNKNOWN;
    }
    const close = stat.lastIndexOf(")");
    if (close < 0) return PROCESS_UNKNOWN;
    const fields = stat.slice(close + 2).split(" ");
    const startTicks = fields[19];
    let bootId;
    try {
      bootId = (options.readFileSync ?? readFileSync2)("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return PROCESS_UNKNOWN;
    }
    if (!/^\d+$/.test(startTicks) || !/^[a-f0-9-]{16,}$/i.test(bootId)) return PROCESS_UNKNOWN;
    return PROCESS_LIVE(`linux:${bootId}:${startTicks}`);
  }
  if (process.platform === "win32") return windowsProcessIdentityProbe(pid, { ...options, timeoutMs });
  const absence = processAbsenceDiagnostic(pid, options.kill);
  if (absence === true) return PROCESS_DEAD;
  if (absence === null) return PROCESS_UNKNOWN;
  try {
    const started = execFileSync2("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs
    }).trim().replace(/\s+/g, " ");
    if (!started) return PROCESS_UNKNOWN;
    const boot = execFileSync2("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs
    }).trim().replace(/\s+/g, " ");
    return boot ? PROCESS_LIVE(`${process.platform}:${boot}:${started}`) : PROCESS_UNKNOWN;
  } catch {
    return PROCESS_UNKNOWN;
  }
}
var cachedCurrentProcessIdentity = null;
var deadlineVerifiedLockOwners = /* @__PURE__ */ new WeakMap();
function defaultProcessIdentityProbe(pid, options = {}) {
  if (pid !== process.pid) return processIdentityProbe(pid, options);
  if (cachedCurrentProcessIdentity?.status === "LIVE") return cachedCurrentProcessIdentity;
  const observed = processIdentityProbe(pid, options);
  if (observed.status === "LIVE") cachedCurrentProcessIdentity = observed;
  return observed;
}
function deadlineRemaining(deadline) {
  if (deadline === null || deadline === void 0) return null;
  invariant(deadline && Number.isFinite(deadline.expiresAt), "PLAN_COORDINATION_DEADLINE_INVALID");
  const remaining = deadline.expiresAt - performance.now();
  if (remaining <= 0) throw new GuardianError("PLAN_COORDINATION_DEADLINE_EXCEEDED", "Plan coordination deadline expired before canonical authority acquisition");
  return remaining;
}
function exactObjectKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function canonicalIsoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
function temporaryPath(path, label) {
  return `${path}.${process.pid}.${randomBytes(16).toString("hex")}.${label}.tmp`;
}
var PlanRevisionWriter = class {
  #io;
  #testHooks;
  #processIdentityProbe;
  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve2(path);
    this.guardianRoot = resolve2(options.guardianRoot ?? join(dirname(this.path), ".guardian"));
    this.lockPath = resolve2(options.lockPath ?? join(this.guardianRoot, "plan-write.lock"));
    this.lockRecoveryPath = `${this.lockPath}.recovery`;
    this.#io = Object.freeze({ ...DEFAULT_IO, ...options.io ?? {} });
    this.#testHooks = options.testHooks ?? null;
    this.#processIdentityProbe = options.processIdentityProbe ?? defaultProcessIdentityProbe;
  }
  #ensureRealDirectory(path) {
    this.#io.mkdirSync(path, { recursive: true });
    const stat = this.#io.lstatSync(path, { bigint: true });
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && samePath(this.#io.realpathSync(path), path), "PLAN_STATE_PATH_REDIRECTED", `Refusing redirected plan state directory: ${path}`);
  }
  #pathExists(path) {
    try {
      this.#io.lstatSync(path, { bigint: true });
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  #readRegular(path, { maximum = MAX_PLAN_STATE_BYTES, code = "PLAN_PROVENANCE_INVALID", allowHardlinks = false } = {}) {
    const absolute = resolve2(path);
    let fd;
    try {
      const beforeStat = this.#io.lstatSync(absolute, { bigint: true });
      const before = stableFileFingerprint(beforeStat);
      invariant(before.regular && !beforeStat.isSymbolicLink(), code, `Expected a regular non-symlink file: ${absolute}`);
      invariant(allowHardlinks || before.nlink === "1", code, `Unexpected hardlink count for ${absolute}`);
      invariant(samePath(this.#io.realpathSync(absolute), absolute), code, `Refusing redirected file: ${absolute}`);
      fd = this.#io.openSync(absolute, "r");
      const openedStat = this.#io.fstatSync(fd, { bigint: true });
      const opened = stableFileFingerprint(openedStat);
      invariant(opened.regular && sameFileFingerprint(before, opened), code, `File changed while opening ${absolute}`);
      invariant(Number(openedStat.size) <= maximum, code, `File exceeds ${maximum} bytes: ${absolute}`);
      const bytes = this.#io.readFileSync(fd);
      const descriptorAfterStat = this.#io.fstatSync(fd, { bigint: true });
      const descriptorAfter = stableFileFingerprint(descriptorAfterStat);
      invariant(bytes.length <= maximum && bytes.length === Number(descriptorAfterStat.size) && sameFileFingerprint(opened, descriptorAfter), code, `File changed while reading ${absolute}`);
      this.#io.closeSync(fd);
      fd = void 0;
      const postPath1Stat = this.#io.lstatSync(absolute, { bigint: true });
      const postPath1 = stableFileFingerprint(postPath1Stat);
      invariant(postPath1.regular && !postPath1Stat.isSymbolicLink() && (allowHardlinks || postPath1.nlink === "1"), code, `File pathname changed after reading ${absolute}`);
      invariant(samePath(this.#io.realpathSync(absolute), absolute), code, `Refusing redirected file after reading ${absolute}`);
      const postPath2Stat = this.#io.lstatSync(absolute, { bigint: true });
      const postPath2 = stableFileFingerprint(postPath2Stat);
      invariant(postPath2.regular && !postPath2Stat.isSymbolicLink() && (allowHardlinks || postPath2.nlink === "1") && sameFileFingerprint(postPath1, postPath2) && sameFileFingerprint(descriptorAfter, postPath2), code, `File pathname changed after reading ${absolute}`);
      return Object.freeze({ bytes, identity: fileIdentity(descriptorAfterStat), fingerprint: descriptorAfter, mode: Number(descriptorAfterStat.mode) & 511 });
    } finally {
      closeQuietly(this.#io, fd);
    }
  }
  #lockError(code, message, details = void 0) {
    return new GuardianError(code, `${message}: ${this.lockPath}`, details);
  }
  #parseLock(record, path = this.lockPath) {
    let metadata;
    try {
      metadata = JSON.parse(record.bytes.toString("utf8"));
    } catch {
      throw this.#lockError("PLAN_LOCK_RECONCILIATION_REQUIRED", "Plan lock metadata is malformed; verify that no Aiopago owner is operating, then explicitly reconcile stale state");
    }
    invariant(
      exactObjectKeys(metadata, LOCK_METADATA_KEYS) && metadata.schema === LOCK_SCHEMA && /^[a-f0-9]{64}$/.test(metadata.ownership_nonce ?? "") && Number.isSafeInteger(metadata.pid) && metadata.pid > 0 && typeof metadata.process_identity === "string" && metadata.process_identity.length > 0 && metadata.process_identity.length <= 2048 && canonicalIsoTimestamp(metadata.created_at) && typeof metadata.plan_path === "string" && samePath(metadata.plan_path, this.path) && typeof metadata.guardian_root === "string" && samePath(metadata.guardian_root, this.guardianRoot),
      "PLAN_LOCK_RECONCILIATION_REQUIRED",
      `Plan lock metadata at ${path} is unknown, incomplete, or belongs to another plan; verify that no Aiopago owner is operating, then explicitly reconcile stale state`
    );
    return Object.freeze(metadata);
  }
  #ownerState(metadata, deadline = null) {
    const remaining = deadlineRemaining(deadline);
    const deadlineOwnerKey = `${metadata.ownership_nonce}\0${metadata.pid}\0${metadata.process_identity}`;
    const verifiedOwners = deadline && process.platform === "win32" ? deadlineVerifiedLockOwners.get(deadline) ?? /* @__PURE__ */ new Set() : null;
    if (verifiedOwners && !deadlineVerifiedLockOwners.has(deadline)) deadlineVerifiedLockOwners.set(deadline, verifiedOwners);
    if (verifiedOwners?.has(deadlineOwnerKey)) return "LIVE";
    const observed = this.#processIdentityProbe(metadata.pid, { timeoutMs: remaining === null ? 5e3 : Math.min(5e3, remaining) });
    invariant(observed && ["LIVE", "DEAD", "UNKNOWN"].includes(observed.status), "PLAN_PROCESS_IDENTITY_UNAVAILABLE");
    if (observed.status === "LIVE" && observed.identity === metadata.process_identity) {
      verifiedOwners?.add(deadlineOwnerKey);
      return "LIVE";
    }
    return observed.status === "DEAD" ? "DEAD" : "UNKNOWN";
  }
  #rejectExistingLock(deadline = null) {
    deadlineRemaining(deadline);
    if (this.#pathExists(this.lockRecoveryPath)) {
      try {
        this.#readRegular(this.lockRecoveryPath, { maximum: 4096, code: "PLAN_LOCK_RECOVERY_INVALID", allowHardlinks: true });
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }
      throw this.#lockError("PLAN_LOCK_RECONCILIATION_REQUIRED", "A plan-lock recovery marker exists; verify that no Aiopago owner is operating, then explicitly reconcile the lock and marker");
    }
    let observed;
    try {
      observed = this.#readRegular(this.lockPath, { maximum: 4096, code: "PLAN_LOCK_INVALID" });
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    const metadata = this.#parseLock(observed, this.lockPath);
    const state = this.#ownerState(metadata, deadline);
    if (state === "LIVE") throw this.#lockError("PLAN_WRITE_LOCKED", "Aiopago plan mutation is held by the exact live process owner");
    throw this.#lockError("PLAN_LOCK_RECONCILIATION_REQUIRED", `Plan lock owner is ${state.toLowerCase()}; verify that no Aiopago owner is operating, then explicitly reconcile stale state`);
  }
  #publishLock(bytes, deadline = null) {
    deadlineRemaining(deadline);
    const temp = temporaryPath(this.lockPath, "owner");
    let fd;
    let ownsTemp = false;
    try {
      fd = this.#io.openSync(temp, "wx", 384);
      ownsTemp = true;
      this.#io.writeFileSync(fd, bytes);
      this.#io.fsyncSync(fd);
      this.#io.closeSync(fd);
      fd = void 0;
      this.#testHooks?.afterLockMetadataWrite?.(Object.freeze({ temp, lockPath: this.lockPath }));
      if (this.#pathExists(this.lockRecoveryPath)) throw Object.assign(new Error("stale recovery in progress"), { code: "EEXIST" });
      deadlineRemaining(deadline);
      this.#io.linkSync(temp, this.lockPath);
      this.#io.unlinkSync(temp);
      ownsTemp = false;
      syncDirectory(this.#io, dirname(this.lockPath));
      this.#testHooks?.afterLockCreate?.(Object.freeze({ lockPath: this.lockPath }));
      if (this.#pathExists(this.lockRecoveryPath)) {
        const own = this.#readRegular(this.lockPath, { maximum: 4096, code: "PLAN_LOCK_OWNERSHIP_LOST" });
        if (own.bytes.equals(bytes)) this.#io.unlinkSync(this.lockPath);
        throw Object.assign(new Error("stale recovery raced lock publication"), { code: "EEXIST" });
      }
      const published = this.#readRegular(this.lockPath, { maximum: 4096, code: "PLAN_LOCK_OWNERSHIP_LOST" });
      invariant(published.bytes.equals(bytes), "PLAN_LOCK_OWNERSHIP_LOST", "Published plan lock metadata differs from its immutable owner record");
      return Object.freeze({ identity: published.identity, bytes });
    } finally {
      closeQuietly(this.#io, fd);
      if (ownsTemp) {
        try {
          this.#io.unlinkSync(temp);
        } catch {
        }
      }
    }
  }
  #acquireLock(deadline = null) {
    deadlineRemaining(deadline);
    this.#ensureRealDirectory(this.guardianRoot);
    if (this.#pathExists(this.lockRecoveryPath) || this.#pathExists(this.lockPath)) this.#rejectExistingLock(deadline);
    const remaining = deadlineRemaining(deadline);
    const own = this.#processIdentityProbe(process.pid, { timeoutMs: remaining === null ? 5e3 : Math.min(5e3, remaining) });
    invariant(own?.status === "LIVE" && typeof own.identity === "string", "PLAN_PROCESS_IDENTITY_UNAVAILABLE", "Cannot establish the current process start identity for plan locking");
    const bytes = Buffer.from(`${JSON.stringify({
      schema: LOCK_SCHEMA,
      ownership_nonce: randomToken(),
      pid: process.pid,
      process_identity: own.identity,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      plan_path: this.path,
      guardian_root: this.guardianRoot
    })}
`, "utf8");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      deadlineRemaining(deadline);
      try {
        return this.#publishLock(bytes, deadline);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!this.#rejectExistingLock(deadline)) throw this.#lockError("PLAN_WRITE_LOCKED", "Aiopago plan mutation is already locked");
      }
    }
    throw this.#lockError("PLAN_WRITE_LOCKED", "Aiopago plan mutation could not acquire coordination");
  }
  #attestLock(lock) {
    let current;
    try {
      current = this.#readRegular(this.lockPath, { maximum: 4096, code: "PLAN_LOCK_OWNERSHIP_LOST" });
    } catch (error) {
      if (error?.code === "ENOENT") throw new GuardianError("PLAN_LOCK_OWNERSHIP_LOST", "The acquired plan lock path no longer exists");
      throw error;
    }
    invariant(sameFilesystemIdentity(current.identity, lock.identity) && current.bytes.equals(lock.bytes), "PLAN_LOCK_OWNERSHIP_LOST", "The plan write lock was removed, replaced, or its ownership nonce changed");
    this.#testHooks?.afterLockAttestation?.(Object.freeze({ lockPath: this.lockPath }));
  }
  #releaseLock(lock) {
    let releaseError;
    try {
      this.#attestLock(lock);
      this.#testHooks?.beforeLockRelease?.(Object.freeze({ lockPath: this.lockPath }));
      this.#io.unlinkSync(this.lockPath);
      syncDirectory(this.#io, dirname(this.lockPath));
    } catch (error) {
      releaseError = error?.code === "PLAN_LOCK_OWNERSHIP_LOST" ? error : new GuardianError("PLAN_LOCK_RELEASE_FAILED", error.message);
    }
    if (releaseError) throw releaseError;
  }
  #readAuthoritySnapshotRaw() {
    let fd;
    try {
      const beforeStat = this.#io.lstatSync(this.path, { bigint: true });
      const before = stableFileFingerprint(beforeStat);
      invariant(before.regular && !beforeStat.isSymbolicLink() && before.nlink === "1" && samePath(this.#io.realpathSync(this.path), this.path), "PLAN_CAS_CONFLICT", "TASK_PLAN.md is not a stable regular authority file during final raw attestation");
      invariant(Number(beforeStat.size) <= MAX_PLAN_BYTES, "PLAN_CAS_CONFLICT", "TASK_PLAN.md exceeds the authority limit during final raw attestation");
      fd = this.#io.openSync(this.path, "r");
      const openedStat = this.#io.fstatSync(fd, { bigint: true });
      const opened = stableFileFingerprint(openedStat);
      invariant(sameFileFingerprint(before, opened), "PLAN_CAS_CONFLICT", "TASK_PLAN.md changed while opening for final raw attestation");
      const bytes = this.#io.readFileSync(fd);
      const descriptorAfterStat = this.#io.fstatSync(fd, { bigint: true });
      const descriptorAfter = stableFileFingerprint(descriptorAfterStat);
      invariant(bytes.length <= MAX_PLAN_BYTES && bytes.length === Number(descriptorAfterStat.size) && sameFileFingerprint(opened, descriptorAfter), "PLAN_CAS_CONFLICT", "TASK_PLAN.md changed during final descriptor read");
      this.#io.closeSync(fd);
      fd = void 0;
      const postPath1Stat = this.#io.lstatSync(this.path, { bigint: true });
      const postPath1 = stableFileFingerprint(postPath1Stat);
      invariant(postPath1.regular && !postPath1Stat.isSymbolicLink() && postPath1.nlink === "1", "PLAN_CAS_CONFLICT", "TASK_PLAN.md pathname changed after final descriptor read");
      const canonicalPath = this.#io.realpathSync(this.path);
      const postPath2Stat = this.#io.lstatSync(this.path, { bigint: true });
      const postPath2 = stableFileFingerprint(postPath2Stat);
      invariant(samePath(canonicalPath, this.path) && postPath2.regular && !postPath2Stat.isSymbolicLink() && postPath2.nlink === "1" && sameFileFingerprint(postPath1, postPath2) && sameFileFingerprint(descriptorAfter, postPath2), "PLAN_CAS_CONFLICT", "TASK_PLAN.md pathname no longer identifies the descriptor snapshot during final attestation");
      return Object.freeze({ bytes, identity: fileIdentity(descriptorAfterStat), fingerprint: descriptorAfter });
    } catch (error) {
      if (error?.code === "PLAN_CAS_CONFLICT") throw error;
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)) throw new GuardianError("PLAN_CAS_CONFLICT", "TASK_PLAN.md disappeared or was redirected during final raw attestation");
      throw error;
    } finally {
      closeQuietly(this.#io, fd);
    }
  }
  #finalRawAuthorityAttestation(current) {
    const observed = this.#readAuthoritySnapshotRaw();
    invariant(sameFilesystemIdentity(observed.identity, current.fileIdentity) && sameFileFingerprint(observed.fingerprint, current.fileFingerprint) && observed.bytes.equals(current.bytes), "PLAN_CAS_CONFLICT", "TASK_PLAN.md no longer equals the exact initial authority bytes, identity, and fingerprint during final raw attestation");
  }
  readCurrent({ requireSingleBlock = false, validate } = {}) {
    const file = this.#readRegular(this.path, { maximum: MAX_PLAN_BYTES, code: "PLAN_PATH_REDIRECTED" });
    const observed = parseTaskPlanBytes(file.bytes, { requireSingleBlock });
    validate?.(observed.task);
    return Object.freeze({ ...observed, fileIdentity: file.identity, fileFingerprint: file.fingerprint, mode: file.mode });
  }
  readPlanBytes() {
    return Buffer.from(this.#readRegular(this.path, { maximum: MAX_PLAN_BYTES, code: "PLAN_PATH_REDIRECTED" }).bytes);
  }
  stateExists(path) {
    return this.#pathExists(resolve2(path));
  }
  assertStateDirectory(path) {
    const absolute = resolve2(path);
    const stat = this.#io.lstatSync(absolute, { bigint: true });
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && samePath(this.#io.realpathSync(absolute), absolute), "PLAN_STATE_PATH_REDIRECTED", `Refusing redirected plan state directory: ${absolute}`);
    return absolute;
  }
  stateDirectoryEntries(path) {
    const absolute = this.assertStateDirectory(path);
    return this.#io.readdirSync(absolute, { withFileTypes: true });
  }
  readImmutable(path, maximum = MAX_PLAN_STATE_BYTES) {
    return Buffer.from(this.#readRegular(resolve2(path), { maximum, code: "PLAN_PROVENANCE_INVALID" }).bytes);
  }
  #redurabilizeExisting(path, identity) {
    let fd;
    try {
      fd = this.#io.openSync(path, "r+");
      const stat = this.#io.fstatSync(fd, { bigint: true });
      invariant(stat.isFile() && sameFilesystemIdentity(fileIdentity(stat), identity), "PLAN_PROVENANCE_INVALID", `Immutable record changed before durability retry: ${path}`);
      this.#io.fsyncSync(fd);
      this.#io.closeSync(fd);
      fd = void 0;
      syncDirectory(this.#io, dirname(path));
    } finally {
      closeQuietly(this.#io, fd);
    }
  }
  writeImmutable(path, bytes, { conflictCode = "PLAN_PROVENANCE_CONFLICT", maximum = MAX_PLAN_STATE_BYTES, allowExistingExact = true } = {}) {
    const destination = resolve2(path);
    const parent = dirname(destination);
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    invariant(value.length <= maximum, "PLAN_PROVENANCE_INVALID", `Immutable record exceeds ${maximum} bytes`);
    this.#ensureRealDirectory(parent);
    if (this.#pathExists(destination)) {
      if (!allowExistingExact) throw new GuardianError(conflictCode, `Immutable plan record already exists before exclusive publication: ${destination}`);
      const existing = this.#readRegular(destination, { maximum, code: "PLAN_PROVENANCE_INVALID" });
      if (!existing.bytes.equals(value)) throw new GuardianError(conflictCode, `Immutable plan record already exists with different bytes: ${destination}`);
      this.#redurabilizeExisting(destination, existing.identity);
      return;
    }
    const temp = temporaryPath(destination, "immutable");
    let fd;
    let ownsTemp = false;
    try {
      fd = this.#io.openSync(temp, "wx", 384);
      ownsTemp = true;
      this.#io.writeFileSync(fd, value);
      this.#io.fsyncSync(fd);
      this.#io.closeSync(fd);
      fd = void 0;
      this.#io.linkSync(temp, destination);
      this.#io.unlinkSync(temp);
      ownsTemp = false;
      syncDirectory(this.#io, parent);
    } catch (error) {
      closeQuietly(this.#io, fd);
      if (ownsTemp) {
        try {
          this.#io.unlinkSync(temp);
        } catch {
        }
      }
      if (error?.code === "EEXIST") {
        if (!allowExistingExact) throw new GuardianError(conflictCode, `Immutable plan record was precreated before exclusive publication: ${destination}`);
        const existing = this.#readRegular(destination, { maximum, code: "PLAN_PROVENANCE_INVALID" });
        if (!existing.bytes.equals(value)) throw new GuardianError(conflictCode, `Immutable plan record already exists with different bytes: ${destination}`);
        this.#redurabilizeExisting(destination, existing.identity);
        return;
      }
      throw error;
    }
  }
  #casConflict(expected, observed, phase) {
    const taskMatches = expected.taskId === void 0 || observed.task.task_id === expected.taskId;
    const revisionMatches = observed.task.plan_revision_id === expected.planRevisionId;
    const digestMatches = observed.contentDigest === expected.contentDigest;
    if (!taskMatches || !revisionMatches || !digestMatches) {
      throw new GuardianError("PLAN_CAS_CONFLICT", `TASK_PLAN.md no longer matches the proposal base during ${phase}; create a new proposal from a fresh observation`, {
        expected_task_id: expected.taskId ?? null,
        observed_task_id: observed.task.task_id,
        task_matches: taskMatches,
        expected_plan_revision_id: expected.planRevisionId,
        observed_plan_revision_id: observed.task.plan_revision_id,
        revision_matches: revisionMatches,
        expected_content_digest: expected.contentDigest,
        observed_content_digest: observed.contentDigest,
        digest_matches: digestMatches,
        phase
      });
    }
  }
  #prepareCandidateTemp(bytes, mode, baseIdentity) {
    const temp = temporaryPath(this.path, "replace");
    let fd;
    let ownsTemp = false;
    try {
      fd = this.#io.openSync(temp, "wx", mode || 384);
      ownsTemp = true;
      if (process.platform !== "win32") this.#io.fchmodSync(fd, mode || 384);
      this.#io.writeFileSync(fd, bytes);
      this.#io.fsyncSync(fd);
      const identity = fileIdentity(this.#io.fstatSync(fd, { bigint: true }));
      invariant(!sameFilesystemIdentity(identity, baseIdentity), "PLAN_COMMIT_WITNESS_INVALID", "Candidate temp must have a distinct filesystem identity from the base authority");
      this.#io.closeSync(fd);
      fd = void 0;
      return { path: temp, identity, reference: relative(dirname(this.path), temp).replaceAll("\\", "/"), ownsTemp };
    } catch (error) {
      closeQuietly(this.#io, fd);
      if (ownsTemp) {
        try {
          this.#io.unlinkSync(temp);
        } catch {
        }
      }
      throw error;
    }
  }
  #historyReference(contentDigest) {
    invariant(/^sha256:[a-f0-9]{64}$/.test(contentDigest), "PLAN_HISTORY_INVALID", "History digest is invalid");
    return `.guardian/plan-history/sha256-${contentDigest.slice("sha256:".length)}.md`;
  }
  #persistHistory(current) {
    const reference = this.#historyReference(current.contentDigest);
    const path = resolve2(dirname(this.path), reference);
    try {
      this.writeImmutable(path, current.bytes, { conflictCode: "PLAN_HISTORY_CORRUPT" });
    } catch (error) {
      if (error?.code === "PLAN_PROVENANCE_INVALID" || error?.code === "PLAN_STATE_PATH_REDIRECTED") throw new GuardianError("PLAN_HISTORY_CORRUPT", `Previous plan history is not trustworthy: ${path}`);
      throw error;
    }
    const stored = this.readImmutable(path, MAX_PLAN_BYTES);
    invariant(sha256(stored) === current.contentDigest && stored.equals(current.bytes), "PLAN_HISTORY_CORRUPT", "Previous plan history does not contain the exact base bytes");
    return reference;
  }
  coordinate({ requireSingleBlock = false, validate, use, deadline = null }) {
    invariant(typeof validate === "function", "PLAN_VALIDATOR_REQUIRED", "Plan coordination requires the canonical semantic validator");
    invariant(typeof use === "function", "PLAN_COORDINATION_CALLBACK_REQUIRED");
    deadlineRemaining(deadline);
    this.readCurrent({ requireSingleBlock, validate });
    deadlineRemaining(deadline);
    const lock = this.#acquireLock(deadline);
    let operationError;
    try {
      const current = this.readCurrent({ requireSingleBlock, validate });
      this.#attestLock(lock);
      deadlineRemaining(deadline);
      const result = use(current);
      invariant(!result || typeof result.then !== "function", "PLAN_COORDINATION_ASYNC_FORBIDDEN", "Plan coordination callback must remain synchronous and bounded");
      this.#attestLock(lock);
      return result;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        this.#releaseLock(lock);
      } catch (releaseError) {
        if (!operationError) throw releaseError;
      }
    }
  }
  commit({
    expected = null,
    requireSingleBlock = false,
    validate,
    inspectExisting,
    prepare
  }) {
    invariant(typeof validate === "function", "PLAN_VALIDATOR_REQUIRED", "Every plan mutation must provide the canonical semantic validator");
    invariant(typeof prepare === "function", "PLAN_PREPARE_REQUIRED", "Every plan mutation must provide a deterministic candidate preparation");
    this.readCurrent({ requireSingleBlock, validate });
    const lock = this.#acquireLock();
    let operationError;
    let temp;
    let committed = false;
    try {
      const current = this.readCurrent({ requireSingleBlock, validate });
      const exactInitialAuthority = Object.freeze({ bytes: Buffer.from(current.bytes), fileIdentity: current.fileIdentity, fileFingerprint: current.fileFingerprint });
      const existing = inspectExisting?.(current);
      if (existing !== void 0 && existing !== null) return existing;
      if (expected) this.#casConflict(expected, current, "initial attestation");
      const previousSnapshotReference = this.#historyReference(current.contentDigest);
      const prepared = prepare(current, Object.freeze({ previousSnapshotReference }));
      if (prepared?.noWrite) return prepared.result;
      invariant(prepared && Buffer.isBuffer(prepared.bytes), "PLAN_MATERIALIZATION_INVALID", "Plan mutation must materialize candidate bytes");
      invariant(prepared.bytes.length <= MAX_PLAN_BYTES, "PLAN_AUTHORITY_TOO_LARGE", `Candidate TASK_PLAN.md exceeds the ${MAX_PLAN_BYTES}-byte authority limit`);
      const candidate = parseTaskPlanBytes(prepared.bytes, { requireSingleBlock });
      validate?.(candidate.task);
      temp = this.#prepareCandidateTemp(prepared.bytes, current.mode, current.fileIdentity);
      const persistedSnapshotReference = this.#persistHistory(current);
      invariant(persistedSnapshotReference === previousSnapshotReference, "PLAN_HISTORY_INVALID");
      prepared.beforeFinalAttestation?.(Object.freeze({
        current,
        candidate,
        candidateTempIdentity: temp.identity,
        candidateTempReference: temp.reference,
        previousSnapshotReference
      }));
      this.#testHooks?.afterPreparation?.(Object.freeze({ current, candidate }));
      this.#attestLock(lock);
      this.#finalRawAuthorityAttestation(exactInitialAuthority);
      this.#io.renameSync(temp.path, this.path);
      temp.ownsTemp = false;
      committed = true;
      this.#testHooks?.afterRename?.(Object.freeze({ candidate }));
      syncDirectory(this.#io, dirname(this.path));
      const committedFile = this.readCurrent({ requireSingleBlock, validate });
      invariant(committedFile.contentDigest === candidate.contentDigest && sameFilesystemIdentity(committedFile.fileIdentity, temp.identity), "PLAN_COMMIT_WITNESS_INVALID", "Committed TASK_PLAN.md does not match the prepared candidate identity and digest");
      try {
        const result = prepared.afterCommit?.(Object.freeze({ committed: committedFile, candidateTempIdentity: temp.identity, previousSnapshotReference }));
        return result ?? prepared.result;
      } catch (error) {
        throw new GuardianError("PLAN_APPLY_COMMITTED_PROVENANCE_PENDING", "TASK_PLAN.md was replaced, but immutable applied provenance is incomplete; retry only the same proposal_id and payload to recover", { cause_code: error?.code ?? null });
      }
    } catch (error) {
      operationError = error;
      if (committed && error?.code !== "PLAN_APPLY_COMMITTED_PROVENANCE_PENDING" && error?.code !== "PLAN_COMMIT_WITNESS_INVALID") {
        operationError = new GuardianError("PLAN_APPLY_COMMITTED_PROVENANCE_PENDING", "TASK_PLAN.md may have been replaced but post-commit bookkeeping failed", { cause_code: error?.code ?? null });
      }
      throw operationError;
    } finally {
      if (temp?.ownsTemp) {
        try {
          this.#io.unlinkSync(temp.path);
        } catch {
        }
      }
      try {
        this.#releaseLock(lock);
      } catch (releaseError) {
        if (!operationError) throw releaseError;
      }
    }
  }
};

// src/plan-markdown.mjs
var SUPPORTED_LEDGER_SCHEMAS = /* @__PURE__ */ new Set([TASK_LEDGER_SCHEMA, LEGACY_TASK_LEDGER_SCHEMA]);
var METADATA_HEADERS = Object.freeze([
  { field: "plan_revision_id", pattern: /^\*\*Current revision:\*\*[ \t]*`([^`\r\n]+)`[ \t]*$/ },
  { field: "requirements_version", pattern: /^\*\*Requirements version:\*\*[ \t]*`([^`\r\n]+)`[ \t]*$/ },
  { field: "updated_at", pattern: /^\*\*Updated:\*\*[ \t]*(\S(?:.*?\S)?)[ \t]*$/ }
]);
function markdownLines(text) {
  const lines = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const next = newline === -1 ? text.length : newline + 1;
    let end = newline === -1 ? text.length : newline;
    if (end > start && text[end - 1] === "\r") end -= 1;
    lines.push({ start, end, next, content: text.slice(start, end) });
    if (newline === -1) break;
    start = next;
  }
  return lines;
}
function analyzeLedgerMetadata(observed, { allowSchemalessCompact = false } = {}) {
  if (allowSchemalessCompact && observed.schemaHeaderCount === 0 && observed.ledgerSchema === null) {
    return Object.freeze({ layout: "compact", spans: Object.freeze({}) });
  }
  invariant(observed.schemaHeaderCount === 1, "PLAN_METADATA_INVALID", "A mutable TASK_PLAN.md must contain exactly one Schema header");
  invariant(SUPPORTED_LEDGER_SCHEMAS.has(observed.ledgerSchema), "PLAN_LEDGER_SCHEMA_UNSUPPORTED", "Ledger Markdown metadata requires a supported task-ledger schema");
  const lines = markdownLines(observed.text);
  const schemaLines = lines.map((line, index) => ({
    line,
    index,
    content: index === 0 && line.content.startsWith("\uFEFF") ? line.content.slice(1) : line.content
  })).filter(({ content }) => {
    const match = /^\*\*Schema:\*\*[ \t]*`([^`]+)`[ \t]*$/.exec(content);
    return match?.[1] === observed.ledgerSchema;
  });
  invariant(schemaLines.length === 1, "PLAN_METADATA_INVALID", "The authoritative Schema line must be structurally identifiable");
  const region = [];
  for (let index = schemaLines[0].index + 1; index < lines.length && lines[index].content.trim() !== ""; index += 1) region.push(lines[index]);
  const metadataLike = region.filter((line) => /^\*\*(?:Current revision|Requirements version|Updated):\*\*/.test(line.content));
  if (metadataLike.length === 0) return Object.freeze({ layout: "compact", spans: Object.freeze({}) });
  invariant(region.length === METADATA_HEADERS.length && metadataLike.length === METADATA_HEADERS.length, "PLAN_METADATA_MISMATCH", "Structural Ledger metadata must be exactly the three canonical lines immediately after Schema");
  const spans = {};
  for (let index = 0; index < METADATA_HEADERS.length; index += 1) {
    const definition = METADATA_HEADERS[index];
    const line = region[index];
    const match = definition.pattern.exec(line.content);
    invariant(match && match[1] === observed.task[definition.field], "PLAN_METADATA_MISMATCH", `Structural Ledger metadata does not match ${definition.field}`);
    const valueOffset = line.content.indexOf(match[1], match.index);
    spans[definition.field] = Object.freeze({ start: line.start + valueOffset, end: line.start + valueOffset + match[1].length, value: match[1] });
  }
  return Object.freeze({ layout: "extended", spans: Object.freeze(spans) });
}
function metadataReplacements(analysis, replacements) {
  const requested = Object.entries(replacements ?? {});
  if (analysis.layout === "compact") {
    invariant(requested.length === 0, "PLAN_MATERIALIZATION_INVALID", "Compact Ledger Markdown has no structural metadata spans");
    return [];
  }
  return requested.map(([field, value]) => {
    const span = analysis.spans[field];
    invariant(span && typeof value === "string", "PLAN_MATERIALIZATION_INVALID", `Unknown or invalid structural Ledger metadata replacement: ${field}`);
    return { ...span, expected: span.value, value };
  });
}
function replaceSpans(text, replacements) {
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  let previousStart = text.length + 1;
  let result = text;
  for (const replacement of ordered) {
    invariant(Number.isInteger(replacement.start) && Number.isInteger(replacement.end) && replacement.start >= 0 && replacement.end >= replacement.start && replacement.end <= text.length && replacement.end <= previousStart, "PLAN_MATERIALIZATION_INVALID", "Materialization spans overlap or are out of bounds");
    invariant(text.slice(replacement.start, replacement.end) === replacement.expected, "PLAN_METADATA_MISMATCH", "Structural Ledger materialization span changed unexpectedly");
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
    previousStart = replacement.start;
  }
  return result;
}
function materializeLedgerMarkdown(observed, { json, metadata = {}, allowSchemalessCompact = false }) {
  invariant(typeof json === "string", "PLAN_MATERIALIZATION_INVALID", "Ledger JSON materialization must be a string");
  const analysis = analyzeLedgerMetadata(observed, { allowSchemalessCompact });
  const replacements = [{
    start: observed.block.jsonIndex,
    end: observed.block.jsonIndex + observed.block.json.length,
    expected: observed.block.json,
    value: json
  }];
  if (analysis.layout === "extended") replacements.push(...metadataReplacements(analysis, metadata));
  return Object.freeze({ text: replaceSpans(observed.text, replacements), analysis });
}

// src/ledger.mjs
var TASK_STATUS_VALUES = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED", "SUPERSEDED"];
var TASK_STATES = new Set(TASK_STATUS_VALUES);
var TASK_STATUS_MESSAGE = `status must be one of ${TASK_STATUS_VALUES.join(", ")}`;
var MAX_RESUME_LIST_ENTRIES = 64;
var MAX_RESUME_ENTRY_LENGTH = 2048;
var MAX_ID_LENGTH = 512;
var MAX_TEXT_LENGTH = 4096;
var MAX_LEDGER_LIST_ENTRIES = 1024;
var TASK_REQUIRED_FIELDS = ["schema_version", "task_id", "title", "objective", "requirements_version", "plan_revision_id", "status", "completion_criteria", "risk", "created_at", "updated_at", "current_item", "next_item", "next_step", "task_items"];
var ITEM_REQUIRED_FIELDS = ["task_item_id", "task_id", "title", "description", "status", "depends_on", "completion_criteria", "evidence", "requirements_refs", "risk", "milestone", "last_updated_at", "last_updated_by"];
var ITEM_OPTIONAL_ID_FIELDS = ["last_session_id", "last_checkpoint_id", "supersedes", "superseded_by"];
var TERMINAL_PROVENANCE_FORMS = [
  { reason: "reason", actor: "actor", timestamp: "timestamp" },
  { reason: "terminal_reason", actor: "terminal_actor", timestamp: "terminal_at" }
];
var OWNER_GATE_COMMON_FIELDS = ["kind", "status", "item_id", "command", "satisfied_plan_revision_id", "satisfied_next_step"];
var OWNER_GATE_OPTIONAL_FIELDS = ["satisfied_task_status", "satisfied_next_item"];
var OWNER_GATE_AUDIT_FIELDS = ["satisfied_at", "satisfied_by"];
var OWNER_GATE_LEGACY_SATISFIED_AUDIT_FIELDS = [
  "evidence_handoff_id",
  "post_fix_validation_handoff_id",
  "post_fix_replacement_session_id",
  "post_fix_continuity",
  "final_acceptance"
];
var OWNER_GATE_LEGACY_ID_FIELDS = ["evidence_handoff_id", "post_fix_validation_handoff_id", "post_fix_replacement_session_id"];
function validateTerminalProvenance(value, label) {
  const present = TERMINAL_PROVENANCE_FORMS.map((form) => Object.values(form).map((field) => Object.hasOwn(value, field)));
  for (const fields of present) invariant(fields.every(Boolean) || fields.every((entry) => !entry), "LEDGER_TERMINAL_PROVENANCE_REQUIRED", `${label} ${value.status} has partial or mixed terminal provenance`);
  const complete = TERMINAL_PROVENANCE_FORMS.filter((form, index) => present[index].every(Boolean));
  invariant(complete.length > 0, "LEDGER_TERMINAL_PROVENANCE_REQUIRED", `${label} ${value.status} requires reason, actor, and timestamp provenance`);
  for (const form of complete) {
    boundedString(value[form.reason], `${label} ${form.reason}`);
    boundedString(value[form.actor], `${label} ${form.actor}`);
    canonicalUtc(value[form.timestamp], `${label} ${form.timestamp}`);
  }
  if (complete.length === 2) {
    invariant(value.reason === value.terminal_reason && value.actor === value.terminal_actor && value.timestamp === value.terminal_at, "LEDGER_TERMINAL_PROVENANCE_CONFLICT", `${label} terminal provenance aliases conflict`);
  }
}
function boundedString(value, field, { id = false, allowEmpty = false } = {}) {
  const maximum = id ? MAX_ID_LENGTH : MAX_TEXT_LENGTH;
  invariant(typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maximum, "LEDGER_FIELD_INVALID", `${field} must be ${allowEmpty ? "a" : "a non-empty"} bounded string`);
  return value;
}
function boundedStringArray(value, field, { nonEmpty = false, ids = false } = {}) {
  invariant(Array.isArray(value) && value.length <= MAX_LEDGER_LIST_ENTRIES && (!nonEmpty || value.length > 0), "LEDGER_FIELD_INVALID", `${field} must be ${nonEmpty ? "a non-empty" : "an"} bounded array`);
  for (const entry of value) boundedString(entry, `${field} entry`, { id: ids });
  return value;
}
function canonicalUtc(value, field) {
  boundedString(value, field);
  invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), "LEDGER_TIMESTAMP_INVALID", `${field} must be canonical RFC 3339 UTC`);
  const milliseconds = Date.parse(value);
  invariant(Number.isFinite(milliseconds), "LEDGER_TIMESTAMP_INVALID", `${field} must be canonical RFC 3339 UTC`);
  const iso = new Date(milliseconds).toISOString();
  invariant(value === iso || value === iso.replace(".000Z", "Z"), "LEDGER_TIMESTAMP_INVALID", `${field} must be canonical RFC 3339 UTC`);
  return value;
}
function isAuthorizedHumanActor(actor) {
  return typeof actor === "string" && actor.length <= MAX_TEXT_LENGTH && actor.startsWith("human:") && actor.slice("human:".length).trim().length > 0;
}
function containsCanonicalCommandMention(text, gateCommand) {
  if (typeof text !== "string") return false;
  const canonicalGateCommand = canonicalOwnerCommand(gateCommand);
  const targetTokens = commandTokens(HANDOFF_CONFIRM_CANONICAL_COMMAND);
  if (canonicalGateCommand === null) return false;
  const embeddedBoundary = /[\p{L}\p{N}\p{M}_\/-]/u;
  const commandNameCharacter = /[A-Za-z0-9-]/;
  const commandArgumentCharacter = /[A-Za-z0-9_-]/;
  for (let start = text.indexOf("/"); start !== -1; start = text.indexOf("/", start + 1)) {
    const previous = start === 0 ? void 0 : text[start - 1];
    if (previous !== void 0 && embeddedBoundary.test(previous)) continue;
    let cursor = start + 1;
    if (!/[A-Za-z]/.test(text[cursor] ?? "")) continue;
    while (commandNameCharacter.test(text[cursor] ?? "")) cursor += 1;
    let parsedTokens = 1;
    let end = cursor;
    while (parsedTokens < targetTokens.length) {
      if (!isCommandTokenWhitespace(text[cursor])) break;
      while (isCommandTokenWhitespace(text[cursor])) cursor += 1;
      const argumentStart = cursor;
      while (commandArgumentCharacter.test(text[cursor] ?? "")) cursor += 1;
      if (cursor === argumentStart) break;
      parsedTokens += 1;
      end = cursor;
    }
    if (parsedTokens !== targetTokens.length) continue;
    if (embeddedBoundary.test(text[end] ?? "")) continue;
    if (canonicalOwnerCommand(text.slice(start, end)) === canonicalGateCommand) return true;
  }
  return false;
}
function validateOwnerGateOpaqueId(value, field) {
  boundedString(value, field, { id: true });
  invariant(value.trim().length > 0, "LEDGER_FIELD_INVALID", `${field} must not be blank`);
}
function validateBoundedStringList(value, field, code = "LEDGER_RESUME_CONTEXT_INVALID") {
  invariant(Array.isArray(value) && value.length <= MAX_RESUME_LIST_ENTRIES, code, `${field} must be an array with at most ${MAX_RESUME_LIST_ENTRIES} entries`);
  for (const entry of value) invariant(typeof entry === "string" && entry.length > 0 && entry.length <= MAX_RESUME_ENTRY_LENGTH, code, `${field} entries must be non-empty bounded strings`);
  return value;
}
function validateRequiredLocalPaths(value, code = "LEDGER_REQUIRED_LOCAL_PATH_INVALID") {
  validateBoundedStringList(value, "required_local_paths", code);
  for (const path of value) {
    const components = path.split("/");
    invariant(!path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && components.every((component) => component.length > 0 && component !== "." && component !== ".."), code, `required_local_paths entries must be normalized repo-relative paths: ${path}`);
  }
  return value;
}
function canonicalRequiredLocalPaths(value = [], code = "LEDGER_REQUIRED_LOCAL_PATH_INVALID") {
  validateRequiredLocalPaths(value, code);
  const canonical = [.../* @__PURE__ */ new Set(["TASK_PLAN.md", ...value])];
  invariant(canonical.length <= MAX_RESUME_LIST_ENTRIES, code, `required_local_paths including TASK_PLAN.md must have at most ${MAX_RESUME_LIST_ENTRIES} entries`);
  return canonical;
}
function validateOwnerGate(task, byId, inProgress) {
  if (!Object.hasOwn(task, "owner_gate")) return;
  const gate = task.owner_gate;
  const fail2 = (condition, message) => invariant(condition, "OWNER_GATE_INVALID", message);
  fail2(gate !== null && typeof gate === "object" && !Array.isArray(gate), "owner_gate must be a known JSON object");
  fail2(gate.kind === "HANDOFF_CONFIRM", "Unknown owner_gate kind is not forward-compatible");
  fail2(gate.status === "BLOCKED" || gate.status === "SATISFIED", "owner_gate status must be BLOCKED or SATISFIED");
  for (const field of OWNER_GATE_COMMON_FIELDS) fail2(Object.hasOwn(gate, field), `owner_gate missing ${field}`);
  const allowed = /* @__PURE__ */ new Set([
    ...OWNER_GATE_COMMON_FIELDS,
    ...OWNER_GATE_OPTIONAL_FIELDS,
    ...gate.status === "SATISFIED" ? [...OWNER_GATE_AUDIT_FIELDS, ...OWNER_GATE_LEGACY_SATISFIED_AUDIT_FIELDS] : []
  ]);
  fail2(Object.keys(gate).every((field) => allowed.has(field)), "owner_gate contains unsupported fields");
  try {
    validateOwnerGateOpaqueId(gate.item_id, "owner_gate item_id");
    boundedString(gate.command, "owner_gate command");
    validateOwnerGateOpaqueId(gate.satisfied_plan_revision_id, "owner_gate satisfied_plan_revision_id");
    boundedString(gate.satisfied_next_step, "owner_gate satisfied_next_step");
    if (Object.hasOwn(gate, "satisfied_next_item") && gate.satisfied_next_item !== null) validateOwnerGateOpaqueId(gate.satisfied_next_item, "owner_gate satisfied_next_item");
    for (const field of OWNER_GATE_LEGACY_ID_FIELDS) if (Object.hasOwn(gate, field)) validateOwnerGateOpaqueId(gate[field], `owner_gate ${field}`);
  } catch (error) {
    throw new GuardianError("OWNER_GATE_INVALID", error.message);
  }
  fail2(canonicalOwnerCommand(gate.command) === HANDOFF_CONFIRM_CANONICAL_COMMAND, "HANDOFF_CONFIRM owner_gate command must be the fixed semantic authorization command");
  fail2(gate.satisfied_next_step.trim().length > 0, "owner_gate target next step must not be blank");
  fail2(!containsCanonicalCommandMention(gate.satisfied_next_step, gate.command), "owner_gate satisfied_next_step must not mention its canonical authorization command or a supported alias");
  if (Object.hasOwn(gate, "satisfied_task_status")) fail2(gate.satisfied_task_status === "IN_PROGRESS", "owner_gate satisfied_task_status must be IN_PROGRESS for the active-work target projection");
  if (Object.hasOwn(gate, "satisfied_next_item") && gate.satisfied_next_item !== null) {
    fail2(gate.satisfied_next_item !== gate.item_id, "owner_gate satisfied_next_item must differ from item_id");
  }
  if (gate.status === "BLOCKED") {
    fail2(byId.has(gate.item_id), "A BLOCKED owner_gate item_id must reference a current TaskItem");
    if (Object.hasOwn(gate, "satisfied_next_item") && gate.satisfied_next_item !== null) {
      fail2(byId.has(gate.satisfied_next_item), "A BLOCKED owner_gate satisfied_next_item must reference a current TaskItem");
      fail2(["PLANNED", "BLOCKED"].includes(byId.get(gate.satisfied_next_item).status), "BLOCKED owner_gate satisfied_next_item must remain a pending lifecycle target");
    }
    fail2(task.status === "BLOCKED", "A BLOCKED owner_gate requires BLOCKED task status");
    fail2(gate.satisfied_plan_revision_id !== task.plan_revision_id, "A BLOCKED owner_gate must target a new plan revision");
    fail2(task.current_item === null, "A BLOCKED owner_gate requires current_item=null");
    fail2(task.next_item === gate.item_id, "A BLOCKED owner_gate must own task.next_item");
    fail2(byId.get(gate.item_id).status === "BLOCKED", "A BLOCKED owner_gate must protect a BLOCKED TaskItem");
    fail2(inProgress.length === 0, "A BLOCKED owner_gate forbids IN_PROGRESS TaskItems");
    return;
  }
  fail2(Object.hasOwn(gate, "satisfied_at") && Object.hasOwn(gate, "satisfied_by"), "A SATISFIED owner_gate requires satisfied_at and satisfied_by audit fields");
  try {
    canonicalUtc(gate.satisfied_at, "owner_gate satisfied_at");
  } catch (error) {
    throw new GuardianError("OWNER_GATE_INVALID", error.message);
  }
  fail2(isAuthorizedHumanActor(gate.satisfied_by), "A SATISFIED owner_gate requires a bounded human:* satisfied_by actor");
  if (Object.hasOwn(gate, "post_fix_continuity")) fail2(gate.post_fix_continuity === "PASS", "Historical owner_gate post_fix_continuity must be the observed PASS value");
  if (Object.hasOwn(gate, "final_acceptance")) fail2(gate.final_acceptance === "PASS", "Historical owner_gate final_acceptance must be the observed PASS value");
}
function validateSatisfiedOwnerGateTransition(base, candidate, actor, now) {
  const fail2 = (condition, message) => invariant(condition, "OWNER_GATE_TRANSITION_INVALID", message);
  const gate = base.owner_gate;
  fail2(gate?.kind === "HANDOFF_CONFIRM" && gate.status === "BLOCKED", "The base owner gate must be a BLOCKED HANDOFF_CONFIRM gate");
  fail2(!Object.hasOwn(gate, "satisfied_task_status") || gate.satisfied_task_status === "IN_PROGRESS", "The owner gate target task status must be IN_PROGRESS");
  fail2(!containsCanonicalCommandMention(gate.satisfied_next_step, gate.command), "The target next step must not repeat the authorization command or an alias");
  const protectedItem = base.task_items.find((item) => item.task_item_id === gate.item_id);
  fail2(protectedItem?.status === "BLOCKED" && base.status === "BLOCKED" && base.current_item === null && base.next_item === gate.item_id, "The protected base lifecycle is not satisfiable");
  if (gate.satisfied_next_item !== void 0 && gate.satisfied_next_item !== null) {
    const next = base.task_items.find((item) => item.task_item_id === gate.satisfied_next_item);
    fail2(gate.satisfied_next_item !== gate.item_id && next && ["PLANNED", "BLOCKED"].includes(next.status), "satisfied_next_item must be a different current PLANNED or BLOCKED item");
  }
  assertExactSatisfiedOwnerGateTransition(base, candidate, actor, now);
}
function validateTaskLedger(task) {
  strictJsonClone(task, { code: "LEDGER_JSON_DOMAIN_INVALID", field: "Ledger", clone: false });
  invariant(task !== null && typeof task === "object" && !Array.isArray(task), "LEDGER_FIELD_INVALID", "Ledger must be a JSON object");
  for (const field of TASK_REQUIRED_FIELDS) invariant(Object.hasOwn(task, field), "LEDGER_FIELD_MISSING", `Ledger missing ${field}`);
  invariant(task.schema_version === "0.1.0", "LEDGER_SCHEMA_UNSUPPORTED");
  boundedString(task.task_id, "task_id", { id: true });
  boundedString(task.title, "title");
  boundedString(task.objective, "objective");
  boundedString(task.requirements_version, "requirements_version", { id: true });
  boundedString(task.plan_revision_id, "plan_revision_id", { id: true });
  invariant(TASK_STATES.has(task.status), "LEDGER_STATUS_INVALID", `task ${TASK_STATUS_MESSAGE}`);
  boundedStringArray(task.completion_criteria, "completion_criteria", { nonEmpty: true });
  boundedString(task.risk, "risk");
  canonicalUtc(task.created_at, "created_at");
  canonicalUtc(task.updated_at, "updated_at");
  boundedString(task.next_step, "next_step");
  if (task.current_item !== null) boundedString(task.current_item, "current_item", { id: true });
  if (task.next_item !== null) boundedString(task.next_item, "next_item", { id: true });
  if (Object.hasOwn(task, "evidence")) boundedStringArray(task.evidence, "evidence");
  if (["DROPPED", "SUPERSEDED"].includes(task.status)) validateTerminalProvenance(task, "Task");
  if (Object.hasOwn(task, "minimal_reads")) validateBoundedStringList(task.minimal_reads, "minimal_reads");
  canonicalRequiredLocalPaths(Object.hasOwn(task, "required_local_paths") ? task.required_local_paths : []);
  invariant(Array.isArray(task.task_items) && task.task_items.length > 0 && task.task_items.length <= MAX_LEDGER_LIST_ENTRIES, "LEDGER_ITEMS_INVALID", "task_items must be a non-empty bounded array");
  const ids = /* @__PURE__ */ new Set();
  for (const item of task.task_items) {
    invariant(item !== null && typeof item === "object" && !Array.isArray(item), "LEDGER_ITEM_FIELDS_INVALID", "TaskItem must be a JSON object");
    for (const field of ITEM_REQUIRED_FIELDS) invariant(Object.hasOwn(item, field), "LEDGER_FIELD_MISSING", `TaskItem missing ${field}`);
    boundedString(item.task_item_id, "task_item_id", { id: true });
    invariant(!ids.has(item.task_item_id), "LEDGER_ITEM_ID_INVALID", "task_item_id must be unique");
    boundedString(item.task_id, "TaskItem task_id", { id: true });
    invariant(item.task_id === task.task_id, "LEDGER_TASK_ID_MISMATCH");
    boundedString(item.title, "TaskItem title");
    boundedString(item.description, "TaskItem description");
    invariant(TASK_STATES.has(item.status), "LEDGER_ITEM_STATUS_INVALID", `item ${TASK_STATUS_MESSAGE}`);
    boundedStringArray(item.depends_on, "depends_on", { ids: true });
    invariant(new Set(item.depends_on).size === item.depends_on.length, "LEDGER_DEPENDENCY_INVALID", "depends_on must not contain duplicates");
    boundedStringArray(item.completion_criteria, "TaskItem completion_criteria", { nonEmpty: true });
    boundedStringArray(item.evidence, "TaskItem evidence");
    boundedStringArray(item.requirements_refs, "requirements_refs", { ids: true });
    boundedString(item.risk, "TaskItem risk");
    boundedString(item.milestone, "milestone", { id: true });
    canonicalUtc(item.last_updated_at, "last_updated_at");
    boundedString(item.last_updated_by, "last_updated_by");
    for (const field of ITEM_OPTIONAL_ID_FIELDS) if (Object.hasOwn(item, field)) boundedString(item[field], field, { id: true });
    if (["DROPPED", "SUPERSEDED"].includes(item.status)) validateTerminalProvenance(item, `TaskItem ${item.task_item_id}`);
    if (item.status === "DONE") invariant(item.evidence.length > 0, "DONE_WITHOUT_EVIDENCE");
    ids.add(item.task_item_id);
  }
  if (task.status === "DONE") {
    invariant(Array.isArray(task.evidence) && task.evidence.length > 0, "DONE_WITHOUT_EVIDENCE");
    invariant(task.task_items.every((item) => ["DONE", "DROPPED", "SUPERSEDED"].includes(item.status)), "DONE_WITH_OPEN_ITEMS");
  }
  for (const item of task.task_items) for (const dependency of item.depends_on) invariant(ids.has(dependency), "LEDGER_DEPENDENCY_UNKNOWN", dependency);
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const byId = new Map(task.task_items.map((item) => [item.task_item_id, item]));
  for (const item of task.task_items) {
    for (const field of ["supersedes", "superseded_by"]) if (Object.hasOwn(item, field)) {
      invariant(item[field] !== item.task_item_id && byId.has(item[field]), "LEDGER_SUPERSESSION_INVALID", `${item.task_item_id}.${field} must reference another existing TaskItem`);
    }
  }
  const visit = (id) => {
    invariant(!visiting.has(id), "LEDGER_DAG_CYCLE", id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  const inProgress = task.task_items.filter((item) => item.status === "IN_PROGRESS");
  invariant(inProgress.length <= 1, "LEDGER_MULTIPLE_CURRENT_ITEMS", "at most one item may be IN_PROGRESS");
  invariant(task.current_item === null || ids.has(task.current_item), "LEDGER_CURRENT_ITEM_INVALID", "current_item must be null or reference an existing item");
  invariant(task.next_item === null || ids.has(task.next_item), "LEDGER_NEXT_ITEM_INVALID", "next_item must be null or reference an existing item");
  invariant(task.current_item !== task.next_item || task.current_item === null, "LEDGER_LIFECYCLE_INVALID", "current_item and next_item must differ");
  if (task.current_item === null) invariant(inProgress.length === 0, "LEDGER_CURRENT_ITEM_MISMATCH", "current_item must reference the sole IN_PROGRESS item, or be null when none is IN_PROGRESS");
  else invariant(inProgress.length === 1 && inProgress[0].task_item_id === task.current_item, "LEDGER_CURRENT_ITEM_MISMATCH", "current_item must reference the sole IN_PROGRESS item");
  if (task.next_item !== null) invariant(["PLANNED", "BLOCKED"].includes(byId.get(task.next_item).status), "LEDGER_NEXT_ITEM_INVALID", "next_item must reference a PLANNED or BLOCKED item");
  if (task.status === "DONE") invariant(task.current_item === null && task.next_item === null, "DONE_WITH_OPEN_LIFECYCLE");
  validateOwnerGate(task, byId, inProgress);
  return task;
}
function ledgerResult(task, contentDigest, path) {
  return Object.freeze({
    ...structuredClone(task),
    content_digest: contentDigest,
    path,
    current_item: task.current_item,
    next_item: task.next_item
  });
}
var TaskLedger = class {
  #writer;
  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve3(path);
    this.#writer = options.writer ?? new PlanRevisionWriter(this.path, options.writerOptions);
    const coordinateExactPlan = (expected, use, code, message) => this.#writer.coordinate({
      validate: validateTaskLedger,
      use: (observed) => {
        const plan2 = ledgerResult(observed.task, observed.contentDigest, this.path);
        invariant(
          plan2.task_id === expected?.taskId && plan2.plan_revision_id === expected?.planRevisionId && plan2.content_digest === expected?.contentDigest,
          code,
          message
        );
        return use(plan2);
      }
    });
    registerTrustedHandoffPlanCapability(this, {
      attest: (expected, reserve) => coordinateExactPlan(
        expected,
        reserve,
        "HANDOFF_CONSENT_STALE",
        "The authoritative plan changed before durable handoff reservation"
      ),
      attestRecovery: (expected, capture) => coordinateExactPlan(
        expected,
        capture,
        "PLAN_REVISION_MISMATCH",
        "The authoritative plan no longer matches the failed handoff recovery provenance"
      ),
      attestResume: (expected, capture) => coordinateExactPlan(
        expected,
        capture,
        "RESUME_EXPECTATION_STALE",
        "The authoritative plan changed after resume confirmation was displayed"
      ),
      attestCurrentTakeover: (claim, deadline = null) => this.#writer.coordinate({
        validate: validateTaskLedger,
        use: (observed) => claim(ledgerResult(observed.task, observed.contentDigest, this.path)),
        deadline
      }),
      satisfyOwnerGate: (request, assertEligible) => this.#satisfyOwnerGate(request, assertEligible)
    });
  }
  read() {
    const observed = this.#writer.readCurrent({ validate: validateTaskLedger });
    return ledgerResult(observed.task, observed.contentDigest, this.path);
  }
  #satisfyOwnerGate({ command, actor, expected = null }, assertEligible = null) {
    return this.#writer.commit({
      expected,
      validate: validateTaskLedger,
      prepare: (observed) => {
        const task = structuredClone(observed.task);
        const eligibility = assertEligible?.();
        invariant(
          !eligibility || typeof eligibility.then !== "function",
          "HANDOFF_OWNER_GATE_AUTHORITY_INVALID",
          "Task ownership eligibility must remain synchronous under plan coordination"
        );
        const gate = task.owner_gate;
        if (!gate || gate.status === "SATISFIED") return { noWrite: true, result: ledgerResult(task, observed.contentDigest, this.path) };
        invariant(gate.kind === "HANDOFF_CONFIRM" && gate.status === "BLOCKED", "OWNER_GATE_INVALID");
        invariant(
          canonicalOwnerCommand(gate.command) === HANDOFF_CONFIRM_CANONICAL_COMMAND && canonicalOwnerCommand(command) === HANDOFF_CONFIRM_CANONICAL_COMMAND && isAuthorizedHumanActor(actor),
          "OWNER_GATE_AUTHORIZATION_REQUIRED"
        );
        invariant(task.current_item === null && task.next_item === gate.item_id, "OWNER_GATE_LIFECYCLE_MISMATCH");
        const item = task.task_items.find((candidate) => candidate.task_item_id === gate.item_id);
        invariant(item?.status === "BLOCKED", "OWNER_GATE_ITEM_NOT_BLOCKED");
        invariant(typeof gate.satisfied_plan_revision_id === "string" && gate.satisfied_plan_revision_id !== task.plan_revision_id, "OWNER_GATE_REVISION_REQUIRED");
        invariant(typeof gate.satisfied_next_step === "string" && gate.satisfied_next_step.length > 0 && !containsCanonicalCommandMention(gate.satisfied_next_step, gate.command), "OWNER_GATE_NEXT_STEP_INVALID");
        const now = utcNow();
        gate.status = "SATISFIED";
        gate.satisfied_at = now;
        gate.satisfied_by = actor;
        task.plan_revision_id = gate.satisfied_plan_revision_id;
        task.status = "IN_PROGRESS";
        task.updated_at = now;
        task.current_item = gate.item_id;
        task.next_item = gate.satisfied_next_item ?? null;
        task.next_step = gate.satisfied_next_step;
        item.status = "IN_PROGRESS";
        item.last_updated_at = now;
        item.last_updated_by = actor;
        validateSatisfiedOwnerGateTransition(observed.task, task, actor, now);
        validateTaskLedger(task);
        const json = JSON.stringify(task, null, 2).replaceAll("\n", observed.block.lineEnding);
        const { text } = materializeLedgerMarkdown(observed, {
          json,
          metadata: { plan_revision_id: task.plan_revision_id, updated_at: now },
          allowSchemalessCompact: true
        });
        const bytes = Buffer.from(text, "utf8");
        return { bytes, result: ledgerResult(task, sha256(bytes), this.path) };
      }
    });
  }
  validate(task) {
    return validateTaskLedger(task);
  }
};

// src/repository.mjs
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync2, lstatSync as lstatSync3, readFileSync as readFileSync3, realpathSync as realpathSync3, statSync } from "node:fs";
import { dirname as dirname2, isAbsolute, join as join2, relative as relative2, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";
var REPOSITORY_CONFIG_SCHEMA = "aiopago.repository/1.0.0";
var LEGACY_REPOSITORY_CONFIG_SCHEMA = "eiopago.repository/1.0.0";
var REPOSITORY_CONFIG_FILE = ".guardian/config.json";
var INSTALLATION_URL = typeof __AIOPAGO_OPERATIONAL_ENTRY_URL__ === "string" ? __AIOPAGO_OPERATIONAL_ENTRY_URL__ : import.meta.url;
var INSTALLATION_ROOT = resolve4(dirname2(fileURLToPath(INSTALLATION_URL)), "..");
var DEFAULT_REPOSITORY_CONFIG = Object.freeze({
  schema_version: REPOSITORY_CONFIG_SCHEMA,
  task_ledger: "TASK_PLAN.md",
  runtime_root: ".guardian/runtime",
  artifact_root: ".guardian"
});
var GIT_FAILURE_INSPECTION_LIMIT = 64 * 1024;
function boundedErrorText(value) {
  if (typeof value === "string") return value.slice(0, GIT_FAILURE_INSPECTION_LIMIT);
  if (Buffer.isBuffer(value)) return value.subarray(0, GIT_FAILURE_INSPECTION_LIMIT).toString("utf8");
  return "";
}
function dubiousOwnershipTarget(error) {
  if (error?.status !== 128) return null;
  const diagnostic2 = [boundedErrorText(error?.stderr), boundedErrorText(error?.message)].filter(Boolean).join("\n");
  const ownership = /^fatal:\s*detected dubious ownership in repository at '(.+)'\r?$/im.exec(diagnostic2);
  if (!ownership || !/^[ \t]*git config --global --add safe\.directory[ \t]+\S.*\r?$/im.test(diagnostic2)) return null;
  return ownership[1];
}
function gitCompatiblePath(path) {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}
function commandArgument(path) {
  return /^[A-Za-z0-9_./:+-]+$/.test(path) ? path : JSON.stringify(path);
}
function runGit(cwd, args, execFile = execFileSync3) {
  try {
    return execFile("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (error?.code === "ENOENT") invariant(false, "GIT_UNAVAILABLE", "Git is required but was not found on PATH");
    const ownershipTarget = dubiousOwnershipTarget(error);
    if (ownershipTarget) {
      const target = gitCompatiblePath(ownershipTarget);
      const command = `git config --global --add safe.directory ${commandArgument(target)}`;
      invariant(false, "GIT_SAFE_DIRECTORY_REQUIRED", `Git requires explicit trust for this worktree:
${target}

If you trust this repository, run manually:

${command}

Aiopago does not modify Git global configuration automatically.`);
    }
    invariant(false, "TARGET_NOT_GIT_WORKTREE", `Target is not a supported Git worktree: ${cwd}`);
  }
}
function samePath2(left, right) {
  const a = resolve4(left);
  const b = resolve4(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function realDirectory(path) {
  const absolute = resolve4(path);
  invariant(existsSync2(absolute), "TARGET_PATH_NOT_FOUND", `Target path does not exist: ${absolute}`);
  invariant(statSync(absolute).isDirectory(), "TARGET_PATH_NOT_DIRECTORY", `Target path is not a directory: ${absolute}`);
  return realpathSync3(absolute);
}
function inspectReservedPath(path, expectedType) {
  let stat;
  try {
    stat = lstatSync3(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  invariant(!stat.isSymbolicLink(), "REPOSITORY_STATE_PATH_REDIRECTED", `Refusing redirected Aiopago state path: ${path}`);
  invariant(expectedType === "directory" ? stat.isDirectory() : stat.isFile(), "REPOSITORY_STATE_PATH_TYPE_INVALID", `${path} must be a ${expectedType}`);
  invariant(samePath2(realpathSync3(path), path), "REPOSITORY_STATE_PATH_REDIRECTED", `Refusing redirected Aiopago state path: ${path}`);
}
function validateRepositoryStateBoundaries(targetRoot) {
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
    [".gitignore", "file"]
  ];
  for (const [localPath, expectedType] of reserved) inspectReservedPath(join2(targetRoot, localPath), expectedType);
}
function discoverTargetRepository(input = process.cwd(), options = {}) {
  const startPath = realDirectory(resolve4(options.baseDirectory ?? process.cwd(), input));
  const inside = runGit(startPath, ["rev-parse", "--is-inside-work-tree"], options.execFile);
  invariant(inside === "true", "TARGET_NOT_GIT_WORKTREE", `Target is not inside a Git worktree: ${startPath}`);
  const gitRoot = runGit(startPath, ["rev-parse", "--show-toplevel"], options.execFile);
  const targetRoot = realDirectory(gitRoot);
  const observedAgain = runGit(targetRoot, ["rev-parse", "--show-toplevel"], options.execFile);
  invariant(samePath2(realDirectory(observedAgain), targetRoot), "GIT_WORKTREE_MISMATCH", `Git root changed while discovering target: ${targetRoot}`);
  return targetRoot;
}
function resolveInside(targetRoot, configuredPath, field) {
  invariant(typeof configuredPath === "string" && configuredPath.length > 0 && !isAbsolute(configuredPath), "REPOSITORY_CONFIG_PATH_INVALID", `${field} must be a non-empty relative path`);
  const absolute = resolve4(targetRoot, configuredPath);
  const rel = relative2(targetRoot, absolute);
  invariant(rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel), "REPOSITORY_CONFIG_PATH_ESCAPE", `${field} escapes the target repository`);
  return absolute;
}
function validateRepositoryConfig(config, targetRoot) {
  invariant(config && typeof config === "object" && !Array.isArray(config), "REPOSITORY_CONFIG_INVALID", "Aiopago repository config must be a JSON object");
  invariant([REPOSITORY_CONFIG_SCHEMA, LEGACY_REPOSITORY_CONFIG_SCHEMA].includes(config.schema_version), "REPOSITORY_CONFIG_SCHEMA_UNSUPPORTED", `Expected ${REPOSITORY_CONFIG_SCHEMA} or legacy ${LEGACY_REPOSITORY_CONFIG_SCHEMA}`);
  const expectedFields = Object.keys(DEFAULT_REPOSITORY_CONFIG).sort();
  invariant(JSON.stringify(Object.keys(config).sort()) === JSON.stringify(expectedFields), "REPOSITORY_CONFIG_FIELDS_INVALID", `Supported fields: ${expectedFields.join(", ")}`);
  const taskLedgerPath = resolveInside(targetRoot, config.task_ledger, "task_ledger");
  const runtimeRoot = resolveInside(targetRoot, config.runtime_root, "runtime_root");
  const artifactRoot = resolveInside(targetRoot, config.artifact_root, "artifact_root");
  for (const field of ["task_ledger", "runtime_root", "artifact_root"]) invariant(config[field] === DEFAULT_REPOSITORY_CONFIG[field], "REPOSITORY_CONFIG_LAYOUT_UNSUPPORTED", `${field} must be ${DEFAULT_REPOSITORY_CONFIG[field]} in this alpha`);
  const configRoot = join2(targetRoot, ".guardian");
  invariant(runtimeRoot !== configRoot && runtimeRoot !== targetRoot, "REPOSITORY_CONFIG_ROOT_INVALID", "runtime_root must be separate from config and target roots");
  invariant(artifactRoot !== targetRoot, "REPOSITORY_CONFIG_ROOT_INVALID", "artifact_root must not be the target root");
  return Object.freeze({
    installationRoot: INSTALLATION_ROOT,
    targetRoot,
    configRoot,
    configPath: join2(targetRoot, REPOSITORY_CONFIG_FILE),
    runtimeRoot,
    artifactRoot,
    taskLedgerPath,
    config: Object.freeze(structuredClone(config))
  });
}
function readRepositoryConfig(targetRoot) {
  validateRepositoryStateBoundaries(targetRoot);
  const path = join2(targetRoot, REPOSITORY_CONFIG_FILE);
  invariant(existsSync2(path), "REPOSITORY_NOT_INITIALIZED", `Aiopago is not initialized in ${targetRoot}; run 'aio init' first`);
  let config;
  try {
    config = JSON.parse(readFileSync3(path, "utf8"));
  } catch (error) {
    invariant(false, "REPOSITORY_CONFIG_JSON_INVALID", `${path}: ${error.message}`);
  }
  return validateRepositoryConfig(config, targetRoot);
}
function loadRepositoryContext(input = process.cwd(), options = {}) {
  return readRepositoryConfig(discoverTargetRepository(input, options));
}

// src/runtime-reader.mjs
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "node:fs";
import { resolve as resolve5 } from "node:path";
var SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);
function boundedRuntimeError(error) {
  return Object.freeze({
    code: error?.code ?? "RUNTIME_READ_FAILED",
    message: String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 320)
  });
}
function runtimeFailure(code, message) {
  throw new GuardianError(code, message);
}
function defaultProbe(path) {
  return Object.freeze({
    database: existsSync3(path),
    sidecars: SIDECAR_SUFFIXES.filter((suffix) => existsSync3(`${path}${suffix}`))
  });
}
function assertStableCleanProbes(first, second) {
  if (!first.database || !second.database) runtimeFailure("RUNTIME_CHANGED_DURING_READ", "Runtime database appeared or disappeared during observation");
  if (first.sidecars.length > 0 || second.sidecars.length > 0) {
    runtimeFailure("RUNTIME_NOT_QUIESCENT", "Runtime SQLite is concurrent or has WAL/SHM/journal state; an external observer cannot verify it safely");
  }
}
function notVerified(available, condition, message) {
  return Object.freeze({
    available,
    workflow: "NEEDS_ATTENTION",
    condition,
    error: Object.freeze({ code: "RUNTIME_NOT_VERIFIED", message })
  });
}
function readRuntimeProjection(path, _plan = null, options = {}) {
  const absolute = resolve5(path);
  const probe = options.probeRuntimeFiles ?? defaultProbe;
  const readBytes = options.readFile ?? readFileSync4;
  const absentFirst = probe(absolute);
  const absentSecond = probe(absolute);
  if (!absentFirst.database && !absentSecond.database && absentFirst.sidecars.length === 0 && absentSecond.sidecars.length === 0) {
    return notVerified(false, "NO_RUNTIME_DATABASE", "No canonical core runtime observation was produced");
  }
  let primaryError = null;
  let beforeDigest = null;
  try {
    const beforeBytes = readBytes(absolute);
    const second = probe(absolute);
    assertStableCleanProbes(absentFirst, second);
    beforeDigest = sha256(beforeBytes);
  } catch (error) {
    primaryError = error;
  }
  try {
    const third = probe(absolute);
    const afterBytes = readBytes(absolute);
    const fourth = probe(absolute);
    assertStableCleanProbes(third, fourth);
    if (beforeDigest !== null && sha256(afterBytes) !== beforeDigest) runtimeFailure("RUNTIME_CHANGED_DURING_READ", "Runtime database changed during observation");
  } catch (error) {
    if (!primaryError) primaryError = error;
  }
  if (primaryError) {
    return Object.freeze({
      available: true,
      workflow: "NEEDS_ATTENTION",
      condition: "RUNTIME_UNVERIFIED",
      error: boundedRuntimeError(primaryError)
    });
  }
  return notVerified(true, "RUNTIME_AUTHORITY_PRESENT", "Persistent runtime authority exists but core 0.1 exposes no canonical read-only verifier");
}

// src/human-workflow.mjs
var TERMINAL_ITEM_STATES = /* @__PURE__ */ new Set(["DONE", "DROPPED", "SUPERSEDED"]);
var FAILED_HANDOFF_STATES = /* @__PURE__ */ new Set([
  "HANDOFF_FAILED",
  "CHECKPOINT_PERSIST_FAILED",
  "MANIFEST_PERSIST_FAILED",
  "RUNNER_OWNERSHIP_ATTESTATION_FAILED",
  "RESUME_DISPATCH_FAILED",
  "RESUME_DISPATCH_UNKNOWN"
]);
var PREPARING_HANDOFF_STATES = /* @__PURE__ */ new Set([
  "SAFE_TO_HANDOFF",
  "CHECKPOINT_PERSISTING",
  "CHECKPOINT_PERSISTED",
  "REPLACEMENT_SESSION_CREATING",
  "REPLACEMENT_SESSION_CREATED_PAUSED",
  "MANIFEST_PERSISTING",
  "MANIFEST_PERSISTED",
  "RESUME_ADMISSION_COMMITTED",
  "RESUME_DISPATCHING",
  "RESUME_DISPATCHED"
]);
var CRASH_INTENT_STATES = /* @__PURE__ */ new Set([
  "CHECKPOINT_PERSISTING",
  "REPLACEMENT_SESSION_CREATING",
  "MANIFEST_PERSISTING"
]);
var KNOWN_HANDOFF_STATES = /* @__PURE__ */ new Set([
  ...PREPARING_HANDOFF_STATES,
  ...FAILED_HANDOFF_STATES,
  "CONTINUITY_FAILED",
  "RESUME_READY",
  "RESUMED",
  "HUMAN_DECISION_REQUIRED"
]);
var HANDOFF_STATES_REQUIRING_TARGET = /* @__PURE__ */ new Set([
  "REPLACEMENT_SESSION_CREATED_PAUSED",
  "RUNNER_OWNERSHIP_ATTESTATION_FAILED",
  "MANIFEST_PERSISTING",
  "MANIFEST_PERSISTED",
  "CONTINUITY_FAILED",
  "RESUME_READY",
  "RESUME_ADMISSION_COMMITTED",
  "RESUME_DISPATCHING",
  "RESUME_DISPATCHED",
  "RESUME_DISPATCH_FAILED",
  "RESUME_DISPATCH_UNKNOWN",
  "RESUMED"
]);
var HANDOFF_STATES_REQUIRING_FAILURE = /* @__PURE__ */ new Set([...FAILED_HANDOFF_STATES, "CONTINUITY_FAILED"]);
function boundedText(value, length = 320) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}
function diagnostic(error, fallback = "READ_FAILED") {
  return Object.freeze({
    code: error?.code ?? fallback,
    message: boundedText(error?.message ?? error),
    source: error
  });
}
function publicDiagnostic(error, fallback = "READ_FAILED") {
  if (!error) return null;
  return {
    code: boundedText(error.code ?? fallback, 128) || fallback,
    message: boundedText(error.message ?? error)
  };
}
function projectedFailure(failure, fallback = "HANDOFF_FAILED") {
  if (!failure) return null;
  return {
    code: boundedText(failure.code ?? fallback, 128) || fallback,
    message: boundedText(failure.message ?? failure)
  };
}
function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function validIdentity(value, maximum = 320) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function deepFreeze(value, seen = /* @__PURE__ */ new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
function observeRawTaskPlan(path) {
  if (!existsSync4(path)) {
    const error = new GuardianError("LEDGER_NOT_FOUND", `Authoritative task plan not found: ${path}`);
    return Object.freeze({ path, exists: false, valid: null, bytes: null, text: null, digest: null, plan: null, error: diagnostic(error) });
  }
  try {
    const bytes = readFileSync5(path);
    return Object.freeze({ path, exists: true, valid: null, bytes, text: bytes.toString("utf8"), digest: sha256(bytes), plan: null, error: null });
  } catch (error) {
    return Object.freeze({ path, exists: true, valid: null, bytes: null, text: null, digest: null, plan: null, error: diagnostic(error, "LEDGER_READ_FAILED") });
  }
}
function observeTaskPlan(path, options = {}) {
  const raw = (options.observeRawTaskPlan ?? observeRawTaskPlan)(path);
  if (!raw.exists || raw.error) return Object.freeze({ ...raw, valid: false });
  try {
    const plan2 = (options.readTaskLedger ?? (() => new TaskLedger(path).read()))();
    if (plan2.content_digest !== raw.digest) throw new GuardianError("PLAN_CHANGED_DURING_READ", "TASK_PLAN.md changed while it was being observed; read it again");
    return Object.freeze({ ...raw, valid: true, plan: plan2, error: null });
  } catch (error) {
    return Object.freeze({ ...raw, valid: false, plan: null, error: diagnostic(error, "LEDGER_READ_FAILED") });
  }
}
var EMPTY_RUNTIME = Object.freeze({
  available: false,
  verified: false,
  workflow: "NEEDS_ATTENTION",
  condition: "RUNTIME_NOT_OBSERVED",
  error: Object.freeze({ code: "RUNTIME_NOT_VERIFIED", message: "No canonical core runtime observation was produced" })
});
function observeHumanWorkflow(input = process.cwd(), options = {}) {
  const targetRoot = (options.discoverTargetRepository ?? discoverTargetRepository)(input, options.repositoryOptions);
  const configPath = join3(targetRoot, REPOSITORY_CONFIG_FILE);
  if (!existsSync4(configPath)) {
    return Object.freeze({ initialized: false, targetRoot, repository: null, configError: null, plan: null, runtime: EMPTY_RUNTIME });
  }
  let repository;
  try {
    repository = (options.readRepositoryConfig ?? readRepositoryConfig)(targetRoot);
  } catch (error) {
    return Object.freeze({ initialized: true, targetRoot, repository: null, configError: diagnostic(error, "REPOSITORY_CONFIG_READ_FAILED"), plan: null, runtime: EMPTY_RUNTIME });
  }
  const plan2 = options.planMode === "raw" ? (options.observeRawTaskPlan ?? observeRawTaskPlan)(repository.taskLedgerPath) : (options.observeTaskPlan ?? observeTaskPlan)(repository.taskLedgerPath, options.planOptions);
  const runtime = plan2.valid && options.includeRuntime !== false ? (options.readRuntimeProjection ?? readRuntimeProjection)(join3(repository.runtimeRoot, "guardian.sqlite"), plan2.plan, options.runtimeOptions) : EMPTY_RUNTIME;
  return Object.freeze({ initialized: true, targetRoot, repository, configError: null, plan: plan2, runtime });
}
function safeContextUsage(ctx) {
  try {
    const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
    if (!usage || !Number.isFinite(usage.percent)) return { availability: "unavailable", percent: null, tokens: null, contextWindow: null };
    return {
      availability: "available",
      percent: usage.percent,
      tokens: Number.isFinite(usage.tokens) ? usage.tokens : null,
      contextWindow: Number.isFinite(usage.contextWindow) ? usage.contextWindow : null
    };
  } catch (error) {
    return { availability: "unavailable", percent: null, tokens: null, contextWindow: null, error: publicDiagnostic(error, "CONTEXT_USAGE_READ_FAILED") };
  }
}
function latchIdentity(latch) {
  return latch ? { state: latch.state, generation: latch.generation, reason: latch.reason ?? null } : null;
}
function handoffIdentity(handoff) {
  return handoff ? {
    handoff_id: handoff.handoff_id,
    state: handoff.state,
    task_id: handoff.task_id ?? null,
    source_session_id: handoff.source_session_id ?? null,
    target_session_id: handoff.target_session_id ?? null,
    runner_instance_id: handoff.runner_instance_id ?? null,
    task_plan_revision: handoff.task_plan_revision ?? null,
    task_plan_digest: handoff.task_plan_digest ?? null,
    latch_generation: handoff.latch_generation ?? null,
    authorization_state: handoff.authorization_state ?? null,
    admission_state: handoff.admission_state ?? null,
    dispatch_state: handoff.dispatch_state ?? null,
    failure: projectedFailure(handoff.failure, handoff.state)
  } : null;
}
function observedHandoffFailure(handoff) {
  if (!handoff) return null;
  if (handoff.failure) return publicDiagnostic(handoff.failure, handoff.state);
  if (!HANDOFF_STATES_REQUIRING_FAILURE.has(handoff.state)) return null;
  return { code: handoff.state, message: `Handoff runtime is in ${handoff.state}` };
}
function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function observeRunnerHumanWorkflow(runner, ctx = null, options = {}) {
  const readPlan = options.observeTaskPlan ?? observeTaskPlan;
  const planOptions = { readTaskLedger: () => runner.ledger.read() };
  const firstPlan = readPlan(runner.ledger.path, planOptions);
  const base = {
    initialized: true,
    targetRoot: runner.roots?.targetRoot ?? runner.cwd ?? null,
    repository: {
      taskLedgerPath: runner.ledger.path,
      runtimeRoot: runner.roots?.runtimeRoot ?? null,
      artifactRoot: runner.roots?.artifactRoot ?? null
    },
    configError: null,
    plan: firstPlan
  };
  if (!firstPlan.valid) return Object.freeze({ ...base, runtime: EMPTY_RUNTIME });
  try {
    const taskId = firstPlan.plan.task_id;
    const sessionBefore = runner.runtime?.session ?? null;
    if (!sessionBefore?.sessionId) throw new GuardianError("RUNTIME_SESSION_UNAVAILABLE", "The live Runner session cannot be observed");
    const latchBefore = runner.storage.getLatch(taskId);
    if (!latchBefore) throw new GuardianError("RUNTIME_LATCH_UNAVAILABLE", "The live Runner has no latch observation for the authoritative task");
    const handoffBefore = runner.storage.latestHandoffForTask(taskId);
    const git2 = runner.handoffService.observeGit();
    const context = safeContextUsage(ctx);
    const latchAfter = runner.storage.getLatch(taskId);
    const handoffAfter = runner.storage.latestHandoffForTask(taskId);
    const sessionAfter = runner.runtime?.session ?? null;
    const secondPlan = readPlan(runner.ledger.path, planOptions);
    if (!secondPlan.valid || firstPlan.digest !== secondPlan.digest || sessionBefore?.sessionId !== sessionAfter?.sessionId || !sameIdentity(latchIdentity(latchBefore), latchIdentity(latchAfter)) || !sameIdentity(handoffIdentity(handoffBefore), handoffIdentity(handoffAfter))) {
      return Object.freeze({
        ...base,
        plan: secondPlan.valid ? secondPlan : firstPlan,
        runtime: Object.freeze({
          available: true,
          verified: false,
          workflow: "NEEDS_ATTENTION",
          condition: "RUNTIME_CHANGED_DURING_READ",
          error: Object.freeze({ code: "RUNTIME_CHANGED_DURING_READ", message: "Live Runner state changed during observation; observe it again" })
        })
      });
    }
    const session = sessionAfter;
    const handoff = handoffAfter;
    const binding = handoff?.target_session_id === session?.sessionId ? runner.storage.getRunnerSessionBinding(handoff.handoff_id) : null;
    const model = session?.model?.provider && session?.model?.id ? `${session.model.provider}/${session.model.id}` : null;
    return Object.freeze({
      ...base,
      plan: secondPlan,
      runtime: deepFreeze({
        available: true,
        verified: true,
        workflow: "LIVE_RUNNER",
        condition: "LIVE_RUNNER",
        error: null,
        planIdentity: {
          taskId: secondPlan.plan.task_id,
          revision: secondPlan.plan.plan_revision_id,
          digest: secondPlan.digest
        },
        latch: latchIdentity(latchAfter),
        handoff: handoff ? {
          ...handoffIdentity(handoff),
          failure: observedHandoffFailure(handoff),
          manual_recovery: Array.isArray(handoff.manual_recovery) ? handoff.manual_recovery.map((line) => boundedText(line, 640)) : []
        } : null,
        session: {
          id: session?.sessionId ?? null,
          model,
          reasoning: session?.thinkingLevel ?? null,
          runnerInstanceId: runner.runnerInstanceId ?? null,
          ownership: binding ? `replacement:${binding.status}` : "source"
        },
        git: {
          repository: git2.repository_id ?? null,
          worktree: git2.workdir ?? null,
          branch: git2.branch ?? null,
          head: git2.head_sha ?? null,
          base: git2.base_sha ?? null,
          indexDigest: git2.index_digest ?? null,
          worktreeDigest: git2.worktree_digest ?? null
        },
        context: {
          ...context,
          thresholdPercent: runner.contextAdvisor?.thresholdPercent ?? null,
          recommended: context.percent !== null && Number.isFinite(runner.contextAdvisor?.thresholdPercent) ? context.percent >= runner.contextAdvisor.thresholdPercent : false
        }
      })
    });
  } catch (error) {
    return Object.freeze({
      ...base,
      runtime: Object.freeze({
        available: true,
        verified: false,
        workflow: "NEEDS_ATTENTION",
        condition: "RUNTIME_READ_FAILED",
        error: Object.freeze(publicDiagnostic(error, "RUNTIME_READ_FAILED"))
      })
    });
  }
}
function invalidRuntime(message) {
  return Object.freeze({
    valid: false,
    error: Object.freeze({ code: "RUNTIME_OBSERVATION_INVALID", message: boundedText(message) })
  });
}
function validateRuntimeObservationUnchecked(runtime, planObservation) {
  if (!isPlainRecord(runtime)) return invalidRuntime("The verified runtime observation is not a record");
  if (runtime.available !== true || runtime.verified !== true || runtime.workflow !== "LIVE_RUNNER" || runtime.condition !== "LIVE_RUNNER" || runtime.error !== null || runtime.failure !== void 0 && runtime.failure !== null) {
    return invalidRuntime("The verified runtime claim has contradictory availability, workflow, condition, or error fields");
  }
  const plan2 = planObservation?.valid === true ? planObservation.plan : null;
  if (!plan2 || !isPlainRecord(runtime.planIdentity) || runtime.planIdentity.taskId !== plan2.task_id || runtime.planIdentity.revision !== plan2.plan_revision_id || runtime.planIdentity.digest !== planObservation.digest) {
    return invalidRuntime("The verified runtime is not bound to the authoritative task, revision, and digest");
  }
  if (!isPlainRecord(runtime.session) || !validIdentity(runtime.session.id) || !validIdentity(runtime.session.runnerInstanceId) || !validIdentity(runtime.session.model) || !(runtime.session.reasoning === null || runtime.session.reasoning === void 0 || validIdentity(runtime.session.reasoning)) || !(runtime.session.ownership === "source" || /^replacement:(ACTIVE|SUPERSEDED)$/.test(runtime.session.ownership ?? ""))) {
    return invalidRuntime("The verified runtime has no coherent session and Runner identity");
  }
  if (!isPlainRecord(runtime.latch) || !["ENGAGED", "RELEASED"].includes(runtime.latch.state) || !Number.isInteger(runtime.latch.generation) || runtime.latch.generation < 0 || !(runtime.latch.reason === null || runtime.latch.reason === void 0 || validIdentity(runtime.latch.reason)) || runtime.latch.state === "RELEASED" && runtime.latch.reason != null || runtime.latch.state === "ENGAGED" && !validIdentity(runtime.latch.reason)) {
    return invalidRuntime("The verified runtime has no valid latch identity");
  }
  if (runtime.handoff !== null) {
    const handoff = runtime.handoff;
    if (!isPlainRecord(handoff) || !validIdentity(handoff.handoff_id) || !KNOWN_HANDOFF_STATES.has(handoff.state) || handoff.task_id !== plan2.task_id || !validIdentity(handoff.source_session_id) || !validIdentity(handoff.runner_instance_id) || !validIdentity(handoff.task_plan_revision) || !validIdentity(handoff.task_plan_digest) || !Number.isInteger(handoff.latch_generation) || handoff.latch_generation < 0 || !(handoff.target_session_id === null || validIdentity(handoff.target_session_id)) || HANDOFF_STATES_REQUIRING_TARGET.has(handoff.state) && !validIdentity(handoff.target_session_id) || !["authorization_state", "admission_state", "dispatch_state"].every((key) => handoff[key] === null || validIdentity(handoff[key], 128)) || !Array.isArray(handoff.manual_recovery) || handoff.manual_recovery.some((line) => typeof line !== "string")) {
      return invalidRuntime("The verified runtime has a malformed or incoherent handoff identity");
    }
    if (HANDOFF_STATES_REQUIRING_FAILURE.has(handoff.state) && (!isPlainRecord(handoff.failure) || !validIdentity(handoff.failure.code, 128) || !validIdentity(handoff.failure.message, 4096))) {
      return invalidRuntime("The verified runtime failure state has no bounded failure code and message");
    }
    if (!HANDOFF_STATES_REQUIRING_FAILURE.has(handoff.state) && handoff.failure !== null) {
      return invalidRuntime("The verified runtime has a failure object that contradicts its handoff state");
    }
  }
  if (runtime.context !== void 0 && runtime.context !== null) {
    const context = runtime.context;
    if (!isPlainRecord(context) || !["available", "unavailable"].includes(context.availability) || typeof context.recommended !== "boolean" || !(context.percent === null || Number.isFinite(context.percent) && context.percent >= 0 && context.percent <= 100) || !(context.tokens === null || Number.isFinite(context.tokens)) || !(context.contextWindow === null || Number.isFinite(context.contextWindow)) || !(context.thresholdPercent === null || Number.isFinite(context.thresholdPercent) && context.thresholdPercent >= 0 && context.thresholdPercent <= 100) || context.availability === "unavailable" && (context.percent !== null || context.tokens !== null || context.contextWindow !== null || context.recommended) || context.recommended && (!Number.isFinite(context.percent) || !Number.isFinite(context.thresholdPercent) || context.percent < context.thresholdPercent)) {
      return invalidRuntime("The verified runtime has malformed or contradictory context evidence");
    }
  }
  if (runtime.git !== void 0 && runtime.git !== null && (!isPlainRecord(runtime.git) || Object.values(runtime.git).some((value) => value !== null && !validIdentity(value, 2048)))) {
    return invalidRuntime("The verified runtime Git evidence is malformed");
  }
  return Object.freeze({ valid: true, error: null });
}
function validateRuntimeObservation(runtime, planObservation) {
  try {
    return validateRuntimeObservationUnchecked(runtime, planObservation);
  } catch {
    return invalidRuntime("The verified runtime observation could not be safely inspected");
  }
}
function guidedHandoffEligibilityIdentity(observation) {
  if (observation?.plan?.valid !== true || observation?.runtime?.verified !== true) return null;
  if (!validateRuntimeObservation(observation.runtime, observation.plan).valid) return null;
  const runtime = observation.runtime;
  if (runtime.latch.state !== "RELEASED") return null;
  return guidedHandoffEligibilityIdentityFromAuthority({
    plan: { ...observation.plan.plan, content_digest: observation.plan.digest },
    sessionId: runtime.session.id,
    runnerInstanceId: runtime.session.runnerInstanceId,
    latch: runtime.latch,
    handoff: runtime.handoff
  });
}
function itemById(plan2, id) {
  return id ? plan2.task_items.find((item) => item.task_item_id === id) ?? null : null;
}
function progress(plan2) {
  const completed = plan2.task_items.filter((item) => TERMINAL_ITEM_STATES.has(item.status)).length;
  return { completed, total: plan2.task_items.length, remaining: plan2.task_items.length - completed };
}
function planSummary(observation) {
  const plan2 = observation.plan?.valid ? observation.plan.plan : null;
  if (!plan2) return null;
  return {
    status: plan2.status,
    nextStep: plan2.next_step,
    currentItem: plan2.current_item,
    nextItem: plan2.next_item,
    revision: plan2.plan_revision_id,
    taskId: plan2.task_id,
    requirementsVersion: plan2.requirements_version,
    digest: observation.plan.digest,
    artifact: observation.plan.path,
    modelPolicy: plan2.model_policy ?? null,
    reasoningPolicy: plan2.reasoning_policy ?? null,
    minimalReads: [...plan2.minimal_reads ?? []],
    requiredLocalPaths: [...plan2.required_local_paths ?? []],
    items: plan2.task_items.map((item) => ({ id: item.task_item_id, title: item.title, status: item.status }))
  };
}
function baseProjection(observation, fields) {
  const plan2 = observation.plan?.valid ? observation.plan.plan : null;
  const runtime = observation.runtime ?? EMPTY_RUNTIME;
  const diagnosticError = observation.configError ?? (!observation.plan?.valid ? observation.plan?.error : null) ?? runtime.error ?? (runtime.verified === true ? null : { code: "RUNTIME_NOT_VERIFIED", message: "No canonical core runtime observation was produced" });
  return {
    schema: "aiopago.human-workflow-projection/0.2-e",
    targetRoot: observation.targetRoot ?? null,
    planPath: observation.plan?.path ?? observation.repository?.taskLedgerPath ?? null,
    objective: plan2?.objective ?? null,
    title: plan2?.title ?? null,
    currentActivity: itemById(plan2 ?? { task_items: [] }, plan2?.current_item)?.title ?? null,
    progress: plan2 ? progress(plan2) : null,
    planSummary: planSummary(observation),
    runtimeSummary: {
      availability: runtime.verified === true ? "available" : runtime.available ? "unverified" : "unavailable",
      verified: runtime.verified === true,
      condition: runtime.condition ?? "RUNTIME_NOT_OBSERVED",
      context: runtime.context ? {
        availability: runtime.context.availability,
        percent: runtime.context.percent ?? null,
        tokens: runtime.context.tokens ?? null,
        contextWindow: runtime.context.contextWindow ?? null,
        thresholdPercent: runtime.context.thresholdPercent ?? null,
        recommended: runtime.context.recommended === true,
        error: publicDiagnostic(runtime.context.error, "CONTEXT_USAGE_READ_FAILED")
      } : null
    },
    humanControl: {
      latchState: runtime.latch?.state ?? "unverified",
      takeoverState: runtime.latch?.reason === "HUMAN_TAKEOVER" ? "active" : runtime.verified === true ? "inactive" : "unverified",
      reason: runtime.latch?.reason ?? null,
      generation: runtime.latch?.generation ?? null
    },
    handoff: {
      state: runtime.handoff?.state ?? (runtime.verified === true ? "none" : "unverified"),
      id: runtime.handoff?.handoff_id ?? null,
      actionability: "none",
      recommendation: runtime.context?.recommended === true ? "recommended" : "none",
      recovery: [...runtime.handoff?.manual_recovery ?? []]
    },
    technical: {
      diagnostic: publicDiagnostic(diagnosticError, "READ_FAILED"),
      code: diagnosticError?.code ?? null,
      message: boundedText(diagnosticError?.message ?? "") || null,
      plan: plan2 ? {
        taskId: plan2.task_id,
        revision: plan2.plan_revision_id,
        status: plan2.status,
        requirementsVersion: plan2.requirements_version,
        digest: observation.plan.digest,
        currentItem: plan2.current_item,
        nextItem: plan2.next_item
      } : null,
      runtime: runtime.verified === true ? {
        session: runtime.session?.id ?? null,
        runnerInstance: runtime.session?.runnerInstanceId ?? null,
        ownership: runtime.session?.ownership ?? null,
        model: runtime.session?.model ?? null,
        reasoning: runtime.session?.reasoning ?? null,
        git: runtime.git ? {
          repository: runtime.git.repository ?? null,
          worktree: runtime.git.worktree ?? null,
          branch: runtime.git.branch ?? null,
          head: runtime.git.head ?? null,
          base: runtime.git.base ?? null,
          indexDigest: runtime.git.indexDigest ?? null,
          worktreeDigest: runtime.git.worktreeDigest ?? null
        } : null,
        latchGeneration: runtime.latch?.generation ?? null,
        handoffId: runtime.handoff?.handoff_id ?? null,
        handoffState: runtime.handoff?.state ?? null,
        failure: projectedFailure(runtime.handoff?.failure, runtime.handoff?.state ?? "HANDOFF_FAILED")
      } : null
    },
    ...fields
  };
}
function project(state, severity, headline, observation, reason, nextAction, extras = {}) {
  const { handoff: handoffExtras, ...fields } = extras;
  const value = baseProjection(observation, { state, severity, headline, reason, nextAction, next: nextAction, ...fields });
  if (handoffExtras) value.handoff = { ...value.handoff, ...handoffExtras };
  return deepFreeze(value);
}
function projectHumanWorkflow(observation) {
  if (!observation.initialized) {
    return project(
      "NOT_CONFIGURED",
      "attention",
      "da configurare",
      observation,
      "Questo repository non è ancora inizializzato per Aiopago.",
      "esegui “aio init”, poi ispeziona il piano autorevole con “aio plan”."
    );
  }
  if (observation.configError) {
    return project(
      "NEEDS_ATTENTION",
      "error",
      "richiede attenzione",
      observation,
      "La configurazione Aiopago non può essere letta o validata.",
      "ispeziona la diagnostica tecnica e correggi la configurazione; non continuare il lavoro alla cieca."
    );
  }
  if (!observation.plan?.valid) {
    if (observation.plan?.error?.code === "PLAN_CHANGED_DURING_READ") {
      return project(
        "NEEDS_ATTENTION",
        "attention",
        "richiede attenzione",
        observation,
        "Il piano autorevole è cambiato mentre veniva letto; questo non implica che TASK_PLAN.md sia corrotto.",
        "attendi che la modifica sia completa, quindi osserva di nuovo lo stato."
      );
    }
    return project(
      "NEEDS_ATTENTION",
      "error",
      "richiede attenzione",
      observation,
      "TASK_PLAN.md non è valido e non può essere usato come piano autorevole.",
      "esegui “aio plan --check”, ispeziona “aio plan --raw” e correggi manualmente il piano."
    );
  }
  const runtime = observation.runtime ?? EMPTY_RUNTIME;
  if (runtime.verified !== true) {
    const error = runtime.error ?? { code: "RUNTIME_NOT_VERIFIED", message: "No canonical core runtime observation was produced" };
    const changing = error.code === "RUNTIME_NOT_QUIESCENT" || error.code === "RUNTIME_CHANGED_DURING_READ" || error.code === "PLAN_CHANGED_DURING_READ";
    const failed = !changing && !["RUNTIME_NOT_VERIFIED"].includes(error.code);
    return project(
      "NEEDS_ATTENTION",
      failed ? "error" : "attention",
      "richiede attenzione",
      observation,
      changing ? "Lo stato runtime è concorrente o in transizione e non può essere verificato in sicurezza dall’osservatore esterno." : failed ? "La lettura dello stato runtime è fallita e Aiopago non può presentarlo come verificato." : "Il core Portable Alpha 0.1 non espone ancora una verifica read-only canonica dell’autorità runtime all’osservatore esterno.",
      changing ? "non avviare né riprovare aio; attendi che il runtime sia quiescente, quindi osserva di nuovo lo stato." : failed ? "ispeziona la diagnostica tecnica, conserva il codice di errore e osserva di nuovo solo dopo aver corretto la causa." : "usa il piano autorevole per orientarti, ma non dedurre avvio o retry da questa projection; serve un Core Observation Port esterno."
    );
  }
  const validation = validateRuntimeObservation(runtime, observation.plan);
  if (!validation.valid) {
    return project(
      "NEEDS_ATTENTION",
      "error",
      "richiede attenzione",
      {
        ...observation,
        runtime: {
          available: true,
          verified: false,
          workflow: "NEEDS_ATTENTION",
          condition: "RUNTIME_OBSERVATION_INVALID",
          error: validation.error
        }
      },
      "L’osservazione live verificata è incompleta o incoerente e non può provare uno stato operativo sicuro.",
      "ispeziona la diagnostica tecnica e osserva di nuovo senza dedurre permessi runtime."
    );
  }
  const latch = runtime.latch;
  const handoff = runtime.handoff;
  if (latch.reason === "HUMAN_TAKEOVER") {
    return project(
      "PAUSED",
      "attention",
      "in pausa per controllo umano",
      observation,
      "Il takeover umano è attivo e l’ammissione di nuovo lavoro resta chiusa.",
      "mantieni il controllo umano e ispeziona lo stato tecnico; questa vista non può rilasciare il latch."
    );
  }
  if (handoff?.state === "CONTINUITY_FAILED") {
    return project(
      "NEEDS_ATTENTION",
      "error",
      "richiede attenzione",
      observation,
      "La continuità dell’handoff non è stata verificata; il target resta in pausa.",
      `recupera esplicitamente l’handoff con “/aio handoff recover ${handoff.handoff_id}” da una sessione Runner fresca.`,
      { handoff: { actionability: "recover" } }
    );
  }
  if (FAILED_HANDOFF_STATES.has(handoff?.state)) {
    const unknown = handoff.state === "RESUME_DISPATCH_UNKNOWN";
    return project(
      "NEEDS_ATTENTION",
      "error",
      "richiede attenzione",
      observation,
      unknown ? "L’esito dell’invio di resume è ambiguo e non può essere ritentato automaticamente." : "L’handoff è fallito e richiede riconciliazione umana senza retry automatico.",
      unknown ? "ispeziona la diagnostica tecnica e riconcilia l’effetto del resume senza ripetere l’invio." : "ispeziona la diagnostica tecnica e segui le istruzioni di recovery preservando il target in pausa.",
      { handoff: { actionability: "manual-recovery" } }
    );
  }
  if (handoff?.state === "RESUME_READY") {
    return project(
      "PAUSED",
      "attention",
      "handoff pronto, target in pausa",
      observation,
      "La continuità è verificata, ma il resume non è ancora autorizzato dall’essere umano.",
      "usa “/aio resume” e conferma esplicitamente solo se vuoi autorizzare una singola ripresa.",
      { handoff: { actionability: "resume-confirmation" } }
    );
  }
  if (CRASH_INTENT_STATES.has(handoff?.state) && handoff.runner_instance_id !== runtime.session.runnerInstanceId) {
    return project(
      "NEEDS_ATTENTION",
      "error",
      "richiede riconciliazione",
      observation,
      `L’handoff ${handoff.handoff_id} è rimasto in ${handoff.state} dopo il cambio di Runner; l’esito dell’operazione è sconosciuto.`,
      `riconcilia manualmente l’handoff ${handoff.handoff_id} e gli eventuali artifact/target; non avviare un secondo handoff e non ritentare automaticamente.`,
      { handoff: {
        actionability: "manual-recovery",
        recovery: [
          "Il cambio di Runner rende sconosciuto l’esito dell’intent persistito.",
          "Conserva il latch e riconcilia l’operazione esistente prima di altro lavoro."
        ]
      } }
    );
  }
  if (PREPARING_HANDOFF_STATES.has(handoff?.state)) {
    return project(
      "PAUSED",
      "attention",
      "handoff in preparazione",
      observation,
      "L’handoff esistente sta raggiungendo o mantenendo un target sicuro in pausa.",
      "attendi l’esito del percorso esistente; non avviare un secondo handoff.",
      { handoff: { actionability: "wait" } }
    );
  }
  if (handoff && !["RESUMED"].includes(handoff.state)) {
    return project(
      "NEEDS_ATTENTION",
      "error",
      "richiede attenzione",
      observation,
      "Lo stato handoff osservato non è riconosciuto dalla projection umana.",
      "ispeziona la vista tecnica e non dedurre autorizzazioni dallo stato sconosciuto.",
      { handoff: { actionability: "inspect" } }
    );
  }
  if (latch.state !== "RELEASED") {
    return project(
      "PAUSED",
      "attention",
      "in pausa",
      observation,
      "Il latch del Runner è attivo e Aiopago non può provare che nuovo lavoro sia ammesso.",
      "ispeziona lo stato tecnico e il percorso handoff corrente; questa vista non può rilasciare il latch."
    );
  }
  if (observation.plan.plan.status === "BLOCKED") {
    return project(
      "NEEDS_ATTENTION",
      "attention",
      "richiede attenzione",
      observation,
      "Il piano autorevole è bloccato e richiede l’azione descritta nel prossimo passo.",
      observation.plan.plan.next_step
    );
  }
  if (runtime.context?.recommended === true) {
    return project(
      "WORKING",
      "attention",
      "al lavoro — handoff consigliato",
      observation,
      `Il contesto è al ${Math.round(runtime.context.percent)}%, oltre la soglia advisory del ${runtime.context.thresholdPercent}%.`,
      "continua l’attività corrente oppure prepara un handoff soltanto con consenso umano esplicito.",
      { handoff: { recommendation: "recommended", actionability: "prepare-with-consent" } }
    );
  }
  if (observation.plan.plan.status === "DONE") {
    return project(
      "COMPLETED",
      "info",
      "piano completato",
      observation,
      "TASK_PLAN.md dichiara concluse le attività; questa projection non inferisce acceptance esterna.",
      "ispeziona il piano e le evidenze senza dedurre acceptance esterna."
    );
  }
  return project(
    "WORKING",
    "info",
    "al lavoro",
    observation,
    "Il Runner live verifica l’ammissione aperta e non osserva un handoff che richieda azione.",
    observation.plan.plan.next_step || "continua l’attività corrente."
  );
}
var STATE_LABELS = Object.freeze({
  NOT_CONFIGURED: "da configurare",
  NEEDS_ATTENTION: "richiede attenzione",
  WORKING: "al lavoro",
  PAUSED: "in pausa",
  COMPLETED: "piano completato"
});
function asProjection(value) {
  return value?.schema === "aiopago.human-workflow-projection/0.2-e" ? value : projectHumanWorkflow(value);
}
function formatHumanStatus(value) {
  const view = asProjection(value);
  const lines = [`Aiopago — ${view.headline ?? STATE_LABELS[view.state] ?? view.state}`];
  if (view.objective) lines.push(`Obiettivo: ${view.objective}`);
  if (view.currentActivity) lines.push(`Attività corrente: ${view.currentActivity}`);
  if (view.progress) lines.push(`Progresso: ${view.progress.completed}/${view.progress.total} attività concluse`);
  if (view.runtimeSummary.verified) {
    const control = view.humanControl.takeoverState === "active" ? "takeover attivo" : view.humanControl.latchState === "RELEASED" ? "ammissione aperta" : "in pausa";
    lines.push(`Controllo umano: ${control}`);
    const context = view.runtimeSummary.context;
    if (context?.percent !== null) lines.push(`Contesto: ${Math.round(context.percent)}%${context.recommended ? " — handoff consigliato" : ""}`);
  }
  lines.push(`Motivo: ${view.reason}`);
  lines.push(`Prossima azione: ${view.nextAction}`);
  return lines.join("\n");
}
function formatHumanWhy(value) {
  const view = asProjection(value);
  return ["Perché", view.reason, `Prossima azione: ${view.nextAction}`].join("\n");
}
function formatHumanNext(value) {
  const view = asProjection(value);
  return `Prossima azione: ${view.nextAction}`;
}
var PLAN_STATUS_LABELS = Object.freeze({
  PLANNED: "pianificato",
  IN_PROGRESS: "in corso",
  BLOCKED: "bloccato",
  DONE: "completato",
  DROPPED: "abbandonato",
  SUPERSEDED: "superato"
});
function formatPlan(value) {
  const view = asProjection(value);
  const plan2 = view.planSummary;
  if (!plan2) {
    const diagnostic2 = view.technical.diagnostic ?? { code: "PLAN_UNAVAILABLE", message: "Piano autorevole non disponibile" };
    if (diagnostic2.code === "PLAN_CHANGED_DURING_READ") {
      return [
        "Piano autorevole cambiato durante la lettura",
        `Artifact: ${view.planPath ?? "non disponibile"}`,
        `Diagnostica: ${diagnostic2.code}: ${diagnostic2.message}`,
        "Azione: attendi che la modifica sia completa, quindi osserva di nuovo lo stato."
      ].join("\n");
    }
    return [
      "Piano autorevole non valido",
      `Artifact: ${view.planPath ?? "non disponibile"}`,
      `Diagnostica: ${diagnostic2.code}: ${diagnostic2.message}`,
      "Verifica: aio plan --check",
      "Ispezione: aio plan --raw"
    ].join("\n");
  }
  return [
    `Piano autorevole: ${view.title}`,
    `Obiettivo: ${view.objective}`,
    `Stato: ${PLAN_STATUS_LABELS[plan2.status] ?? plan2.status}`,
    `Progresso: ${view.progress.completed}/${view.progress.total} attività concluse`,
    "Attività:",
    ...plan2.items.map((item) => `  - ${item.title} — ${PLAN_STATUS_LABELS[item.status] ?? item.status}`),
    `Prossimo passo: ${plan2.nextStep}`,
    `Artifact: ${plan2.artifact}`
  ].join("\n");
}
function formatPlanTechnical(value) {
  const view = asProjection(value);
  const plan2 = view.planSummary;
  if (!plan2) return formatPlan(view);
  return [
    "Aiopago plan — technical",
    `Artifact: ${plan2.artifact}`,
    `Task ID: ${plan2.taskId}`,
    `Revisione: ${plan2.revision}`,
    `Requirements: ${plan2.requirementsVersion}`,
    `Digest: ${plan2.digest}`,
    `Status: ${plan2.status}`,
    `Current item: ${plan2.currentItem ?? "none"}`,
    `Next item: ${plan2.nextItem ?? "none"}`,
    `Next step: ${plan2.nextStep}`,
    `Model policy: ${plan2.modelPolicy ?? "runtime-selected"}`,
    `Reasoning policy: ${plan2.reasoningPolicy ?? "unspecified"}`,
    `Minimal reads: ${JSON.stringify(plan2.minimalReads)}`,
    `Required local paths: ${JSON.stringify(plan2.requiredLocalPaths)}`
  ].join("\n");
}
function formatHumanTechnical(value) {
  const view = asProjection(value);
  const plan2 = view.technical.plan;
  const runtime = view.technical.runtime;
  const diagnostic2 = view.technical.diagnostic;
  return [
    "Aiopago status — technical",
    `Target repository: ${view.targetRoot ?? "unavailable"}`,
    `Plan artifact: ${view.planPath ?? "unavailable"}`,
    `Git: branch=${runtime?.git?.branch ?? "unavailable"} HEAD=${runtime?.git?.head ?? "unavailable"}`,
    `Worktree: ${runtime?.git?.worktree ?? "unavailable"}`,
    `Task: ${plan2?.taskId ?? "unavailable"} revision=${plan2?.revision ?? "unavailable"} status=${plan2?.status ?? "unavailable"}`,
    `Plan digest: ${plan2?.digest ?? "unavailable"}`,
    `Current item: ${plan2?.currentItem ?? "none"}`,
    `Next item: ${plan2?.nextItem ?? "none"}`,
    `Runtime: ${view.runtimeSummary.availability}; condition=${view.runtimeSummary.condition}`,
    `Runner ownership: ${runtime?.ownership === "source" ? "Runner-owned source" : runtime?.ownership?.startsWith("replacement:") ? `Runner-owned replacement (${runtime.ownership.slice("replacement:".length)})` : "unavailable"}; instance=${runtime?.runnerInstance ?? "unavailable"}`,
    `Session: ${runtime?.session ?? "unavailable"}; model=${runtime?.model ?? "unavailable"}; reasoning=${runtime?.reasoning ?? "unavailable"}`,
    `Latch: ${view.humanControl.latchState}; generation=${view.humanControl.generation ?? "unavailable"}; reason=${view.humanControl.reason ?? "none"}`,
    `Handoff: ${view.handoff.id ?? "none"}; state=${view.handoff.state}`,
    `Advisor/context: ${view.runtimeSummary.context?.percent == null ? "unavailable" : `${Math.round(view.runtimeSummary.context.percent)}%`}; threshold=${view.runtimeSummary.context?.thresholdPercent ?? "unavailable"}%`,
    ...diagnostic2 ? [`Diagnostic: ${diagnostic2.code}: ${diagnostic2.message}`] : [],
    ...runtime?.failure ? [
      `Runtime failure code: ${runtime.failure.code}`,
      `Runtime failure message: ${runtime.failure.message}`
    ] : [],
    ...view.handoff.recovery
  ].join("\n");
}

// src/plan-proposal.mjs
import { randomBytes as randomBytes2 } from "node:crypto";
import { dirname as dirname3, join as join4, relative as relative3, resolve as resolve6 } from "node:path";
var PLAN_PROPOSAL_SCHEMA = "aiopago.plan-proposal/0.1.0";
var PLAN_DIFF_SCHEMA = "aiopago.plan-diff/0.1.0";
var PLAN_REVISION_SCHEMA = "aiopago.plan-revision/0.2.0";
var PLAN_APPLY_RESULT_SCHEMA = "aiopago.plan-apply-result/0.2.0";
var PROPOSAL_REGISTRATION_SCHEMA = "aiopago.plan-proposal-registration/0.2.0";
var COMMIT_INTENT_SCHEMA = "aiopago.plan-commit-intent/0.2.0";
var COMMIT_WITNESS_SCHEMA = "aiopago.plan-commit-witness/0.2.0";
var MAX_PROPOSAL_REGISTRATION_BYTES = 64 * 1024 * 1024;
var MAX_PLAN_DIFF_BYTES = 96 * 1024 * 1024;
var MAX_COMMIT_RECORD_BYTES = MAX_PLAN_STATE_BYTES;
var MAX_PLAN_ATTEMPTS = 128;
var PROPOSAL_FIELDS = [
  "base_content_digest",
  "base_plan_revision_id",
  "candidate_plan",
  "change_reason",
  "created_at",
  "producer",
  "proposal_id",
  "proposed_plan_revision_id",
  "requirements_version",
  "schema",
  "task_id"
].sort();
var REGISTRATION_FIELDS = ["authority", "proposal", "proposal_digest", "schema"].sort();
var IDENTITY_FIELDS = ["device", "inode"].sort();
var INTENT_FIELDS = [
  "attempt_token",
  "authority",
  "base_content_digest",
  "base_filesystem_identity",
  "base_plan_revision_id",
  "candidate_content_digest",
  "candidate_plan_revision_id",
  "candidate_temp_filesystem_identity",
  "candidate_temp_reference",
  "diff",
  "prepared_at",
  "previous_snapshot_reference",
  "proposal_digest",
  "proposal_id",
  "provenance",
  "schema",
  "state"
].sort();
var REVISION_FIELDS = [
  "authority",
  "change_reason",
  "content_digest",
  "created_at",
  "plan_revision_id",
  "previous_content_digest",
  "previous_revision_id",
  "previous_snapshot_reference",
  "producer",
  "requirements_version",
  "schema",
  "task_id"
].sort();
var WITNESS_FIELDS = ["attempt_token", "commit_intent_reference", "filesystem_identity", "schema"].sort();
var APPLY_RESULT_FIELDS = [
  "applied_at",
  "commit_witness",
  "content_digest",
  "diff",
  "plan_revision_id",
  "prepared_at",
  "previous_content_digest",
  "previous_revision_id",
  "proposal_digest",
  "proposal_id",
  "provenance",
  "provenance_reference",
  "recovered_at",
  "schema",
  "task_id"
].sort();
function exactFields(value, fields, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(fields), code, `${label} fields are invalid`);
}
function deepFreeze2(value) {
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze2(child);
    Object.freeze(value);
  }
  return value;
}
function canonicalClone(value) {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (value !== null && typeof value === "object") {
    const clone = {};
    for (const key of Object.keys(value).sort()) Object.defineProperty(clone, key, { value: canonicalClone(value[key]), enumerable: true, writable: true, configurable: true });
    return clone;
  }
  return value;
}
function nonEmptyString(value, field, maximum = 4096) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= maximum, "PLAN_PROPOSAL_INVALID", `${field} must be a non-empty bounded string`);
}
function exactUtcTimestamp(value, field, code = "PLAN_PROPOSAL_INVALID") {
  invariant(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, code, `${field} must be a canonical RFC 3339 UTC timestamp`);
}
function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function canonicalPrettyJson(value, depth = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `[
${value.map((entry) => `${childIndent}${canonicalPrettyJson(entry, depth + 1)}`).join(",\n")}
${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `{
${keys.map((key) => `${childIndent}${JSON.stringify(key)}: ${canonicalPrettyJson(value[key], depth + 1)}`).join(",\n")}
${indent}}`;
  }
  return JSON.stringify(value);
}
function fieldDiff(before, after, excluded = /* @__PURE__ */ new Set()) {
  const added = [];
  const removed = [];
  const changed = [];
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !excluded.has(key)).sort();
  for (const field of keys) {
    const hasBefore = Object.hasOwn(before, field);
    const hasAfter = Object.hasOwn(after, field);
    if (!hasBefore) added.push({ field, value: canonicalClone(after[field]) });
    else if (!hasAfter) removed.push({ field, value: canonicalClone(before[field]) });
    else if (!sameValue(before[field], after[field])) changed.push({ field, before: canonicalClone(before[field]), after: canonicalClone(after[field]) });
  }
  return { added, removed, changed };
}
function diffTaskPlans(basePlan, candidatePlan) {
  validateTaskLedger(basePlan);
  validateTaskLedger(candidatePlan);
  invariant(basePlan.task_id === candidatePlan.task_id, "PLAN_TASK_ID_MISMATCH", "Plan diff requires the same task_id");
  const baseItems = new Map(basePlan.task_items.map((item) => [item.task_item_id, item]));
  const candidateItems = new Map(candidatePlan.task_items.map((item) => [item.task_item_id, item]));
  const added = [];
  const removed = [];
  const changed = [];
  const itemIds = [.../* @__PURE__ */ new Set([...baseItems.keys(), ...candidateItems.keys()])].sort();
  for (const taskItemId of itemIds) {
    const before = baseItems.get(taskItemId);
    const after = candidateItems.get(taskItemId);
    if (!before) added.push({ task_item_id: taskItemId, value: canonicalClone(after) });
    else if (!after) removed.push({ task_item_id: taskItemId, value: canonicalClone(before) });
    else {
      const fields = fieldDiff(before, after, /* @__PURE__ */ new Set(["task_item_id"]));
      if (fields.added.length || fields.removed.length || fields.changed.length) changed.push({ task_item_id: taskItemId, fields });
    }
  }
  return deepFreeze2({
    schema: PLAN_DIFF_SCHEMA,
    task_id: basePlan.task_id,
    base_plan_revision_id: basePlan.plan_revision_id,
    candidate_plan_revision_id: candidatePlan.plan_revision_id,
    plan: fieldDiff(basePlan, candidatePlan, /* @__PURE__ */ new Set(["task_items"])),
    task_items: { added, removed, changed }
  });
}
function proposalPayload(proposal) {
  const payload = {};
  for (const field of PROPOSAL_FIELDS) Object.defineProperty(payload, field, { value: proposal[field], enumerable: true, writable: true, configurable: true });
  return payload;
}
var PlanProposal = class {
  constructor(input) {
    const payload = strictJsonClone(input, { code: "PLAN_PROPOSAL_JSON_DOMAIN_INVALID", field: "PlanProposal" });
    exactFields(payload, PROPOSAL_FIELDS, "PLAN_PROPOSAL_FIELDS_INVALID", "PlanProposal");
    invariant(payload.schema === PLAN_PROPOSAL_SCHEMA, "PLAN_PROPOSAL_SCHEMA_UNSUPPORTED", `Expected ${PLAN_PROPOSAL_SCHEMA}`);
    for (const field of ["proposal_id", "task_id", "base_plan_revision_id", "base_content_digest", "proposed_plan_revision_id", "requirements_version", "producer", "change_reason"]) nonEmptyString(payload[field], field);
    exactUtcTimestamp(payload.created_at, "created_at");
    invariant(/^sha256:[a-f0-9]{64}$/.test(payload.base_content_digest), "PLAN_PROPOSAL_INVALID", "base_content_digest must be an exact SHA-256 digest");
    invariant(payload.proposed_plan_revision_id !== payload.base_plan_revision_id, "PLAN_REVISION_REUSE", "A proposal must create a new plan_revision_id");
    const candidate = payload.candidate_plan;
    validateTaskLedger(candidate);
    invariant(candidate.task_id === payload.task_id, "PLAN_TASK_ID_MISMATCH", "candidate_plan task_id must match proposal task_id");
    invariant(candidate.plan_revision_id === payload.proposed_plan_revision_id, "PLAN_REVISION_MISMATCH", "candidate_plan plan_revision_id must match proposed_plan_revision_id");
    invariant(candidate.requirements_version === payload.requirements_version, "PLAN_REQUIREMENTS_MISMATCH", "candidate_plan requirements_version must match proposal requirements_version");
    invariant(candidate.updated_at === payload.created_at, "PLAN_UPDATED_AT_MISMATCH", "candidate_plan updated_at must equal proposal created_at for deterministic materialization");
    const canonicalPayloadBytes = Buffer.from(canonicalJson(payload), "utf8");
    invariant(canonicalPayloadBytes.length <= MAX_PROPOSAL_REGISTRATION_BYTES, "PLAN_PROPOSAL_TOO_LARGE", `Canonical proposal exceeds ${MAX_PROPOSAL_REGISTRATION_BYTES} bytes`);
    const proposalDigest = sha256(canonicalPayloadBytes);
    Object.assign(this, payload, { proposal_digest: proposalDigest });
    deepFreeze2(this);
  }
};
function assertProposalMutationSchema(observed) {
  if (observed.ledgerSchema === LEGACY_TASK_LEDGER_SCHEMA) {
    throw new GuardianError("PLAN_LEGACY_MIGRATION_REQUIRED", `Reading ${LEGACY_TASK_LEDGER_SCHEMA} remains supported, but Plan Proposal mutation requires an explicit migration to ${TASK_LEDGER_SCHEMA}`);
  }
  invariant(observed.ledgerSchema === TASK_LEDGER_SCHEMA, "PLAN_LEDGER_SCHEMA_UNSUPPORTED", `Plan Proposal mutation requires ${TASK_LEDGER_SCHEMA}`);
}
function assertGenericProposalPreservesBlockedOwnerLatch(base, candidate) {
  if (!Object.hasOwn(base, "owner_gate")) return;
  const gate = base.owner_gate;
  const provenSatisfied = gate !== null && typeof gate === "object" && gate.kind === "HANDOFF_CONFIRM" && gate.status === "SATISFIED";
  if (provenSatisfied) return;
  for (const field of ["status", "current_item", "next_item", "next_step"]) {
    invariant(sameValue(base[field], candidate[field]), "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN", `Generic PlanProposal cannot change ${field} while a HANDOFF_CONFIRM owner latch is BLOCKED`);
  }
  const baseItems = new Map(base.task_items.map((item) => [item.task_item_id, item]));
  const candidateItems = new Map(candidate.task_items.map((item) => [item.task_item_id, item]));
  invariant(baseItems.size === candidateItems.size && [...baseItems.keys()].every((id) => candidateItems.has(id)), "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN", "Generic PlanProposal cannot restructure lifecycle-critical items while the owner latch is BLOCKED");
  const protectedItem = candidateItems.get(gate.item_id);
  invariant(protectedItem?.status === "BLOCKED", "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN", "The owner-latch TaskItem must remain present and BLOCKED");
  invariant(candidate.task_items.every((item) => item.status !== "IN_PROGRESS"), "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN", "No TaskItem may become IN_PROGRESS while the owner latch is BLOCKED");
  for (const [id, before] of baseItems) {
    const after = candidateItems.get(id);
    invariant(before.status === after.status, "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN", `TaskItem ${id} status cannot change while the owner latch is BLOCKED`);
    invariant(sameValue(before.depends_on, after.depends_on), "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN", `TaskItem ${id} dependency topology cannot change while the owner latch is BLOCKED`);
    for (const field of ["supersedes", "superseded_by"]) {
      invariant(Object.hasOwn(before, field) === Object.hasOwn(after, field) && (!Object.hasOwn(before, field) || before[field] === after[field]), "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN", `TaskItem ${id} supersession topology cannot change while the owner latch is BLOCKED`);
    }
  }
}
function materializeObserved(observed, proposal) {
  assertProposalMutationSchema(observed);
  invariant(observed.task.task_id === proposal.task_id, "PLAN_TASK_ID_MISMATCH", "Proposal task_id does not match the observed Ledger");
  invariant(observed.task.plan_revision_id === proposal.base_plan_revision_id, "PLAN_CAS_CONFLICT", "Observed revision does not match proposal base revision");
  invariant(observed.contentDigest === proposal.base_content_digest, "PLAN_CAS_CONFLICT", "Observed bytes do not match proposal base digest");
  const candidate = proposal.candidate_plan;
  validateTaskLedger(candidate);
  const baseHasOwnerGate = Object.hasOwn(observed.task, "owner_gate");
  const candidateHasOwnerGate = Object.hasOwn(candidate, "owner_gate");
  invariant(baseHasOwnerGate === candidateHasOwnerGate && (!baseHasOwnerGate || sameValue(observed.task.owner_gate, candidate.owner_gate)), "PLAN_OWNER_GATE_MUTATION_FORBIDDEN", "Generic PlanProposal must preserve owner_gate exactly; only satisfyOwnerGate() may transition it");
  assertGenericProposalPreservesBlockedOwnerLatch(observed.task, candidate);
  const json = canonicalPrettyJson(candidate).replaceAll("\n", observed.block.lineEnding);
  const { text } = materializeLedgerMarkdown(observed, {
    json,
    metadata: {
      plan_revision_id: candidate.plan_revision_id,
      requirements_version: candidate.requirements_version,
      updated_at: candidate.updated_at
    }
  });
  const bytes = Buffer.from(text, "utf8");
  const parsed = parseTaskPlanBytes(bytes, { requireSingleBlock: true });
  validateTaskLedger(parsed.task);
  invariant(sameValue(parsed.task, candidate), "PLAN_MATERIALIZATION_INVALID", "Materialized Ledger does not equal candidate_plan");
  return deepFreeze2({
    bytes,
    content_digest: sha256(bytes),
    candidate_plan: candidate,
    diff: diffTaskPlans(observed.task, candidate)
  });
}
function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}
`, "utf8");
}
function readJson(writer, path, maximum = MAX_COMMIT_RECORD_BYTES) {
  try {
    const parsed = JSON.parse(writer.readImmutable(path, maximum).toString("utf8"));
    return strictJsonClone(parsed, { code: "PLAN_PROVENANCE_INVALID", field: path });
  } catch (error) {
    if (error?.code === "PLAN_PROVENANCE_INVALID") throw error;
    throw new GuardianError("PLAN_PROVENANCE_INVALID", `${path}: ${error.message}`);
  }
}
function validateIdentity(value, label) {
  exactFields(value, IDENTITY_FIELDS, "PLAN_PROVENANCE_INVALID", label);
  invariant(/^[0-9]+$/.test(value.device) && /^[0-9]+$/.test(value.inode), "PLAN_PROVENANCE_INVALID", `${label} is invalid`);
}
function revisionFor(proposal, materialized, previousSnapshotReference) {
  return deepFreeze2({
    schema: PLAN_REVISION_SCHEMA,
    authority: "DERIVED_EVIDENCE",
    plan_revision_id: proposal.proposed_plan_revision_id,
    task_id: proposal.task_id,
    previous_revision_id: proposal.base_plan_revision_id,
    previous_content_digest: proposal.base_content_digest,
    previous_snapshot_reference: previousSnapshotReference,
    requirements_version: proposal.requirements_version,
    content_digest: materialized.content_digest,
    created_at: proposal.created_at,
    producer: proposal.producer,
    change_reason: proposal.change_reason
  });
}
function validateRegistration(registration, proposal) {
  exactFields(registration, REGISTRATION_FIELDS, "PLAN_PROVENANCE_INVALID", "Proposal registration");
  invariant(registration.schema === PROPOSAL_REGISTRATION_SCHEMA && registration.authority === "DERIVED_EVIDENCE", "PLAN_PROVENANCE_INVALID", "Proposal registration schema or authority is invalid");
  if (registration.proposal_digest !== proposal.proposal_digest) throw new GuardianError("PLAN_PROPOSAL_ID_CONFLICT", "The same proposal_id was already registered with different content");
  invariant(sameValue(registration.proposal, proposalPayload(proposal)), "PLAN_PROVENANCE_INVALID", "Registered proposal payload does not match its digest and caller proposal");
}
function validateIntent(intent, proposal, materialized, previousSnapshotReference) {
  exactFields(intent, INTENT_FIELDS, "PLAN_PROVENANCE_INVALID", "Commit intent");
  invariant(intent.schema === COMMIT_INTENT_SCHEMA && intent.authority === "DERIVED_EVIDENCE" && intent.state === "COMMIT_INTENT", "PLAN_PROVENANCE_INVALID", "Commit intent schema, authority, or state is invalid");
  invariant(intent.proposal_id === proposal.proposal_id && intent.proposal_digest === proposal.proposal_digest, "PLAN_PROVENANCE_INVALID", "Commit intent proposal identity is invalid");
  invariant(/^[a-f0-9]{64}$/.test(intent.attempt_token), "PLAN_PROVENANCE_INVALID", "Commit intent attempt token is invalid");
  exactUtcTimestamp(intent.prepared_at, "prepared_at", "PLAN_PROVENANCE_INVALID");
  invariant(intent.base_plan_revision_id === proposal.base_plan_revision_id && intent.base_content_digest === proposal.base_content_digest, "PLAN_PROVENANCE_INVALID", "Commit intent base identity is invalid");
  invariant(intent.candidate_plan_revision_id === proposal.proposed_plan_revision_id && intent.candidate_content_digest === materialized.content_digest, "PLAN_PROVENANCE_INVALID", "Commit intent candidate identity is invalid");
  invariant(intent.previous_snapshot_reference === previousSnapshotReference, "PLAN_PROVENANCE_INVALID", "Commit intent history reference is invalid");
  validateIdentity(intent.base_filesystem_identity, "Base filesystem identity");
  validateIdentity(intent.candidate_temp_filesystem_identity, "Candidate filesystem identity");
  invariant(!sameFilesystemIdentity(intent.base_filesystem_identity, intent.candidate_temp_filesystem_identity), "PLAN_PROVENANCE_INVALID", "Candidate witness must differ from the base filesystem identity");
  invariant(typeof intent.candidate_temp_reference === "string" && !intent.candidate_temp_reference.includes("/") && !intent.candidate_temp_reference.includes("\\") && intent.candidate_temp_reference.endsWith(".replace.tmp"), "PLAN_PROVENANCE_INVALID", "Candidate temp reference is invalid");
  invariant(sameValue(intent.diff, materialized.diff), "PLAN_PROVENANCE_INVALID", "Commit intent diff does not match deterministic materialization");
  invariant(sameValue(intent.provenance, revisionFor(proposal, materialized, previousSnapshotReference)), "PLAN_PROVENANCE_INVALID", "Commit intent PlanRevision does not match deterministic materialization");
  return intent;
}
function resultFor({ proposal, materialized, provenance, provenanceReference, intent, intentReference, appliedAt }) {
  return deepFreeze2({
    schema: PLAN_APPLY_RESULT_SCHEMA,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    task_id: proposal.task_id,
    previous_revision_id: proposal.base_plan_revision_id,
    plan_revision_id: proposal.proposed_plan_revision_id,
    previous_content_digest: proposal.base_content_digest,
    content_digest: materialized.content_digest,
    prepared_at: intent.prepared_at,
    applied_at: appliedAt,
    recovered_at: null,
    diff: materialized.diff,
    provenance,
    provenance_reference: provenanceReference,
    commit_witness: {
      schema: COMMIT_WITNESS_SCHEMA,
      attempt_token: intent.attempt_token,
      filesystem_identity: intent.candidate_temp_filesystem_identity,
      commit_intent_reference: intentReference
    }
  });
}
function validateStoredResult(result, proposal, materialized, provenanceReference, intent, intentReference) {
  exactFields(result, APPLY_RESULT_FIELDS, "PLAN_PROVENANCE_INVALID", "Stored apply result");
  invariant(result.schema === PLAN_APPLY_RESULT_SCHEMA && result.proposal_id === proposal.proposal_id && result.proposal_digest === proposal.proposal_digest, "PLAN_PROVENANCE_INVALID", "Stored apply result identity is invalid");
  invariant(result.task_id === proposal.task_id && result.previous_revision_id === proposal.base_plan_revision_id && result.plan_revision_id === proposal.proposed_plan_revision_id, "PLAN_PROVENANCE_INVALID", "Stored apply result revision identity is invalid");
  invariant(result.previous_content_digest === proposal.base_content_digest && result.content_digest === materialized.content_digest, "PLAN_PROVENANCE_INVALID", "Stored apply result digest identity is invalid");
  invariant(result.prepared_at === intent.prepared_at && result.provenance_reference === provenanceReference && sameValue(result.diff, materialized.diff), "PLAN_PROVENANCE_INVALID", "Stored apply result deterministic fields are invalid");
  invariant(typeof result.applied_at === "string" && result.recovered_at === null, "PLAN_PROVENANCE_INVALID", "Stored result must contain a live post-rename applied_at and no recovered success");
  exactUtcTimestamp(result.applied_at, "applied_at", "PLAN_PROVENANCE_INVALID");
  invariant(Date.parse(result.applied_at) >= Date.parse(result.prepared_at), "PLAN_PROVENANCE_INVALID", "Stored applied_at cannot precede prepared_at");
  exactFields(result.provenance, REVISION_FIELDS, "PLAN_PROVENANCE_INVALID", "Stored PlanRevision");
  invariant(sameValue(result.provenance, revisionFor(proposal, materialized, intent.previous_snapshot_reference)), "PLAN_PROVENANCE_INVALID", "Stored PlanRevision does not match deterministic materialization");
  exactFields(result.commit_witness, WITNESS_FIELDS, "PLAN_PROVENANCE_INVALID", "Stored commit witness");
  invariant(result.commit_witness.schema === COMMIT_WITNESS_SCHEMA && result.commit_witness.attempt_token === intent.attempt_token && result.commit_witness.commit_intent_reference === intentReference && sameValue(result.commit_witness.filesystem_identity, intent.candidate_temp_filesystem_identity), "PLAN_PROVENANCE_INVALID", "Stored commit witness is invalid");
  return result;
}
var PlanPort = class {
  #liveAppliedReceipts = /* @__PURE__ */ new Map();
  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve6(path);
    this.writer = options.writer ?? new PlanRevisionWriter(this.path, options.writerOptions);
    this.now = options.now ?? utcNow;
    this.provenanceRoot = resolve6(options.provenanceRoot ?? join4(dirname3(this.path), ".guardian", "plan-proposals"));
  }
  proposal(input) {
    invariant(input && typeof input === "object" && !Array.isArray(input), "PLAN_PROPOSAL_FIELDS_INVALID", "PlanProposal input must be an object");
    const reconstructed = {};
    for (const field of PROPOSAL_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      invariant(descriptor && "value" in descriptor && descriptor.enumerable, "PLAN_PROPOSAL_FIELDS_INVALID", `PlanProposal must contain an own enumerable data field: ${field}`);
      Object.defineProperty(reconstructed, field, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
    }
    return new PlanProposal(reconstructed);
  }
  observe() {
    const observed = this.writer.readCurrent({ requireSingleBlock: true, validate: validateTaskLedger });
    return deepFreeze2({
      task_id: observed.task.task_id,
      plan_revision_id: observed.task.plan_revision_id,
      content_digest: observed.contentDigest,
      bytes: Buffer.from(observed.bytes),
      plan: canonicalClone(observed.task)
    });
  }
  materialize(input, baseBytes) {
    const proposal = this.proposal(input);
    const observed = parseTaskPlanBytes(baseBytes ?? this.writer.readPlanBytes(), { requireSingleBlock: true });
    validateTaskLedger(observed.task);
    return materializeObserved(observed, proposal);
  }
  apply(input) {
    const proposal = this.proposal(input);
    const recordId = stableId("proposal", proposal.proposal_id);
    const recordRoot = join4(this.provenanceRoot, recordId);
    const registrationPath = join4(recordRoot, "proposal.json");
    const attemptsRoot = join4(recordRoot, "attempts");
    const appliedPath = join4(recordRoot, "applied.json");
    const provenanceReference = relative3(dirname3(this.path), appliedPath).replaceAll("\\", "/");
    const expectedRegistration = deepFreeze2({
      schema: PROPOSAL_REGISTRATION_SCHEMA,
      authority: "DERIVED_EVIDENCE",
      proposal_digest: proposal.proposal_digest,
      proposal: proposalPayload(proposal)
    });
    const registrationBytes = jsonBytes(expectedRegistration);
    invariant(registrationBytes.length <= MAX_PROPOSAL_REGISTRATION_BYTES, "PLAN_PROPOSAL_TOO_LARGE", `Proposal registration exceeds ${MAX_PROPOSAL_REGISTRATION_BYTES} bytes`);
    let activeIntent;
    let activeIntentPath;
    let activeIntentReference;
    let activeMaterialized;
    const inspectTree = () => {
      if (!this.writer.stateExists(recordRoot)) return { registration: null, intents: [], applied: null };
      const names = this.writer.stateDirectoryEntries(recordRoot);
      invariant(names.length <= 3 && names.every((entry) => ["proposal.json", "attempts", "applied.json"].includes(entry.name)), "PLAN_PROVENANCE_INVALID", "Proposal record directory contains an unexpected entry");
      invariant(this.writer.stateExists(registrationPath), "PLAN_PROVENANCE_INVALID", "Proposal record directory has no immutable proposal registration");
      const registration = readJson(this.writer, registrationPath, MAX_PROPOSAL_REGISTRATION_BYTES);
      validateRegistration(registration, proposal);
      const intents = [];
      if (this.writer.stateExists(attemptsRoot)) {
        const attemptEntries = this.writer.stateDirectoryEntries(attemptsRoot);
        invariant(attemptEntries.length <= MAX_PLAN_ATTEMPTS, "PLAN_PROVENANCE_INVALID", "Too many plan commit attempts");
        for (const entry of attemptEntries) {
          invariant(entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name), "PLAN_PROVENANCE_INVALID", "Invalid plan commit-intent record");
          const path = join4(attemptsRoot, entry.name);
          const value = readJson(this.writer, path, MAX_COMMIT_RECORD_BYTES);
          invariant(entry.name === `${value.attempt_token}.json`, "PLAN_PROVENANCE_INVALID", "Commit-intent filename does not match its attempt token");
          intents.push({ path, reference: relative3(dirname3(this.path), path).replaceAll("\\", "/"), value });
        }
      }
      const applied = this.writer.stateExists(appliedPath) ? readJson(this.writer, appliedPath, MAX_COMMIT_RECORD_BYTES) : null;
      return { registration, intents, applied };
    };
    return deepFreeze2(this.writer.commit({
      expected: { planRevisionId: proposal.base_plan_revision_id, contentDigest: proposal.base_content_digest },
      requireSingleBlock: true,
      validate: validateTaskLedger,
      inspectExisting: (current) => {
        const tree = inspectTree();
        if (!tree.registration) return null;
        const currentIsBase = current.task.plan_revision_id === proposal.base_plan_revision_id && current.contentDigest === proposal.base_content_digest;
        if (currentIsBase && tree.applied) throw new GuardianError("PLAN_PROVENANCE_INVALID", "Applied provenance exists while the authoritative plan is still the proposal base");
        if (currentIsBase && tree.intents.length === 0) return null;
        const previousSnapshotReference = `.guardian/plan-history/sha256-${proposal.base_content_digest.slice("sha256:".length)}.md`;
        const snapshotPath = resolve6(dirname3(this.path), previousSnapshotReference);
        invariant(this.writer.stateExists(snapshotPath), "PLAN_PROVENANCE_INVALID", "Commit evidence exists without the exact previous revision snapshot");
        const baseBytes = this.writer.readImmutable(snapshotPath);
        invariant(sha256(baseBytes) === proposal.base_content_digest, "PLAN_HISTORY_CORRUPT", "Previous plan snapshot digest is corrupt");
        const base = parseTaskPlanBytes(baseBytes, { requireSingleBlock: true });
        validateTaskLedger(base.task);
        const materialized = materializeObserved(base, proposal);
        for (const attempt of tree.intents) validateIntent(attempt.value, proposal, materialized, previousSnapshotReference);
        if (currentIsBase && tree.intents.length >= MAX_PLAN_ATTEMPTS) {
          throw new GuardianError("PLAN_ATTEMPT_LIMIT_REACHED", `Proposal ${proposal.proposal_id} is explicitly abandoned after ${MAX_PLAN_ATTEMPTS} durable attempts; reconcile state and use a new proposal_id`, {
            proposal_id: proposal.proposal_id,
            maximum_attempts: MAX_PLAN_ATTEMPTS,
            disposition: "ABANDON_PROPOSAL"
          });
        }
        if (currentIsBase) return null;
        const currentIsCandidate = current.task.plan_revision_id === proposal.proposed_plan_revision_id && current.contentDigest === materialized.content_digest && sameValue(current.task, proposal.candidate_plan);
        if (!currentIsCandidate) throw new GuardianError("PLAN_PROPOSAL_RECOVERY_CONFLICT", "Current authoritative plan is neither the exact proposal base nor its deterministic candidate");
        if (!tree.applied) throw new GuardianError("PLAN_RECOVERY_AMBIGUOUS", "Current candidate has no live receipt in this PlanPort instance; filesystem evidence cannot authenticate who committed it");
        const witnessed = tree.intents.filter((attempt) => attempt.value.attempt_token === tree.applied?.commit_witness?.attempt_token && attempt.reference === tree.applied?.commit_witness?.commit_intent_reference);
        invariant(witnessed.length === 1, "PLAN_PROVENANCE_INVALID", "Stored apply result does not identify exactly one validated commit intent");
        const provenance = revisionFor(proposal, materialized, previousSnapshotReference);
        const validated = deepFreeze2(validateStoredResult(tree.applied, proposal, materialized, provenanceReference, witnessed[0].value, witnessed[0].reference));
        const receipt = this.#liveAppliedReceipts.get(proposal.proposal_digest);
        if (!receipt || receipt.proposalDigest !== proposal.proposal_digest || receipt.attemptToken !== witnessed[0].value.attempt_token || receipt.contentDigest !== current.contentDigest || !sameFilesystemIdentity(receipt.committedFileIdentity, current.fileIdentity) || !sameFileFingerprint(receipt.committedFileFingerprint, current.fileFingerprint) || !sameValue(receipt.result, validated)) {
          throw new GuardianError("PLAN_RECOVERY_AMBIGUOUS", "Exact bytes and disk evidence are insufficient; this PlanPort instance has no live receipt bound to the current authority filesystem object and fingerprint");
        }
        return receipt.result;
      },
      prepare: (current, { previousSnapshotReference }) => {
        const materialized = materializeObserved(current, proposal);
        invariant(jsonBytes(materialized.diff).length <= MAX_PLAN_DIFF_BYTES, "PLAN_DIFF_TOO_LARGE", `Plan diff exceeds ${MAX_PLAN_DIFF_BYTES} bytes`);
        activeMaterialized = materialized;
        const provenance = revisionFor(proposal, materialized, previousSnapshotReference);
        return {
          bytes: Buffer.from(materialized.bytes),
          beforeFinalAttestation: ({ candidateTempIdentity, candidateTempReference }) => {
            this.writer.writeImmutable(registrationPath, registrationBytes, { conflictCode: "PLAN_PROPOSAL_ID_CONFLICT", maximum: MAX_PROPOSAL_REGISTRATION_BYTES });
            const preparedAt = this.now();
            exactUtcTimestamp(preparedAt, "prepared_at", "PLAN_PREPARED_AT_INVALID");
            const attemptToken = randomBytes2(32).toString("hex");
            activeIntent = deepFreeze2({
              schema: COMMIT_INTENT_SCHEMA,
              authority: "DERIVED_EVIDENCE",
              state: "COMMIT_INTENT",
              proposal_id: proposal.proposal_id,
              proposal_digest: proposal.proposal_digest,
              attempt_token: attemptToken,
              prepared_at: preparedAt,
              base_plan_revision_id: proposal.base_plan_revision_id,
              base_content_digest: proposal.base_content_digest,
              base_filesystem_identity: current.fileIdentity,
              candidate_plan_revision_id: proposal.proposed_plan_revision_id,
              candidate_content_digest: materialized.content_digest,
              candidate_temp_filesystem_identity: candidateTempIdentity,
              candidate_temp_reference: candidateTempReference,
              previous_snapshot_reference: previousSnapshotReference,
              diff: materialized.diff,
              provenance
            });
            activeIntentPath = join4(attemptsRoot, `${attemptToken}.json`);
            activeIntentReference = relative3(dirname3(this.path), activeIntentPath).replaceAll("\\", "/");
            this.writer.writeImmutable(activeIntentPath, jsonBytes(activeIntent), { maximum: MAX_COMMIT_RECORD_BYTES });
          },
          afterCommit: ({ committed }) => {
            invariant(activeIntent && activeMaterialized && sameFilesystemIdentity(committed.fileIdentity, activeIntent.candidate_temp_filesystem_identity), "PLAN_COMMIT_WITNESS_INVALID", "Post-commit authority does not match the durable commit intent witness");
            const appliedAt = this.now();
            exactUtcTimestamp(appliedAt, "applied_at", "PLAN_APPLIED_AT_INVALID");
            invariant(Date.parse(appliedAt) >= Date.parse(activeIntent.prepared_at), "PLAN_APPLIED_AT_INVALID", "applied_at cannot precede prepared_at");
            const result = resultFor({
              proposal,
              materialized: activeMaterialized,
              provenance,
              provenanceReference,
              intent: activeIntent,
              intentReference: activeIntentReference,
              appliedAt
            });
            validateStoredResult(result, proposal, activeMaterialized, provenanceReference, activeIntent, activeIntentReference);
            this.writer.writeImmutable(appliedPath, jsonBytes(result), { maximum: MAX_COMMIT_RECORD_BYTES, allowExistingExact: false });
            const validated = deepFreeze2(validateStoredResult(result, proposal, activeMaterialized, provenanceReference, activeIntent, activeIntentReference));
            this.#liveAppliedReceipts.set(proposal.proposal_digest, deepFreeze2({
              proposalDigest: proposal.proposal_digest,
              attemptToken: activeIntent.attempt_token,
              contentDigest: committed.contentDigest,
              committedFileIdentity: { ...committed.fileIdentity },
              committedFileFingerprint: { ...committed.fileFingerprint },
              result: validated
            }));
            return validated;
          }
        };
      }
    }));
  }
};

// src/intent-adapter.mjs
var PLAN_INTENT_SCHEMA = "aiopago.plan-intent/0.1.0";
var PLAN_OBSERVATION_SCHEMA = "aiopago.plan-observation/0.1.0";
var PLAN_VALIDATION_SCHEMA = "aiopago.plan-validation/0.1.0";
var INTENT_FIELDS2 = ["base", "candidate_plan", "change_reason", "producer", "proposal_id", "schema"].sort();
var INTENT_BASE_FIELDS = ["content_digest", "plan_revision_id", "task_id"].sort();
var PROPOSAL_PAYLOAD_FIELDS = [
  "base_content_digest",
  "base_plan_revision_id",
  "candidate_plan",
  "change_reason",
  "created_at",
  "producer",
  "proposal_id",
  "proposed_plan_revision_id",
  "requirements_version",
  "schema",
  "task_id"
].sort();
var ADAPTER_PROPOSAL_FIELDS = [...PROPOSAL_PAYLOAD_FIELDS, "proposal_digest"].sort();
function exactFields2(value, expected, code, label) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson(expected),
    code,
    `${label} fields are invalid`
  );
}
function deepFreeze3(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze3(child);
    Object.freeze(value);
  }
  return value;
}
function boundaryClone(value, { code, field }) {
  try {
    return strictJsonClone(value, { code, field });
  } catch (error) {
    if (error instanceof GuardianError) throw error;
    throw new GuardianError(error?.code ?? code, error?.message ?? `${field} is invalid`);
  }
}
function validateIntentBase(base) {
  exactFields2(base, INTENT_BASE_FIELDS, "PLAN_INTENT_BASE_FIELDS_INVALID", "Plan intent base");
  for (const field of ["task_id", "plan_revision_id", "content_digest"]) {
    invariant(
      typeof base[field] === "string" && base[field].length > 0 && base[field].length <= 4096,
      "PLAN_INTENT_BASE_INVALID",
      `base.${field} must be a non-empty bounded string`
    );
  }
  invariant(
    /^sha256:[a-f0-9]{64}$/.test(base.content_digest),
    "PLAN_INTENT_BASE_INVALID",
    "base.content_digest must be an exact SHA-256 digest"
  );
}
function assertBaseCurrent(expected, observed) {
  const taskMatches = expected.task_id === observed.task_id;
  const revisionMatches = expected.plan_revision_id === observed.plan_revision_id;
  const digestMatches = expected.content_digest === observed.content_digest;
  if (!taskMatches || !revisionMatches || !digestMatches) {
    throw new GuardianError(
      "PLAN_PROPOSAL_STALE",
      "The expected plan base is stale relative to the current TASK_PLAN.md authority",
      {
        expected_task_id: expected.task_id,
        observed_task_id: observed.task_id,
        task_matches: taskMatches,
        expected_plan_revision_id: expected.plan_revision_id,
        observed_plan_revision_id: observed.plan_revision_id,
        revision_matches: revisionMatches,
        expected_content_digest: expected.content_digest,
        observed_content_digest: observed.content_digest,
        digest_matches: digestMatches
      }
    );
  }
}
function immutableJson(value, options) {
  return deepFreeze3(boundaryClone(value, options));
}
function proposalPayload2(proposal) {
  const payload = {};
  for (const field of PROPOSAL_PAYLOAD_FIELDS) payload[field] = proposal[field];
  return payload;
}
function proposalView(proposal) {
  return immutableJson(
    { ...proposalPayload2(proposal), proposal_digest: proposal.proposal_digest },
    { code: "PLAN_PROPOSAL_JSON_DOMAIN_INVALID", field: "Plan proposal response" }
  );
}
var IntentAdapter = class {
  #port;
  constructor(path = "TASK_PLAN.md", options = {}) {
    this.#port = options.port ?? new PlanPort(path, options.planPortOptions);
    Object.freeze(this);
  }
  #observeRaw() {
    return this.#port.observe();
  }
  #reconstruct(input) {
    const external = boundaryClone(input, { code: "PLAN_ADAPTER_PROPOSAL_JSON_DOMAIN_INVALID", field: "plan proposal" });
    exactFields2(external, ADAPTER_PROPOSAL_FIELDS, "PLAN_ADAPTER_PROPOSAL_FIELDS_INVALID", "Adapter plan proposal");
    const suppliedDigest = external.proposal_digest;
    const payload = {};
    for (const field of PROPOSAL_PAYLOAD_FIELDS) payload[field] = external[field];
    const proposal = this.#port.proposal(payload);
    invariant(
      suppliedDigest === proposal.proposal_digest,
      "PLAN_PROPOSAL_DIGEST_INVALID",
      "proposal_digest does not match the reconstructed canonical PlanProposal"
    );
    return proposal;
  }
  #materializeCurrent(proposal) {
    const observed = this.#observeRaw();
    assertBaseCurrent({
      task_id: proposal.task_id,
      plan_revision_id: proposal.base_plan_revision_id,
      content_digest: proposal.base_content_digest
    }, observed);
    const materialized = this.#port.materialize(proposal, observed.bytes);
    invariant(
      materialized.bytes.length <= MAX_PLAN_BYTES,
      "PLAN_AUTHORITY_TOO_LARGE",
      `Candidate TASK_PLAN.md exceeds the ${MAX_PLAN_BYTES}-byte authority limit`
    );
    return { observed, materialized };
  }
  observe() {
    const observed = this.#observeRaw();
    return immutableJson({
      schema: PLAN_OBSERVATION_SCHEMA,
      task_id: observed.task_id,
      plan_revision_id: observed.plan_revision_id,
      content_digest: observed.content_digest,
      plan: observed.plan
    }, { code: "PLAN_OBSERVATION_INVALID", field: "plan.observe response" });
  }
  propose(input) {
    const intent = boundaryClone(input, { code: "PLAN_INTENT_JSON_DOMAIN_INVALID", field: "plan.propose intent" });
    exactFields2(intent, INTENT_FIELDS2, "PLAN_INTENT_FIELDS_INVALID", "Plan intent");
    invariant(intent.schema === PLAN_INTENT_SCHEMA, "PLAN_INTENT_SCHEMA_UNSUPPORTED", `Expected ${PLAN_INTENT_SCHEMA}`);
    validateIntentBase(intent.base);
    const observed = this.#observeRaw();
    assertBaseCurrent(intent.base, observed);
    const candidate = intent.candidate_plan;
    const proposal = this.#port.proposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      proposal_id: intent.proposal_id,
      task_id: observed.task_id,
      base_plan_revision_id: observed.plan_revision_id,
      base_content_digest: observed.content_digest,
      proposed_plan_revision_id: candidate?.plan_revision_id,
      requirements_version: candidate?.requirements_version,
      created_at: candidate?.updated_at,
      producer: intent.producer,
      change_reason: intent.change_reason,
      candidate_plan: candidate
    });
    const materialized = this.#port.materialize(proposal, observed.bytes);
    invariant(
      materialized.bytes.length <= MAX_PLAN_BYTES,
      "PLAN_AUTHORITY_TOO_LARGE",
      `Candidate TASK_PLAN.md exceeds the ${MAX_PLAN_BYTES}-byte authority limit`
    );
    return proposalView(proposal);
  }
  validate(input) {
    const proposal = this.#reconstruct(input);
    const { materialized } = this.#materializeCurrent(proposal);
    return immutableJson({
      schema: PLAN_VALIDATION_SCHEMA,
      valid: true,
      stale: false,
      task_id: proposal.task_id,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      base_plan_revision_id: proposal.base_plan_revision_id,
      base_content_digest: proposal.base_content_digest,
      candidate_plan_revision_id: proposal.proposed_plan_revision_id,
      candidate_content_digest: materialized.content_digest
    }, { code: "PLAN_VALIDATION_RESULT_INVALID", field: "plan.validate response" });
  }
  diff(input) {
    const proposal = this.#reconstruct(input);
    const { materialized } = this.#materializeCurrent(proposal);
    return immutableJson(materialized.diff, { code: "PLAN_DIFF_INVALID", field: "plan.diff response" });
  }
  apply(input) {
    const proposal = this.#reconstruct(input);
    const result = this.#port.apply(proposal);
    return immutableJson(result, { code: "PLAN_APPLY_RESULT_INVALID", field: "plan.apply response" });
  }
};
Object.freeze(IntentAdapter.prototype);
function publicSurface(adapter) {
  const surface = /* @__PURE__ */ Object.create(null);
  for (const operation of ["observe", "propose", "validate", "diff", "apply"]) {
    Object.defineProperty(surface, operation, {
      value: (...args) => {
        const expected = operation === "observe" ? 0 : 1;
        invariant(args.length === expected, "PLAN_ADAPTER_ARGUMENTS_INVALID", `plan.${operation} expects exactly ${expected} argument${expected === 1 ? "" : "s"}`);
        return adapter[operation](...args);
      },
      enumerable: true,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(surface);
}
function createPlanAdapter(path = "TASK_PLAN.md") {
  invariant(arguments.length <= 1, "PLAN_ADAPTER_ARGUMENTS_INVALID", "createPlanAdapter expects at most one path argument");
  invariant(typeof path === "string" && path.length > 0, "PLAN_ADAPTER_PATH_INVALID", "Plan adapter path must be a non-empty string");
  return publicSurface(new IntentAdapter(path));
}
var plan = createPlanAdapter();

// src/metrics.mjs
import { statSync as statSync2 } from "node:fs";
var METRICS_SCHEMA_VERSION = "1.0.0";
var DEFAULT_METRICS_RETENTION = Object.freeze({ sessions: 100, samples: 2e3, handoffEvents: 1e3, diagnostics: 100 });
var FORBIDDEN_RECORD_KEYS = /* @__PURE__ */ new Set(["conversation", "history", "messages", "prompt", "response", "content", "transcript"]);
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function assertTelemetrySafe(record) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_RECORD_KEYS.has(key.toLowerCase())) throw new Error(`METRICS_FORBIDDEN_FIELD:${key}`);
      visit(child);
    }
  };
  visit(record);
  return record;
}
function measureHandoffArtifacts({ taskPlanPath = null, checkpointBytes = null, manifestBytes = null, resumePrompt = null, minimalReads = null } = {}) {
  let taskPlanBytes = null;
  if (taskPlanPath) {
    try {
      taskPlanBytes = statSync2(taskPlanPath).size;
    } catch {
      taskPlanBytes = null;
    }
  }
  return {
    task_plan_bytes: numberOrNull(taskPlanBytes),
    checkpoint_sealed_bytes: Buffer.isBuffer(checkpointBytes) || checkpointBytes instanceof Uint8Array ? checkpointBytes.byteLength : null,
    manifest_bytes: Buffer.isBuffer(manifestBytes) || manifestBytes instanceof Uint8Array ? manifestBytes.byteLength : null,
    resume_prompt_bytes: typeof resumePrompt === "string" ? Buffer.byteLength(resumePrompt, "utf8") : null,
    minimal_reads_count: null,
    minimal_reads_declared_count: Array.isArray(minimalReads) ? minimalReads.length : null
  };
}

// src/runner-ownership.mjs
var RUNNER_BINDING_CUSTOM_TYPE = "aiopago.runner-session-binding.v1";
var LEGACY_RUNNER_BINDING_CUSTOM_TYPE = "eiopago.runner-session-binding.v1";
var RUNNER_BINDING_CUSTOM_TYPES = /* @__PURE__ */ new Set([RUNNER_BINDING_CUSTOM_TYPE, LEGACY_RUNNER_BINDING_CUSTOM_TYPE]);
var BINDING_FIELDS = ["handoff_id", "replacement_session_id", "runner_instance_id", "session_binding_id"];
function assertBindingShape(binding) {
  invariant(binding && typeof binding === "object", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "binding missing");
  invariant(binding.schema_version === "1.0.0", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "binding schema");
  for (const field of BINDING_FIELDS) invariant(typeof binding[field] === "string" && binding[field].length > 0, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", field);
  return binding;
}
function readRuntimeRunnerBinding(session) {
  invariant(session?.sessionManager && typeof session.sessionId === "string", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "runtime session missing");
  const entries = session.sessionManager.getEntries();
  const matches = entries.filter((entry2) => entry2.type === "custom" && RUNNER_BINDING_CUSTOM_TYPES.has(entry2.customType));
  invariant(matches.length === 1, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "Runner binding entry missing or duplicated");
  const entry = matches[0];
  const bindingIndex = entries.indexOf(entry);
  invariant(entries.slice(0, bindingIndex).every((candidate) => ["model_change", "thinking_level_change"].includes(candidate.type)), "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "Runner binding was not installed during session setup");
  const binding = assertBindingShape(entry.data);
  invariant(session.sessionManager.getSessionId() === session.sessionId && binding.replacement_session_id === session.sessionId, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "current runtime session mismatch");
  return binding;
}
function verifyRunnerOwnership({ runtimeBinding, journalBinding, manifestBinding, expected }) {
  assertBindingShape(runtimeBinding);
  assertBindingShape(journalBinding);
  assertBindingShape(manifestBinding);
  assertBindingShape(expected);
  invariant(journalBinding.status === "ACTIVE", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "handoff binding stale or superseded");
  for (const field of BINDING_FIELDS) {
    invariant(runtimeBinding[field] === expected[field] && journalBinding[field] === expected[field] && manifestBinding[field] === expected[field], "RUNNER_OWNERSHIP_ATTESTATION_FAILED", field);
  }
  invariant(journalBinding.event_data && typeof journalBinding.event_data === "object", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "journal binding event missing");
  for (const field of BINDING_FIELDS) invariant(journalBinding.event_data[field] === expected[field], "RUNNER_OWNERSHIP_ATTESTATION_FAILED", `journal ${field}`);
  return Object.freeze({ ...expected, status: "ATTESTED" });
}
export {
  CONTEXT_HANDOFF_THRESHOLD_ENV,
  ContextHandoffAdvisor,
  DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT,
  DEFAULT_METRICS_RETENTION,
  DEFAULT_REPOSITORY_CONFIG,
  GuardianError,
  INSTALLATION_ROOT,
  LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV,
  LEGACY_REPOSITORY_CONFIG_SCHEMA,
  LEGACY_RUNNER_BINDING_CUSTOM_TYPE,
  METRICS_SCHEMA_VERSION,
  REPOSITORY_CONFIG_FILE,
  REPOSITORY_CONFIG_SCHEMA,
  RUNNER_BINDING_CUSTOM_TYPE,
  TaskLedger,
  assertTelemetrySafe,
  canonicalJson,
  canonicalRequiredLocalPaths,
  contextHandoffThreshold,
  contextHandoffThresholdEnvironment,
  createPlanAdapter,
  digestObject,
  discoverTargetRepository,
  fail,
  formatHumanNext,
  formatHumanStatus,
  formatHumanTechnical,
  formatHumanWhy,
  formatPlan,
  formatPlanTechnical,
  guidedHandoffEligibilityIdentity,
  invariant,
  jsonClone,
  loadRepositoryContext,
  measureHandoffArtifacts,
  observeGitState,
  observeHumanWorkflow,
  observeRawTaskPlan,
  observeRunnerHumanWorkflow,
  observeTaskPlan,
  opaqueId,
  plan,
  projectHumanWorkflow,
  readRepositoryConfig,
  readRuntimeProjection,
  readRuntimeRunnerBinding,
  sameGitState,
  sameGuidedHandoffEligibility,
  sha256,
  stableId,
  strictJsonClone,
  utcNow,
  validateRepositoryConfig,
  validateRepositoryStateBoundaries,
  validateRequiredLocalPaths,
  validateRuntimeObservation,
  validateTaskLedger,
  verifyRunnerOwnership
};
