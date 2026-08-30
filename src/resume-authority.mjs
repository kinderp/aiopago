import { canonicalJson, sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { operationIdentifier } from "./operation-authority.mjs";

export const RESUME_AUTHORITY_MODES = Object.freeze({ SECURE: "SECURE", PORTABLE: "PORTABLE" });

export const SECURE_RESUME_AUTHORITY_LABEL = Object.freeze({
  mode: RESUME_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_resume_admission_dispatch_isolation: true,
});

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTOR = /^human:[^\r\n]{1,1024}$/;
const IDEMPOTENCY_KEY = /^[^\r\n]{1,1024}$/;
const MAX_PROMPT_BYTES = 131_072;
const OUTCOMES = new Set(["ACKNOWLEDGED", "DISPATCHED", "FAILED", "UNKNOWN"]);

function digest(value, code, field) {
  invariant(typeof value === "string" && DIGEST.test(value), code, `${field} is invalid`);
  return value;
}

function exactLatch(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "RESUME_LATCH_INVALID");
  invariant(value.state === "ENGAGED" && Number.isSafeInteger(value.generation) && value.generation >= 0
    && typeof value.reason === "string" && value.reason.length > 0 && value.reason !== "HUMAN_TAKEOVER",
  "RESUME_LATCH_INVALID");
  return Object.freeze({
    task_id: operationIdentifier(value.task_id, "RESUME_TASK_INVALID", "task_id"),
    state: "ENGAGED",
    generation: value.generation,
    reason: value.reason,
  });
}

function exactBinding(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "RESUME_BINDING_INVALID");
  invariant(value.status === "ACTIVE" && Number.isSafeInteger(value.lifecycle_incarnation) && value.lifecycle_incarnation > 0,
    "RESUME_BINDING_INVALID");
  return Object.freeze({
    handoff_id: operationIdentifier(value.handoff_id, "RESUME_HANDOFF_INVALID", "handoff_id"),
    replacement_session_id: operationIdentifier(value.replacement_session_id, "RESUME_SESSION_INVALID", "replacement_session_id"),
    runner_instance_id: operationIdentifier(value.runner_instance_id, "RESUME_RUNNER_INVALID", "runner_instance_id"),
    session_binding_id: operationIdentifier(value.session_binding_id, "RESUME_BINDING_INVALID", "session_binding_id"),
    lifecycle_incarnation: value.lifecycle_incarnation,
    status: "ACTIVE",
  });
}

export function validateResumeReadiness(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "RESUME_READINESS_INVALID");
  const prompt = request.resume_prompt;
  invariant(typeof prompt === "string" && prompt.length > 0 && Buffer.byteLength(prompt, "utf8") <= MAX_PROMPT_BYTES,
    "RESUME_PROMPT_INVALID");
  const value = Object.freeze({
    handoff_id: operationIdentifier(request.handoff_id, "RESUME_HANDOFF_INVALID", "handoff_id"),
    reservation_digest: operationIdentifier(request.reservation_digest, "RESUME_RESERVATION_INVALID", "reservation_digest"),
    binding: exactBinding(request.binding),
    latch: exactLatch(request.latch),
    checkpoint_digest: digest(request.checkpoint_digest, "RESUME_CHECKPOINT_INVALID", "checkpoint_digest"),
    resume_manifest_digest: digest(request.resume_manifest_digest, "RESUME_MANIFEST_INVALID", "resume_manifest_digest"),
    resume_prompt_id: operationIdentifier(request.resume_prompt_id, "RESUME_PROMPT_INVALID", "resume_prompt_id"),
    resume_prompt_digest: digest(request.resume_prompt_digest, "RESUME_PROMPT_INVALID", "resume_prompt_digest"),
    resume_prompt: prompt,
    plan_semantic_digest: digest(request.plan_semantic_digest, "RESUME_PLAN_INVALID", "plan_semantic_digest"),
  });
  invariant(value.binding.handoff_id === value.handoff_id && value.latch.task_id.length > 0,
    "RESUME_READINESS_INVALID");
  invariant(sha256(Buffer.from(prompt, "utf8")) === value.resume_prompt_digest,
    "RESUME_PROMPT_INVALID", "resume prompt bytes do not match their digest");
  return Object.freeze({ value, payload_digest: sha256(Buffer.from(canonicalJson(value), "utf8")) });
}

export function validateResumeDecision(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "RESUME_DECISION_INVALID");
  invariant(request.answer === "YES" || request.answer === "NO", "RESUME_DECISION_INVALID");
  invariant(typeof request.actor === "string" && ACTOR.test(request.actor), "HUMAN_AUTHORIZATION_REQUIRED");
  const value = {
    answer: request.answer,
    actor: request.actor,
    handoff_id: operationIdentifier(request.handoff_id, "RESUME_HANDOFF_INVALID", "handoff_id"),
    readiness_digest: digest(request.readiness_digest, "RESUME_READINESS_INVALID", "readiness_digest"),
    resume_prompt_id: operationIdentifier(request.resume_prompt_id, "RESUME_PROMPT_INVALID", "resume_prompt_id"),
  };
  if (request.answer === "YES") {
    value.authorization_id = operationIdentifier(request.authorization_id, "RESUME_AUTHORIZATION_INVALID", "authorization_id");
    value.admission_id = operationIdentifier(request.admission_id, "RESUME_ADMISSION_INVALID", "admission_id");
    invariant(typeof request.idempotency_key === "string" && IDEMPOTENCY_KEY.test(request.idempotency_key), "RESUME_IDEMPOTENCY_KEY_INVALID");
    value.idempotency_key = request.idempotency_key;
    value.dispatch_attempt_id = operationIdentifier(request.dispatch_attempt_id, "RESUME_DISPATCH_INVALID", "dispatch_attempt_id");
    invariant(request.attempt_no === 1, "RESUME_DISPATCH_INVALID", "Resume dispatch supports exactly one non-replayable attempt");
    value.attempt_no = 1;
    value.binding = exactBinding(request.binding);
    value.latch = exactLatch(request.latch);
  }
  const frozen = Object.freeze(value);
  return Object.freeze({ value: frozen, payload_digest: sha256(Buffer.from(canonicalJson(frozen), "utf8")) });
}

export function validateResumeDispatchOutcome(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "RESUME_DISPATCH_OUTCOME_INVALID");
  const outcome = request.outcome;
  invariant(OUTCOMES.has(outcome), "RESUME_DISPATCH_OUTCOME_INVALID");
  invariant(request.error === null || request.error === undefined
    || (typeof request.error === "string" && !/[\r\n]/.test(request.error) && request.error.length <= 2048),
  "RESUME_DISPATCH_OUTCOME_INVALID");
  const value = Object.freeze({
    dispatch_attempt_id: operationIdentifier(request.dispatch_attempt_id, "RESUME_DISPATCH_INVALID", "dispatch_attempt_id"),
    outcome,
    error: request.error ?? null,
  });
  return Object.freeze({ value, payload_digest: sha256(Buffer.from(canonicalJson(value), "utf8")) });
}

export function detachedResumeReadiness(row) { return row ? Object.freeze({ ...structuredClone(row) }) : null; }
export function detachedResumeState(value) {
  if (!value) return null;
  return Object.freeze({
    readiness: detachedResumeReadiness(value.readiness),
    authorization: value.authorization ? Object.freeze({ ...value.authorization }) : null,
    admission: value.admission ? Object.freeze({ ...value.admission }) : null,
    dispatch: value.dispatch ? Object.freeze({ ...value.dispatch }) : null,
  });
}

export function requireSecureResumeAuthority(authority) {
  invariant(authority?.resumeSecurity?.mode === RESUME_AUTHORITY_MODES.SECURE
    && authority.resumeSecurity.canonical === true
    && authority.resumeSecurity.r1_m_13_resume_admission_dispatch_isolation === true,
  "SECURE_RESUME_AUTHORITY_REQUIRED", "Secure resume cannot use or fall back to portable authorization/admission/dispatch state");
  return authority;
}
