import { GuardianError, invariant } from "./errors.mjs";
import { operationIdentifier } from "./operation-authority.mjs";

export const LATCH_AUTHORITY_MODES = Object.freeze({
  SECURE: "SECURE",
  PORTABLE: "PORTABLE",
});

export const SECURE_LATCH_AUTHORITY_LABEL = Object.freeze({
  mode: LATCH_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_latch_isolation: true,
});

const PORTABLE_LATCH_AUTHORITY_LABEL = Object.freeze({
  mode: LATCH_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_latch_isolation: false,
});

const LATCH_STATES = new Set(["ENGAGED", "RELEASED"]);
const BOUNDED_TEXT = /^[^\r\n]{1,256}$/;

export function detachedLatch(row) { return row ? Object.freeze({ ...row }) : null; }

export function validateLatchExpected(taskId, expected) {
  if (expected === null || expected === undefined) return null;
  invariant(expected && typeof expected === "object" && !Array.isArray(expected), "LATCH_CLAIM_INVALID");
  invariant(expected.task_id === taskId && LATCH_STATES.has(expected.state)
    && Number.isSafeInteger(expected.generation) && expected.generation >= 0
    && (expected.reason === null || (typeof expected.reason === "string" && BOUNDED_TEXT.test(expected.reason))),
  "LATCH_CLAIM_INVALID");
  invariant((expected.state === "RELEASED" && expected.reason === null)
    || (expected.state === "ENGAGED" && typeof expected.reason === "string"), "LATCH_CLAIM_INVALID");
  return Object.freeze({ task_id: taskId, state: expected.state, generation: expected.generation, reason: expected.reason });
}

export function validateLatchClaim(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "LATCH_CLAIM_INVALID");
  const taskId = operationIdentifier(request.taskId, "LATCH_TASK_INVALID", "taskId");
  invariant(typeof request.reason === "string" && BOUNDED_TEXT.test(request.reason), "LATCH_REASON_INVALID");
  invariant(typeof request.actor === "string" && BOUNDED_TEXT.test(request.actor), "LATCH_ACTOR_INVALID");
  const expected = validateLatchExpected(taskId, request.expected ?? null);
  return Object.freeze({ taskId, reason: request.reason, actor: request.actor, expected });
}

export class PortableLatchAuthority {
  constructor(storage) {
    invariant(storage && typeof storage.ensureLatch === "function" && typeof storage.getLatch === "function"
      && typeof storage.assertLatchIdentity === "function" && typeof storage.isAdmissionOpen === "function",
    "PORTABLE_LATCH_AUTHORITY_INVALID");
    this.storage = storage;
    this.security = PORTABLE_LATCH_AUTHORITY_LABEL;
  }

  ensureLatch(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.storage.ensureLatch(taskId));
  }

  getLatch(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.storage.getLatch(taskId));
  }

  assertLatchIdentity(taskId, expected, options = {}) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return detachedLatch(this.storage.assertLatchIdentity(taskId, expected, options));
  }

  isAdmissionOpen(taskId) {
    operationIdentifier(taskId, "LATCH_TASK_INVALID", "taskId");
    return this.storage.isAdmissionOpen(taskId);
  }
}

export function portableLatchAuthority(storage) { return new PortableLatchAuthority(storage); }

export function requireSecureLatchAuthority(authority) {
  invariant(authority?.latchSecurity?.mode === LATCH_AUTHORITY_MODES.SECURE
    && authority.latchSecurity.canonical === true
    && authority.latchSecurity.r1_m_13_latch_isolation === true,
  "SECURE_LATCH_AUTHORITY_REQUIRED", "Secure execution cannot use or fall back to portable latch state");
  return authority;
}

export function assertLatchIdentityValue(current, expected, { allowHumanTakeover = false } = {}) {
  if (!allowHumanTakeover && current?.state === "ENGAGED" && current.reason === "HUMAN_TAKEOVER") {
    throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover has priority");
  }
  invariant(current?.state === expected?.state && current.generation === expected?.generation
    && (current.reason ?? null) === (expected?.reason ?? null), "LATCH_GENERATION_MISMATCH", "Canonical latch identity changed");
  return current;
}
