import { canonicalJson, sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { operationIdentifier } from "./operation-authority.mjs";
import { canonicalPlanSemantics, planSemanticDigest } from "./plan-semantics-internal.mjs";

export const RECOVERY_INPUT_AUTHORITY_MODES = Object.freeze({ SECURE: "SECURE", PORTABLE: "PORTABLE" });

export const SECURE_RECOVERY_INPUT_AUTHORITY_LABEL = Object.freeze({
  mode: RECOVERY_INPUT_AUTHORITY_MODES.SECURE,
  canonical: true,
  isolation: "OS_PROTECTED_DISTINCT_IDENTITY",
  r1_m_13_recovery_input_isolation: true,
});

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const KINDS = new Set(["checkpoint", "manifest"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(value, code, field) {
  invariant(typeof value === "string" && DIGEST.test(value), code, `${field} is invalid`);
  return value;
}

export function protectedPlanSnapshot(projection) {
  invariant(projection && typeof projection === "object" && !Array.isArray(projection), "PLAN_AUTHORITY_INVALID");
  const snapshot = canonicalPlanSemantics(projection.reserved_plan_snapshot, {
    requireAll: true,
    code: "PLAN_AUTHORITY_INVALID",
  });
  invariant(snapshot.task_id === projection.task_id
    && snapshot.plan_revision_id === projection.task_plan_revision
    && snapshot.content_digest === projection.task_plan_digest
    && snapshot.current_item === (projection.current_item ?? null)
    && snapshot.next_item === (projection.next_item ?? null)
    && snapshot.next_step === projection.next_step
    && snapshot.requirements_version === projection.requirements_version
    && snapshot.model_policy === (projection.model_policy ?? null)
    && snapshot.reasoning_policy === (projection.reasoning_policy ?? null),
  "PLAN_AUTHORITY_INVALID", "Protected plan snapshot conflicts with reservation provenance");
  const semanticDigest = planSemanticDigest(snapshot, { requireAll: true });
  return Object.freeze({ snapshot, semantic_digest: semanticDigest, snapshot_id: semanticDigest });
}

export function validateArtifactRegistration(request) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "ARTIFACT_AUTHORITY_INVALID");
  invariant(KINDS.has(request.kind), "ARTIFACT_AUTHORITY_KIND_INVALID");
  const value = {
    kind: request.kind,
    artifact_id: operationIdentifier(request.artifact_id, "ARTIFACT_AUTHORITY_ID_INVALID", "artifact_id"),
    handoff_id: operationIdentifier(request.handoff_id, "ARTIFACT_AUTHORITY_HANDOFF_INVALID", "handoff_id"),
    artifact_digest: digest(request.artifact_digest, "ARTIFACT_AUTHORITY_DIGEST_INVALID", "artifact_digest"),
    content_digest: digest(request.content_digest, "ARTIFACT_AUTHORITY_DIGEST_INVALID", "content_digest"),
    plan_semantic_digest: digest(request.plan_semantic_digest, "ARTIFACT_AUTHORITY_PLAN_INVALID", "plan_semantic_digest"),
    checkpoint_id: null,
    checkpoint_digest: null,
  };
  if (request.kind === "manifest") {
    value.checkpoint_id = operationIdentifier(request.checkpoint_id, "ARTIFACT_AUTHORITY_CHECKPOINT_INVALID", "checkpoint_id");
    value.checkpoint_digest = digest(request.checkpoint_digest, "ARTIFACT_AUTHORITY_CHECKPOINT_INVALID", "checkpoint_digest");
  } else {
    invariant(request.checkpoint_id === null || request.checkpoint_id === undefined,
      "ARTIFACT_AUTHORITY_CHECKPOINT_INVALID", "A checkpoint cannot claim a checkpoint parent");
    invariant(request.checkpoint_digest === null || request.checkpoint_digest === undefined,
      "ARTIFACT_AUTHORITY_CHECKPOINT_INVALID", "A checkpoint cannot claim a checkpoint digest parent");
  }
  const frozen = Object.freeze(value);
  return Object.freeze({ value: frozen, payload_digest: sha256(Buffer.from(canonicalJson(frozen), "utf8")) });
}

export function validateArtifactActual(actual) {
  invariant(actual && typeof actual === "object" && !Array.isArray(actual), "ARTIFACT_AUTHENTICITY_INVALID");
  return Object.freeze({
    kind: actual.kind,
    artifact_id: operationIdentifier(actual.artifact_id, "ARTIFACT_AUTHORITY_ID_INVALID", "artifact_id"),
    handoff_id: operationIdentifier(actual.handoff_id, "ARTIFACT_AUTHORITY_HANDOFF_INVALID", "handoff_id"),
    artifact_digest: digest(actual.artifact_digest, "ARTIFACT_AUTHORITY_DIGEST_INVALID", "artifact_digest"),
    content_digest: digest(actual.content_digest, "ARTIFACT_AUTHORITY_DIGEST_INVALID", "content_digest"),
  });
}

export function detachedPlanAuthority(row) {
  if (!row) return null;
  return Object.freeze({
    snapshot_id: row.snapshot_id,
    task_id: row.task_id,
    plan_revision_id: row.plan_revision_id,
    content_digest: row.plan_content_digest,
    semantic_digest: row.plan_semantic_digest,
    current_item: row.current_item ?? null,
    next_item: row.next_item ?? null,
    next_step: row.next_step,
    snapshot: deepFreeze(JSON.parse(row.snapshot_json)),
    reservation_digest: row.reservation_digest ?? null,
    handoff_id: row.handoff_id ?? null,
    created_at: row.created_at,
  });
}

export function detachedArtifactAuthority(row) {
  return row ? Object.freeze({ ...row }) : null;
}

export function requireSecureRecoveryInputAuthority(authority) {
  invariant(authority?.recoveryInputSecurity?.mode === RECOVERY_INPUT_AUTHORITY_MODES.SECURE
    && authority.recoveryInputSecurity.canonical === true
    && authority.recoveryInputSecurity.r1_m_13_recovery_input_isolation === true,
  "SECURE_RECOVERY_INPUT_AUTHORITY_REQUIRED", "Secure recovery-input reads cannot use or fall back to project plan/artifact state");
  return authority;
}
