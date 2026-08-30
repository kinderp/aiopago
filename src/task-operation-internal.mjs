// Package-private task-operation lifecycle classification. This module is not
// exported through the package root: it centralizes durable arbitration and
// read-only guidance without creating a second authority.

const ACTIVE_STATES = new Set([
  "SAFE_TO_HANDOFF",
  "CHECKPOINT_PERSISTING",
  "CHECKPOINT_PERSISTED",
  "REPLACEMENT_SESSION_CREATING",
  "REPLACEMENT_SESSION_CREATED_PAUSED",
  "MANIFEST_PERSISTING",
  "MANIFEST_PERSISTED",
  "RESUME_READY",
  "RESUME_ADMISSION_COMMITTED",
  "RESUME_DISPATCHING",
  "RESUME_DISPATCHED",
]);

const AMBIGUOUS_STATES = new Set([
  "CHECKPOINT_PERSIST_FAILED",
  "RUNNER_OWNERSHIP_ATTESTATION_FAILED",
  "MANIFEST_PERSIST_FAILED",
  "HANDOFF_FAILED",
  "HUMAN_DECISION_REQUIRED",
  "RESUME_DISPATCH_FAILED",
  "RESUME_DISPATCH_UNKNOWN",
]);

export function taskOperationDisposition(handoff, { binding = null, recoveryStarted = false, recoveryChildExists = false } = {}) {
  if (!handoff) return "SAFE_TERMINAL";
  if (handoff.state === "RESUMED") return "SAFE_TERMINAL";
  if (handoff.state === "CONTINUITY_FAILED") {
    if (binding?.status === "SUPERSEDED" && recoveryStarted && recoveryChildExists) return "RECOVERY_TRANSFERRED";
    return "RECOVERY_REQUIRED";
  }
  if (ACTIVE_STATES.has(handoff.state)) return "BLOCKING_ACTIVE";
  if (AMBIGUOUS_STATES.has(handoff.state)) return "AMBIGUOUS_RECONCILIATION_REQUIRED";
  return "AMBIGUOUS_RECONCILIATION_REQUIRED";
}

export function taskOperationBlocksNewHandoff(disposition) {
  return disposition !== "SAFE_TERMINAL" && disposition !== "RECOVERY_TRANSFERRED";
}

export const TASK_OPERATION_ACTIVE_STATES = Object.freeze([...ACTIVE_STATES]);
export const TASK_OPERATION_AMBIGUOUS_STATES = Object.freeze([...AMBIGUOUS_STATES]);
