import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./canonical.mjs";
import { GuardianError } from "./errors.mjs";

const SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);

function boundedRuntimeError(error) {
  return Object.freeze({
    code: error?.code ?? "RUNTIME_READ_FAILED",
    message: String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 320),
  });
}

function runtimeFailure(code, message) {
  throw new GuardianError(code, message);
}

function defaultProbe(path) {
  return Object.freeze({
    database: existsSync(path),
    sidecars: SIDECAR_SUFFIXES.filter((suffix) => existsSync(`${path}${suffix}`)),
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
    error: Object.freeze({ code: "RUNTIME_NOT_VERIFIED", message }),
  });
}

/**
 * Acquire only filesystem-level runtime availability and quiescence evidence.
 *
 * This module deliberately does not interpret SQLite authority rows. Core 0.1
 * has no canonical read-only observation port that can attest the complete
 * operation/latch/handoff/admission/dispatch/ownership protocol without its
 * live transition context. Until such a port exists, runtime authority cannot
 * produce READY or SUSPENDED in the Human Workflow Layer.
 */
export function readRuntimeProjection(path, _plan = null, options = {}) {
  const absolute = resolve(path);
  const probe = options.probeRuntimeFiles ?? defaultProbe;
  const readBytes = options.readFile ?? readFileSync;

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
      error: boundedRuntimeError(primaryError),
    });
  }
  return notVerified(true, "RUNTIME_AUTHORITY_PRESENT", "Persistent runtime authority exists but core 0.1 exposes no canonical read-only verifier");
}
