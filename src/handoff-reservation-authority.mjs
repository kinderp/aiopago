import { canonicalJson, sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { operationIdentifier } from "./operation-authority.mjs";

export const HANDOFF_AUTHORITY_MODES = Object.freeze({ SECURE: "SECURE", PORTABLE: "PORTABLE" });

export const SECURE_HANDOFF_AUTHORITY_LABEL = Object.freeze({
  mode: HANDOFF_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_handoff_reservation_isolation: true,
});

export const PORTABLE_HANDOFF_AUTHORITY_LABEL = Object.freeze({
  mode: HANDOFF_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_handoff_reservation_isolation: false,
});

export const HANDOFF_RESERVATION_IDENTITY_FIELDS = Object.freeze([
  "handoff_id",
  "source_session_id",
  "source_session_file",
  "task_id",
  "task_plan_revision",
  "task_plan_digest",
  "requirements_version",
  "current_item",
  "next_item",
  "next_step",
  "latch_generation",
  "runner_instance_id",
  "session_binding_id",
  "parent_session_id",
  "parent_session_file",
  "parent_checkpoint_id",
  "recovery_of_handoff_id",
  "checkpoint_id",
  "resume_manifest_id",
  "model_policy",
  "reasoning_policy",
]);

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BOUNDED_PATH = /^[^\r\n]{1,4096}$/;
const BOUNDED_TEXT = /^[^\r\n]{1,8192}$/;
const MAX_PROJECTION_BYTES = 196_608;

function optionalIdentifier(value, code, field) {
  if (value === null || value === undefined) return null;
  return operationIdentifier(value, code, field);
}

function boundedNullable(value, code, field, expression = BOUNDED_TEXT) {
  invariant(value === null || value === undefined || (typeof value === "string" && expression.test(value)), code, `${field} is invalid`);
  return value ?? null;
}

export function reservationIdentity(projection) {
  return Object.freeze(Object.fromEntries(HANDOFF_RESERVATION_IDENTITY_FIELDS.map((field) => [field, projection?.[field] ?? null])));
}

export function sameHandoffReservationIdentity(left, right) {
  return HANDOFF_RESERVATION_IDENTITY_FIELDS.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}

export function validateHandoffProjection(projection) {
  invariant(projection && typeof projection === "object" && !Array.isArray(projection), "HANDOFF_RESERVATION_INVALID");
  operationIdentifier(projection.handoff_id, "HANDOFF_ID_INVALID", "handoff_id");
  operationIdentifier(projection.source_session_id, "HANDOFF_SOURCE_INVALID", "source_session_id");
  invariant(typeof projection.source_session_file === "string" && BOUNDED_PATH.test(projection.source_session_file), "HANDOFF_SOURCE_INVALID", "source_session_file is invalid");
  operationIdentifier(projection.task_id, "HANDOFF_TASK_INVALID", "task_id");
  operationIdentifier(projection.task_plan_revision, "HANDOFF_PLAN_INVALID", "task_plan_revision");
  invariant(DIGEST.test(projection.task_plan_digest ?? ""), "HANDOFF_PLAN_INVALID", "task_plan_digest is invalid");
  operationIdentifier(projection.requirements_version, "HANDOFF_PLAN_INVALID", "requirements_version");
  operationIdentifier(projection.runner_instance_id, "HANDOFF_RUNNER_INVALID", "runner_instance_id");
  operationIdentifier(projection.session_binding_id, "HANDOFF_BINDING_INVALID", "session_binding_id");
  operationIdentifier(projection.parent_session_id, "HANDOFF_PARENT_INVALID", "parent_session_id");
  invariant(typeof projection.parent_session_file === "string" && BOUNDED_PATH.test(projection.parent_session_file), "HANDOFF_PARENT_INVALID", "parent_session_file is invalid");
  operationIdentifier(projection.checkpoint_id, "HANDOFF_CHECKPOINT_INVALID", "checkpoint_id");
  operationIdentifier(projection.resume_manifest_id, "HANDOFF_MANIFEST_INVALID", "resume_manifest_id");
  optionalIdentifier(projection.current_item, "HANDOFF_PLAN_INVALID", "current_item");
  optionalIdentifier(projection.next_item, "HANDOFF_PLAN_INVALID", "next_item");
  boundedNullable(projection.next_step, "HANDOFF_PLAN_INVALID", "next_step");
  optionalIdentifier(projection.parent_checkpoint_id, "HANDOFF_PARENT_INVALID", "parent_checkpoint_id");
  optionalIdentifier(projection.recovery_of_handoff_id, "HANDOFF_RECOVERY_INVALID", "recovery_of_handoff_id");
  boundedNullable(projection.model_policy, "HANDOFF_POLICY_INVALID", "model_policy");
  boundedNullable(projection.reasoning_policy, "HANDOFF_POLICY_INVALID", "reasoning_policy");
  invariant(Number.isSafeInteger(projection.latch_generation) && projection.latch_generation >= 0, "HANDOFF_LATCH_INVALID");
  invariant(projection.state === "SAFE_TO_HANDOFF" && projection.target_session_id === null
    && projection.authorization_state === "NOT_AUTHORIZED"
    && projection.admission_state === "NOT_COMMITTED"
    && projection.dispatch_state === "NOT_STARTED",
  "HANDOFF_RESERVATION_STATE_INVALID", "A canonical reservation begins paused with empty resume authority");
  invariant(projection.reserved_plan_snapshot?.task_id === projection.task_id
    && projection.reserved_plan_snapshot?.plan_revision_id === projection.task_plan_revision
    && projection.reserved_plan_snapshot?.content_digest === projection.task_plan_digest,
  "HANDOFF_PLAN_PROVENANCE_MISMATCH", "Reserved plan snapshot does not match handoff plan identity");
  const bytes = Buffer.from(canonicalJson(projection), "utf8");
  invariant(bytes.length <= MAX_PROJECTION_BYTES, "HANDOFF_RESERVATION_TOO_LARGE");
  return Object.freeze({ projection: structuredClone(projection), projectionDigest: sha256(bytes) });
}

export function validateHandoffReservationRequest(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "HANDOFF_RESERVATION_INVALID");
  const validated = validateHandoffProjection(request.projection);
  const taskId = validated.projection.task_id;
  const expectedLatch = request.expectedLatch;
  invariant(expectedLatch?.task_id === taskId && expectedLatch.state === "ENGAGED"
    && Number.isSafeInteger(expectedLatch.generation) && expectedLatch.generation >= 0
    && typeof expectedLatch.reason === "string" && expectedLatch.reason.length > 0 && expectedLatch.reason !== "HUMAN_TAKEOVER"
    && validated.projection.latch_generation === expectedLatch.generation,
  "HANDOFF_LATCH_INVALID", "Reservation requires the exact acquired non-takeover latch");
  let expectedLatest = null;
  if (request.expectedLatest !== null && request.expectedLatest !== undefined) {
    invariant(request.expectedLatest && typeof request.expectedLatest === "object" && !Array.isArray(request.expectedLatest), "HANDOFF_LATEST_INVALID");
    expectedLatest = Object.freeze({
      handoff_id: operationIdentifier(request.expectedLatest.handoff_id, "HANDOFF_LATEST_INVALID", "handoff_id"),
      reservation_digest: operationIdentifier(request.expectedLatest.reservation_digest, "HANDOFF_LATEST_INVALID", "reservation_digest"),
    });
  }
  invariant(validated.projection.recovery_of_handoff_id === null,
    "SECURE_RECOVERY_AUTHORITY_UNAVAILABLE", "Continuity recovery remains unavailable until its authority domain is migrated");
  return Object.freeze({
    projection: validated.projection,
    projectionDigest: validated.projectionDigest,
    expectedLatch: Object.freeze({ task_id: taskId, state: "ENGAGED", generation: expectedLatch.generation, reason: expectedLatch.reason }),
    expectedLatest,
  });
}

export function detachedReservation(row) {
  if (!row) return null;
  const projection = typeof row.projection_json === "string" ? JSON.parse(row.projection_json) : row.projection ?? row;
  return Object.freeze({
    ...structuredClone(projection),
    reservation_digest: row.reservation_digest ?? projection.reservation_digest ?? null,
    latch_reason: row.latch_reason ?? projection.latch_reason ?? null,
    reservation_event_id: row.reservation_event_id ?? projection.reservation_event_id ?? null,
  });
}

export function requireSecureHandoffAuthority(authority) {
  invariant(authority?.handoffSecurity?.mode === HANDOFF_AUTHORITY_MODES.SECURE
    && authority.handoffSecurity.canonical === true
    && authority.handoffSecurity.r1_m_13_handoff_reservation_isolation === true,
  "SECURE_HANDOFF_AUTHORITY_REQUIRED", "Secure handoff cannot use or fall back to portable reservation state");
  return authority;
}
