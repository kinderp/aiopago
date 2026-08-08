import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256, stableId, utcNow } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { sameGitState } from "./git-state.mjs";

function normalizePath(path) { return path?.replaceAll("\\", "/"); }

export class HandoffService {
  constructor({ storage, artifacts, ledger, observeGit, safePoint, modelPolicy = null, reasoningPolicy = null }) {
    this.storage = storage;
    this.artifacts = artifacts;
    this.ledger = ledger;
    this.observeGit = observeGit;
    this.safePoint = safePoint;
    this.modelPolicy = modelPolicy;
    this.reasoningPolicy = reasoningPolicy;
  }

  async handoff({ sourceSession, replacePaused, mode = "manual", actor = "human:command", confirmResume = async () => false, sendResume }) {
    invariant(["manual", "confirm"].includes(mode), "HANDOFF_MODE_INVALID");
    const plan = this.ledger.read();
    const sourceFile = normalizePath(sourceSession.sessionFile);
    invariant(sourceFile, "PERSISTED_SOURCE_SESSION_REQUIRED");
    const sourceSessionId = sourceSession.sessionId;
    this.assertModelPolicy(plan, sourceSession);
    const safe = await this.safePoint.request(sourceSession, actor);
    const git = this.observeGit();
    const handoffId = stableId("HO", sourceSessionId, plan.plan_revision_id, String(safe.latch_generation));
    const checkpointId = stableId("CP", handoffId, plan.content_digest);
    const parentHandoff = this.storage.findHandoffByTarget(sourceSessionId);
    const createdAt = utcNow();
    const base = {
      handoff_id: handoffId,
      source_session_id: sourceSessionId,
      source_session_file: sourceFile,
      target_session_id: null,
      target_session_file: null,
      parent_session_id: sourceSessionId,
      parent_session_file: sourceFile,
      parent_checkpoint_id: parentHandoff?.checkpoint_id ?? null,
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
      expected_git_state: git,
      model_policy: this.modelPolicy ?? plan.model_policy ?? null,
      reasoning_policy: this.reasoningPolicy ?? plan.reasoning_policy ?? null,
      state: "SAFE_TO_HANDOFF",
      created_at: createdAt,
      updated_at: createdAt,
    };
    const reserved = this.storage.reserveHandoff(base);
    let handoff = reserved.handoff;
    if (!reserved.created) return this.resumeExisting(handoff, { mode, actor, confirmResume, sendResume });

    handoff.state = "CHECKPOINT_PERSISTING";
    this.storage.saveHandoff(handoff, "STATE_TRANSITION", { from: "SAFE_TO_HANDOFF", to: handoff.state });
    try {
      const checkpoint = this.artifacts.persist("checkpoint", checkpointId, this.buildCheckpoint(handoff, plan, safe.operations));
      handoff.checkpoint_digest = checkpoint.digest;
      handoff.state = "CHECKPOINT_PERSISTED";
      this.storage.saveHandoff(handoff, "CHECKPOINT_PERSISTED", { checkpoint_id: checkpointId, digest: checkpoint.digest, event_key: `checkpoint:${checkpointId}` });
    } catch (error) {
      handoff.state = "CHECKPOINT_PERSIST_FAILED";
      this.storage.saveHandoff(handoff, "CHECKPOINT_PERSIST_FAILED", { error: error.message, event_key: `checkpoint-failed:${checkpointId}` });
      throw error;
    }

    handoff.state = "REPLACEMENT_SESSION_CREATING";
    this.storage.saveHandoff(handoff, "REPLACEMENT_SESSION_CREATE_INTENT", { parent_session_file: sourceFile, event_key: `replacement-intent:${handoffId}` });
    let replacementResult;
    try {
      replacementResult = await replacePaused(sourceFile, async (target) => this.finishPausedHandoff(handoffId, target, { mode, actor, confirmResume, sendResume }));
    } catch (error) {
      handoff = this.storage.getHandoff(handoffId);
      if (handoff.target_session_id) throw error;
      handoff.state = "HANDOFF_FAILED";
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

    h = this.storage.getHandoff(handoffId);
    h.resume_prompt_id = stableId("RP", h.handoff_id, h.checkpoint_digest, h.task_plan_revision, h.requirements_version);
    h.state = "MANIFEST_PERSISTING";
    this.storage.saveHandoff(h, "STATE_TRANSITION", { from: "REPLACEMENT_SESSION_CREATED_PAUSED", to: h.state });
    try {
      const manifest = this.artifacts.persist("manifest", h.resume_manifest_id, this.buildManifest(h));
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
      h.state = error.code && error.code !== "ILLEGAL_TRANSITION" ? error.code : "CONTINUITY_FAILED";
      this.storage.saveHandoff(h, "CONTINUITY_FAILED", { code: h.state, error: error.message });
      throw error;
    }
    target.setEditor?.(h.resume_prompt);
    if (options.mode === "confirm") {
      const confirmed = await options.confirmResume(target, h);
      if (confirmed) return this.resume(handoffId, { actor: options.actor, sendResume: options.sendResume ?? target.sendResume });
    }
    return h;
  }

  continuity(handoffId, targetSession) {
    let h = this.storage.getHandoff(handoffId);
    invariant(["MANIFEST_PERSISTED", "RESUME_READY"].includes(h.state), "CONTINUITY_STATE_INVALID", h.state);
    const checkpoint = this.artifacts.verify("checkpoint", h.checkpoint_id, h.checkpoint_digest);
    const manifest = this.artifacts.verify("manifest", h.resume_manifest_id, h.resume_manifest_digest);
    const plan = this.ledger.read();
    const currentGit = this.observeGit();
    const m = manifest.payload;
    const header = targetSession.sessionManager.getHeader();
    const entries = targetSession.sessionManager.getEntries();
    const historyEntries = entries.filter((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type));
    invariant(plan.task_id === h.task_id && m.task_id === h.task_id, "CONTINUITY_FAILED", "task_id");
    invariant(plan.plan_revision_id === h.task_plan_revision && plan.content_digest === h.task_plan_digest && m.task_plan_revision === h.task_plan_revision && m.task_plan_digest === h.task_plan_digest, "PLAN_REVISION_MISMATCH");
    invariant(plan.requirements_version === h.requirements_version && m.requirements_version === h.requirements_version, "REQUIREMENTS_VERSION_MISMATCH");
    invariant(checkpoint.payload.checkpoint_id === h.checkpoint_id && m.checkpoint_id === h.checkpoint_id && m.checkpoint_digest === h.checkpoint_digest, "CHECKPOINT_MISMATCH");
    invariant(sameGitState(checkpoint.payload.git_state, h.expected_git_state), "CHECKPOINT_MISMATCH", "git state");
    invariant(m.resume_manifest_id === h.resume_manifest_id && m.handoff_id === h.handoff_id && m.resume_prompt_id === h.resume_prompt_id, "MANIFEST_MISMATCH");
    invariant(m.source_session_id === h.source_session_id && m.replacement_session_id === h.target_session_id && m.parent_session_id === h.source_session_id, "STALE_HANDOFF");
    invariant(m.repository === h.expected_git_state.repository_id && m.worktree === h.expected_git_state.workdir && m.branch === h.expected_git_state.branch && m.base_sha === h.expected_git_state.base_sha && m.head_sha === h.expected_git_state.head_sha && m.index_digest === h.expected_git_state.index_digest && m.worktree_digest === h.expected_git_state.worktree_digest && JSON.stringify(m.git_status_summary) === JSON.stringify(h.expected_git_state.status_entries), "MANIFEST_MISMATCH", "git state");
    invariant(targetSession.sessionId === h.target_session_id && historyEntries.length === 0 && targetSession.isIdle, "REPLACEMENT_NOT_PAUSED_NO_HISTORY");
    invariant(normalizePath(header.parentSession) === h.parent_session_file, "PARENT_LINEAGE_MISMATCH");
    invariant(sameGitState(h.expected_git_state, currentGit), "GIT_STATE_MISMATCH");
    invariant(m.current_item === plan.current_item && m.next_item === plan.next_item && m.next_step === plan.next_step, "CONTINUITY_FAILED", "current item/next item/next step");
    invariant(m.model_policy === h.model_policy && m.reasoning_policy === h.reasoning_policy, "CONTINUITY_FAILED", "model/reasoning policy");
    const repositoryRoot = dirname(this.ledger.path);
    invariant(m.minimal_reads.every((path) => typeof path === "string" && path.length > 0 && existsSync(resolve(repositoryRoot, path))), "CONTINUITY_FAILED", "minimal reads unavailable");
    const latch = this.storage.getLatch(h.task_id);
    invariant(latch?.state === "ENGAGED" && latch.generation === h.latch_generation, "LATCH_GENERATION_MISMATCH");
    this.assertModelPolicy(plan, targetSession);
    h.resume_prompt = this.buildPrompt(h, m);
    h.resume_prompt_digest = sha256(Buffer.from(h.resume_prompt, "utf8"));
    h.state = "RESUME_READY";
    this.storage.saveHandoff(h, "CONTINUITY_VALIDATED", { manifest_digest: h.resume_manifest_digest, resume_prompt_digest: h.resume_prompt_digest });
    return this.storage.getHandoff(handoffId);
  }

  async resume(handoffId, { actor = "human:resume", sendResume }) {
    let h = this.storage.getHandoff(handoffId);
    invariant(h, "HANDOFF_NOT_FOUND");
    if (h.state === "RESUMED") return h;
    if (h.state === "RESUME_DISPATCH_UNKNOWN" || h.dispatch_state === "UNKNOWN") throw new GuardianError("RESUME_DISPATCH_UNKNOWN", "Automatic redispatch is forbidden");
    invariant(typeof sendResume === "function", "RESUME_TRANSPORT_REQUIRED");
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
      return this.storage.finishDispatch(handoffId, "ACKNOWLEDGED");
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
      `${cause}; Eiopago will not create or prompt a second target automatically.`,
      `1. Preserve checkpoint ${h.checkpoint_id} (${h.checkpoint_digest}) at ${checkpointPath}.`,
      `2. Do not retry handoff ${h.handoff_id} until the Pi session effect has been reconciled by a human.`,
      "3. Inspect Pi sessions for a child whose parentSession equals the recorded source_session_file.",
      "4. If no child exists, start a fresh Eiopago session manually and keep the latch engaged; if one exists, keep it paused and verify lineage before any resume.",
      `5. Use /eio status and retain handoff_id=${h.handoff_id}; RESUME_DISPATCH_UNKNOWN or an unknown target must never be retried blindly.`,
      "The final Resume Context Manifest cannot be sealed until the real replacement_session_id is known.",
    ];
  }

  buildCheckpoint(h, plan, operations) {
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
      requirements_version: h.requirements_version,
      checkpoint_message: "M1-H0 handoff sealed at a Runner-owned safe point",
      created_at: h.created_at,
      producer: { component: "eiopago-runner", version: "0.1.0", actor_type: "guardian" },
      git_state: h.expected_git_state,
      completion_criteria: plan.completion_criteria.map((criterion) => ({ criterion, status: "IN_PROGRESS" })),
      evidence: operations.filter((operation) => operation.effect_reference).map((operation) => ({ kind: "operation_effect", locator: operation.effect_reference, verification_status: "VERIFIED" })),
      usage: null,
      cost: { provider_billing: null, local_estimate: null, currency: null, status: "unknown" },
      risks: [{ code: "PROVIDER_EXECUTION_NOT_EXACTLY_ONCE", status: "OPEN" }],
      next_step: h.next_step,
      status: "PARTIAL",
      checkpoint_spec_id: null,
      changes: [],
      tests: ["npm test", "npm run test:e2e"],
      decisions: ["ADR-0015", "SP-01 REQUIRES_RUNNER", "SP-03 FINISH CURRENT ATOMIC OPERATION", "SP-04 dispatch unknown fail-closed"],
      idempotency_key: `checkpoint:${h.checkpoint_id}`,
    };
  }

  buildManifest(h) {
    return {
      manifest_version: "1.0.0",
      resume_manifest_id: h.resume_manifest_id,
      created_at: h.created_at,
      task_id: h.task_id,
      objective: this.ledger.read().objective,
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
      relevant_decisions: ["docs/adr/0015-m0-boundaries-and-contract-freeze.md"],
      relevant_tests: ["npm test", "npm run test:e2e"],
      evidence_references: ["docs/m1-h0-handoff-mvp.md"],
      risks: ["Provider execution is not exactly-once", "Session create to journal remains a saga boundary"],
      blocks: [],
      minimal_reads: [
        ...this.ledger.read().minimal_reads,
        `.guardian/checkpoints/${h.checkpoint_id}.json`,
        `.guardian/manifests/${h.resume_manifest_id}.json`,
      ],
      model_policy: h.model_policy,
      reasoning_policy: h.reasoning_policy,
      remaining_budget: null,
      handoff_id: h.handoff_id,
      resume_prompt_id: h.resume_prompt_id,
    };
  }

  buildPrompt(h, manifest) {
    return [
      "EIOPAGO_RESUME_V1",
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
      `minimal_reads=${manifest.minimal_reads.join("|")}`,
      "Read only the listed authoritative artifacts. Do not reconstruct state from previous conversation history.",
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
