import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { opaqueId, sha256, stableId, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { sameGitState } from "./git-state.mjs";
import { PORTABLE_HANDOFF_AUTHORITY_LABEL, requireSecureHandoffAuthority, sameHandoffReservationIdentity } from "./handoff-reservation-authority.mjs";
import { requireSecureLifecycleAuthority } from "./lifecycle-binding-authority.mjs";
import { requireSecureResumeAuthority } from "./resume-authority.mjs";
import { requireSecureRecoveryAuthority } from "./recovery-authority.mjs";
import {
  assertNoCompetingResumeEvidence,
  authorizeTrustedResume,
  beginTrustedResumeDispatch,
  bindTrustedRunnerSession,
  claimTrustedHandoffLatch,
  finishTrustedResumeDispatch,
  prepareTrustedContinuityRecovery,
  projectTrustedCanonicalResumeDecision,
  projectTrustedCanonicalResumeOutcome,
  projectTrustedCanonicalRunnerSessionBinding,
  reserveTrustedHandoffPlan,
  satisfyTrustedHandoffOwnerGate,
  saveTrustedHandoff,
  supersedeTrustedRunnerSessionBinding,
} from "./handoff-plan-internal.mjs";
import {
  assertGuidedHandoffEligibilityIdentity,
  assertHandoffConsentIdentity,
  assertTrustedCurrentSourceVerifier,
  assertPlanConsentIdentity,
  handoffConsentIdentity,
} from "./handoff-consent.mjs";
import { canonicalRequiredLocalPaths, validateRequiredLocalPaths } from "./ledger.mjs";
import { measureHandoffArtifacts } from "./metrics.mjs";
import {
  assertPlanSemanticSubset,
  canonicalPlanSemantics,
  planSemanticDigest,
  sameCanonicalJson,
  samePlanSemantics,
} from "./plan-semantics-internal.mjs";
import { readRuntimeRunnerBinding, verifyRunnerOwnership } from "./runner-ownership.mjs";

function normalizePath(path) { return path?.replaceAll("\\", "/"); }

const HISTORY_ENTRY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const HANDOFF_PLAN_FIELD_MAP = Object.freeze({
  task_id: "task_id",
  current_item: "current_item",
  next_item: "next_item",
  next_step: "next_step",
  task_plan_revision: "plan_revision_id",
  task_plan_digest: "content_digest",
  requirements_version: "requirements_version",
  model_policy: "model_policy",
  reasoning_policy: "reasoning_policy",
});

const CHECKPOINT_PLAN_FIELD_MAP = Object.freeze({
  task_id: "task_id",
  plan_revision_id: "plan_revision_id",
  plan_content_digest: "content_digest",
  requirements_version: "requirements_version",
  next_step: "next_step",
  tests: "relevant_tests",
  decisions: "relevant_decisions",
});

const MANIFEST_PLAN_FIELD_MAP = Object.freeze({
  task_id: "task_id",
  objective: "objective",
  current_item: "current_item",
  next_item: "next_item",
  next_step: "next_step",
  task_plan_revision: "plan_revision_id",
  task_plan_digest: "content_digest",
  requirements_version: "requirements_version",
  relevant_decisions: "relevant_decisions",
  relevant_tests: "relevant_tests",
  evidence_references: "evidence_references",
  minimal_reads: "minimal_reads",
  required_local_paths: "required_local_paths",
  model_policy: "model_policy",
  reasoning_policy: "reasoning_policy",
});

function manifestGitState(manifest) {
  return {
    repository_id: manifest?.repository,
    workdir: manifest?.worktree,
    branch: manifest?.branch,
    head_sha: manifest?.head_sha,
    base_sha: manifest?.base_sha,
    index_digest: manifest?.index_digest,
    worktree_digest: manifest?.worktree_digest,
    status_entries: manifest?.git_status_summary,
  };
}

function captureReservedPlanSnapshot(plan, { modelPolicy = undefined, reasoningPolicy = undefined } = {}) {
  return deepFreeze(canonicalPlanSemantics(plan, { modelPolicy, reasoningPolicy }));
}

function assertReservedPlanConsistency(handoff, plan) {
  const canonicalPlan = canonicalPlanSemantics(plan, { requireAll: true });
  invariant(samePlanSemantics(handoff?.reserved_plan_snapshot, canonicalPlan, { leftRequireAll: true, rightRequireAll: true }),
    "HANDOFF_PLAN_PROVENANCE_MISMATCH", "Reserved handoff snapshot conflicts with canonical plan semantics");
  assertPlanSemanticSubset(canonicalPlan, handoff, HANDOFF_PLAN_FIELD_MAP, {
    code: "HANDOFF_PLAN_PROVENANCE_MISMATCH",
    label: "handoff top-level provenance",
  });
  return canonicalPlan;
}

function assertCheckpointPlanConsistency(handoff, plan, checkpoint) {
  const canonicalPlan = assertReservedPlanConsistency(handoff, plan);
  assertPlanSemanticSubset(canonicalPlan, checkpoint, CHECKPOINT_PLAN_FIELD_MAP, {
    code: "CHECKPOINT_MISMATCH",
    label: "checkpoint",
  });
  const expectedCriteria = canonicalPlan.completion_criteria.map((criterion) => ({ criterion, status: "IN_PROGRESS" }));
  const expectedItems = canonicalPlan.current_item === null ? [] : [canonicalPlan.current_item];
  invariant(checkpoint?.checkpoint_id === handoff.checkpoint_id
    && checkpoint.parent_checkpoint_id === (handoff.parent_checkpoint_id ?? null)
    && sameCanonicalJson(checkpoint.task_item_ids, expectedItems)
    && sameCanonicalJson(checkpoint.session_lineage, [handoff.source_session_id])
    && sameCanonicalJson(checkpoint.completion_criteria, expectedCriteria)
    && sameGitState(handoff.expected_git_state, checkpoint.git_state),
  "CHECKPOINT_MISMATCH", "Checkpoint and canonical handoff provenance disagree");
  return canonicalPlan;
}

function assertManifestPlanConsistency(handoff, plan, manifest, { allowLegacyRequiredPathsOmission = false } = {}) {
  const canonicalPlan = assertReservedPlanConsistency(handoff, plan);
  assertPlanSemanticSubset(canonicalPlan, manifest, MANIFEST_PLAN_FIELD_MAP, {
    code: "MANIFEST_MISMATCH",
    label: "manifest",
    optionalFields: allowLegacyRequiredPathsOmission ? ["required_local_paths"] : [],
  });
  invariant(manifest?.resume_manifest_id === handoff.resume_manifest_id
    && manifest.handoff_id === handoff.handoff_id
    && manifest.resume_prompt_id === handoff.resume_prompt_id
    && manifest.checkpoint_id === handoff.checkpoint_id
    && manifest.checkpoint_digest === handoff.checkpoint_digest
    && manifest.source_session_id === handoff.source_session_id
    && manifest.replacement_session_id === handoff.target_session_id
    && manifest.runner_instance_id === handoff.runner_instance_id
    && manifest.session_binding_id === handoff.session_binding_id
    && manifest.parent_session_id === handoff.parent_session_id
    && manifest.parent_checkpoint_id === (handoff.parent_checkpoint_id ?? null)
    && sameCanonicalJson(manifest.session_lineage, [handoff.source_session_id, handoff.target_session_id])
    && sameGitState(handoff.expected_git_state, manifestGitState(manifest)),
  "MANIFEST_MISMATCH", "Manifest identity, Git, or session lineage conflicts with canonical handoff provenance");
  return canonicalPlan;
}

function conversationHistory(session) {
  return session.sessionManager.getEntries().filter((entry) => HISTORY_ENTRY_TYPES.has(entry.type));
}

export function verifyRequiredLocalPaths(repositoryRoot, paths) {
  const root = realpathSync(repositoryRoot);
  for (const path of paths) {
    const candidate = resolve(root, path);
    if (!existsSync(candidate)) throw new GuardianError("REQUIRED_LOCAL_PATH_MISSING", `required local path unavailable: ${path}`);
    const actual = realpathSync(candidate);
    const fromRoot = relative(root, actual);
    invariant(fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot), "REQUIRED_LOCAL_PATH_INVALID", `required local path resolves outside repository: ${path}`);
  }
}

function gitAuthority(git) {
  return {
    repository_id: git?.repository_id ?? null,
    workdir: git?.workdir ?? null,
    branch: git?.branch ?? null,
    head_sha: git?.head_sha ?? null,
    base_sha: git?.base_sha ?? null,
    index_digest: git?.index_digest ?? null,
    worktree_digest: git?.worktree_digest ?? null,
    status_entries: structuredClone(git?.status_entries ?? []),
  };
}

function boundedFailure(error, fallback) {
  return {
    code: String(error?.code ?? fallback).slice(0, 128),
    message: String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 1024),
  };
}

export class HandoffService {
  #resumeExpectations = new WeakMap();

  constructor({ storage, artifacts, ledger, observeGit, safePoint, runnerInstanceId, modelPolicy = null, reasoningPolicy = null, telemetry = null, testHooks = null, reservationAuthority = null }) {
    invariant(typeof runnerInstanceId === "string" && runnerInstanceId.length > 0, "RUNNER_INSTANCE_REQUIRED");
    if (reservationAuthority) {
      requireSecureHandoffAuthority(reservationAuthority);
      requireSecureLifecycleAuthority(reservationAuthority);
      requireSecureResumeAuthority(reservationAuthority);
      requireSecureRecoveryAuthority(reservationAuthority);
      invariant(safePoint?.latchAuthority === reservationAuthority,
        "SECURE_HANDOFF_LATCH_TRANSACTION_REQUIRED", "Secure handoff reservation and canonical latch must share one protected authority");
      invariant(artifacts?.authority === reservationAuthority,
        "SECURE_RECOVERY_INPUT_AUTHORITY_REQUIRED", "Secure handoff artifacts must register and verify against the same protected authority");
    }
    this.storage = storage;
    this.reservationAuthority = reservationAuthority;
    this.bindingAuthority = reservationAuthority ?? storage;
    this.handoffAuthoritySecurity = reservationAuthority?.handoffSecurity ?? PORTABLE_HANDOFF_AUTHORITY_LABEL;
    this.latchAuthority = reservationAuthority ?? storage;
    this.artifacts = artifacts;
    this.ledger = ledger;
    this.observeGit = observeGit;
    this.safePoint = safePoint;
    this.runnerInstanceId = runnerInstanceId;
    this.modelPolicy = modelPolicy;
    this.reasoningPolicy = reasoningPolicy;
    this.telemetry = telemetry;
    this.testHooks = testHooks;
  }

  #protectedPlan(handoffId, portableSnapshot) {
    if (!this.reservationAuthority) return captureReservedPlanSnapshot(portableSnapshot);
    const authority = this.reservationAuthority.getPlanAuthorityForHandoff(handoffId);
    invariant(authority?.handoff_id === handoffId && authority.snapshot,
      "PLAN_AUTHORITY_UNAVAILABLE", "Protected handoff plan identity is absent; project plan state was not substituted");
    return captureReservedPlanSnapshot(authority.snapshot);
  }

  #protectedContinuityFailure(handoffId) {
    if (!this.reservationAuthority) return null;
    const recovery = this.reservationAuthority.getContinuityRecovery(handoffId);
    return recovery?.failure ?? null;
  }

  #commitProtectedContinuityFailure(handoff, error, { plan, checkpoint, manifest }) {
    if (!this.reservationAuthority) return null;
    const reservation = this.reservationAuthority.getHandoffReservation(handoff.handoff_id);
    const binding = this.bindingAuthority.getLifecycleBinding(handoff.handoff_id);
    const latch = this.latchAuthority.getLatch(handoff.task_id);
    const failed = structuredClone(handoff);
    failed.state = "CONTINUITY_FAILED";
    failed.failure = boundedFailure(error, "CONTINUITY_FAILED");
    failed.updated_at = utcNow();
    const committed = this.reservationAuthority.requestContinuityFailure(`failure:${handoff.handoff_id}`, {
      failed_handoff: failed,
      reservation_digest: reservation?.reservation_digest,
      binding,
      latch: { task_id: latch?.task_id, state: latch?.state, generation: latch?.generation, reason: latch?.reason },
      plan_semantic_digest: planSemanticDigest(plan, { requireAll: true }),
      checkpoint: { id: checkpoint.id ?? checkpoint.artifact_id, digest: checkpoint.digest, content_digest: checkpoint.content_digest },
      manifest: { id: manifest.id ?? manifest.artifact_id, digest: manifest.digest, content_digest: manifest.content_digest },
    });
    return committed.recovery.failure;
  }

  verifyCurrentSource(sourceSession, currentSourceVerifier, { required = false } = {}) {
    invariant(!required || typeof currentSourceVerifier === "function", "HANDOFF_SOURCE_ATTESTATION_REQUIRED");
    if (typeof currentSourceVerifier !== "function") return null;
    if (required) assertTrustedCurrentSourceVerifier(currentSourceVerifier, sourceSession, this.runnerInstanceId);
    const attestation = currentSourceVerifier();
    invariant(attestation && typeof attestation === "object" && typeof attestation.then !== "function",
      "HANDOFF_SOURCE_CHANGED", "Current Runner source attestation must be synchronous");
    invariant(attestation?.sessionId === sourceSession.sessionId && attestation?.runnerInstanceId === this.runnerInstanceId,
      "HANDOFF_SOURCE_CHANGED", "Current Runner source attestation no longer matches this handoff");
    return attestation;
  }

  metric(lifecycleState, details) {
    try { return this.telemetry?.recordHandoffEvent(lifecycleState, details) ?? null; }
    catch { return null; }
  }

  #buildHandoffReservation({ sourceSession, plan, safe, git, recoveryOf = null, recoveryParent = null, modelPolicy = undefined, reasoningPolicy = undefined }) {
    const sourceFile = normalizePath(sourceSession?.sessionFile);
    invariant(sourceFile, "PERSISTED_SOURCE_SESSION_REQUIRED");
    const sourceSessionId = sourceSession.sessionId;
    const handoffId = stableId("HO", sourceSessionId, plan.plan_revision_id, String(safe.latch_generation));
    const checkpointId = stableId("CP", handoffId, plan.content_digest);
    const createdAt = utcNow();
    return {
      handoff_id: handoffId,
      source_session_id: sourceSessionId,
      source_session_file: sourceFile,
      target_session_id: null,
      target_session_file: null,
      runner_instance_id: this.runnerInstanceId,
      session_binding_id: opaqueId("BIND"),
      parent_session_id: sourceSessionId,
      parent_session_file: sourceFile,
      parent_checkpoint_id: recoveryParent?.checkpoint_id ?? null,
      recovery_of_handoff_id: recoveryOf,
      task_id: plan.task_id,
      current_item: plan.current_item,
      next_item: plan.next_item,
      next_step: plan.next_step,
      task_plan_revision: plan.plan_revision_id,
      task_plan_digest: plan.content_digest,
      requirements_version: plan.requirements_version,
      latch_generation: safe.latch_generation,
      checkpoint_id: checkpointId,
      checkpoint_digest: null,
      resume_manifest_id: stableId("RM", handoffId),
      resume_manifest_digest: null,
      resume_prompt_id: null,
      resume_prompt_digest: null,
      resume_prompt: null,
      authorization_state: "NOT_AUTHORIZED",
      admission_state: "NOT_COMMITTED",
      admission_id: null,
      dispatch_state: "NOT_STARTED",
      dispatch_attempt_id: null,
      dispatch_attempt_no: 0,
      expected_git_state: structuredClone(git),
      model_policy: modelPolicy === undefined ? this.modelPolicy ?? plan.model_policy ?? null : modelPolicy,
      reasoning_policy: reasoningPolicy === undefined ? this.reasoningPolicy ?? plan.reasoning_policy ?? null : reasoningPolicy,
      reserved_plan_snapshot: plan,
      state: "SAFE_TO_HANDOFF",
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  #captureRecoveryAttestation({ failedHandoffId, expectedFailed, sourceSession, currentSourceVerifier, sourceAttestation, plan, expectedLatch, safe = null }) {
    const protectedFailure = this.#protectedContinuityFailure(failedHandoffId);
    const failed = protectedFailure?.failed_handoff ?? this.storage.getHandoff(failedHandoffId);
    invariant(failed?.state === "CONTINUITY_FAILED", "CONTINUITY_RECOVERY_NOT_ALLOWED", failed?.state ?? "HANDOFF_NOT_FOUND");
    invariant(sameCanonicalJson(failed, expectedFailed),
      "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed handoff authority changed during recovery");
    const lifecycle = this.verifyCurrentSource(sourceSession, currentSourceVerifier, { required: true });
    invariant(sourceAttestation?.session_id === sourceSession?.sessionId && sourceAttestation?.runner_instance_id === this.runnerInstanceId,
      "CONTINUITY_RECOVERY_SOURCE_INVALID", "The recovery source must be the fresh session owned by the current Runner");
    invariant(sourceSession.sessionId !== failed.source_session_id && sourceSession.sessionId !== failed.target_session_id,
      "CONTINUITY_RECOVERY_SOURCE_INVALID", "The failed handoff sessions are evidence, not the fresh recovery source");
    const historyLength = conversationHistory(sourceSession).length;
    invariant(historyLength === 0
      && sourceSession.isIdle === true
      && sourceSession.isStreaming !== true
      && sourceSession.pendingMessageCount === 0
      && sourceSession.isRetrying !== true
      && sourceSession.isCompacting !== true,
    "CONTINUITY_RECOVERY_SOURCE_INVALID", "The current Runner source must remain idle, quiescent, and at zero conversation history");
    const planSnapshot = captureReservedPlanSnapshot(plan, {
      modelPolicy: this.modelPolicy ?? plan.model_policy ?? null,
      reasoningPolicy: this.reasoningPolicy ?? plan.reasoning_policy ?? null,
    });
    invariant(planSnapshot.task_id === failed.task_id
      && planSnapshot.plan_revision_id === failed.task_plan_revision
      && planSnapshot.content_digest === failed.task_plan_digest,
    "PLAN_REVISION_MISMATCH", "current Ledger does not match failed handoff plan identity");
    assertReservedPlanConsistency(failed, planSnapshot);
    const actualModel = sourceSession.model ? `${sourceSession.model.provider}/${sourceSession.model.id}` : null;
    invariant(actualModel === failed.model_policy, "MODEL_POLICY_MISMATCH", `${actualModel} != ${failed.model_policy}`);
    invariant(sourceSession.thinkingLevel === failed.reasoning_policy, "REASONING_POLICY_MISMATCH", `${sourceSession.thinkingLevel} != ${failed.reasoning_policy}`);
    const checkpoint = this.artifacts.verify("checkpoint", failed.checkpoint_id, failed.checkpoint_digest);
    const manifest = this.artifacts.verify("manifest", failed.resume_manifest_id, failed.resume_manifest_digest);
    this.verifyRecoveryEvidence(failed, planSnapshot, checkpoint.payload, manifest.payload);
    const git = this.observeGit();
    invariant(git && typeof git === "object" && typeof git.then !== "function", "GIT_STATE_MISMATCH", "Git observation must be synchronous");
    invariant(sameGitState(failed.expected_git_state, git), "GIT_STATE_MISMATCH", "recovery source differs from failed handoff Git state");
    const latch = this.latchAuthority.getLatch(failed.task_id);
    invariant(latch?.state === "ENGAGED" && latch.generation === failed.latch_generation, "LATCH_GENERATION_MISMATCH");
    invariant(latch.reason !== "HUMAN_TAKEOVER", "HUMAN_TAKEOVER_ACTIVE");
    if (expectedLatch) invariant(latch.state === expectedLatch.state && latch.generation === expectedLatch.generation && latch.reason === expectedLatch.reason,
      "LATCH_GENERATION_MISMATCH", "Recovery latch changed after initial validation");
    if (safe) invariant(safe.latch.state === latch.state && safe.latch.generation === latch.generation && safe.latch.reason === latch.reason,
      "LATCH_GENERATION_MISMATCH", "SafePoint result no longer matches the canonical recovery latch");
    const binding = this.bindingAuthority.getLifecycleBinding
      ? this.bindingAuthority.getLifecycleBinding(failedHandoffId)
      : this.storage.getRunnerSessionBinding(failedHandoffId);
    invariant(binding?.status === "ACTIVE"
      && binding.replacement_session_id === failed.target_session_id
      && binding.runner_instance_id === failed.runner_instance_id
      && binding.session_binding_id === failed.session_binding_id,
    "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed target binding is not active and coherent");
    const semanticDigest = planSemanticDigest(planSnapshot, { requireAll: true });
    return deepFreeze(structuredClone({
      schema: "aiopago.internal-recovery-attestation/1",
      failedHandoff: failed,
      failure_digest: protectedFailure?.failure_digest ?? null,
      failedBinding: {
        handoff_id: binding.handoff_id ?? failedHandoffId,
        status: binding.status,
        replacement_session_id: binding.replacement_session_id,
        runner_instance_id: binding.runner_instance_id,
        session_binding_id: binding.session_binding_id,
        lifecycle_incarnation: binding.lifecycle_incarnation ?? lifecycle.lifecycleEpoch,
      },
      source: {
        session_id: sourceSession.sessionId,
        runner_instance_id: this.runnerInstanceId,
        lifecycle_epoch: lifecycle.lifecycleEpoch,
        active: lifecycle.active,
        history_length: historyLength,
        idle: true,
      },
      plan: planSnapshot,
      plan_semantic_digest: semanticDigest,
      model_policy: failed.model_policy,
      reasoning_policy: failed.reasoning_policy,
      git,
      checkpoint: { id: checkpoint.id ?? checkpoint.artifact_id, digest: checkpoint.digest, content_digest: checkpoint.content_digest },
      manifest: { id: manifest.id ?? manifest.artifact_id, digest: manifest.digest, content_digest: manifest.content_digest },
      latch: { task_id: failed.task_id, state: latch.state, generation: latch.generation, reason: latch.reason },
      safe_operations: safe?.operations ?? [],
    }));
  }

  async handoff({ sourceSession, currentSourceVerifier = null, expectedEligibility = null, replacePaused, mode = "manual", actor = "human:command", confirmResume = async () => false, sendResume, recoveryOf = null, verifyCurrentTarget = null }) {
    invariant(["manual", "confirm"].includes(mode), "HANDOFF_MODE_INVALID");
    const guided = expectedEligibility !== null;
    if (guided) assertGuidedHandoffEligibilityIdentity(expectedEligibility);
    const sourceFile = normalizePath(sourceSession?.sessionFile);
    invariant(sourceFile, "PERSISTED_SOURCE_SESSION_REQUIRED");
    const sourceSessionId = sourceSession.sessionId;
    this.verifyCurrentSource(sourceSession, currentSourceVerifier, { required: mode === "confirm" });
    if (guided) {
      invariant(expectedEligibility.runnerInstanceId === this.runnerInstanceId, "HANDOFF_RUNNER_CHANGED", "Guided consent belongs to a different Runner");
      invariant(expectedEligibility.sessionId === sourceSessionId, "HANDOFF_SOURCE_CHANGED", "Guided consent belongs to a different source session");
    }

    let plan = this.ledger.read();
    if (guided) assertPlanConsentIdentity(plan, expectedEligibility);
    const ownerGateExpected = Object.freeze({
      taskId: plan.task_id,
      planRevisionId: plan.plan_revision_id,
      contentDigest: plan.content_digest,
    });
    const secureReservation = this.reservationAuthority !== null;
    invariant(!secureReservation || recoveryOf === null,
      "CONTINUITY_RECOVERY_TRUSTED_PATH_REQUIRED", "Protected recovery children can be reserved only by the final R-star recovery transaction");
    const canonicalLatest = secureReservation ? this.reservationAuthority.latestHandoffReservationForTask(plan.task_id) : null;
    const expectedLatest = canonicalLatest ? {
      handoff_id: canonicalLatest.handoff_id,
      reservation_digest: canonicalLatest.reservation_digest,
    } : null;
    const parentHandoff = secureReservation ? null : this.storage.findHandoffByTarget(sourceSessionId);
    const recoveryParent = recoveryOf === null || secureReservation ? null : this.storage.getHandoff(recoveryOf);
    const portableLatest = secureReservation ? null : this.storage.latestHandoffForTask(plan.task_id);
    const expectedHandoff = guided ? expectedEligibility.handoff : handoffConsentIdentity(portableLatest);
    if (secureReservation && canonicalLatest) {
      const sourceBinding = this.bindingAuthority.getLifecycleBinding(canonicalLatest.handoff_id);
      invariant(sourceBinding?.status === "ACTIVE"
        && sourceBinding.replacement_session_id === sourceSessionId
        && sourceBinding.runner_instance_id === this.runnerInstanceId,
      "HANDOFF_TASK_RESERVATION_CONFLICT", "The current source is not the exact ACTIVE protected lifecycle successor");
    } else if (!secureReservation) assertHandoffConsentIdentity(portableLatest, expectedHandoff);
    const latchAuthority = secureReservation ? this.reservationAuthority : this.storage;
    const observedLatch = latchAuthority.getLatch(plan.task_id);
    const expectedLatch = guided ? {
      task_id: plan.task_id,
      state: expectedEligibility.latch.state,
      generation: expectedEligibility.latch.generation,
      reason: expectedEligibility.latch.reason,
    } : {
      task_id: plan.task_id,
      state: observedLatch?.state,
      generation: observedLatch?.generation,
      reason: observedLatch?.reason ?? null,
    };
    latchAuthority.assertLatchIdentity(plan.task_id, expectedLatch);

    if (!secureReservation) {
      if (recoveryOf === null) {
        const pending = this.storage.pendingContinuityFailureForTask(plan.task_id);
        invariant(!pending, "CONTINUITY_RECOVERY_REQUIRED", pending ? `Use /aio handoff recover ${pending.handoff_id}` : undefined);
        invariant(parentHandoff?.state !== "CONTINUITY_FAILED", "CONTINUITY_RECOVERY_REQUIRED", parentHandoff ? `Use /aio handoff recover ${parentHandoff.handoff_id}` : undefined);
      } else {
        this.storage.assertContinuityRecoveryPrepared(recoveryOf, { sourceSessionId, runnerInstanceId: this.runnerInstanceId });
      }
    }
    if (mode === "confirm" && recoveryOf === null) {
      // Optional UI/test preparation is complete before O*. This is the final
      // asynchronous boundary: exact Runner/source lifecycle attestation is
      // then immediately followed by the synchronous owner-authority section.
      await this.testHooks?.beforeOwnerGate?.({ plan, sourceSession, expected: ownerGateExpected });
      this.verifyCurrentSource(sourceSession, currentSourceVerifier, { required: true });
      plan = satisfyTrustedHandoffOwnerGate(this.ledger, {
        storage: this.storage,
        expected: ownerGateExpected,
        taskId: plan.task_id,
        expectedHandoff,
        expectedLatch,
        expectedLatest,
        reservationAuthority: this.reservationAuthority,
        command: "/aio handoff confirm",
        actor,
      });
      await this.testHooks?.afterOwnerGate?.({ plan, sourceSession, expected: ownerGateExpected });
    }
    plan = captureReservedPlanSnapshot(plan, {
      modelPolicy: this.modelPolicy ?? plan.model_policy ?? null,
      reasoningPolicy: this.reasoningPolicy ?? plan.reasoning_policy ?? null,
    });
    const trustedPlanIdentity = Object.freeze({
      taskId: plan.task_id,
      planRevisionId: plan.plan_revision_id,
      contentDigest: plan.content_digest,
    });
    this.assertModelPolicy(plan, sourceSession);
    const safePointReason = expectedLatch.state === "ENGAGED" ? expectedLatch.reason : "INTEGRITY";
    invariant(typeof safePointReason === "string" && safePointReason !== "HUMAN_TAKEOVER", "HUMAN_TAKEOVER_ACTIVE");
    const acquiredLatch = claimTrustedHandoffLatch(this.ledger, {
      storage: this.storage,
      expected: trustedPlanIdentity,
      taskId: plan.task_id,
      reason: safePointReason,
      actor,
      expectedLatch,
      latchAuthority: this.reservationAuthority,
    });
    const safe = await this.safePoint.request(sourceSession, actor, safePointReason, { expectedLatch, acquiredLatch });
    await this.testHooks?.afterSafePoint?.({ safe, plan, sourceSession });
    const git = this.observeGit();

    this.verifyCurrentSource(sourceSession, currentSourceVerifier, { required: mode === "confirm" });
    if (secureReservation) {
      const latestAfterSafePoint = this.reservationAuthority.latestHandoffReservationForTask(plan.task_id);
      invariant(JSON.stringify(latestAfterSafePoint ? { handoff_id: latestAfterSafePoint.handoff_id, reservation_digest: latestAfterSafePoint.reservation_digest } : null) === JSON.stringify(expectedLatest),
        "HANDOFF_LATEST_RESERVATION_STALE", "Protected reservation authority changed during SafePoint");
    } else assertHandoffConsentIdentity(this.storage.latestHandoffForTask(plan.task_id), expectedHandoff);
    latchAuthority.assertLatchIdentity(plan.task_id, safe.latch);
    const base = this.#buildHandoffReservation({
      sourceSession, plan, safe, git, recoveryOf, recoveryParent: recoveryParent ?? parentHandoff,
    });
    const handoffId = base.handoff_id;
    const checkpointId = base.checkpoint_id;
    const reserved = reserveTrustedHandoffPlan(this.ledger, {
      expected: trustedPlanIdentity,
      storage: this.storage,
      projection: base,
      reservationAuthority: this.reservationAuthority,
      requestId: handoffId,
      precondition: { latch: safe.latch, expectedHandoff, expectedLatest },
    });
    return this.#continueReservedHandoff({ reserved, sourceSession, plan, safe, replacePaused, mode, actor, confirmResume, sendResume, verifyCurrentTarget });
  }

  async #continueReservedHandoff({ reserved, sourceSession, plan, safe, replacePaused, mode, actor, confirmResume, sendResume, verifyCurrentTarget = null }) {
    let handoff = reserved.handoff;
    if (!reserved.created) return this.resumeExisting(handoff, { mode, actor, confirmResume, sendResume });
    if (this.reservationAuthority) plan = this.#protectedPlan(handoff.handoff_id, plan);
    assertReservedPlanConsistency(handoff, plan);
    const sourceSessionId = handoff.source_session_id;
    const sourceFile = handoff.source_session_file;
    const handoffId = handoff.handoff_id;
    const checkpointId = handoff.checkpoint_id;
    await this.testHooks?.afterReservation?.({ handoff, safe, plan, sourceSession });
    this.metric("STARTED", {
      handoff,
      session_id: sourceSessionId,
      task: plan,
      checkpoint_id: checkpointId,
      threshold_percent: this.telemetry?.thresholdPercent,
      reason: mode === "confirm" ? "HANDOFF_COMMAND_CONFIRMED" : "HANDOFF_COMMAND_MANUAL",
      artifacts: measureHandoffArtifacts({ taskPlanPath: this.ledger.path }),
    });

    handoff.state = "CHECKPOINT_PERSISTING";
    saveTrustedHandoff(this.storage, handoff, "STATE_TRANSITION", { from: "SAFE_TO_HANDOFF", to: handoff.state });
    try {
      const checkpoint = this.artifacts.persist("checkpoint", checkpointId, this.buildCheckpoint(handoff, plan, safe.operations), {
        handoffId,
        planSemanticDigest: planSemanticDigest(plan, { requireAll: true }),
      });
      handoff.checkpoint_digest = checkpoint.digest;
      handoff.state = "CHECKPOINT_PERSISTED";
      saveTrustedHandoff(this.storage, handoff, "CHECKPOINT_PERSISTED", { checkpoint_id: checkpointId, digest: checkpoint.digest, event_key: `checkpoint:${checkpointId}` });
      this.metric("CHECKPOINT_SEALED", {
        handoff,
        session_id: sourceSessionId,
        task: plan,
        checkpoint_id: checkpointId,
        reason: "SEALED_ARTIFACT_PERSISTED",
        artifacts: measureHandoffArtifacts({ taskPlanPath: this.ledger.path, checkpointBytes: checkpoint.bytes }),
      });
    } catch (error) {
      handoff.state = "CHECKPOINT_PERSIST_FAILED";
      handoff.failure = boundedFailure(error, "CHECKPOINT_PERSIST_FAILED");
      handoff.manual_recovery = [
        `Checkpoint persistence for handoff ${handoffId} has an unknown or failed durable outcome.`,
        `Preserve and inspect checkpoint ${checkpointId}; reconcile handoff ${handoffId} before any new handoff.`,
        "Do not rewrite the artifact or retry handoff automatically.",
      ];
      saveTrustedHandoff(this.storage, handoff, "CHECKPOINT_PERSIST_FAILED", { code: handoff.failure.code, error: handoff.failure.message, manual_recovery: handoff.manual_recovery, event_key: `checkpoint-failed:${checkpointId}` });
      throw error;
    }

    await this.testHooks?.beforeReplacement?.({ handoff: this.storage.getHandoff(handoffId), safe, plan, sourceSession });
    try {
      this.latchAuthority.assertLatchIdentity(plan.task_id, safe.latch);
    } catch (error) {
      handoff = this.storage.getHandoff(handoffId);
      handoff.state = "HANDOFF_FAILED";
      handoff.failure = { code: error.code ?? "LATCH_GENERATION_MISMATCH", message: error.message };
      handoff.manual_recovery = [
        "Human control changed after durable handoff reservation; no replacement session was created.",
        `Inspect /aio status and reconcile handoff ${handoffId}; do not retry automatically.`,
      ];
      saveTrustedHandoff(this.storage, handoff, "HANDOFF_FAILED", { code: handoff.failure.code, error: handoff.failure.message, event_key: `handoff-failed:${handoffId}` });
      throw error;
    }

    handoff.state = "REPLACEMENT_SESSION_CREATING";
    saveTrustedHandoff(this.storage, handoff, "REPLACEMENT_SESSION_CREATE_INTENT", { parent_session_file: sourceFile, event_key: `replacement-intent:${handoffId}` });
    await this.testHooks?.afterReplacementIntent?.({ handoff: this.storage.getHandoff(handoffId), safe, plan, sourceSession });
    let replacementResult;
    try {
      this.latchAuthority.assertLatchIdentity(plan.task_id, safe.latch);
      const expectedBinding = {
        schema_version: "1.0.0",
        handoff_id: handoffId,
        runner_instance_id: handoff.runner_instance_id,
        session_binding_id: handoff.session_binding_id,
      };
      replacementResult = await replacePaused(sourceFile, expectedBinding, async (target) => this.finishPausedHandoff(handoffId, target, { mode, actor, confirmResume, sendResume, verifyCurrentTarget }));
    } catch (error) {
      handoff = this.storage.getHandoff(handoffId);
      if (handoff.target_session_id) throw error;
      supersedeTrustedRunnerSessionBinding(this.storage, handoffId, "replacement creation failed before target registration");
      handoff.state = "HANDOFF_FAILED";
      if (["HUMAN_TAKEOVER_ACTIVE", "LATCH_GENERATION_MISMATCH"].includes(error?.code)) {
        handoff.failure = { code: error.code, message: error.message };
        handoff.manual_recovery = [
          "Human control changed before replacement creation; no replacement session was created.",
          `Inspect /aio status and reconcile handoff ${handoffId}; do not retry automatically.`,
        ];
        saveTrustedHandoff(this.storage, handoff, "HANDOFF_FAILED", { code: error.code, error: error.message, manual_recovery: handoff.manual_recovery, event_key: `handoff-failed:${handoffId}` });
        throw error;
      }
      handoff.failure = { code: "REPLACEMENT_SESSION_CREATE_UNKNOWN", message: error.message };
      handoff.manual_recovery = this.buildManualRecovery(handoff, "Replacement creation outcome is ambiguous");
      saveTrustedHandoff(this.storage, handoff, "HANDOFF_FAILED", { error: error.message, manual_recovery: handoff.manual_recovery, event_key: `handoff-failed:${handoffId}` });
      throw new GuardianError("HANDOFF_FAILED", handoff.manual_recovery.join("\n"), { cause: error.message, instructions: handoff.manual_recovery });
    }
    if (replacementResult?.cancelled) {
      handoff = this.storage.getHandoff(handoffId);
      handoff.state = "HANDOFF_FAILED";
      handoff.failure = { code: "REPLACEMENT_SESSION_CANCELLED", message: "Pi cancelled replacement creation before a target was registered" };
      handoff.manual_recovery = this.buildManualRecovery(handoff, handoff.failure.message);
      saveTrustedHandoff(this.storage, handoff, "HANDOFF_FAILED", { error: handoff.failure.message, manual_recovery: handoff.manual_recovery, event_key: `handoff-failed:${handoffId}` });
      throw new GuardianError("HANDOFF_FAILED", handoff.manual_recovery.join("\n"), { instructions: handoff.manual_recovery });
    }
    return this.storage.getHandoff(handoffId);
  }

  async finishPausedHandoff(handoffId, target, options) {
    let h = this.storage.getHandoff(handoffId);
    const session = target.session;
    h.target_session_id = session.sessionId;
    h.target_session_file = normalizePath(session.sessionFile);
    h.state = "REPLACEMENT_SESSION_CREATED_PAUSED";
    saveTrustedHandoff(this.storage, h, "REPLACEMENT_SESSION_CREATED_PAUSED", { target_session_id: h.target_session_id, target_session_file: h.target_session_file, event_key: `replacement:${handoffId}` });
    this.metric("REPLACEMENT_STARTED", {
      handoff: h,
      session_id: h.target_session_id,
      checkpoint_id: h.checkpoint_id,
      reason: "PAUSED_NO_HISTORY_TARGET_CREATED",
    });

    try {
      const runtimeBinding = readRuntimeRunnerBinding(session);
      invariant(runtimeBinding.handoff_id === h.handoff_id && runtimeBinding.runner_instance_id === h.runner_instance_id && runtimeBinding.session_binding_id === h.session_binding_id, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "replacement setup binding");
      if (this.reservationAuthority) {
        const lifecycle = options.verifyCurrentTarget?.(session);
        invariant(lifecycle?.sessionId === session.sessionId
          && lifecycle.runnerInstanceId === h.runner_instance_id
          && Number.isSafeInteger(lifecycle.lifecycleEpoch) && lifecycle.lifecycleEpoch > 0,
        "LIFECYCLE_ATTESTATION_INVALID", "Protected binding requires the exact active Runner lifecycle incarnation");
        const canonical = this.bindingAuthority.requestLifecycleBindingCreate(handoffId, {
          binding: { ...runtimeBinding, lifecycle_incarnation: lifecycle.lifecycleEpoch },
        });
        invariant(canonical?.binding?.status === "ACTIVE", "LIFECYCLE_BINDING_COMMIT_FAILED");
        projectTrustedCanonicalRunnerSessionBinding(this.storage, handoffId, runtimeBinding, {
          canonical: true,
          binding: canonical.binding,
        });
      } else bindTrustedRunnerSession(this.storage, handoffId, runtimeBinding);
    } catch (error) {
      h = this.storage.getHandoff(handoffId);
      h.state = "RUNNER_OWNERSHIP_ATTESTATION_FAILED";
      h.failure = boundedFailure(error, "RUNNER_OWNERSHIP_ATTESTATION_FAILED");
      h.manual_recovery = [
        `The paused target for handoff ${handoffId} could not prove exact Runner ownership.`,
        "Keep the target paused and reconcile its session header and durable binding before any new handoff.",
        "Do not install a replacement binding or retry automatically.",
      ];
      saveTrustedHandoff(this.storage, h, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", { code: h.failure.code, error: h.failure.message, manual_recovery: h.manual_recovery });
      throw error;
    }

    h = this.storage.getHandoff(handoffId);
    h.resume_prompt_id = stableId("RP", h.handoff_id, h.checkpoint_digest, h.task_plan_revision, h.requirements_version);
    h.state = "MANIFEST_PERSISTING";
    saveTrustedHandoff(this.storage, h, "STATE_TRANSITION", { from: "REPLACEMENT_SESSION_CREATED_PAUSED", to: h.state });
    try {
      const plan = this.#protectedPlan(h.handoff_id, h.reserved_plan_snapshot);
      const checkpoint = this.artifacts.verify("checkpoint", h.checkpoint_id, h.checkpoint_digest, h.handoff_id);
      assertCheckpointPlanConsistency(h, plan, checkpoint.payload);
      await this.testHooks?.beforeManifest?.({ handoff: h, plan, checkpoint: checkpoint.payload, target });
      const manifest = this.artifacts.persist("manifest", h.resume_manifest_id, this.buildManifest(h, plan), {
        handoffId: h.handoff_id,
        planSemanticDigest: planSemanticDigest(plan, { requireAll: true }),
        checkpointId: h.checkpoint_id,
        checkpointDigest: h.checkpoint_digest,
      });
      h.resume_manifest_digest = manifest.digest;
      h.state = "MANIFEST_PERSISTED";
      saveTrustedHandoff(this.storage, h, "MANIFEST_PERSISTED", { manifest_id: h.resume_manifest_id, digest: manifest.digest, event_key: `manifest:${h.resume_manifest_id}` });
    } catch (error) {
      h.state = "MANIFEST_PERSIST_FAILED";
      h.failure = boundedFailure(error, "MANIFEST_PERSIST_FAILED");
      h.manual_recovery = [
        `Manifest persistence for handoff ${handoffId} has an unknown or failed durable outcome.`,
        `Keep target ${h.target_session_id} paused and reconcile manifest ${h.resume_manifest_id} before any new handoff.`,
        "Do not rewrite the artifact, recreate the target, or retry automatically.",
      ];
      saveTrustedHandoff(this.storage, h, "MANIFEST_PERSIST_FAILED", { code: h.failure.code, error: h.failure.message, manual_recovery: h.manual_recovery, event_key: `manifest-failed:${h.resume_manifest_id}` });
      throw error;
    }

    try { h = this.continuity(handoffId, session); }
    catch (error) {
      h = error.canonicalContinuityFailure ? structuredClone(error.canonicalContinuityFailure) : this.storage.getHandoff(handoffId);
      h.state = "CONTINUITY_FAILED";
      h.failure = { code: error.code ?? "CONTINUITY_FAILED", message: error.message };
      saveTrustedHandoff(this.storage, h, "CONTINUITY_FAILED", { code: h.failure.code, error: error.message });
      throw error;
    }
    target.setEditor?.(h.resume_prompt);
    if (options.mode === "confirm") {
      const expectedResume = this.prepareResumeConfirmation(handoffId, session, {
        currentTargetVerifier: options.verifyCurrentTarget ? () => options.verifyCurrentTarget(session) : null,
      });
      const confirmed = await options.confirmResume(target, h);
      if (confirmed) return this.resume(handoffId, {
        actor: options.actor,
        sendResume: options.sendResume ?? target.sendResume,
        expectedResume,
        targetSession: session,
      });
      this.declineResumeConfirmation(expectedResume, options.actor);
    }
    return h;
  }

  async recoverContinuityFailure({ failedHandoffId, sourceSession, currentSourceVerifier = null, sourceAttestation, replacePaused, actor = "human:/aio-handoff-recover", confirmResume = async () => false, sendResume, verifyCurrentTarget = null }) {
    const protectedFailure = this.#protectedContinuityFailure(failedHandoffId);
    const failed = protectedFailure?.failed_handoff ?? this.storage.getHandoff(failedHandoffId);
    invariant(failed?.state === "CONTINUITY_FAILED", "CONTINUITY_RECOVERY_NOT_ALLOWED", failed?.state ?? "HANDOFF_NOT_FOUND");
    const initial = this.#captureRecoveryAttestation({
      failedHandoffId,
      expectedFailed: failed,
      sourceSession,
      currentSourceVerifier,
      sourceAttestation,
      plan: this.ledger.read(),
      expectedLatch: null,
    });
    const recoveryLatch = claimTrustedHandoffLatch(this.ledger, {
      storage: this.storage,
      expected: { taskId: initial.plan.task_id, planRevisionId: initial.plan.plan_revision_id, contentDigest: initial.plan.content_digest },
      taskId: initial.plan.task_id,
      reason: initial.latch.reason,
      actor,
      expectedLatch: initial.latch,
      latchAuthority: this.reservationAuthority,
    });
    const safe = await this.safePoint.request(sourceSession, actor, initial.latch.reason, { expectedLatch: initial.latch, acquiredLatch: recoveryLatch });

    // SafePoint is only an asynchronous drain. The single final R* capture and
    // prepare+child reservation below run synchronously while compliant plan
    // writers are excluded by the package-private PlanRevisionWriter lock.
    const prepared = prepareTrustedContinuityRecovery(this.ledger, {
      recoveryAuthority: this.reservationAuthority,
      expected: {
        taskId: initial.plan.task_id,
        planRevisionId: initial.plan.plan_revision_id,
        contentDigest: initial.plan.content_digest,
      },
      storage: this.storage,
      capture: (coordinatedPlan) => {
        const attestation = this.#captureRecoveryAttestation({
          failedHandoffId,
          expectedFailed: initial.failedHandoff,
          sourceSession,
          currentSourceVerifier,
          sourceAttestation,
          plan: coordinatedPlan,
          expectedLatch: initial.latch,
          safe,
        });
        const projection = this.#buildHandoffReservation({
          sourceSession,
          plan: attestation.plan,
          safe: { latch_generation: attestation.latch.generation },
          git: attestation.git,
          recoveryOf: failedHandoffId,
          recoveryParent: attestation.failedHandoff,
          modelPolicy: attestation.model_policy,
          reasoningPolicy: attestation.reasoning_policy,
        });
        if (this.reservationAuthority) {
          const failedReservation = this.reservationAuthority.getHandoffReservation(failedHandoffId);
          const decisionId = stableId("RCD", failedHandoffId, projection.handoff_id);
          return {
            requestId: decisionId,
            recovery: {
              decision_id: decisionId,
              failed_handoff_id: failedHandoffId,
              failure_digest: attestation.failure_digest,
              actor,
              source: {
                session_id: attestation.source.session_id,
                runner_instance_id: attestation.source.runner_instance_id,
                lifecycle_incarnation: attestation.source.lifecycle_epoch,
                active: attestation.source.active,
                history_length: attestation.source.history_length,
                idle: attestation.source.idle,
              },
              binding: attestation.failedBinding,
              latch: attestation.latch,
              plan_semantic_digest: attestation.plan_semantic_digest,
              model_policy: attestation.model_policy,
              reasoning_policy: attestation.reasoning_policy,
              git: attestation.git,
              checkpoint: attestation.checkpoint,
              manifest: attestation.manifest,
              child_projection: projection,
              expected_latest: {
                handoff_id: failedHandoffId,
                reservation_digest: failedReservation.reservation_digest,
              },
            },
            attestation,
          };
        }
        return {
          failedHandoffId,
          preparation: {
            sourceSessionId: attestation.source.session_id,
            runnerInstanceId: attestation.source.runner_instance_id,
            actor,
            expectedFailed: attestation.failedHandoff,
            expectedFailedPlanSemanticDigest: attestation.plan_semantic_digest,
            expectedBinding: attestation.failedBinding,
            expectedLatch: attestation.latch,
          },
          reservation: {
            projection,
            precondition: {
              latch: attestation.latch,
              expectedHandoff: handoffConsentIdentity(attestation.failedHandoff),
            },
          },
          attestation,
        };
      },
    });
    const attestation = prepared.attestation;
    const boundSafe = Object.freeze({
      state: "SAFE_TO_HANDOFF",
      latch_generation: attestation.latch.generation,
      latch: attestation.latch,
      operations: attestation.safe_operations,
    });
    return this.#continueReservedHandoff({
      reserved: prepared.reserved,
      sourceSession,
      plan: attestation.plan,
      safe: boundSafe,
      replacePaused,
      mode: "confirm",
      actor,
      confirmResume,
      sendResume,
      verifyCurrentTarget,
    });
  }

  verifyRecoveryEvidence(failed, canonicalPlan, checkpoint, manifest) {
    invariant(["1.0.0", "1.1.0"].includes(manifest?.manifest_version), "MANIFEST_MISMATCH", "unsupported recovery evidence manifest version");
    assertCheckpointPlanConsistency(failed, canonicalPlan, checkpoint);
    assertManifestPlanConsistency(failed, canonicalPlan, manifest, {
      allowLegacyRequiredPathsOmission: manifest.manifest_version === "1.0.0",
    });
  }

  continuity(handoffId, targetSession) {
    const continuityStarted = performance.now();
    let h = this.storage.getHandoff(handoffId);
    invariant(["MANIFEST_PERSISTED", "RESUME_READY"].includes(h.state), "CONTINUITY_STATE_INVALID", h.state);
    const checkpoint = this.artifacts.verify("checkpoint", h.checkpoint_id, h.checkpoint_digest, h.handoff_id);
    const manifest = this.artifacts.verify("manifest", h.resume_manifest_id, h.resume_manifest_digest, h.handoff_id);
    const reservedPlan = this.#protectedPlan(h.handoff_id, h.reserved_plan_snapshot);
    try {
    const m = manifest.payload;
    assertCheckpointPlanConsistency(h, reservedPlan, checkpoint.payload);
    assertManifestPlanConsistency(h, reservedPlan, m);
    const plan = this.ledger.read();
    const currentGit = this.observeGit();
    invariant(m.manifest_version === "1.1.0", "MANIFEST_MISMATCH", "manifest version");
    const header = targetSession.sessionManager.getHeader();
    const entries = targetSession.sessionManager.getEntries();
    const historyEntries = entries.filter((entry) => HISTORY_ENTRY_TYPES.has(entry.type));
    invariant(plan.task_id === h.task_id && m.task_id === h.task_id, "CONTINUITY_FAILED", "task_id");
    invariant(plan.plan_revision_id === h.task_plan_revision && plan.content_digest === h.task_plan_digest && m.task_plan_revision === h.task_plan_revision && m.task_plan_digest === h.task_plan_digest, "PLAN_REVISION_MISMATCH");
    invariant(plan.requirements_version === h.requirements_version && m.requirements_version === h.requirements_version, "REQUIREMENTS_VERSION_MISMATCH");
    invariant(checkpoint.payload.checkpoint_id === h.checkpoint_id && m.checkpoint_id === h.checkpoint_id && m.checkpoint_digest === h.checkpoint_digest, "CHECKPOINT_MISMATCH");
    invariant(sameGitState(checkpoint.payload.git_state, h.expected_git_state), "CHECKPOINT_MISMATCH", "git state");
    invariant(m.resume_manifest_id === h.resume_manifest_id && m.handoff_id === h.handoff_id && m.resume_prompt_id === h.resume_prompt_id, "MANIFEST_MISMATCH");
    invariant(m.source_session_id === h.source_session_id && m.replacement_session_id === h.target_session_id && m.parent_session_id === h.source_session_id, "STALE_HANDOFF");
    this.attestRunnerOwnership(h, targetSession, m);
    invariant(m.repository === h.expected_git_state.repository_id && m.worktree === h.expected_git_state.workdir && m.branch === h.expected_git_state.branch && m.base_sha === h.expected_git_state.base_sha && m.head_sha === h.expected_git_state.head_sha && m.index_digest === h.expected_git_state.index_digest && m.worktree_digest === h.expected_git_state.worktree_digest && JSON.stringify(m.git_status_summary) === JSON.stringify(h.expected_git_state.status_entries), "MANIFEST_MISMATCH", "git state");
    invariant(targetSession.sessionId === h.target_session_id && historyEntries.length === 0 && targetSession.isIdle, "REPLACEMENT_NOT_PAUSED_NO_HISTORY");
    invariant(normalizePath(header.parentSession) === h.parent_session_file, "PARENT_LINEAGE_MISMATCH");
    invariant(sameGitState(h.expected_git_state, currentGit), "GIT_STATE_MISMATCH");
    invariant(m.current_item === plan.current_item && m.next_item === plan.next_item && m.next_step === plan.next_step, "CONTINUITY_FAILED", "current item/next item/next step");
    invariant(m.model_policy === h.model_policy && m.reasoning_policy === h.reasoning_policy, "CONTINUITY_FAILED", "model/reasoning policy");
    const semanticMinimalReads = plan.minimal_reads ?? [];
    invariant(Array.isArray(m.minimal_reads) && JSON.stringify(m.minimal_reads) === JSON.stringify(semanticMinimalReads), "MANIFEST_MISMATCH", "semantic minimal reads");
    validateRequiredLocalPaths(m.required_local_paths, "REQUIRED_LOCAL_PATH_INVALID");
    const expectedLocalPaths = canonicalRequiredLocalPaths(plan.required_local_paths ?? [], "REQUIRED_LOCAL_PATH_INVALID");
    invariant(JSON.stringify(m.required_local_paths) === JSON.stringify(expectedLocalPaths), "MANIFEST_MISMATCH", "required local paths");
    verifyRequiredLocalPaths(dirname(this.ledger.path), m.required_local_paths);
    const latch = this.latchAuthority.getLatch(h.task_id);
    invariant(latch?.state === "ENGAGED" && latch.generation === h.latch_generation, "LATCH_GENERATION_MISMATCH");
    this.assertModelPolicy(plan, targetSession);
    const resumePrompt = this.buildPrompt(h, m);
    const resumePromptDigest = sha256(Buffer.from(resumePrompt, "utf8"));
    const alreadyReady = h.state === "RESUME_READY";
    if (alreadyReady) {
      invariant(h.resume_prompt === resumePrompt && h.resume_prompt_digest === resumePromptDigest,
        "RESUME_EXPECTATION_STALE", "Existing resume prompt no longer equals current continuity evidence");
    } else {
      h.resume_prompt = resumePrompt;
      h.resume_prompt_digest = resumePromptDigest;
      h.state = "RESUME_READY";
    }
    if (this.reservationAuthority) {
      const reservation = this.reservationAuthority.getHandoffReservation(handoffId);
      invariant(reservation && sameHandoffReservationIdentity(reservation, h),
        "RESUME_RESERVATION_STALE", "Portable handoff projection no longer matches protected reservation identity");
      const binding = this.bindingAuthority.getLifecycleBinding(handoffId);
      invariant(binding?.status === "ACTIVE", "LIFECYCLE_BINDING_STALE");
      const readiness = this.reservationAuthority.requestResumeReadiness(`ready:${h.resume_prompt_id}`, {
        handoff_id: h.handoff_id,
        reservation_digest: reservation.reservation_digest,
        binding,
        latch: { task_id: h.task_id, state: latch.state, generation: latch.generation, reason: latch.reason },
        checkpoint_digest: h.checkpoint_digest,
        resume_manifest_digest: h.resume_manifest_digest,
        resume_prompt_id: h.resume_prompt_id,
        resume_prompt_digest: h.resume_prompt_digest,
        resume_prompt: h.resume_prompt,
        plan_semantic_digest: planSemanticDigest(reservedPlan, { requireAll: true }),
      });
      invariant(readiness?.readiness?.readiness_digest, "RESUME_READINESS_COMMIT_FAILED");
    }
    if (alreadyReady) return h;
    saveTrustedHandoff(this.storage, h, "CONTINUITY_VALIDATED", { manifest_digest: h.resume_manifest_digest, resume_prompt_digest: h.resume_prompt_digest });
    const ready = this.storage.getHandoff(handoffId);
    this.metric("RESUME_READY", {
      handoff: ready,
      session_id: ready.target_session_id,
      checkpoint_id: ready.checkpoint_id,
      reason: "CONTINUITY_VALIDATED",
      continuity_duration_ms: performance.now() - continuityStarted,
      artifacts: measureHandoffArtifacts({
        taskPlanPath: this.ledger.path,
        checkpointBytes: checkpoint.bytes,
        manifestBytes: manifest.bytes,
        resumePrompt: ready.resume_prompt,
        minimalReads: m.minimal_reads,
      }),
    });
    return ready;
    } catch (error) {
      if (this.reservationAuthority) {
        const canonicalFailure = this.#commitProtectedContinuityFailure(h, error, {
          plan: reservedPlan, checkpoint, manifest,
        });
        error.canonicalContinuityFailure = canonicalFailure?.failed_handoff ?? null;
      }
      throw error;
    }
  }

  attestRunnerOwnership(h, targetSession, manifest) {
    invariant(h.runner_instance_id === this.runnerInstanceId, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "current Runner instance");
    const expected = {
      schema_version: "1.0.0",
      handoff_id: h.handoff_id,
      replacement_session_id: h.target_session_id,
      runner_instance_id: this.runnerInstanceId,
      session_binding_id: h.session_binding_id,
    };
    return verifyRunnerOwnership({
      runtimeBinding: readRuntimeRunnerBinding(targetSession),
      journalBinding: this.bindingAuthority.getLifecycleBinding
        ? this.bindingAuthority.getLifecycleBinding(h.handoff_id)
        : this.storage.getRunnerSessionBinding(h.handoff_id),
      manifestBinding: {
        schema_version: "1.0.0",
        handoff_id: manifest.handoff_id,
        replacement_session_id: manifest.replacement_session_id,
        runner_instance_id: manifest.runner_instance_id,
        session_binding_id: manifest.session_binding_id,
      },
      expected,
    });
  }

  #captureResumeAuthority(handoffId, targetSession, coordinatedPlan, expectedAuthority = null) {
    const h = this.storage.getHandoff(handoffId);
    invariant(h?.state === "RESUME_READY", "RESUME_NOT_READY", h?.state ?? "HANDOFF_NOT_FOUND");
    const protectedResume = this.reservationAuthority?.getResumeState?.(handoffId) ?? null;
    const protectedReadiness = protectedResume?.readiness ?? null;
    if (this.reservationAuthority) {
      invariant(protectedReadiness && protectedReadiness.resume_prompt_id === h.resume_prompt_id
        && protectedReadiness.resume_prompt_digest === h.resume_prompt_digest
        && protectedReadiness.checkpoint_digest === h.checkpoint_digest
        && protectedReadiness.resume_manifest_digest === h.resume_manifest_digest
        && protectedResume.authorization === null && protectedResume.admission === null && protectedResume.dispatch === null,
      "RESUME_READINESS_STALE", "Protected resume readiness is absent, changed, or already consumed");
    }
    invariant(targetSession && typeof targetSession === "object" && targetSession.sessionId === h.target_session_id,
      "RESUME_EXPECTATION_STALE", "The confirmed target session no longer matches the handoff");
    invariant(normalizePath(targetSession.sessionFile) === h.target_session_file,
      "RESUME_EXPECTATION_STALE", "The target session file changed after confirmation was displayed");
    const plan = captureReservedPlanSnapshot(coordinatedPlan, {
      modelPolicy: this.modelPolicy ?? coordinatedPlan.model_policy ?? null,
      reasoningPolicy: this.reasoningPolicy ?? coordinatedPlan.reasoning_policy ?? null,
    });
    const semanticPlan = assertReservedPlanConsistency(h, plan);
    const semanticDigest = planSemanticDigest(semanticPlan, { requireAll: true });
    const checkpoint = this.artifacts.verify("checkpoint", h.checkpoint_id, h.checkpoint_digest, h.handoff_id);
    const manifest = this.artifacts.verify("manifest", h.resume_manifest_id, h.resume_manifest_digest, h.handoff_id);
    assertCheckpointPlanConsistency(h, semanticPlan, checkpoint.payload);
    assertManifestPlanConsistency(h, semanticPlan, manifest.payload);
    invariant(manifest.payload.manifest_version === "1.1.0", "MANIFEST_MISMATCH", "manifest version");
    const git = this.observeGit();
    invariant(git && typeof git === "object" && typeof git.then !== "function", "GIT_STATE_MISMATCH", "Git observation must be synchronous");
    invariant(sameGitState(h.expected_git_state, git), "GIT_STATE_MISMATCH", "Git changed after resume confirmation was displayed");
    const header = targetSession.sessionManager.getHeader();
    const entries = targetSession.sessionManager.getEntries();
    const history = entries.filter((entry) => HISTORY_ENTRY_TYPES.has(entry.type));
    invariant(targetSession.sessionManager.getSessionId() === targetSession.sessionId
      && history.length === 0
      && targetSession.isIdle === true
      && targetSession.isStreaming !== true
      && targetSession.pendingMessageCount === 0
      && targetSession.isRetrying !== true
      && targetSession.isCompacting !== true,
    "REPLACEMENT_NOT_PAUSED_NO_HISTORY", "The confirmed target is no longer paused, idle, and free of conversation history");
    invariant(normalizePath(header.parentSession) === h.parent_session_file, "PARENT_LINEAGE_MISMATCH");
    const runtimeBinding = readRuntimeRunnerBinding(targetSession);
    this.attestRunnerOwnership(h, targetSession, manifest.payload);
    this.assertModelPolicy(semanticPlan, targetSession);
    const actualModel = targetSession.model ? `${targetSession.model.provider}/${targetSession.model.id}` : null;
    validateRequiredLocalPaths(manifest.payload.required_local_paths, "REQUIRED_LOCAL_PATH_INVALID");
    verifyRequiredLocalPaths(dirname(this.ledger.path), manifest.payload.required_local_paths);
    invariant(typeof h.resume_prompt === "string" && h.resume_prompt.length > 0
      && sha256(Buffer.from(h.resume_prompt, "utf8")) === h.resume_prompt_digest
      && h.resume_prompt === this.buildPrompt(h, manifest.payload),
    "RESUME_EXPECTATION_STALE", "Resume prompt identity changed after confirmation was displayed");
    const binding = this.bindingAuthority.getLifecycleBinding
      ? this.bindingAuthority.getLifecycleBinding(handoffId)
      : this.storage.getRunnerSessionBinding(handoffId);
    invariant(binding?.status === "ACTIVE", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "Durable Runner binding is not ACTIVE");
    const latch = this.latchAuthority.getLatch(h.task_id);
    invariant(latch?.state === "ENGAGED" && latch.generation === h.latch_generation && latch.reason !== "HUMAN_TAKEOVER",
      latch?.reason === "HUMAN_TAKEOVER" ? "HUMAN_TAKEOVER_ACTIVE" : "LATCH_GENERATION_MISMATCH");
    invariant(h.authorization_state === "NOT_AUTHORIZED" && h.admission_state === "NOT_COMMITTED" && h.dispatch_state === "NOT_STARTED",
      "RESUME_EXPECTATION_STALE", "Resume authorization, admission, or dispatch is no longer empty");
    const latest = this.reservationAuthority
      ? this.reservationAuthority.latestHandoffReservationForTask(h.task_id)
      : this.storage.latestHandoffForTask(h.task_id);
    invariant(latest?.handoff_id === h.handoff_id, "TASK_OPERATION_CONFLICT", "The handoff no longer owns the task operation");
    const durableCounts = this.reservationAuthority
      ? { authorizations: 0, admissions: 0, dispatch_attempts: 0 }
      : assertNoCompetingResumeEvidence(this.storage, handoffId);
    const authority = deepFreeze(structuredClone({
      schema: "aiopago.internal-resume-attestation/1",
      handoff: h,
      plan: semanticPlan,
      plan_semantic_digest: semanticDigest,
      git: gitAuthority(git),
      target: {
        session_id: targetSession.sessionId,
        session_file: normalizePath(targetSession.sessionFile),
        parent_session_file: normalizePath(header.parentSession),
        runner_binding: runtimeBinding,
        model_policy: actualModel,
        reasoning_policy: targetSession.thinkingLevel ?? null,
        history_length: history.length,
        entry_count: entries.length,
        idle: targetSession.isIdle === true,
        streaming: targetSession.isStreaming === true,
        pending_messages: targetSession.pendingMessageCount,
        retrying: targetSession.isRetrying === true,
        compacting: targetSession.isCompacting === true,
      },
      binding: {
        handoff_id: binding.handoff_id,
        replacement_session_id: binding.replacement_session_id,
        runner_instance_id: binding.runner_instance_id,
        session_binding_id: binding.session_binding_id,
        lifecycle_incarnation: binding.lifecycle_incarnation ?? null,
        status: binding.status,
      },
      checkpoint: { id: h.checkpoint_id, digest: checkpoint.digest, content_digest: checkpoint.content_digest },
      manifest: { id: h.resume_manifest_id, digest: manifest.digest, content_digest: manifest.content_digest },
      resume_prompt: { id: h.resume_prompt_id, digest: h.resume_prompt_digest, text: h.resume_prompt },
      latch: { task_id: h.task_id, state: latch.state, generation: latch.generation, reason: latch.reason },
      authorization: { state: h.authorization_state, admission: h.admission_state, dispatch: h.dispatch_state, durable_counts: durableCounts },
      protected_readiness: protectedReadiness,
      task_operation_handoff_id: latest.handoff_id,
    }));
    if (expectedAuthority) {
      const changed = Object.keys(authority).filter((field) => !sameCanonicalJson(authority[field], expectedAuthority[field]));
      invariant(changed.length === 0,
        "RESUME_EXPECTATION_STALE", `The exact operation shown before human confirmation is no longer current (${changed.join(", ")})`);
    }
    return authority;
  }

  prepareResumeConfirmation(handoffId, targetSession, { currentTargetVerifier = null } = {}) {
    const targetAttestation = currentTargetVerifier?.();
    invariant(!targetAttestation || typeof targetAttestation.then !== "function", "RESUME_ATTESTATION_INVALID", "Current target attestation must be synchronous");
    const h = this.storage.getHandoff(handoffId);
    invariant(h?.state === "RESUME_READY", "RESUME_NOT_READY", h?.state ?? "HANDOFF_NOT_FOUND");
    const authority = this.#captureResumeAuthority(handoffId, targetSession, this.ledger.read());
    const expectation = deepFreeze({
      schema: "aiopago.resume-expectation/1",
      expectation_id: opaqueId("RE"),
      handoff_id: h.handoff_id,
      state: h.state,
      task_id: h.task_id,
      task_plan_revision: h.task_plan_revision,
      task_plan_digest: h.task_plan_digest,
      plan_semantic_digest: authority.plan_semantic_digest,
      expected_git_state: authority.git,
      target_session_id: h.target_session_id,
      target_session_file: h.target_session_file,
      runner_instance_id: h.runner_instance_id,
      session_binding_id: h.session_binding_id,
      checkpoint_id: h.checkpoint_id,
      checkpoint_digest: h.checkpoint_digest,
      resume_manifest_id: h.resume_manifest_id,
      resume_manifest_digest: h.resume_manifest_digest,
      resume_prompt_id: h.resume_prompt_id,
      resume_prompt_digest: h.resume_prompt_digest,
      model_policy: h.model_policy,
      reasoning_policy: h.reasoning_policy,
      latch: authority.latch,
      authorization_state: h.authorization_state,
      admission_state: h.admission_state,
      dispatch_state: h.dispatch_state,
    });
    this.#resumeExpectations.set(expectation, { targetSession, authority, currentTargetVerifier, targetAttestation });
    return expectation;
  }

  discardResumeConfirmation(expectation) {
    return this.#resumeExpectations.delete(expectation);
  }

  declineResumeConfirmation(expectation, actor = "human:resume") {
    const prepared = expectation && typeof expectation === "object" ? this.#resumeExpectations.get(expectation) : null;
    invariant(prepared, "RESUME_ATTESTATION_REQUIRED", "Resume NO requires the invocation-local expectation shown by this trusted interaction");
    this.#resumeExpectations.delete(expectation);
    if (!this.reservationAuthority) return { answer: "NO", authorized: false, admitted: false, dispatch_permit: false };
    const readiness = prepared.authority.protected_readiness;
    invariant(readiness?.readiness_digest, "RESUME_READINESS_STALE");
    return this.reservationAuthority.requestResumeDecision(expectation.expectation_id, {
      answer: "NO", actor, handoff_id: expectation.handoff_id,
      readiness_digest: readiness.readiness_digest,
      resume_prompt_id: expectation.resume_prompt_id,
    });
  }

  async resume(handoffId, { actor = "human:resume", sendResume, expectedResume = null, targetSession = null } = {}) {
    let h = this.storage.getHandoff(handoffId);
    invariant(h, "HANDOFF_NOT_FOUND");
    const canonicalBefore = this.reservationAuthority?.getResumeState?.(handoffId) ?? null;
    if (canonicalBefore?.dispatch?.state === "ACKNOWLEDGED") {
      if (h.state !== "RESUMED") h = projectTrustedCanonicalResumeOutcome(this.storage, {
        handoff_id: handoffId, outcome: "ACKNOWLEDGED", state: canonicalBefore,
      });
      return h;
    }
    if (h.state === "RESUMED") return h;
    if (h.state === "CONTINUITY_FAILED") throw new GuardianError("CONTINUITY_RECOVERY_REQUIRED", `Use /aio handoff recover ${h.handoff_id}`);
    if (canonicalBefore?.dispatch || h.state === "RESUME_DISPATCH_UNKNOWN" || h.dispatch_state === "UNKNOWN") {
      throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "A durable dispatch intent already exists and has no safe replay");
    }
    invariant(typeof sendResume === "function", "RESUME_TRANSPORT_REQUIRED");
    const prepared = expectedResume && typeof expectedResume === "object" ? this.#resumeExpectations.get(expectedResume) : null;
    invariant(prepared && prepared.targetSession === targetSession && expectedResume.handoff_id === handoffId,
      "RESUME_ATTESTATION_REQUIRED", "Direct resume requires the invocation-local expectation captured for this exact target and human prompt");
    this.#resumeExpectations.delete(expectedResume);
    const resumeStarted = performance.now();
    const authorizationId = stableId("AUTH", expectedResume.resume_prompt_id);
    const admissionId = stableId("ADM", expectedResume.resume_prompt_id);
    const attemptId = stableId("DSP", admissionId, "1");
    const admission = authorizeTrustedResume(this.ledger, {
      storage: this.storage,
      resumeAuthority: this.reservationAuthority,
      expectedPlan: {
        taskId: expectedResume.task_id,
        planRevisionId: expectedResume.task_plan_revision,
        contentDigest: expectedResume.task_plan_digest,
      },
      capture: (coordinatedPlan) => {
        const targetAttestation = prepared.currentTargetVerifier?.();
        invariant(!targetAttestation || typeof targetAttestation.then !== "function", "RESUME_ATTESTATION_INVALID", "Final current target attestation must be synchronous");
        invariant(sameCanonicalJson(targetAttestation ?? null, prepared.targetAttestation ?? null),
          "RESUME_EXPECTATION_STALE", "Current Runner target ownership changed after resume confirmation was displayed");
        const authority = this.#captureResumeAuthority(handoffId, targetSession, coordinatedPlan, prepared.authority);
        if (this.reservationAuthority) return {
          requestId: expectedResume.expectation_id,
          decision: {
            answer: "YES", actor, handoff_id: handoffId,
            readiness_digest: authority.protected_readiness.readiness_digest,
            resume_prompt_id: authority.resume_prompt.id,
            authorization_id: authorizationId,
            admission_id: admissionId,
            idempotency_key: `resume:${authority.resume_prompt.id}`,
            dispatch_attempt_id: attemptId,
            attempt_no: 1,
            binding: authority.binding,
            latch: authority.latch,
          },
          attestation: authority,
        };
        return {
          handoffId,
          actor,
          idempotencyKey: `resume:${authority.resume_prompt.id}`,
          admissionId,
          expected: {
            handoff: authority.handoff,
            binding: authority.binding,
            latch: authority.latch,
            planSemanticDigest: authority.plan_semantic_digest,
            taskOperationHandoffId: authority.task_operation_handoff_id,
          },
          attestation: authority,
        };
      },
    });

    let dispatchPermit;
    let prompt;
    if (this.reservationAuthority) {
      h = projectTrustedCanonicalResumeDecision(this.storage, admission);
      dispatchPermit = admission.dispatch_permit === true;
      prompt = admission.state.readiness.resume_prompt;
    } else {
      h = admission.handoff;
      const dispatch = beginTrustedResumeDispatch(this.storage, handoffId, attemptId, 1);
      if (dispatch.idempotent) {
        if (dispatch.attempt.state === "ACKNOWLEDGED") return this.storage.getHandoff(handoffId);
        throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Durable dispatch intent has no safe replay");
      }
      dispatchPermit = true;
      prompt = h.resume_prompt;
    }
    this.metric("RESUME_STARTED", {
      handoff: h,
      session_id: h.target_session_id,
      checkpoint_id: h.checkpoint_id,
      reason: "HUMAN_RESUME_AUTHORIZED",
    });
    if (!dispatchPermit) throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Duplicate admission cannot replay the durable external dispatch intent");

    if (this.reservationAuthority) {
      try {
        const finalTarget = prepared.currentTargetVerifier?.();
        invariant(!finalTarget || (typeof finalTarget.then !== "function" && sameCanonicalJson(finalTarget, prepared.targetAttestation)),
          "RESUME_EXPECTATION_STALE", "Target lifecycle changed after admission but before external dispatch");
        const finalBinding = this.reservationAuthority.getLifecycleBinding(handoffId);
        invariant(finalBinding?.status === "ACTIVE"
          && finalBinding.lifecycle_incarnation === admission.state.readiness.lifecycle_incarnation,
        "LIFECYCLE_BINDING_STALE", "Protected target shut down after admission but before external dispatch");
        const finalLatch = this.reservationAuthority.getLatch(h.task_id);
        invariant(finalLatch?.state === "RELEASED"
          && finalLatch.generation === admission.state.authorization.released_latch_generation,
        finalLatch?.reason === "HUMAN_TAKEOVER" ? "HUMAN_TAKEOVER_ACTIVE" : "LATCH_GENERATION_MISMATCH",
        "Protected latch changed after admission but before external dispatch");
      } catch (error) {
        const failed = this.reservationAuthority.requestResumeDispatchOutcome(`failed:${attemptId}`, {
          dispatch_attempt_id: attemptId, outcome: "FAILED", error: String(error?.code ?? error?.message ?? error).replace(/\s+/g, " ").slice(0, 2048),
        });
        projectTrustedCanonicalResumeOutcome(this.storage, failed);
        throw error;
      }
    }

    try {
      await sendResume(prompt);
    } catch (error) {
      const unknown = this.reservationAuthority
        ? this.reservationAuthority.requestResumeDispatchOutcome(`unknown:${attemptId}`, { dispatch_attempt_id: attemptId, outcome: "UNKNOWN", error: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 2048) })
        : { handoff_id: handoffId, outcome: "UNKNOWN", state: null };
      if (this.reservationAuthority) projectTrustedCanonicalResumeOutcome(this.storage, unknown);
      else finishTrustedResumeDispatch(this.storage, handoffId, "UNKNOWN", error.message);
      throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Resume might have been accepted; no automatic retry", { cause: error.message });
    }

    let outcome;
    try {
      outcome = this.reservationAuthority
        ? this.reservationAuthority.requestResumeDispatchOutcome(`ack:${attemptId}`, { dispatch_attempt_id: attemptId, outcome: "ACKNOWLEDGED", error: null })
        : null;
    } catch (error) {
      throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "External resume returned success but its protected outcome was not committed; reconciliation is required and retry is forbidden", { cause: error.message });
    }
    const completed = this.reservationAuthority
      ? projectTrustedCanonicalResumeOutcome(this.storage, outcome)
      : finishTrustedResumeDispatch(this.storage, handoffId, "ACKNOWLEDGED");
    this.metric("COMPLETED", {
      handoff: completed,
      session_id: completed.target_session_id,
      checkpoint_id: completed.checkpoint_id,
      reason: "RESUME_ACKNOWLEDGED",
      resume_duration_ms: performance.now() - resumeStarted,
    });
    return completed;
  }

  async resumeExisting(h, options) {
    if (h.state === "RESUMED") return h;
    if (h.state === "RESUME_READY") {
      if (options.mode !== "confirm") return h;
      invariant(options.targetSession, "RESUME_ATTESTATION_REQUIRED", "Existing handoff confirmation requires the exact paused target runtime");
      const expectedResume = this.prepareResumeConfirmation(h.handoff_id, options.targetSession, {
        currentTargetVerifier: options.currentTargetVerifier ?? null,
      });
      if (await options.confirmResume(options.targetSession, h)) {
        return this.resume(h.handoff_id, { ...options, expectedResume, targetSession: options.targetSession });
      }
      this.declineResumeConfirmation(expectedResume, options.actor);
      return h;
    }
    if (h.admission_state === "COMMITTED") throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Committed admission cannot be reconfirmed or replayed");
    throw new GuardianError("ACTIVE_HANDOFF_EXISTS", `Existing handoff is ${h.state}`, { handoff_id: h.handoff_id });
  }

  buildManualRecovery(h, cause) {
    const checkpointPath = this.storage.getArtifact("checkpoint", h.checkpoint_id)?.path ?? `.guardian/checkpoints/${h.checkpoint_id}.json`;
    return [
      `${cause}; Aiopago will not create or prompt a second target automatically.`,
      `1. Preserve checkpoint ${h.checkpoint_id} (${h.checkpoint_digest}) at ${checkpointPath}.`,
      `2. Do not retry handoff ${h.handoff_id} until the Pi session effect has been reconciled by a human.`,
      "3. Inspect Pi sessions for a child whose parentSession equals the recorded source_session_file.",
      "4. If no child exists, start a fresh Aiopago session manually and keep the latch engaged; if one exists, keep it paused and verify lineage before any resume.",
      `5. Use /aio status and retain handoff_id=${h.handoff_id}; RESUME_DISPATCH_UNKNOWN or an unknown target must never be retried blindly.`,
      "The final Resume Context Manifest cannot be sealed until the real replacement_session_id is known.",
    ];
  }

  buildCheckpoint(h, plan, operations) {
    assertReservedPlanConsistency(h, plan);
    const relevantTests = Array.isArray(plan.relevant_tests) ? plan.relevant_tests : [];
    const relevantDecisions = Array.isArray(plan.relevant_decisions) ? plan.relevant_decisions : [];
    const changes = operations
      .filter((operation) => operation.effect_reference)
      .map((operation) => operation.effect_reference);
    return {
      schema_version: "0.1.0",
      checkpoint_id: h.checkpoint_id,
      parent_checkpoint_id: h.parent_checkpoint_id,
      merge_parent_checkpoint_ids: [],
      task_id: h.task_id,
      task_item_ids: h.current_item ? [h.current_item] : [],
      session_lineage: [h.source_session_id],
      run_lineage: [],
      plan_revision_id: h.task_plan_revision,
      plan_content_digest: h.task_plan_digest,
      requirements_version: h.requirements_version,
      checkpoint_message: `Aiopago handoff for ${plan.task_id} sealed at a Runner-owned safe point`,
      created_at: h.created_at,
      producer: { component: "aiopago-runner", version: "0.1.0", actor_type: "guardian" },
      git_state: h.expected_git_state,
      completion_criteria: plan.completion_criteria.map((criterion) => ({ criterion, status: "IN_PROGRESS" })),
      evidence: operations.filter((operation) => operation.effect_reference).map((operation) => ({ kind: "operation_effect", locator: operation.effect_reference, verification_status: "VERIFIED" })),
      usage: null,
      cost: { provider_billing: null, local_estimate: null, currency: null, status: "unknown" },
      risks: [{ code: "PROVIDER_EXECUTION_NOT_EXACTLY_ONCE", status: "OPEN" }],
      next_step: h.next_step,
      status: "PARTIAL",
      checkpoint_spec_id: null,
      changes,
      tests: relevantTests,
      decisions: relevantDecisions,
      idempotency_key: `checkpoint:${h.checkpoint_id}`,
    };
  }

  buildManifest(h, plan) {
    assertReservedPlanConsistency(h, plan);
    const relevantDecisions = Array.isArray(plan.relevant_decisions) ? plan.relevant_decisions : [];
    const relevantTests = Array.isArray(plan.relevant_tests) ? plan.relevant_tests : [];
    const evidenceReferences = Array.isArray(plan.evidence_references) ? plan.evidence_references : [];
    const manifest = {
      manifest_version: "1.1.0",
      resume_manifest_id: h.resume_manifest_id,
      created_at: h.created_at,
      task_id: h.task_id,
      objective: plan.objective,
      current_item: h.current_item,
      next_item: h.next_item,
      next_step: h.next_step,
      task_plan_revision: h.task_plan_revision,
      task_plan_digest: h.task_plan_digest,
      requirements_version: h.requirements_version,
      checkpoint_id: h.checkpoint_id,
      checkpoint_digest: h.checkpoint_digest,
      source_session_id: h.source_session_id,
      replacement_session_id: h.target_session_id,
      runner_instance_id: h.runner_instance_id,
      session_binding_id: h.session_binding_id,
      parent_session_id: h.parent_session_id,
      parent_checkpoint_id: h.parent_checkpoint_id,
      session_lineage: [h.source_session_id, h.target_session_id],
      repository: h.expected_git_state.repository_id,
      branch: h.expected_git_state.branch,
      worktree: h.expected_git_state.workdir,
      base_sha: h.expected_git_state.base_sha,
      head_sha: h.expected_git_state.head_sha,
      index_digest: h.expected_git_state.index_digest,
      worktree_digest: h.expected_git_state.worktree_digest,
      git_status_summary: h.expected_git_state.status_entries,
      relevant_decisions: relevantDecisions,
      relevant_tests: relevantTests,
      evidence_references: evidenceReferences,
      risks: ["Provider execution is not exactly-once", "Session create to journal remains a saga boundary"],
      blocks: [],
      minimal_reads: [...(plan.minimal_reads ?? [])],
      required_local_paths: canonicalRequiredLocalPaths(plan.required_local_paths ?? []),
      model_policy: h.model_policy,
      reasoning_policy: h.reasoning_policy,
      remaining_budget: null,
      handoff_id: h.handoff_id,
      resume_prompt_id: h.resume_prompt_id,
    };
    assertManifestPlanConsistency(h, plan, manifest);
    return manifest;
  }

  buildPrompt(h, manifest) {
    return [
      "AIOPAGO_RESUME_V1",
      `task_id=${h.task_id}`,
      `task_plan_revision=${h.task_plan_revision}`,
      `task_plan_digest=${h.task_plan_digest}`,
      `requirements_version=${h.requirements_version}`,
      `checkpoint_id=${h.checkpoint_id}`,
      `checkpoint_digest=${h.checkpoint_digest}`,
      `resume_manifest_id=${h.resume_manifest_id}`,
      `resume_manifest_digest=${h.resume_manifest_digest}`,
      `handoff_id=${h.handoff_id}`,
      `resume_prompt_id=${h.resume_prompt_id}`,
      `current_item=${manifest.current_item}`,
      `next_item=${manifest.next_item}`,
      `next_step=${manifest.next_step}`,
      `semantic_minimal_reads_json=${JSON.stringify(manifest.minimal_reads)}`,
      `required_local_paths_json=${JSON.stringify(manifest.required_local_paths)}`,
      "Follow the semantic minimal-read directives exactly. Required local paths are machine-verified dependencies; checkpoint and manifest integrity are sealed separately. Do not reconstruct state from previous conversation history.",
    ].join("\n");
  }

  assertModelPolicy(plan, session) {
    const expectedModel = this.modelPolicy ?? plan.model_policy;
    const actualModel = session.model ? `${session.model.provider}/${session.model.id}` : null;
    if (expectedModel) invariant(actualModel === expectedModel, "MODEL_POLICY_MISMATCH", `${actualModel} != ${expectedModel}`);
    const expectedReasoning = this.reasoningPolicy ?? plan.reasoning_policy;
    if (expectedReasoning) invariant(session.thinkingLevel === expectedReasoning, "REASONING_POLICY_MISMATCH", `${session.thinkingLevel} != ${expectedReasoning}`);
  }
}
