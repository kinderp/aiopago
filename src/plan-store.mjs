import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { sha256 } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";

export const TASK_LEDGER_SCHEMA = "aiopago.task-ledger/0.1.0";
export const LEGACY_TASK_LEDGER_SCHEMA = "eiopago.task-ledger/0.1.0";

const LEDGER_BLOCK = /```json task-ledger[^\S\r\n]*(\r?\n)([\s\S]*?)(\r?\n)```/;
const SCHEMA_HEADER = /^\*\*Schema:\*\*[ \t]*`([^`]+)`[ \t]*$/gm;
export const MAX_PLAN_BYTES = 32 * 1024 * 1024;
export const MAX_PLAN_STATE_BYTES = 128 * 1024 * 1024;
const LOCK_SCHEMA = "aiopago.plan-write-lock/0.3.0";
const LOCK_METADATA_KEYS = Object.freeze([
  "schema", "ownership_nonce", "pid", "process_identity", "created_at", "plan_path", "guardian_root",
]);

const DEFAULT_IO = Object.freeze({
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
});

function parseJson(text) {
  try { return JSON.parse(text); }
  catch (error) { throw new GuardianError("LEDGER_JSON_INVALID", error.message); }
}

export function parseTaskPlanBytes(bytes, { requireSingleBlock = false } = {}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(source); }
  catch { throw new GuardianError("PLAN_UTF8_INVALID", "TASK_PLAN.md must contain well-formed UTF-8 bytes"); }
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
      lineEnding: block[1],
    }),
    ledgerSchema: schemaMatches.length === 1 ? schemaMatches[0][1] : null,
    schemaHeaderCount: schemaMatches.length,
    contentDigest: sha256(source),
  });
}

function closeQuietly(io, fd) {
  if (fd === undefined) return;
  try { io.closeSync(fd); } catch {}
}

function directorySyncUnsupported(error, phase) {
  if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error?.code)) return true;
  if (process.platform !== "win32") return false;
  const windowsUnsupported = phase === "open"
    ? ["EPERM", "EINVAL", "EISDIR"]
    : ["EPERM", "EINVAL", "EBADF"];
  return windowsUnsupported.includes(error?.code);
}

function syncDirectory(io, path) {
  let fd;
  try {
    try { fd = io.openSync(path, "r"); }
    catch (error) { if (directorySyncUnsupported(error, "open")) return false; throw error; }
    try { io.fsyncSync(fd); }
    catch (error) {
      if (!directorySyncUnsupported(error, "fsync")) throw error;
      io.closeSync(fd);
      fd = undefined;
      return false;
    }
    io.closeSync(fd);
    fd = undefined;
    return true;
  } finally {
    closeQuietly(io, fd);
  }
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function statValue(stat, field) {
  return typeof stat[field] === "bigint" ? stat[field].toString() : String(stat[field]);
}

function fileIdentity(stat) {
  return Object.freeze({ device: statValue(stat, "dev"), inode: statValue(stat, "ino") });
}

function timestampValue(stat, nanoseconds, milliseconds) {
  if (stat[nanoseconds] !== undefined) return statValue(stat, nanoseconds);
  return String(Math.trunc(Number(stat[milliseconds]) * 1_000_000));
}

function stableFileFingerprint(stat) {
  return Object.freeze({
    ...fileIdentity(stat),
    size: statValue(stat, "size"),
    nlink: statValue(stat, "nlink"),
    mtimeNs: timestampValue(stat, "mtimeNs", "mtimeMs"),
    ctimeNs: timestampValue(stat, "ctimeNs", "ctimeMs"),
    regular: stat.isFile(),
  });
}

export function sameFileFingerprint(left, right) {
  return Boolean(left && right)
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.regular === right.regular;
}

export function sameFilesystemIdentity(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}

function randomToken() {
  return randomBytes(32).toString("hex");
}

const PROCESS_LIVE = (identity) => Object.freeze({ status: "LIVE", identity });
const PROCESS_DEAD = Object.freeze({ status: "DEAD", identity: null });
const PROCESS_UNKNOWN = Object.freeze({ status: "UNKNOWN", identity: null });
const WINDOWS_LIVE_SENTINEL = "AIOPAGO_PROCESS_LIVE_V1:";
const WINDOWS_UNKNOWN_SENTINEL = "AIOPAGO_PROCESS_UNKNOWN_V1";
// Node's synchronous child termination after a Windows timeout can itself take
// a short scheduling interval. Near a takeover deadline, do not start a new OS
// subprocess that cannot be safely reaped inside the remaining wall-clock
// budget. The deadline itself remains start + timeoutMs.
const MIN_BOUNDED_PROCESS_PROBE_BUDGET_MS = 3_000;

function positiveNativeProcessAbsence(pid, kill = process.kill.bind(process)) {
  try { kill(pid, 0); return false; }
  catch (error) {
    if (error?.code === "ESRCH") return true;
    return null;
  }
}

function windowsProcessIdentityProbe(pid, { timeoutMs = 5_000, spawn = spawnSync, kill } = {}) {
  const nativeAbsence = positiveNativeProcessAbsence(pid, kill);
  if (nativeAbsence === true) return PROCESS_DEAD;
  if (nativeAbsence === null) return PROCESS_UNKNOWN;
  const command = [
    "$ErrorActionPreference='Stop'",
    "$probeErrors=@()",
    `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue -ErrorVariable +probeErrors`,
    "if ($null -eq $p) {",
    // PowerShell is user-space identity diagnostics only. Even its exact
    // not-found classification cannot authorize stale-lock deletion; a later
    // native process.kill(pid, 0) ESRCH observation supplies that authority.
    `  [Console]::Out.Write('${WINDOWS_UNKNOWN_SENTINEL}'); exit 4`,
    "}",
    "try {",
    `  [Console]::Out.Write('${WINDOWS_LIVE_SENTINEL}'+$p.StartTime.ToUniversalTime().Ticks); exit 0`,
    "} catch {",
    `  [Console]::Out.Write('${WINDOWS_UNKNOWN_SENTINEL}'); exit 4`,
    "}",
  ].join(";");
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.max(1, Math.floor(timeoutMs)),
    windowsHide: true,
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
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5_000;
  if (process.platform === "linux") {
    let stat;
    try { stat = (options.readFileSync ?? readFileSync)(`/proc/${pid}/stat`, "utf8"); }
    catch (error) { return error?.code === "ENOENT" ? PROCESS_DEAD : PROCESS_UNKNOWN; }
    const close = stat.lastIndexOf(")");
    if (close < 0) return PROCESS_UNKNOWN;
    const fields = stat.slice(close + 2).split(" ");
    const startTicks = fields[19];
    let bootId;
    try { bootId = (options.readFileSync ?? readFileSync)("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
    catch { return PROCESS_UNKNOWN; }
    if (!/^\d+$/.test(startTicks) || !/^[a-f0-9-]{16,}$/i.test(bootId)) return PROCESS_UNKNOWN;
    return PROCESS_LIVE(`linux:${bootId}:${startTicks}`);
  }
  if (process.platform === "win32") return windowsProcessIdentityProbe(pid, { ...options, timeoutMs });

  const nativeAbsence = positiveNativeProcessAbsence(pid, options.kill);
  if (nativeAbsence === true) return PROCESS_DEAD;
  if (nativeAbsence === null) return PROCESS_UNKNOWN;
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs,
    }).trim().replace(/\s+/g, " ");
    if (!started) return PROCESS_UNKNOWN;
    const boot = execFileSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs,
    }).trim().replace(/\s+/g, " ");
    return boot ? PROCESS_LIVE(`${process.platform}:${boot}:${started}`) : PROCESS_UNKNOWN;
  } catch {
    return PROCESS_UNKNOWN;
  }
}

export function processIdentityProbeForInternalTest(pid, options = {}) { return processIdentityProbe(pid, options); }

let cachedCurrentProcessIdentity = null;
const deadlineVerifiedLockOwners = new WeakMap();
function defaultProcessIdentityProbe(pid, options = {}) {
  if (pid !== process.pid) return processIdentityProbe(pid, options);
  if (cachedCurrentProcessIdentity?.status === "LIVE") return cachedCurrentProcessIdentity;
  const observed = processIdentityProbe(pid, options);
  if (observed.status === "LIVE") cachedCurrentProcessIdentity = observed;
  return observed;
}

function deadlineRemaining(deadline) {
  if (deadline === null || deadline === undefined) return null;
  invariant(deadline && Number.isFinite(deadline.expiresAt), "PLAN_COORDINATION_DEADLINE_INVALID");
  const remaining = deadline.expiresAt - performance.now();
  if (remaining <= 0) throw new GuardianError("PLAN_COORDINATION_DEADLINE_EXCEEDED", "Plan coordination deadline expired before canonical authority acquisition");
  return remaining;
}

function exactObjectKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function temporaryPath(path, label) {
  return `${path}.${process.pid}.${randomBytes(16).toString("hex")}.${label}.tmp`;
}

export class PlanRevisionWriter {
  #io;
  #testHooks;
  #processIdentityProbe;

  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve(path);
    this.guardianRoot = resolve(options.guardianRoot ?? join(dirname(this.path), ".guardian"));
    this.lockPath = resolve(options.lockPath ?? join(this.guardianRoot, "plan-write.lock"));
    this.lockRecoveryPath = `${this.lockPath}.recovery`;
    this.#io = Object.freeze({ ...DEFAULT_IO, ...(options.io ?? {}) });
    this.#testHooks = options.testHooks ?? null;
    this.#processIdentityProbe = options.processIdentityProbe ?? defaultProcessIdentityProbe;
  }

  #ensureRealDirectory(path) {
    this.#io.mkdirSync(path, { recursive: true });
    const stat = this.#io.lstatSync(path, { bigint: true });
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && samePath(this.#io.realpathSync(path), path), "PLAN_STATE_PATH_REDIRECTED", `Refusing redirected plan state directory: ${path}`);
  }

  #pathExists(path) {
    try { this.#io.lstatSync(path, { bigint: true }); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }

  #readRegular(path, { maximum = MAX_PLAN_STATE_BYTES, code = "PLAN_PROVENANCE_INVALID", allowHardlinks = false } = {}) {
    const absolute = resolve(path);
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
      fd = undefined;

      const postPath1Stat = this.#io.lstatSync(absolute, { bigint: true });
      const postPath1 = stableFileFingerprint(postPath1Stat);
      invariant(postPath1.regular && !postPath1Stat.isSymbolicLink() && (allowHardlinks || postPath1.nlink === "1"), code, `File pathname changed after reading ${absolute}`);
      invariant(samePath(this.#io.realpathSync(absolute), absolute), code, `Refusing redirected file after reading ${absolute}`);
      const postPath2Stat = this.#io.lstatSync(absolute, { bigint: true });
      const postPath2 = stableFileFingerprint(postPath2Stat);
      invariant(postPath2.regular && !postPath2Stat.isSymbolicLink() && (allowHardlinks || postPath2.nlink === "1")
        && sameFileFingerprint(postPath1, postPath2) && sameFileFingerprint(descriptorAfter, postPath2), code, `File pathname changed after reading ${absolute}`);
      return Object.freeze({ bytes, identity: fileIdentity(descriptorAfterStat), fingerprint: descriptorAfter, mode: Number(descriptorAfterStat.mode) & 0o777 });
    } finally {
      closeQuietly(this.#io, fd);
    }
  }

  #lockError(code, message, details = undefined) {
    return new GuardianError(code, `${message}: ${this.lockPath}`, details);
  }

  #parseLock(record, path = this.lockPath) {
    let metadata;
    try { metadata = JSON.parse(record.bytes.toString("utf8")); }
    catch { throw this.#lockError("PLAN_LOCK_INVALID", "Plan lock metadata is malformed and requires explicit human reconciliation"); }
    invariant(exactObjectKeys(metadata, LOCK_METADATA_KEYS)
      && metadata.schema === LOCK_SCHEMA
      && /^[a-f0-9]{64}$/.test(metadata.ownership_nonce ?? "")
      && Number.isSafeInteger(metadata.pid) && metadata.pid > 0
      && typeof metadata.process_identity === "string" && metadata.process_identity.length > 0 && metadata.process_identity.length <= 2048
      && canonicalIsoTimestamp(metadata.created_at)
      && typeof metadata.plan_path === "string" && samePath(metadata.plan_path, this.path)
      && typeof metadata.guardian_root === "string" && samePath(metadata.guardian_root, this.guardianRoot),
    "PLAN_LOCK_INVALID", `Plan lock metadata at ${path} is unknown, incomplete, or belongs to another plan; explicit human reconciliation is required`);
    return Object.freeze(metadata);
  }

  #ownerState(metadata, deadline = null) {
    const remaining = deadlineRemaining(deadline);
    const deadlineOwnerKey = `${metadata.ownership_nonce}\0${metadata.pid}\0${metadata.process_identity}`;
    const verifiedOwners = deadline && process.platform === "win32"
      ? (deadlineVerifiedLockOwners.get(deadline) ?? new Set())
      : null;
    if (verifiedOwners && !deadlineVerifiedLockOwners.has(deadline)) deadlineVerifiedLockOwners.set(deadline, verifiedOwners);
    if (verifiedOwners?.has(deadlineOwnerKey)) {
      // This is not a liveness cache: native PID existence is re-observed on
      // every retry. The prior exact match only means an existing PID cannot
      // authorize cleanup without another start-identity proof.
      if (positiveNativeProcessAbsence(metadata.pid) === true) return "DEAD";
      throw this.#lockError("PLAN_WRITE_LOCKED", "Plan lock remains held by an invocation-locally verified owner instance");
    }
    if (remaining !== null && remaining < MIN_BOUNDED_PROCESS_PROBE_BUDGET_MS) {
      // A native ESRCH is still a positive, non-spawning absence proof. If the
      // PID exists (including possible reuse), there is not enough time left to
      // establish its exact start identity safely, so coordination times out.
      if (process.platform === "win32" && positiveNativeProcessAbsence(metadata.pid) === true) return "DEAD";
      throw this.#lockError("PLAN_WRITE_LOCKED", "Plan lock remains coordinated because the exact owner cannot be re-probed inside the remaining deadline budget");
    }
    const observed = this.#processIdentityProbe(metadata.pid, { timeoutMs: remaining === null ? 5_000 : Math.min(5_000, remaining) });
    invariant(observed && ["LIVE", "DEAD", "UNKNOWN"].includes(observed.status), "PLAN_PROCESS_IDENTITY_UNAVAILABLE");
    if (observed.status === "LIVE" && observed.identity === metadata.process_identity) {
      verifiedOwners?.add(deadlineOwnerKey);
      return "LIVE";
    }
    if (process.platform === "win32") {
      // The only Windows cleanup authority is a fresh positive native absence
      // observation. PowerShell DEAD output, process-start mismatch, PATH/PATHEXT
      // or cwd shadowing, and every other user-space ambiguity preserve the lock.
      return positiveNativeProcessAbsence(metadata.pid) === true ? "DEAD" : "UNKNOWN";
    }
    if (observed.status === "DEAD") return "DEAD";
    // A different start identity while the PID exists is conservative PID-reuse
    // ambiguity, not proof that the recorded owner is absent.
    return "UNKNOWN";
  }

  #assertDeadLock(record, path, deadline = null) {
    const metadata = this.#parseLock(record, path);
    const state = this.#ownerState(metadata, deadline);
    if (state === "LIVE") throw this.#lockError("PLAN_WRITE_LOCKED", "Aiopago plan mutation is held by the exact live process owner");
    if (state !== "DEAD") throw this.#lockError("PLAN_LOCK_OWNER_UNVERIFIED", "Plan lock owner identity cannot be proven live or dead; explicit human reconciliation is required");
    return metadata;
  }

  #completeStaleRecovery(expected = null, deadline = null) {
    deadlineRemaining(deadline);
    let marker;
    try { marker = this.#readRegular(this.lockRecoveryPath, { maximum: 4096, code: "PLAN_LOCK_RECOVERY_INVALID", allowHardlinks: true }); }
    catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    this.#assertDeadLock(marker, this.lockRecoveryPath, deadline);
    if (expected) invariant(sameFilesystemIdentity(marker.identity, expected.identity) && marker.bytes.equals(expected.bytes),
      "PLAN_LOCK_RECOVERY_RACED", "The stale-lock recovery marker no longer identifies the observed dead lock");

    let current = null;
    try { current = this.#readRegular(this.lockPath, { maximum: 4096, code: "PLAN_LOCK_RECOVERY_INVALID", allowHardlinks: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (current) {
      invariant(sameFilesystemIdentity(current.identity, marker.identity) && current.bytes.equals(marker.bytes),
        "PLAN_LOCK_RECOVERY_RACED", "A replacement plan lock appeared during stale cleanup and was not removed");
      this.#io.unlinkSync(this.lockPath);
      syncDirectory(this.#io, dirname(this.lockPath));
    }
    let markerAgain;
    try { markerAgain = this.#readRegular(this.lockRecoveryPath, { maximum: 4096, code: "PLAN_LOCK_RECOVERY_INVALID", allowHardlinks: true }); }
    catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    invariant(sameFilesystemIdentity(markerAgain.identity, marker.identity) && markerAgain.bytes.equals(marker.bytes),
      "PLAN_LOCK_RECOVERY_RACED", "The stale-lock recovery marker changed before cleanup");
    try { this.#io.unlinkSync(this.lockRecoveryPath); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    syncDirectory(this.#io, dirname(this.lockRecoveryPath));
    return true;
  }

  #recoverExistingLock(deadline = null) {
    deadlineRemaining(deadline);
    if (this.#pathExists(this.lockRecoveryPath)) return this.#completeStaleRecovery(null, deadline);
    let observed;
    try { observed = this.#readRegular(this.lockPath, { maximum: 4096, code: "PLAN_LOCK_INVALID" }); }
    catch (error) { if (error?.code === "ENOENT") return true; throw error; }
    this.#assertDeadLock(observed, this.lockPath, deadline);
    try { this.#io.linkSync(this.lockPath, this.lockRecoveryPath); }
    catch (error) {
      if (error?.code === "EEXIST") return this.#completeStaleRecovery(null, deadline);
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    syncDirectory(this.#io, dirname(this.lockPath));
    return this.#completeStaleRecovery(observed, deadline);
  }

  #publishLock(bytes, deadline = null) {
    deadlineRemaining(deadline);
    const temp = temporaryPath(this.lockPath, "owner");
    let fd;
    let ownsTemp = false;
    try {
      fd = this.#io.openSync(temp, "wx", 0o600);
      ownsTemp = true;
      this.#io.writeFileSync(fd, bytes);
      this.#io.fsyncSync(fd);
      this.#io.closeSync(fd);
      fd = undefined;
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
      if (ownsTemp) { try { this.#io.unlinkSync(temp); } catch {} }
    }
  }

  #acquireLock(deadline = null) {
    deadlineRemaining(deadline);
    this.#ensureRealDirectory(this.guardianRoot);
    const remaining = deadlineRemaining(deadline);
    const ownIdentityAlreadyCached = this.#processIdentityProbe === defaultProcessIdentityProbe
      && cachedCurrentProcessIdentity?.status === "LIVE";
    if (remaining !== null && remaining < MIN_BOUNDED_PROCESS_PROBE_BUDGET_MS && !ownIdentityAlreadyCached) {
      throw new GuardianError("PLAN_COORDINATION_DEADLINE_EXCEEDED", "Insufficient remaining coordination budget for a bounded current-process identity probe");
    }
    const own = this.#processIdentityProbe(process.pid, { timeoutMs: remaining === null ? 5_000 : Math.min(5_000, remaining) });
    invariant(own?.status === "LIVE" && typeof own.identity === "string", "PLAN_PROCESS_IDENTITY_UNAVAILABLE", "Cannot establish the current process start identity for plan locking");
    const bytes = Buffer.from(`${JSON.stringify({
      schema: LOCK_SCHEMA,
      ownership_nonce: randomToken(),
      pid: process.pid,
      process_identity: own.identity,
      created_at: new Date().toISOString(),
      plan_path: this.path,
      guardian_root: this.guardianRoot,
    })}\n`, "utf8");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      deadlineRemaining(deadline);
      try { return this.#publishLock(bytes, deadline); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!this.#recoverExistingLock(deadline)) throw this.#lockError("PLAN_WRITE_LOCKED", "Aiopago plan mutation is already locked");
      }
    }
    throw this.#lockError("PLAN_WRITE_LOCKED", "Aiopago plan mutation could not acquire coordination after stale-lock recovery");
  }

  #attestLock(lock) {
    let current;
    try { current = this.#readRegular(this.lockPath, { maximum: 4096, code: "PLAN_LOCK_OWNERSHIP_LOST" }); }
    catch (error) {
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
      fd = undefined;

      const postPath1Stat = this.#io.lstatSync(this.path, { bigint: true });
      const postPath1 = stableFileFingerprint(postPath1Stat);
      invariant(postPath1.regular && !postPath1Stat.isSymbolicLink() && postPath1.nlink === "1", "PLAN_CAS_CONFLICT", "TASK_PLAN.md pathname changed after final descriptor read");
      const canonicalPath = this.#io.realpathSync(this.path);
      const postPath2Stat = this.#io.lstatSync(this.path, { bigint: true });
      const postPath2 = stableFileFingerprint(postPath2Stat);
      invariant(samePath(canonicalPath, this.path)
        && postPath2.regular && !postPath2Stat.isSymbolicLink() && postPath2.nlink === "1"
        && sameFileFingerprint(postPath1, postPath2) && sameFileFingerprint(descriptorAfter, postPath2), "PLAN_CAS_CONFLICT", "TASK_PLAN.md pathname no longer identifies the descriptor snapshot during final attestation");
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
    invariant(sameFilesystemIdentity(observed.identity, current.fileIdentity)
      && sameFileFingerprint(observed.fingerprint, current.fileFingerprint)
      && observed.bytes.equals(current.bytes), "PLAN_CAS_CONFLICT", "TASK_PLAN.md no longer equals the exact initial authority bytes, identity, and fingerprint during final raw attestation");
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
    return this.#pathExists(resolve(path));
  }

  assertStateDirectory(path) {
    const absolute = resolve(path);
    const stat = this.#io.lstatSync(absolute, { bigint: true });
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && samePath(this.#io.realpathSync(absolute), absolute), "PLAN_STATE_PATH_REDIRECTED", `Refusing redirected plan state directory: ${absolute}`);
    return absolute;
  }

  stateDirectoryEntries(path) {
    const absolute = this.assertStateDirectory(path);
    return this.#io.readdirSync(absolute, { withFileTypes: true });
  }

  readImmutable(path, maximum = MAX_PLAN_STATE_BYTES) {
    return Buffer.from(this.#readRegular(resolve(path), { maximum, code: "PLAN_PROVENANCE_INVALID" }).bytes);
  }

  #redurabilizeExisting(path, identity) {
    let fd;
    try {
      fd = this.#io.openSync(path, "r+");
      const stat = this.#io.fstatSync(fd, { bigint: true });
      invariant(stat.isFile() && sameFilesystemIdentity(fileIdentity(stat), identity), "PLAN_PROVENANCE_INVALID", `Immutable record changed before durability retry: ${path}`);
      this.#io.fsyncSync(fd);
      this.#io.closeSync(fd);
      fd = undefined;
      syncDirectory(this.#io, dirname(path));
    } finally {
      closeQuietly(this.#io, fd);
    }
  }

  writeImmutable(path, bytes, { conflictCode = "PLAN_PROVENANCE_CONFLICT", maximum = MAX_PLAN_STATE_BYTES, allowExistingExact = true } = {}) {
    const destination = resolve(path);
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
      fd = this.#io.openSync(temp, "wx", 0o600);
      ownsTemp = true;
      this.#io.writeFileSync(fd, value);
      this.#io.fsyncSync(fd);
      this.#io.closeSync(fd);
      fd = undefined;
      this.#io.linkSync(temp, destination);
      this.#io.unlinkSync(temp);
      ownsTemp = false;
      syncDirectory(this.#io, parent);
    } catch (error) {
      closeQuietly(this.#io, fd);
      if (ownsTemp) { try { this.#io.unlinkSync(temp); } catch {} }
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
    const taskMatches = expected.taskId === undefined || observed.task.task_id === expected.taskId;
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
        phase,
      });
    }
  }

  #prepareCandidateTemp(bytes, mode, baseIdentity) {
    const temp = temporaryPath(this.path, "replace");
    let fd;
    let ownsTemp = false;
    try {
      fd = this.#io.openSync(temp, "wx", mode || 0o600);
      ownsTemp = true;
      if (process.platform !== "win32") this.#io.fchmodSync(fd, mode || 0o600);
      this.#io.writeFileSync(fd, bytes);
      this.#io.fsyncSync(fd);
      const identity = fileIdentity(this.#io.fstatSync(fd, { bigint: true }));
      invariant(!sameFilesystemIdentity(identity, baseIdentity), "PLAN_COMMIT_WITNESS_INVALID", "Candidate temp must have a distinct filesystem identity from the base authority");
      this.#io.closeSync(fd);
      fd = undefined;
      return { path: temp, identity, reference: relative(dirname(this.path), temp).replaceAll("\\", "/"), ownsTemp };
    } catch (error) {
      closeQuietly(this.#io, fd);
      if (ownsTemp) { try { this.#io.unlinkSync(temp); } catch {} }
      throw error;
    }
  }

  #historyReference(contentDigest) {
    invariant(/^sha256:[a-f0-9]{64}$/.test(contentDigest), "PLAN_HISTORY_INVALID", "History digest is invalid");
    return `.guardian/plan-history/sha256-${contentDigest.slice("sha256:".length)}.md`;
  }

  #persistHistory(current) {
    const reference = this.#historyReference(current.contentDigest);
    const path = resolve(dirname(this.path), reference);
    try { this.writeImmutable(path, current.bytes, { conflictCode: "PLAN_HISTORY_CORRUPT" }); }
    catch (error) {
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
      try { this.#releaseLock(lock); }
      catch (releaseError) { if (!operationError) throw releaseError; }
    }
  }

  commit({
    expected = null,
    requireSingleBlock = false,
    validate,
    inspectExisting,
    prepare,
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
      if (existing !== undefined && existing !== null) return existing;
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
        previousSnapshotReference,
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
      if (temp?.ownsTemp) { try { this.#io.unlinkSync(temp.path); } catch {} }
      try { this.#releaseLock(lock); }
      catch (releaseError) { if (!operationError) throw releaseError; }
    }
  }
}
