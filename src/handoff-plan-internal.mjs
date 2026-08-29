import { invariant } from "./errors.mjs";
import { requireSecureHandoffAuthority } from "./handoff-reservation-authority.mjs";
import { requireSecureLatchAuthority } from "./latch-authority.mjs";

// Package-private capability registries. Public TaskLedger and GuardianStorage
// objects expose their accepted APIs only; trusted handoff receives one bounded
// plan-attestation + reservation operation with no caller-supplied callback.
const handoffPlanCapabilities = new WeakMap();
const handoffStorageCapabilities = new WeakMap();

export function registerTrustedHandoffPlanCapability(ledger, capability) {
  invariant(ledger
    && typeof capability?.attest === "function"
    && typeof capability?.attestRecovery === "function"
    && typeof capability?.attestResume === "function"
    && typeof capability?.attestCurrentTakeover === "function"
    && typeof capability?.satisfyOwnerGate === "function", "HANDOFF_PLAN_CAPABILITY_INVALID");
  invariant(!handoffPlanCapabilities.has(ledger), "HANDOFF_PLAN_CAPABILITY_DUPLICATE");
  handoffPlanCapabilities.set(ledger, Object.freeze({
    attest: capability.attest,
    attestRecovery: capability.attestRecovery,
    attestResume: capability.attestResume,
    attestCurrentTakeover: capability.attestCurrentTakeover,
    satisfyOwnerGate: capability.satisfyOwnerGate,
  }));
}

export function registerTrustedHandoffStorageCapability(storage, capability) {
  invariant(storage
    && typeof capability?.reserve === "function"
    && typeof capability?.projectCanonicalReservation === "function"
    && typeof capability?.prepareRecovery === "function"
    && typeof capability?.authorizeResume === "function"
    && typeof capability?.resumeEvidence === "function"
    && typeof capability?.assertOwnerGateAuthority === "function"
    && typeof capability?.claimTakeover === "function"
    && typeof capability?.claimHandoffLatch === "function"
    && typeof capability?.saveHandoff === "function"
    && typeof capability?.bindRunnerSession === "function"
    && typeof capability?.projectCanonicalRunnerSessionBinding === "function"
    && typeof capability?.supersedeRunnerSessionBinding === "function"
    && typeof capability?.beginDispatch === "function"
    && typeof capability?.finishDispatch === "function", "HANDOFF_STORAGE_CAPABILITY_INVALID");
  invariant(!handoffStorageCapabilities.has(storage), "HANDOFF_STORAGE_CAPABILITY_DUPLICATE");
  handoffStorageCapabilities.set(storage, Object.freeze({
    reserve: capability.reserve,
    projectCanonicalReservation: capability.projectCanonicalReservation,
    prepareRecovery: capability.prepareRecovery,
    authorizeResume: capability.authorizeResume,
    resumeEvidence: capability.resumeEvidence,
    assertOwnerGateAuthority: capability.assertOwnerGateAuthority,
    claimTakeover: capability.claimTakeover,
    claimHandoffLatch: capability.claimHandoffLatch,
    saveHandoff: capability.saveHandoff,
    bindRunnerSession: capability.bindRunnerSession,
    projectCanonicalRunnerSessionBinding: capability.projectCanonicalRunnerSessionBinding,
    supersedeRunnerSessionBinding: capability.supersedeRunnerSessionBinding,
    beginDispatch: capability.beginDispatch,
    finishDispatch: capability.finishDispatch,
  }));
}

// The task-operation eligibility read and exact HUMAN owner-gate transition
// execute synchronously under the same PlanRevisionWriter coordination used by
// every trusted lifecycle reservation. The guard is assembled here from narrow
// internal capabilities; callers cannot inject an arbitrary callback under the
// plan lock.
export function satisfyTrustedHandoffOwnerGate(ledger, request) {
  const planCapability = handoffPlanCapabilities.get(ledger);
  const storageCapability = handoffStorageCapabilities.get(request?.storage);
  invariant(planCapability, "HANDOFF_PLAN_CAPABILITY_REQUIRED", "Trusted owner-gate mutation requires an internally constructed TaskLedger");
  invariant(storageCapability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted owner-gate mutation requires an internally constructed GuardianStorage");
  const { expected, taskId, expectedHandoff, expectedLatch, expectedLatest = null, reservationAuthority = null, command, actor } = request;
  invariant(taskId === expected?.taskId && expectedLatch?.task_id === taskId,
    "HANDOFF_OWNER_GATE_AUTHORITY_INVALID");
  return planCapability.satisfyOwnerGate({ expected, command, actor }, () => {
    const authority = reservationAuthority
      ? requireSecureHandoffAuthority(reservationAuthority).assertHandoffOwnerAuthority({ taskId, expectedLatch, expectedLatest })
      : storageCapability.assertOwnerGateAuthority({ taskId, expectedHandoff, expectedLatch });
    invariant(!authority || typeof authority.then !== "function", "HANDOFF_OWNER_GATE_AUTHORITY_INVALID", "Owner authority attestation must be synchronous");
    return authority;
  });
}

// HUMAN_TAKEOVER is current-task control authority, not consent to a plan
// revision observed before coordination. One attempt acquires the common
// PlanRevisionWriter → SQLite order, reads the current validated plan while the
// lock is held, binds it to the current Runner task, and claims the latch. The
// Runner owns bounded retry of transient lock contention before SafePoint.
export function claimTrustedHumanTakeoverCurrentPlan(ledger, request) {
  const planCapability = handoffPlanCapabilities.get(ledger);
  const storageCapability = handoffStorageCapabilities.get(request?.storage);
  invariant(planCapability, "HANDOFF_PLAN_CAPABILITY_REQUIRED", "Trusted takeover requires an internally constructed TaskLedger");
  invariant(storageCapability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted takeover requires an internally constructed GuardianStorage");
  const { taskId, actor, coordinationDeadline = null } = request;
  invariant(typeof taskId === "string" && taskId.length > 0 && typeof actor === "string", "HUMAN_TAKEOVER_AUTHORITY_INVALID");
  return planCapability.attestCurrentTakeover((plan) => {
    invariant(plan.task_id === taskId, "HUMAN_TAKEOVER_TASK_CHANGED", "The current plan belongs to a different task than the active Runner");
    const latch = storageCapability.claimTakeover({ taskId, actor });
    invariant(latch && typeof latch.then !== "function", "HUMAN_TAKEOVER_AUTHORITY_INVALID", "Takeover claim must be synchronous");
    return Object.freeze({
      taskId: plan.task_id,
      planRevisionId: plan.plan_revision_id,
      contentDigest: plan.content_digest,
      latch,
    });
  }, coordinationDeadline);
}

export function claimTrustedHandoffLatch(ledger, request) {
  const planCapability = handoffPlanCapabilities.get(ledger);
  const storageCapability = handoffStorageCapabilities.get(request?.storage);
  invariant(planCapability, "HANDOFF_PLAN_CAPABILITY_REQUIRED", "Trusted SafePoint requires an internally constructed TaskLedger");
  invariant(storageCapability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted SafePoint requires an internally constructed GuardianStorage");
  const { expected, taskId, reason, actor, expectedLatch, latchAuthority = null } = request;
  invariant(taskId === expected?.taskId && expectedLatch?.task_id === taskId
    && typeof reason === "string" && reason !== "HUMAN_TAKEOVER" && typeof actor === "string",
  "HANDOFF_LATCH_AUTHORITY_INVALID");
  return planCapability.attest(expected, () => {
    const claimed = latchAuthority
      ? requireSecureLatchAuthority(latchAuthority).claimLatch({ taskId, reason, actor, expected: expectedLatch })
      : storageCapability.claimHandoffLatch({ taskId, reason, actor, expectedLatch });
    invariant(claimed && typeof claimed.then !== "function", "HANDOFF_LATCH_AUTHORITY_INVALID", "SafePoint latch claim must be synchronous");
    return claimed;
  });
}

function trustedStorageCapability(storage) {
  const capability = handoffStorageCapabilities.get(storage);
  invariant(capability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted lifecycle mutation requires an internally constructed GuardianStorage");
  return capability;
}

export function assertNoCompetingResumeEvidence(storage, handoffId) {
  const evidence = trustedStorageCapability(storage).resumeEvidence(handoffId);
  invariant(evidence && typeof evidence.then !== "function"
    && Number.isInteger(evidence.authorizations)
    && Number.isInteger(evidence.admissions)
    && Number.isInteger(evidence.dispatch_attempts),
  "RESUME_ATTESTATION_INVALID", "Durable resume evidence attestation must be synchronous and structured");
  invariant(Object.values(evidence).every((count) => count === 0),
    "RESUME_EXPECTATION_STALE", "Competing durable resume evidence exists");
  return evidence;
}

export function saveTrustedHandoff(storage, ...args) {
  return trustedStorageCapability(storage).saveHandoff(...args);
}

export function bindTrustedRunnerSession(storage, ...args) {
  return trustedStorageCapability(storage).bindRunnerSession(...args);
}

export function projectTrustedCanonicalRunnerSessionBinding(storage, ...args) {
  return trustedStorageCapability(storage).projectCanonicalRunnerSessionBinding(...args);
}

export function supersedeTrustedRunnerSessionBinding(storage, ...args) {
  return trustedStorageCapability(storage).supersedeRunnerSessionBinding(...args);
}

export function beginTrustedResumeDispatch(storage, ...args) {
  return trustedStorageCapability(storage).beginDispatch(...args);
}

export function finishTrustedResumeDispatch(storage, ...args) {
  return trustedStorageCapability(storage).finishDispatch(...args);
}

export function reserveTrustedHandoffPlan(ledger, request) {
  const planCapability = handoffPlanCapabilities.get(ledger);
  const storageCapability = handoffStorageCapabilities.get(request?.storage);
  invariant(planCapability, "HANDOFF_PLAN_CAPABILITY_REQUIRED", "Trusted handoff requires an internally constructed TaskLedger");
  invariant(storageCapability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted handoff requires an internally constructed GuardianStorage");
  const { expected, projection, precondition, reservationAuthority = null, requestId = projection?.handoff_id } = request;
  invariant(projection?.task_id === expected?.taskId
    && projection.task_plan_revision === expected.planRevisionId
    && projection.task_plan_digest === expected.contentDigest,
  "HANDOFF_PLAN_PROVENANCE_MISMATCH", "Reservation projection does not match the attested plan identity");
  const reserved = planCapability.attest(expected, () => reservationAuthority
    ? reservationAuthority.requestHandoffReservation(requestId, {
      projection,
      expectedLatch: precondition.latch,
      expectedLatest: precondition.expectedLatest ?? null,
    })
    : storageCapability.reserve(projection, precondition));
  if (!reservationAuthority) return reserved;
  const canonical = reservationAuthority.getHandoffReservation(projection.handoff_id);
  invariant(canonical && reserved?.reservation?.reservation_digest === canonical.reservation_digest,
    "HANDOFF_CANONICAL_RESULT_INVALID", "Protected reservation result could not be re-observed exactly");
  let handoff = projection;
  if (reserved.created) {
    handoff = storageCapability.projectCanonicalReservation(projection, {
      canonical: true,
      created: true,
      reservation_digest: canonical.reservation_digest,
      active_source: reserved.active_source,
      event: reserved.event,
    });
  }
  return Object.freeze({
    created: reserved.created,
    canonical: true,
    reservation: canonical,
    active_source: reserved.active_source,
    event: reserved.event,
    handoff: handoff ?? projection,
  });
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

// Human YES is bound to one invocation-local expectation. Final plan
// attestation, synchronous runtime/Git capture and durable SQLite admission are
// one bounded package-private operation. No lock spans UI or transport.
export function authorizeTrustedResume(ledger, request) {
  const planCapability = handoffPlanCapabilities.get(ledger);
  const storageCapability = handoffStorageCapabilities.get(request?.storage);
  invariant(planCapability, "HANDOFF_PLAN_CAPABILITY_REQUIRED", "Trusted resume requires an internally constructed TaskLedger");
  invariant(storageCapability, "HANDOFF_STORAGE_CAPABILITY_REQUIRED", "Trusted resume requires an internally constructed GuardianStorage");
  invariant(typeof request?.capture === "function", "RESUME_ATTESTATION_REQUIRED");
  return planCapability.attestResume(request.expectedPlan, (plan) => {
    const captured = request.capture(plan);
    invariant(captured && !captured?.then, "RESUME_ATTESTATION_INVALID", "Final resume attestation must be synchronous");
    return storageCapability.authorizeResume(captured);
  });
}
