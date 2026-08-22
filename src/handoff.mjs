import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { opaqueId, sha256, stableId, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { sameGitState } from "./git-state.mjs";
import { prepareTrustedContinuityRecovery, reserveTrustedHandoffPlan } from "./handoff-plan-internal.mjs";
import {
  assertGuidedHandoffEligibilityIdentity,
  assertHandoffConsentIdentity,
  assertPlanConsentIdentity,
  handoffConsentIdentity,
} from "./handoff-consent.mjs";
import { canonicalRequiredLocalPaths, validateRequiredLocalPaths } from "./ledger.mjs";
import { measureHandoffArtifacts } from "./metrics.mjs";
import { readRuntimeRunnerBinding, verifyRunnerOwnership } from "./runner-ownership.mjs";

function normalizePath(path) { return path?.replaceAll("\\", "/"); }

const HISTORY_ENTRY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function planList(plan, field) {
  return Array.isArray(plan[field]) ? structuredClone(plan[field]) : [];
}

function captureReservedPlanSnapshot(plan) {
  return deepFreeze({
    task_id: plan.task_id,
    objective: plan.objective,
    current_item: plan.current_item,
    next_item: plan.next_item,
    next_step: plan.next_step,
    plan_revision_id: plan.plan_revision_id,
    content_digest: plan.content_digest,
    requirements_version: plan.requirements_version,
    completion_criteria: planList(plan, "completion_criteria"),
    relevant_decisions: planList(plan, "relevant_decisions"),
    relevant_tests: planList(plan, "relevant_tests"),
    evidence_references: planList(plan, "evidence_references"),
    minimal_reads: planList(plan, "minimal_reads"),
    required_local_paths: planList(plan, "required_local_paths"),
    model_policy: plan.model_policy ?? null,
    reasoning_policy: plan.reasoning_policy ?? null,
  });
}

function assertReservedPlanConsistency(handoff, plan) {
  invariant(plan && handoff.task_id === plan.task_id
    && handoff.task_plan_revision === plan.plan_revision_id
    && handoff.task_plan_digest === plan.content_digest
    && handoff.requirements_version === plan.requirements_version
    && handoff.current_item === plan.current_item
    && handoff.next_item === plan.next_item
    && handoff.next_step === plan.next_step,
  "HANDOFF_PLAN_PROVENANCE_MISMATCH", "Reserved handoff and immutable plan snapshot disagree");
  return plan;
}

function assertCheckpointPlanConsistency(handoff, plan, checkpoint) {
  assertReservedPlanConsistency(handoff, plan);
  invariant(checkpoint?.checkpoint_id === handoff.checkpoint_id
    && checkpoint.task_id === plan.task_id
    && checkpoint.plan_revision_id === plan.plan_revision_id
    && checkpoint.plan_content_digest === plan.content_digest
    && checkpoint.requirements_version === plan.requirements_version,
  "CHECKPOINT_MISMATCH", "Checkpoint and reserved plan snapshot disagree");
}

function assertManifestPlanConsistency(handoff, plan, manifest) {
  assertReservedPlanConsistency(handoff, plan);
  invariant(manifest?.task_id === plan.task_id
    && manifest.task_plan_revision === plan.plan_revision_id
    && manifest.task_plan_digest === plan.content_digest
    && manifest.requirements_version === plan.requirements_version
    && manifest.objective === plan.objective
    && manifest.current_item === plan.current_item
    && manifest.next_item === plan.next_item
    && manifest.next_step === plan.next_step
    && JSON.stringify(manifest.relevant_decisions) === JSON.stringify(plan.relevant_decisions)
    && JSON.stringify(manifest.relevant_tests) === JSON.stringify(plan.relevant_tests)
    && JSON.stringify(manifest.evidence_references) === JSON.stringify(plan.evidence_references)
    && JSON.stringify(manifest.minimal_reads) === JSON.stringify(plan.minimal_reads)
    && JSON.stringify(manifest.required_local_paths) === JSON.stringify(canonicalRequiredLocalPaths(plan.required_local_paths)),
  "MANIFEST_MISMATCH", "Manifest and reserved plan snapshot disagree");
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

export class HandoffService {
  constructor({ storage, artifacts, ledger, observeGit, safePoint, runnerInstanceId, modelPolicy = null, reasoningPolicy = null, telemetry = null, testHooks = null }) {
    invariant(typeof runnerInstanceId === "string" && runnerInstanceId.length > 0, "RUNNER_INSTANCE_REQUIRED");
    this.storage = storage;
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

  verifyCurrentSource(sourceSession, currentSourceVerifier, { required = false } = {}) {
    invariant(!required || typeof currentSourceVerifier === "function", "HANDOFF_SOURCE_ATTESTATION_REQUIRED");
    if (typeof currentSourceVerifier !== "function") return null;
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
    const failed = this.storage.getHandoff(failedHandoffId);
    invariant(failed?.state === "CONTINUITY_FAILED", "CONTINUITY_RECOVERY_NOT_ALLOWED", failed?.state ?? "HANDOFF_NOT_FOUND");
    invariant(JSON.stringify(failed) === JSON.stringify(expectedFailed),
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
    invariant(plan.task_id === failed.task_id
      && plan.plan_revision_id === failed.task_plan_revision
      && plan.content_digest === failed.task_plan_digest
      && plan.requirements_version === failed.requirements_version,
    "PLAN_REVISION_MISMATCH", "current Ledger does not match failed handoff provenance");
    invariant(plan.current_item === failed.current_item && plan.next_item === failed.next_item && plan.next_step === failed.next_step,
      "CONTINUITY_RECOVERY_SOURCE_INVALID", "current Ledger task position differs from failed handoff");
    const actualModel = sourceSession.model ? `${sourceSession.model.provider}/${sourceSession.model.id}` : null;
    invariant(actualModel === failed.model_policy, "MODEL_POLICY_MISMATCH", `${actualModel} != ${failed.model_policy}`);
    invariant(sourceSession.thinkingLevel === failed.reasoning_policy, "REASONING_POLICY_MISMATCH", `${sourceSession.thinkingLevel} != ${failed.reasoning_policy}`);
    const checkpoint = this.artifacts.verify("checkpoint", failed.checkpoint_id, failed.checkpoint_digest);
    const manifest = this.artifacts.verify("manifest", failed.resume_manifest_id, failed.resume_manifest_digest);
    this.verifyRecoveryEvidence(failed, checkpoint.payload, manifest.payload);
    const git = this.observeGit();
    invariant(git && typeof git === "object" && typeof git.then !== "function", "GIT_STATE_MISMATCH", "Git observation must be synchronous");
    invariant(sameGitState(failed.expected_git_state, git), "GIT_STATE_MISMATCH", "recovery source differs from failed handoff Git state");
    const latch = this.storage.getLatch(failed.task_id);
    invariant(latch?.state === "ENGAGED" && latch.generation === failed.latch_generation, "LATCH_GENERATION_MISMATCH");
    invariant(latch.reason !== "HUMAN_TAKEOVER", "HUMAN_TAKEOVER_ACTIVE");
    if (expectedLatch) invariant(latch.state === expectedLatch.state && latch.generation === expectedLatch.generation && latch.reason === expectedLatch.reason,
      "LATCH_GENERATION_MISMATCH", "Recovery latch changed after initial validation");
    if (safe) invariant(safe.latch.state === latch.state && safe.latch.generation === latch.generation && safe.latch.reason === latch.reason,
      "LATCH_GENERATION_MISMATCH", "SafePoint result no longer matches the canonical recovery latch");
    const binding = this.storage.getRunnerSessionBinding(failedHandoffId);
    invariant(binding?.status === "ACTIVE"
      && binding.replacement_session_id === failed.target_session_id
      && binding.runner_instance_id === failed.runner_instance_id
      && binding.session_binding_id === failed.session_binding_id,
    "CONTINUITY_RECOVERY_SOURCE_INVALID", "failed target binding is not active and coherent");
    const planSnapshot = captureReservedPlanSnapshot(plan);
    return deepFreeze(structuredClone({
      schema: "aiopago.internal-recovery-attestation/1",
      failedHandoff: failed,
      failedBinding: {
        status: binding.status,
        replacement_session_id: binding.replacement_session_id,
        runner_instance_id: binding.runner_instance_id,
        session_binding_id: binding.session_binding_id,
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
      model_policy: failed.model_policy,
      reasoning_policy: failed.reasoning_policy,
      git,
      checkpoint: { id: checkpoint.id, digest: checkpoint.digest, content_digest: checkpoint.content_digest },
      manifest: { id: manifest.id, digest: manifest.digest, content_digest: manifest.content_digest },
      latch: { task_id: failed.task_id, state: latch.state, generation: latch.generation, reason: latch.reason },
      safe_operations: safe?.operations ?? [],
    }));
  }

  async handoff({ sourceSession, currentSourceVerifier = null, expectedEligibility = null, replacePaused, mode = "manual", actor = "human:command", confirmResume = async () => false, sendResume, recoveryOf = null }) {
    invariant(["manual", "confirm"].includes(mode), "HANDOFF_MODE_INVALID");
    const guided = expectedEligibility !== null;
    if (guided) assertGuidedHandoffEligibilityIdentity(expectedEligibility);
    const sourceFile = normalizePath(sourceSession?.sessionFile);
    invariant(sourceFile, "PERSISTED_SOURCE_SESSION_REQUIRED");
    const sourceSessionId = sourceSession.sessionId;
    this.verifyCurrentSource(sourceSession, currentSourceVerifier, { required: guided });
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
    const parentHandoff = this.storage.findHandoffByTarget(sourceSessionId);
    const recoveryParent = recoveryOf === null ? null : this.storage.getHandoff(recoveryOf);
    const expectedHandoff = guided ? expectedEligibility.handoff : handoffConsentIdentity(this.storage.latestHandoffForTask(plan.task_id));
    assertHandoffConsentIdentity(this.storage.latestHandoffForTask(plan.task_id), expectedHandoff);
    const observedLatch = this.storage.getLatch(plan.task_id);
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
    this.storage.assertLatchIdentity(plan.task_id, expectedLatch);

    if (recoveryOf === null) {
      const pending = this.storage.pendingContinuityFailureForTask(plan.task_id);
      invariant(!pending, "CONTINUITY_RECOVERY_REQUIRED", pending ? `Use /aio handoff recover ${pending.handoff_id}` : undefined);
      invariant(parentHandoff?.state !== "CONTINUITY_FAILED", "CONTINUITY_RECOVERY_REQUIRED", parentHandoff ? `Use /aio handoff recover ${parentHandoff.handoff_id}` : undefined);
    } else {
      this.storage.assertContinuityRecoveryPrepared(recoveryOf, { sourceSessionId, runnerInstanceId: this.runnerInstanceId });
    }
    if (mode === "confirm" && recoveryOf === null) {
      await this.testHooks?.beforeOwnerGate?.({ plan, sourceSession, expected: ownerGateExpected });
      plan = this.ledger.satisfyOwnerGate({ command: "/aio handoff confirm", actor, expected: ownerGateExpected });
      await this.testHooks?.afterOwnerGate?.({ plan, sourceSession, expected: ownerGateExpected });
    }
    plan = captureReservedPlanSnapshot(plan);
    const trustedPlanIdentity = Object.freeze({
      taskId: plan.task_id,
      planRevisionId: plan.plan_revision_id,
      contentDigest: plan.content_digest,
    });
    this.assertModelPolicy(plan, sourceSession);
    const safePointReason = expectedLatch.state === "ENGAGED" ? expectedLatch.reason : "INTEGRITY";
    invariant(typeof safePointReason === "string" && safePointReason !== "HUMAN_TAKEOVER", "HUMAN_TAKEOVER_ACTIVE");
    const safe = await this.safePoint.request(sourceSession, actor, safePointReason, { expectedLatch });
    await this.testHooks?.afterSafePoint?.({ safe, plan, sourceSession });
    const git = this.observeGit();

    this.verifyCurrentSource(sourceSession, currentSourceVerifier, { required: guided });
    assertHandoffConsentIdentity(this.storage.latestHandoffForTask(plan.task_id), expectedHandoff);
    this.storage.assertLatchIdentity(plan.task_id, safe.latch);
    const base = this.#buildHandoffReservation({
      sourceSession, plan, safe, git, recoveryOf, recoveryParent: recoveryParent ?? parentHandoff,
    });
    const handoffId = base.handoff_id;
    const checkpointId = base.checkpoint_id;
    const reserved = reserveTrustedHandoffPlan(this.ledger, {
      expected: trustedPlanIdentity,
      storage: this.storage,
      projection: base,
      precondition: { latch: safe.latch, expectedHandoff },
    });
    return this.#continueReservedHandoff({ reserved, sourceSession, plan, safe, replacePaused, mode, actor, confirmResume, sendResume });
  }

  async #continueReservedHandoff({ reserved, sourceSession, plan, safe, replacePaused, mode, actor, confirmResume, sendResume }) {
    let handoff = reserved.handoff;
    if (!reserved.created) return this.resumeExisting(handoff, { mode, actor, confirmResume, sendResume });
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
    this.storage.saveHandoff(handoff, "STATE_TRANSITION", { from: "SAFE_TO_HANDOFF", to: handoff.state });
    try {
      const checkpoint = this.artifacts.persist("checkpoint", checkpointId, this.buildCheckpoint(handoff, plan, safe.operations));
      handoff.checkpoint_digest = checkpoint.digest;
      handoff.state = "CHECKPOINT_PERSISTED";
      this.storage.saveHandoff(handoff, "CHECKPOINT_PERSISTED", { checkpoint_id: checkpointId, digest: checkpoint.digest, event_key: `checkpoint:${checkpointId}` });
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
      this.storage.saveHandoff(handoff, "CHECKPOINT_PERSIST_FAILED", { error: error.message, event_key: `checkpoint-failed:${checkpointId}` });
      throw error;
    }

    await this.testHooks?.beforeReplacement?.({ handoff: this.storage.getHandoff(handoffId), safe, plan, sourceSession });
    try {
      this.storage.assertLatchIdentity(plan.task_id, safe.latch);
    } catch (error) {
      handoff = this.storage.getHandoff(handoffId);
      handoff.state = "HANDOFF_FAILED";
      handoff.failure = { code: error.code ?? "LATCH_GENERATION_MISMATCH", message: error.message };
      handoff.manual_recovery = [
        "Human control changed after durable handoff reservation; no replacement session was created.",
        `Inspect /aio status and reconcile handoff ${handoffId}; do not retry automatically.`,
      ];
      this.storage.saveHandoff(handoff, "HANDOFF_FAILED", { code: handoff.failure.code, error: handoff.failure.message, event_key: `handoff-failed:${handoffId}` });
      throw error;
    }

    handoff.state = "REPLACEMENT_SESSION_CREATING";
    this.storage.saveHandoff(handoff, "REPLACEMENT_SESSION_CREATE_INTENT", { parent_session_file: sourceFile, event_key: `replacement-intent:${handoffId}` });
    let replacementResult;
    try {
      this.storage.assertLatchIdentity(plan.task_id, safe.latch);
      const expectedBinding = {
        schema_version: "1.0.0",
        handoff_id: handoffId,
        runner_instance_id: handoff.runner_instance_id,
        session_binding_id: handoff.session_binding_id,
      };
      replacementResult = await replacePaused(sourceFile, expectedBinding, async (target) => this.finishPausedHandoff(handoffId, target, { mode, actor, confirmResume, sendResume }));
    } catch (error) {
      handoff = this.storage.getHandoff(handoffId);
      if (handoff.target_session_id) throw error;
      this.storage.supersedeRunnerSessionBinding(handoffId, "replacement creation failed before target registration");
      handoff.state = "HANDOFF_FAILED";
      if (["HUMAN_TAKEOVER_ACTIVE", "LATCH_GENERATION_MISMATCH"].includes(error?.code)) {
        handoff.failure = { code: error.code, message: error.message };
        handoff.manual_recovery = [
          "Human control changed before replacement creation; no replacement session was created.",
          `Inspect /aio status and reconcile handoff ${handoffId}; do not retry automatically.`,
        ];
        this.storage.saveHandoff(handoff, "HANDOFF_FAILED", { code: error.code, error: error.message, manual_recovery: handoff.manual_recovery, event_key: `handoff-failed:${handoffId}` });
        throw error;
      }
      handoff.failure = { code: "REPLACEMENT_SESSION_CREATE_UNKNOWN", message: error.message };
      handoff.manual_recovery = this.buildManualRecovery(handoff, "Replacement creation outcome is ambiguous");
      this.storage.saveHandoff(handoff, "HANDOFF_FAILED", { error: error.message, manual_recovery: handoff.manual_recovery, event_key: `handoff-failed:${handoffId}` });
      throw new GuardianError("HANDOFF_FAILED", handoff.manual_recovery.join("\n"), { cause: error.message, instructions: handoff.manual_recovery });
    }
    if (replacementResult?.cancelled) {
      handoff = this.storage.getHandoff(handoffId);
      handoff.state = "HANDOFF_FAILED";
      handoff.failure = { code: "REPLACEMENT_SESSION_CANCELLED", message: "Pi cancelled replacement creation before a target was registered" };
      handoff.manual_recovery = this.buildManualRecovery(handoff, handoff.failure.message);
      this.storage.saveHandoff(handoff, "HANDOFF_FAILED", { error: handoff.failure.message, manual_recovery: handoff.manual_recovery, event_key: `handoff-failed:${handoffId}` });
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
    this.storage.saveHandoff(h, "REPLACEMENT_SESSION_CREATED_PAUSED", { target_session_id: h.target_session_id, target_session_file: h.target_session_file, event_key: `replacement:${handoffId}` });
    this.metric("REPLACEMENT_STARTED", {
      handoff: h,
      session_id: h.target_session_id,
      checkpoint_id: h.checkpoint_id,
      reason: "PAUSED_NO_HISTORY_TARGET_CREATED",
    });

    try {
      const runtimeBinding = readRuntimeRunnerBinding(session);
      invariant(runtimeBinding.handoff_id === h.handoff_id && runtimeBinding.runner_instance_id === h.runner_instance_id && runtimeBinding.session_binding_id === h.session_binding_id, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "replacement setup binding");
      this.storage.bindRunnerSession(handoffId, runtimeBinding);
    } catch (error) {
      h = this.storage.getHandoff(handoffId);
      h.state = "RUNNER_OWNERSHIP_ATTESTATION_FAILED";
      this.storage.saveHandoff(h, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", { error: error.message });
      throw error;
    }

    h = this.storage.getHandoff(handoffId);
    h.resume_prompt_id = stableId("RP", h.handoff_id, h.checkpoint_digest, h.task_plan_revision, h.requirements_version);
    h.state = "MANIFEST_PERSISTING";
    this.storage.saveHandoff(h, "STATE_TRANSITION", { from: "REPLACEMENT_SESSION_CREATED_PAUSED", to: h.state });
    try {
      const plan = captureReservedPlanSnapshot(h.reserved_plan_snapshot);
      const checkpoint = this.artifacts.verify("checkpoint", h.checkpoint_id, h.checkpoint_digest);
      assertCheckpointPlanConsistency(h, plan, checkpoint.payload);
      await this.testHooks?.beforeManifest?.({ handoff: h, plan, checkpoint: checkpoint.payload, target });
      const manifest = this.artifacts.persist("manifest", h.resume_manifest_id, this.buildManifest(h, plan));
      h.resume_manifest_digest = manifest.digest;
      h.state = "MANIFEST_PERSISTED";
      this.storage.saveHandoff(h, "MANIFEST_PERSISTED", { manifest_id: h.resume_manifest_id, digest: manifest.digest, event_key: `manifest:${h.resume_manifest_id}` });
    } catch (error) {
      h.state = "MANIFEST_PERSIST_FAILED";
      this.storage.saveHandoff(h, "MANIFEST_PERSIST_FAILED", { error: error.message, event_key: `manifest-failed:${h.resume_manifest_id}` });
      throw error;
    }

    try { h = this.continuity(handoffId, session); }
    catch (error) {
      h = this.storage.getHandoff(handoffId);
      h.state = "CONTINUITY_FAILED";
      h.failure = { code: error.code ?? "CONTINUITY_FAILED", message: error.message };
      this.storage.saveHandoff(h, "CONTINUITY_FAILED", { code: h.failure.code, error: error.message });
      throw error;
    }
    target.setEditor?.(h.resume_prompt);
    if (options.mode === "confirm") {
      const confirmed = await options.confirmResume(target, h);
      if (confirmed) return this.resume(handoffId, { actor: options.actor, sendResume: options.sendResume ?? target.sendResume });
    }
    return h;
  }

  async recoverContinuityFailure({ failedHandoffId, sourceSession, currentSourceVerifier = null, sourceAttestation, replacePaused, actor = "human:/aio-handoff-recover", confirmResume = async () => false, sendResume }) {
    const failed = this.storage.getHandoff(failedHandoffId);
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
    const safe = await this.safePoint.request(sourceSession, actor, initial.latch.reason, { expectedLatch: initial.latch });

    // SafePoint is only an asynchronous drain. The single final R* capture and
    // prepare+child reservation below run synchronously while compliant plan
    // writers are excluded by the package-private PlanRevisionWriter lock.
    const prepared = prepareTrustedContinuityRecovery(this.ledger, {
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
        return {
          failedHandoffId,
          preparation: {
            sourceSessionId: attestation.source.session_id,
            runnerInstanceId: attestation.source.runner_instance_id,
            actor,
            expectedFailed: attestation.failedHandoff,
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
    });
  }

  verifyRecoveryEvidence(failed, checkpoint, manifest) {
    invariant(["1.0.0", "1.1.0"].includes(manifest.manifest_version), "MANIFEST_MISMATCH", "unsupported recovery evidence manifest version");
    invariant(checkpoint.checkpoint_id === failed.checkpoint_id
      && checkpoint.task_id === failed.task_id
      && checkpoint.plan_revision_id === failed.task_plan_revision
      && checkpoint.plan_content_digest === failed.task_plan_digest
      && checkpoint.requirements_version === failed.requirements_version
      && JSON.stringify(checkpoint.session_lineage) === JSON.stringify([failed.source_session_id]),
    "CHECKPOINT_MISMATCH", "recovery provenance");
    invariant(manifest.resume_manifest_id === failed.resume_manifest_id && manifest.handoff_id === failed.handoff_id && manifest.resume_prompt_id === failed.resume_prompt_id, "MANIFEST_MISMATCH", "recovery identity");
    invariant(manifest.checkpoint_id === failed.checkpoint_id && manifest.checkpoint_digest === failed.checkpoint_digest && manifest.task_id === failed.task_id, "MANIFEST_MISMATCH", "recovery checkpoint/task provenance");
    invariant(manifest.source_session_id === failed.source_session_id && manifest.replacement_session_id === failed.target_session_id && manifest.parent_session_id === failed.source_session_id, "MANIFEST_MISMATCH", "recovery session provenance");
    invariant(manifest.runner_instance_id === failed.runner_instance_id && manifest.session_binding_id === failed.session_binding_id, "MANIFEST_MISMATCH", "recovery binding provenance");
    invariant(manifest.task_plan_revision === failed.task_plan_revision
      && manifest.task_plan_digest === failed.task_plan_digest
      && manifest.requirements_version === failed.requirements_version
      && manifest.current_item === failed.current_item
      && manifest.next_item === failed.next_item
      && manifest.next_step === failed.next_step
      && manifest.model_policy === failed.model_policy
      && manifest.reasoning_policy === failed.reasoning_policy,
    "MANIFEST_MISMATCH", "recovery plan/model provenance");
  }

  continuity(handoffId, targetSession) {
    const continuityStarted = performance.now();
    let h = this.storage.getHandoff(handoffId);
    invariant(["MANIFEST_PERSISTED", "RESUME_READY"].includes(h.state), "CONTINUITY_STATE_INVALID", h.state);
    const checkpoint = this.artifacts.verify("checkpoint", h.checkpoint_id, h.checkpoint_digest);
    const manifest = this.artifacts.verify("manifest", h.resume_manifest_id, h.resume_manifest_digest);
    const reservedPlan = captureReservedPlanSnapshot(h.reserved_plan_snapshot);
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
    const latch = this.storage.getLatch(h.task_id);
    invariant(latch?.state === "ENGAGED" && latch.generation === h.latch_generation, "LATCH_GENERATION_MISMATCH");
    this.assertModelPolicy(plan, targetSession);
    h.resume_prompt = this.buildPrompt(h, m);
    h.resume_prompt_digest = sha256(Buffer.from(h.resume_prompt, "utf8"));
    h.state = "RESUME_READY";
    this.storage.saveHandoff(h, "CONTINUITY_VALIDATED", { manifest_digest: h.resume_manifest_digest, resume_prompt_digest: h.resume_prompt_digest });
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
      journalBinding: this.storage.getRunnerSessionBinding(h.handoff_id),
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

  async resume(handoffId, { actor = "human:resume", sendResume }) {
    let h = this.storage.getHandoff(handoffId);
    invariant(h, "HANDOFF_NOT_FOUND");
    if (h.state === "RESUMED") return h;
    if (h.state === "CONTINUITY_FAILED") throw new GuardianError("CONTINUITY_RECOVERY_REQUIRED", `Use /aio handoff recover ${h.handoff_id}`);
    if (h.state === "RESUME_DISPATCH_UNKNOWN" || h.dispatch_state === "UNKNOWN") throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Automatic redispatch is forbidden");
    invariant(typeof sendResume === "function", "RESUME_TRANSPORT_REQUIRED");
    const resumeStarted = performance.now();
    this.metric("RESUME_STARTED", {
      handoff: h,
      session_id: h.target_session_id,
      checkpoint_id: h.checkpoint_id,
      reason: "HUMAN_RESUME_AUTHORIZED",
    });
    const admissionId = stableId("ADM", h.resume_prompt_id);
    const admission = this.storage.authorizeAndAdmit(handoffId, actor, `resume:${h.resume_prompt_id}`, admissionId);
    h = admission.handoff;
    const attemptId = stableId("DSP", admissionId, "1");
    const dispatch = this.storage.beginDispatch(handoffId, attemptId, 1);
    if (dispatch.idempotent) {
      const state = dispatch.attempt.state;
      if (state === "ACKNOWLEDGED") return this.storage.getHandoff(handoffId);
      this.storage.finishDispatch(handoffId, "UNKNOWN", "reload/retry after durable dispatch intent");
      throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Durable dispatch intent has no safe replay");
    }
    try {
      await sendResume(h.resume_prompt);
      const completed = this.storage.finishDispatch(handoffId, "ACKNOWLEDGED");
      this.metric("COMPLETED", {
        handoff: completed,
        session_id: completed.target_session_id,
        checkpoint_id: completed.checkpoint_id,
        reason: "RESUME_ACKNOWLEDGED",
        resume_duration_ms: performance.now() - resumeStarted,
      });
      return completed;
    } catch (error) {
      this.storage.finishDispatch(handoffId, "UNKNOWN", error.message);
      throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Resume might have been accepted; no automatic retry", { cause: error.message });
    }
  }

  async resumeExisting(h, options) {
    if (h.state === "RESUMED") return h;
    if (h.state === "RESUME_READY" || h.admission_state === "COMMITTED") {
      if (options.mode === "confirm" && await options.confirmResume(null, h)) return this.resume(h.handoff_id, options);
      return h;
    }
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
