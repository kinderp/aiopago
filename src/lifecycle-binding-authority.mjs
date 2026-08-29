import { canonicalJson, sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { operationIdentifier } from "./operation-authority.mjs";

export const LIFECYCLE_AUTHORITY_MODES = Object.freeze({ SECURE: "SECURE", PORTABLE: "PORTABLE" });

export const SECURE_LIFECYCLE_AUTHORITY_LABEL = Object.freeze({
  mode: LIFECYCLE_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_lifecycle_binding_isolation: true,
});

export const PORTABLE_LIFECYCLE_AUTHORITY_LABEL = Object.freeze({
  mode: LIFECYCLE_AUTHORITY_MODES.PORTABLE,
  canonical: false,
  isolation: "ORDINARY_USER_OWNED",
  r1_m_13_lifecycle_binding_isolation: false,
});

export const LIFECYCLE_BINDING_STATES = Object.freeze(["ACTIVE", "SUPERSEDED"]);
export const LIFECYCLE_BINDING_IDENTITY_FIELDS = Object.freeze([
  "handoff_id",
  "replacement_session_id",
  "runner_instance_id",
  "session_binding_id",
  "lifecycle_incarnation",
]);

const BOUNDED_REASON = /^[^\r\n]{1,2048}$/;

function lifecycleIncarnation(value) {
  invariant(Number.isSafeInteger(value) && value > 0, "LIFECYCLE_INCARNATION_INVALID");
  return value;
}

export function lifecycleBindingIdentity(binding) {
  return Object.freeze(Object.fromEntries(LIFECYCLE_BINDING_IDENTITY_FIELDS.map((field) => [field, binding?.[field] ?? null])));
}

export function sameLifecycleBindingIdentity(left, right) {
  return LIFECYCLE_BINDING_IDENTITY_FIELDS.every((field) => (left?.[field] ?? null) === (right?.[field] ?? null));
}

export function validateLifecycleBindingCreate(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "LIFECYCLE_BINDING_INVALID");
  const binding = request.binding;
  invariant(binding && typeof binding === "object" && !Array.isArray(binding), "LIFECYCLE_BINDING_INVALID");
  const value = Object.freeze({
    handoff_id: operationIdentifier(binding.handoff_id, "LIFECYCLE_HANDOFF_INVALID", "handoff_id"),
    replacement_session_id: operationIdentifier(binding.replacement_session_id, "LIFECYCLE_SESSION_INVALID", "replacement_session_id"),
    runner_instance_id: operationIdentifier(binding.runner_instance_id, "LIFECYCLE_RUNNER_INVALID", "runner_instance_id"),
    session_binding_id: operationIdentifier(binding.session_binding_id, "LIFECYCLE_BINDING_ID_INVALID", "session_binding_id"),
    lifecycle_incarnation: lifecycleIncarnation(binding.lifecycle_incarnation),
  });
  return Object.freeze({ binding: value, payload_digest: sha256(Buffer.from(canonicalJson(value), "utf8")) });
}

export function validateLifecycleBindingTransition(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "LIFECYCLE_TRANSITION_INVALID");
  const expected = validateLifecycleBindingCreate({ binding: request.expected }).binding;
  invariant(request.expected.status === "ACTIVE" && request.nextStatus === "SUPERSEDED", "LIFECYCLE_TRANSITION_INVALID", "Only ACTIVE to SUPERSEDED is supported");
  invariant(typeof request.reason === "string" && BOUNDED_REASON.test(request.reason), "LIFECYCLE_REASON_INVALID");
  const value = Object.freeze({ expected: Object.freeze({ ...expected, status: "ACTIVE" }), nextStatus: "SUPERSEDED", reason: request.reason });
  return Object.freeze({ ...value, payload_digest: sha256(Buffer.from(canonicalJson(value), "utf8")) });
}

export function detachedLifecycleBinding(row, event = null) {
  if (!row) return null;
  return Object.freeze({
    schema_version: "1.0.0",
    ...structuredClone(row),
    event_data: event?.data_json ? JSON.parse(event.data_json) : event?.event_data ? structuredClone(event.event_data) : undefined,
  });
}

export function requireSecureLifecycleAuthority(authority) {
  invariant(authority?.lifecycleSecurity?.mode === LIFECYCLE_AUTHORITY_MODES.SECURE
    && authority.lifecycleSecurity.canonical === true
    && authority.lifecycleSecurity.r1_m_13_lifecycle_binding_isolation === true,
  "SECURE_LIFECYCLE_AUTHORITY_REQUIRED", "Secure lifecycle cannot use or fall back to portable Runner/session bindings");
  return authority;
}
