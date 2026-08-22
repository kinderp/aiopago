import { invariant } from "./errors.mjs";

// Package-private capability registries. Public TaskLedger and GuardianStorage
// objects expose their accepted APIs only; trusted handoff receives one bounded
// plan-attestation + reservation operation with no caller-supplied callback.
const handoffPlanCapabilities = new WeakMap();
const handoffStorageCapabilities = new WeakMap();

export function registerTrustedHandoffPlanCapability(ledger, capability) {
  invariant(ledger && typeof capability?.attest === "function" && typeof capability?.attestRecovery === "function", "HANDOFF_PLAN_CAPABILITY_INVALID");
  invariant(!handoffPlanCapabilities.has(ledger), "HANDOFF_PLAN_CAPABILITY_DUPLICATE");
  handoffPlanCapabilities.set(ledger, Object.freeze({ attest: capability.attest, attestRecovery: capability.attestRecovery }));
}

export function registerTrustedHandoffStorageCapability(storage, capability) {
  invariant(storage && typeof capability?.reserve === "function" && typeof capability?.prepareRecovery === "function", "HANDOFF_STORAGE_CAPABILITY_INVALID");
  invariant(!handoffStorageCapabilities.has(storage), "HANDOFF_STORAGE_CAPABILITY_DUPLICATE");
  handoffStorageCapabilities.set(storage, Object.freeze({ reserve: capability.reserve, prepareRecovery: capability.prepareRecovery }));
}

export function reserveTrustedHandoffPlan(ledger, request) {
  const planCapability = handoffPlanCapabilities.get(ledger);
  const storageCapability = handoffStorageCapabilities.get(request?.storage);
  invariant(planCapability, "HANDOFF_PLAN_CAPABILITY_REQUIRED", "Trusted handoff requires an internally constructed TaskLedger");
  invariant(storageCapability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted handoff requires an internally constructed GuardianStorage");
  const { expected, projection, precondition } = request;
  invariant(projection?.task_id === expected?.taskId
    && projection.task_plan_revision === expected.planRevisionId
    && projection.task_plan_digest === expected.contentDigest,
  "HANDOFF_PLAN_PROVENANCE_MISMATCH", "Reservation projection does not match the attested plan identity");
  return planCapability.attest(expected, () => storageCapability.reserve(projection, precondition));
}

// Recovery uses the same package-private PlanRevisionWriter coordination as
// ordinary final reservation. The capture callback is supplied only by the
// trusted HandoffService and must stay synchronous: it creates one detached
// final attestation and the storage capability prepares + reserves atomically.
export function prepareTrustedContinuityRecovery(ledger, request) {
  const planCapability = handoffPlanCapabilities.get(ledger);
  const storageCapability = handoffStorageCapabilities.get(request?.storage);
  invariant(planCapability, "HANDOFF_PLAN_CAPABILITY_REQUIRED", "Trusted recovery requires an internally constructed TaskLedger");
  invariant(storageCapability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted recovery requires an internally constructed GuardianStorage");
  invariant(typeof request?.capture === "function", "CONTINUITY_RECOVERY_ATTESTATION_REQUIRED");
  return planCapability.attestRecovery(request.expected, (plan) => {
    const captured = request.capture(plan);
    invariant(captured && !captured?.then, "CONTINUITY_RECOVERY_ATTESTATION_INVALID", "Final recovery attestation must be synchronous");
    return storageCapability.prepareRecovery(captured);
  });
}
