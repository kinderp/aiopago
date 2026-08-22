import { GuardianError, invariant } from "./errors.mjs";

const IDENTITY_KEYS = Object.freeze([
  "taskId", "planRevisionId", "contentDigest", "sessionId", "runnerInstanceId", "latch", "handoff",
]);
const LATCH_KEYS = Object.freeze(["state", "generation", "reason"]);
const HANDOFF_KEYS = Object.freeze([
  "handoffId", "state", "sourceSessionId", "targetSessionId", "runnerInstanceId",
  "taskPlanRevision", "taskPlanDigest", "latchGeneration", "authorizationState",
  "admissionState", "dispatchState", "failure",
]);
const FAILURE_KEYS = Object.freeze(["code", "message"]);

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function identity(value, maximum = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function nullableIdentity(value, maximum = 4096) {
  return value === null || identity(value, maximum);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function handoffConsentIdentity(handoff) {
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
    failure: handoff.failure ? { code: handoff.failure.code, message: handoff.failure.message } : null,
  };
}

export function guidedHandoffEligibilityIdentityFromAuthority({ plan, sessionId, runnerInstanceId, latch, handoff }) {
  return freeze({
    taskId: plan.task_id,
    planRevisionId: plan.plan_revision_id,
    contentDigest: plan.content_digest,
    sessionId,
    runnerInstanceId,
    latch: { state: latch.state, generation: latch.generation, reason: latch.reason ?? null },
    handoff: handoffConsentIdentity(handoff),
  });
}

export function assertGuidedHandoffEligibilityIdentity(value) {
  const invalid = () => { throw new GuardianError("HANDOFF_CONSENT_INVALID", "Guided handoff consent identity is malformed or incomplete"); };
  if (!exactKeys(value, IDENTITY_KEYS)
    || !identity(value.taskId) || !identity(value.planRevisionId)
    || !/^sha256:[a-f0-9]{64}$/.test(value.contentDigest ?? "")
    || !identity(value.sessionId) || !identity(value.runnerInstanceId)
    || !exactKeys(value.latch, LATCH_KEYS)
    || value.latch.state !== "RELEASED" || !Number.isInteger(value.latch.generation) || value.latch.generation < 0
    || value.latch.reason !== null) invalid();
  if (value.handoff !== null) {
    const h = value.handoff;
    if (!exactKeys(h, HANDOFF_KEYS) || !identity(h.handoffId) || !identity(h.state)
      || !identity(h.sourceSessionId) || !nullableIdentity(h.targetSessionId)
      || !identity(h.runnerInstanceId) || !identity(h.taskPlanRevision)
      || !/^sha256:[a-f0-9]{64}$/.test(h.taskPlanDigest ?? "")
      || !Number.isInteger(h.latchGeneration) || h.latchGeneration < 0
      || !nullableIdentity(h.authorizationState, 128) || !nullableIdentity(h.admissionState, 128)
      || !nullableIdentity(h.dispatchState, 128)) invalid();
    if (h.failure !== null && (!exactKeys(h.failure, FAILURE_KEYS) || !identity(h.failure.code, 128) || !identity(h.failure.message))) invalid();
  }
  return value;
}

export function sameGuidedHandoffEligibility(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function assertPlanConsentIdentity(plan, expected) {
  invariant(plan?.task_id === expected.taskId
    && plan?.plan_revision_id === expected.planRevisionId
    && plan?.content_digest === expected.contentDigest,
  "HANDOFF_CONSENT_STALE", "The authoritative plan no longer matches the approved guided handoff consent");
  return plan;
}

export function assertHandoffConsentIdentity(actual, expected) {
  invariant(JSON.stringify(handoffConsentIdentity(actual)) === JSON.stringify(expected),
    "HANDOFF_CONSENT_STALE", "The handoff lifecycle no longer matches the approved consent identity");
  return actual;
}
