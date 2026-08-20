import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256 } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";

export const TASK_LEDGER_SCHEMA = "aiopago.task-ledger/0.1.0";
export const LEGACY_TASK_LEDGER_SCHEMA = "eiopago.task-ledger/0.1.0";

const LEDGER_BLOCK = /```json task-ledger[^\S\r\n]*(\r?\n)([\s\S]*?)(\r?\n)```/;
const SCHEMA_HEADER = /^\*\*Schema:\*\*[ \t]*`([^`]+)`[ \t]*$/gm;
let temporarySequence = 0;

const DEFAULT_IO = Object.freeze({
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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

function unlinkQuietly(io, path) {
  try { if (io.existsSync(path)) io.unlinkSync(path); } catch {}
}

function syncDirectory(io, path) {
  let fd;
  try {
    fd = io.openSync(path, "r");
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
  } catch {
    closeQuietly(io, fd);
  }
}

function temporaryPath(path, label) {
  temporarySequence += 1;
  return `${path}.${process.pid}.${Date.now()}.${temporarySequence}.${label}.tmp`;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class PlanRevisionWriter {
  constructor(path = "TASK_PLAN.md", options = {}) {
    this.path = resolve(path);
    this.io = Object.freeze({ ...DEFAULT_IO, ...(options.io ?? {}) });
    this.guardianRoot = resolve(options.guardianRoot ?? join(dirname(this.path), ".guardian"));
    this.lockPath = resolve(options.lockPath ?? join(this.guardianRoot, "plan-write.lock"));
  }

  #assertRealFile(path) {
    const stat = this.io.lstatSync(path);
    invariant(stat.isFile() && !stat.isSymbolicLink() && samePath(this.io.realpathSync(path), path), "PLAN_PATH_REDIRECTED", `Refusing redirected or non-file authoritative plan path: ${path}`);
  }

  #ensureRealDirectory(path) {
    this.io.mkdirSync(path, { recursive: true });
    const stat = this.io.lstatSync(path);
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && samePath(this.io.realpathSync(path), path), "PLAN_STATE_PATH_REDIRECTED", `Refusing redirected plan state directory: ${path}`);
  }

  #ensureGuardianRoot() {
    this.#ensureRealDirectory(this.guardianRoot);
  }

  #acquireLock() {
    this.#ensureGuardianRoot();
    let fd;
    let ownsLock = false;
    try {
      fd = this.io.openSync(this.lockPath, "wx", 0o600);
      ownsLock = true;
      const record = `${JSON.stringify({ schema: "aiopago.plan-write-lock/0.1.0", pid: process.pid, created_at: new Date().toISOString() })}\n`;
      this.io.writeFileSync(fd, record, "utf8");
      this.io.fsyncSync(fd);
      this.io.closeSync(fd);
      return undefined;
    } catch (error) {
      closeQuietly(this.io, fd);
      if (error?.code === "EEXIST") {
        throw new GuardianError("PLAN_WRITE_LOCKED", `Aiopago plan mutation is already locked: ${this.lockPath}. Stale or corrupt locks require explicit human inspection and removal.`);
      }
      if (ownsLock) unlinkQuietly(this.io, this.lockPath);
      throw error;
    }
  }

  #releaseLock() {
    try { this.io.unlinkSync(this.lockPath); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    syncDirectory(this.io, dirname(this.lockPath));
  }

  readCurrent({ requireSingleBlock = false, validate } = {}) {
    const observed = parseTaskPlanBytes(this.io.readFileSync(this.path), { requireSingleBlock });
    validate?.(observed.task);
    return observed;
  }

  #casConflict(expected, observed, phase) {
    const revisionMatches = observed.task.plan_revision_id === expected.planRevisionId;
    const digestMatches = observed.contentDigest === expected.contentDigest;
    if (!revisionMatches || !digestMatches) {
      throw new GuardianError("PLAN_CAS_CONFLICT", `TASK_PLAN.md no longer matches the proposal base during ${phase}; create a new proposal from a fresh observation`, {
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

  atomicReplace(bytes) {
    const candidate = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const temp = temporaryPath(this.path, "replace");
    let fd;
    let ownsTemp = false;
    try {
      fd = this.io.openSync(temp, "wx", 0o600);
      ownsTemp = true;
      this.io.writeFileSync(fd, candidate);
      this.io.fsyncSync(fd);
      this.io.closeSync(fd);
      fd = undefined;
      this.io.renameSync(temp, this.path);
      syncDirectory(this.io, dirname(this.path));
    } catch (error) {
      closeQuietly(this.io, fd);
      if (ownsTemp) unlinkQuietly(this.io, temp);
      throw error;
    }
  }

  writeImmutable(path, bytes) {
    const destination = resolve(path);
    const parent = dirname(destination);
    this.#ensureRealDirectory(parent);
    const temp = temporaryPath(destination, "immutable");
    let fd;
    let ownsTemp = false;
    try {
      fd = this.io.openSync(temp, "wx", 0o600);
      ownsTemp = true;
      this.io.writeFileSync(fd, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      this.io.fsyncSync(fd);
      this.io.closeSync(fd);
      fd = undefined;
      this.io.linkSync(temp, destination);
      syncDirectory(this.io, parent);
      this.io.unlinkSync(temp);
    } catch (error) {
      closeQuietly(this.io, fd);
      if (ownsTemp) unlinkQuietly(this.io, temp);
      if (error?.code === "EEXIST") throw new GuardianError("PLAN_PROVENANCE_CONFLICT", `Immutable plan provenance already exists: ${destination}`);
      throw error;
    }
  }

  commit({
    expected = null,
    requireSingleBlock = false,
    validate,
    inspectExisting,
    prepare,
    beforeFinalAttestation,
  }) {
    this.#assertRealFile(this.path);
    this.#acquireLock();
    let operationError;
    try {
      const current = this.readCurrent({ requireSingleBlock, validate });
      const existing = inspectExisting?.(current);
      if (existing !== undefined && existing !== null) return existing;
      if (expected) this.#casConflict(expected, current, "initial attestation");
      const prepared = prepare(current);
      if (prepared?.noWrite) return prepared.result;
      invariant(prepared && Buffer.isBuffer(prepared.bytes), "PLAN_MATERIALIZATION_INVALID", "Plan mutation must materialize candidate bytes");
      const candidate = parseTaskPlanBytes(prepared.bytes, { requireSingleBlock });
      validate?.(candidate.task);
      beforeFinalAttestation?.(Object.freeze({ current, candidate }));
      const finalObservation = this.readCurrent({ requireSingleBlock, validate });
      const attestation = expected ?? { planRevisionId: current.task.plan_revision_id, contentDigest: current.contentDigest };
      this.#casConflict(attestation, finalObservation, "final attestation");
      invariant(finalObservation.contentDigest === current.contentDigest, "PLAN_CAS_CONFLICT", "TASK_PLAN.md changed while the mutation was being prepared");
      this.atomicReplace(prepared.bytes);
      try { prepared.afterCommit?.(); }
      catch (error) {
        throw new GuardianError("PLAN_APPLY_COMMITTED_PROVENANCE_PENDING", "TASK_PLAN.md was replaced, but immutable applied provenance is incomplete; retry only the same proposal_id and payload to recover", { cause_code: error?.code ?? null });
      }
      return prepared.result;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try { this.#releaseLock(); }
      catch (releaseError) { if (!operationError) throw releaseError; }
    }
  }
}
