import { canonicalJson, sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { operationIdentifier } from "./operation-authority.mjs";
import { validateHandoffProjection } from "./handoff-reservation-authority.mjs";

export const RECOVERY_AUTHORITY_MODES = Object.freeze({ SECURE: "SECURE", PORTABLE: "PORTABLE" });

export const SECURE_RECOVERY_AUTHORITY_LABEL = Object.freeze({
  mode: RECOVERY_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_recovery_reconciliation_isolation: true,
});

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTOR = /^human:[^\r\n]{1,1024}$/;
const BOUNDED_TEXT = /^[^\r\n]{1,2048}$/;

function digest(value, code, field) {
  invariant(typeof value === "string" && DIGEST.test(value), code, `${field} is invalid`);
  return value;
}

function exactLatch(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "RECOVERY_LATCH_INVALID");
  invariant(value.state === "ENGAGED" && Number.isSafeInteger(value.generation) && value.generation >= 0
    && typeof value.reason === "string" && value.reason.length > 0 && value.reason !== "HUMAN_TAKEOVER",
  "RECOVERY_LATCH_INVALID");
  return Object.freeze({
    task_id: operationIdentifier(value.task_id, "RECOVERY_TASK_INVALID", "task_id"),
    state: "ENGAGED", generation: value.generation, reason: value.reason,
  });
}

function exactBinding(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "RECOVERY_BINDING_INVALID");
  invariant(value.status === "ACTIVE" && Number.isSafeInteger(value.lifecycle_incarnation) && value.lifecycle_incarnation > 0,
    "RECOVERY_BINDING_INVALID");
  return Object.freeze({
    handoff_id: operationIdentifier(value.handoff_id, "RECOVERY_HANDOFF_INVALID", "handoff_id"),
    replacement_session_id: operationIdentifier(value.replacement_session_id, "RECOVERY_SESSION_INVALID", "replacement_session_id"),
    runner_instance_id: operationIdentifier(value.runner_instance_id, "RECOVERY_RUNNER_INVALID", "runner_instance_id"),
    session_binding_id: operationIdentifier(value.session_binding_id, "RECOVERY_BINDING_INVALID", "session_binding_id"),
    lifecycle_incarnation: value.lifecycle_incarnation,
    status: "ACTIVE",
  });
}

function exactArtifact(value, kind) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "RECOVERY_ARTIFACT_INVALID");
  return Object.freeze({
    id: operationIdentifier(value.id, "RECOVERY_ARTIFACT_INVALID", `${kind}.id`),
    digest: digest(value.digest, "RECOVERY_ARTIFACT_INVALID", `${kind}.digest`),
    content_digest: digest(value.content_digest, "RECOVERY_ARTIFACT_INVALID", `${kind}.content_digest`),
  });
}

export function validateContinuityFailure(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "CONTINUITY_FAILURE_INVALID");
  const failed = request.failed_handoff;
  invariant(failed && typeof failed === "object" && !Array.isArray(failed) && failed.state === "CONTINUITY_FAILED",
    "CONTINUITY_FAILURE_INVALID");
  invariant(failed.failure && typeof failed.failure === "object"
    && typeof failed.failure.code === "string" && BOUNDED_TEXT.test(failed.failure.code)
    && typeof failed.failure.message === "string" && BOUNDED_TEXT.test(failed.failure.message),
  "CONTINUITY_FAILURE_INVALID");
  const value = Object.freeze({
    failed_handoff: structuredClone(failed),
    reservation_digest: digest(request.reservation_digest, "CONTINUITY_FAILURE_INVALID", "reservation_digest"),
    binding: exactBinding(request.binding),
    latch: exactLatch(request.latch),
    plan_semantic_digest: digest(request.plan_semantic_digest, "CONTINUITY_FAILURE_INVALID", "plan_semantic_digest"),
    checkpoint: exactArtifact(request.checkpoint, "checkpoint"),
    manifest: exactArtifact(request.manifest, "manifest"),
  });
  invariant(value.binding.handoff_id === failed.handoff_id && value.latch.task_id === failed.task_id,
    "CONTINUITY_FAILURE_INVALID");
  return Object.freeze({ value, payload_digest: sha256(Buffer.from(canonicalJson(value), "utf8")) });
}

export function validateContinuityRecovery(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "CONTINUITY_RECOVERY_INVALID");
  invariant(typeof request.actor === "string" && ACTOR.test(request.actor), "CONTINUITY_RECOVERY_AUTHORITY_INVALID");
  const child = validateHandoffProjection(request.child_projection).projection;
  invariant(child.recovery_of_handoff_id !== null, "CONTINUITY_RECOVERY_INVALID", "Recovery child must identify one failed handoff");
  const source = request.source;
  invariant(source && typeof source === "object" && !Array.isArray(source)
    && Number.isSafeInteger(source.lifecycle_incarnation) && source.lifecycle_incarnation > 0
    && source.active === true && source.history_length === 0 && source.idle === true,
  "CONTINUITY_RECOVERY_SOURCE_INVALID");
  const value = Object.freeze({
    decision_id: operationIdentifier(request.decision_id, "RECOVERY_DECISION_ID_INVALID", "decision_id"),
    failed_handoff_id: operationIdentifier(request.failed_handoff_id, "RECOVERY_HANDOFF_INVALID", "failed_handoff_id"),
    failure_digest: digest(request.failure_digest, "CONTINUITY_RECOVERY_INVALID", "failure_digest"),
    actor: request.actor,
    source: Object.freeze({
      session_id: operationIdentifier(source.session_id, "RECOVERY_SESSION_INVALID", "source.session_id"),
      runner_instance_id: operationIdentifier(source.runner_instance_id, "RECOVERY_RUNNER_INVALID", "source.runner_instance_id"),
      lifecycle_incarnation: source.lifecycle_incarnation,
      active: true, history_length: 0, idle: true,
    }),
    binding: exactBinding(request.binding),
    latch: exactLatch(request.latch),
    plan_semantic_digest: digest(request.plan_semantic_digest, "CONTINUITY_RECOVERY_INVALID", "plan_semantic_digest"),
    model_policy: request.model_policy ?? null,
    reasoning_policy: request.reasoning_policy ?? null,
    git: structuredClone(request.git),
    checkpoint: exactArtifact(request.checkpoint, "checkpoint"),
    manifest: exactArtifact(request.manifest, "manifest"),
    child_projection: child,
    expected_latest: Object.freeze({
      handoff_id: operationIdentifier(request.expected_latest?.handoff_id, "RECOVERY_LATEST_INVALID", "expected_latest.handoff_id"),
      reservation_digest: digest(request.expected_latest?.reservation_digest, "RECOVERY_LATEST_INVALID", "expected_latest.reservation_digest"),
    }),
  });
  invariant(value.failed_handoff_id === value.binding.handoff_id
    && value.failed_handoff_id === value.child_projection.recovery_of_handoff_id
    && value.source.session_id === value.child_projection.source_session_id
    && value.source.runner_instance_id === value.child_projection.runner_instance_id
    && value.latch.task_id === value.child_projection.task_id
    && value.latch.generation === value.child_projection.latch_generation
    && value.expected_latest.handoff_id === value.failed_handoff_id,
  "CONTINUITY_RECOVERY_INVALID");
  invariant(value.model_policy === null || (typeof value.model_policy === "string" && BOUNDED_TEXT.test(value.model_policy)), "CONTINUITY_RECOVERY_INVALID");
  invariant(value.reasoning_policy === null || (typeof value.reasoning_policy === "string" && BOUNDED_TEXT.test(value.reasoning_policy)), "CONTINUITY_RECOVERY_INVALID");
  const payloadDigest = sha256(Buffer.from(canonicalJson(value), "utf8"));
  const childReservationPayload = Object.freeze({
    projection: child,
    expectedLatch: value.latch,
    expectedLatest: value.expected_latest,
  });
  return Object.freeze({
    value,
    payload_digest: payloadDigest,
    child_reservation_digest: sha256(Buffer.from(canonicalJson(childReservationPayload), "utf8")),
    attestation_digest: sha256(Buffer.from(canonicalJson({
      failure_digest: value.failure_digest, source: value.source, binding: value.binding, latch: value.latch,
      plan_semantic_digest: value.plan_semantic_digest, model_policy: value.model_policy,
      reasoning_policy: value.reasoning_policy, git: value.git, checkpoint: value.checkpoint, manifest: value.manifest,
    }), "utf8")),
  });
}

export function detachedContinuityFailure(row) {
  if (!row) return null;
  return Object.freeze({ ...row, failed_handoff: Object.freeze(JSON.parse(row.failed_projection_json)) });
}

export function detachedContinuityRecovery(value) {
  if (!value) return null;
  return Object.freeze({
    failure: detachedContinuityFailure(value.failure),
    decision: value.decision ? Object.freeze({ ...value.decision }) : null,
    event: value.event ? Object.freeze({ ...value.event, data: value.event.data_json ? JSON.parse(value.event.data_json) : undefined }) : null,
    child: value.child ?? null,
    binding: value.binding ?? null,
  });
}

export function requireSecureRecoveryAuthority(authority) {
  invariant(authority?.recoverySecurity?.mode === RECOVERY_AUTHORITY_MODES.SECURE
    && authority.recoverySecurity.canonical === true
    && authority.recoverySecurity.r1_m_13_recovery_reconciliation_isolation === true,
  "SECURE_RECOVERY_AUTHORITY_REQUIRED", "Secure recovery/reconciliation cannot use or fall back to project recovery state");
  return authority;
}
