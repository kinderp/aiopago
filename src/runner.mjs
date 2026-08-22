import { join, resolve } from "node:path";
import { ArtifactStore } from "./artifact-store.mjs";
import { verifyCalibrationRuntimeState } from "./calibration-preflight.mjs";
import { opaqueId, stableId } from "./canonical.mjs";
import { ContextHandoffAdvisor, contextHandoffThresholdEnvironment } from "./context-advisor.mjs";
import { createGuardianExtension } from "./extension.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { observeGitState } from "./git-state.mjs";
import { assertGuidedHandoffEligibilityIdentity } from "./handoff-consent.mjs";
import { HandoffService } from "./handoff.mjs";
import { TaskLedger } from "./ledger.mjs";
import { MeasurementInstrumentation } from "./metrics.mjs";
import { installRunnerSessionBinding } from "./runner-ownership.mjs";
import { loadPi } from "./pi-loader.mjs";
import { AdmissionGate, SafePointCoordinator, ToolOperationTracker } from "./safety.mjs";
import { GuardianStorage } from "./storage.mjs";

export const DEFAULT_PORTABLE_TOOLS = Object.freeze(["read", "edit", "write", "grep", "find", "ls", "bash"]);

export class GuardianRunner {
  static async create(options = {}) {
    const repository = options.repository ?? null;
    const requestedRoot = repository?.targetRoot ?? options.cwd;
    invariant(requestedRoot, "REPOSITORY_CONTEXT_REQUIRED", "Pass a validated repository context (or an explicit cwd for internal runners)");
    const cwd = resolve(requestedRoot);
    const pi = options.pi ?? await loadPi({ searchRoot: cwd });
    const ledger = options.ledger ?? new TaskLedger(options.ledgerPath ?? repository?.taskLedgerPath ?? join(cwd, "TASK_PLAN.md"));
    const plan = ledger.read();
    const storage = options.storage ?? new GuardianStorage(options.storagePath ?? join(repository?.runtimeRoot ?? join(cwd, ".guardian", "runtime"), "guardian.sqlite"));
    if (options.calibration) storage.bindCalibrationRuntimeIdentity(options.calibration.runtimeIdentity, { allowExisting: options.calibration.resume === true });
    storage.ensureLatch(plan.task_id);
    const artifacts = options.artifacts ?? new ArtifactStore(options.artifactRoot ?? repository?.artifactRoot ?? join(cwd, ".guardian"), storage);
    const modelRuntime = options.modelRuntime ?? await pi.coding.ModelRuntime.create();
    const gate = new AdmissionGate(storage, plan.task_id);
    gate.install(modelRuntime);
    const modelPolicy = options.modelPolicy ?? plan.model_policy ?? null;
    const [policyProvider, policyModel] = modelPolicy?.split("/") ?? [];
    const model = options.model ?? (policyProvider && policyModel ? modelRuntime.getModel(policyProvider, policyModel) : undefined);
    const reasoningPolicy = options.reasoningPolicy ?? plan.reasoning_policy ?? "high";
    if (!options.allowMissingModel && modelPolicy) invariant(model, "MODEL_POLICY_UNAVAILABLE", modelPolicy);
    const settingsManager = options.settingsManager ?? pi.coding.SettingsManager.create(cwd, options.agentDir);
    settingsManager.applyOverrides({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const environmentThreshold = contextHandoffThresholdEnvironment(options.processEnv ?? process.env, { warn: options.environmentWarning });
    const contextAdvisor = options.contextAdvisor ?? new ContextHandoffAdvisor({
      thresholdPercent: options.contextHandoffThresholdPercent ?? environmentThreshold,
    });
    const runnerInstanceId = options.runnerInstanceId ?? opaqueId("RUNNER");
    const roots = Object.freeze({
      installationRoot: repository?.installationRoot ?? null,
      targetRoot: cwd,
      configRoot: repository?.configRoot ?? join(cwd, ".guardian"),
      runtimeRoot: repository?.runtimeRoot ?? join(cwd, ".guardian", "runtime"),
      artifactRoot: repository?.artifactRoot ?? join(cwd, ".guardian"),
    });
    const runner = new GuardianRunner({ cwd, roots, repository, pi, ledger, storage, artifacts, modelRuntime, gate, model, reasoningPolicy, settingsManager, contextAdvisor, runnerInstanceId, confirmMode: options.confirmMode ?? "confirm-or-manual", calibration: options.calibration ?? null, tools: options.tools ?? DEFAULT_PORTABLE_TOOLS });
    runner.metrics = options.metrics ?? new MeasurementInstrumentation({
      storage,
      ledger,
      runnerInstanceId,
      thresholdPercent: contextAdvisor.thresholdPercent,
      retention: options.metricsRetention,
    });
    runner.toolTracker = new ToolOperationTracker(storage, plan.task_id);
    runner.safePoint = new SafePointCoordinator({ storage, taskId: plan.task_id, gate });
    runner.handoffService = new HandoffService({
      storage,
      artifacts,
      ledger,
      observeGit: options.observeGit ?? (() => observeGitState(cwd)),
      safePoint: runner.safePoint,
      runnerInstanceId,
      modelPolicy,
      reasoningPolicy,
      telemetry: runner.metrics,
    });
    await runner.createRuntime(options);
    if (!modelPolicy) {
      const selected = runner.runtime.session.model;
      invariant(selected?.provider && selected?.id, "MODEL_POLICY_UNAVAILABLE", "Pi did not select a model");
      runner.handoffService.modelPolicy = `${selected.provider}/${selected.id}`;
    }
    if (runner.calibration) {
      runner.requireCalibrationRuntime();
      gate.setPreflightVerifier((requestModel) => runner.requireCalibrationRuntime(requestModel));
    }
    return runner;
  }

  constructor(fields) {
    Object.assign(this, fields);
    this.replacementPermit = 0;
    this.runtime = null;
    this.sessionLifecycleEpoch = 0;
    this.sessionLifecycle = null;
  }

  async createRuntime(options) {
    const { coding } = this.pi;
    const inline = { name: "aiopago", factory: createGuardianExtension(this) };
    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await coding.createAgentSessionServices({
        cwd,
        agentDir: options.agentDir,
        settingsManager: this.settingsManager,
        modelRuntime: this.modelRuntime,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          extensionFactories: [inline],
        },
      });
      return {
        ...(await coding.createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: this.model,
          thinkingLevel: this.reasoningPolicy,
          tools: this.tools,
          noTools: options.noTools,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    const sessionManager = options.sessionManager ?? coding.SessionManager.create(this.cwd, options.sessionDir);
    this.runtime = await coding.createAgentSessionRuntime(createRuntime, {
      cwd: this.cwd,
      agentDir: options.agentDir ?? coding.getAgentDir(),
      sessionManager,
    });
    this.ensureCurrentSessionLifecycle(this.runtime.session);
    this.recoverySourceSession = this.runtime.session;
  }

  lifecycleSessionId(ctx = null) {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id.length > 0) return id;
    } catch {}
    const current = this.runtime?.session?.sessionId;
    return typeof current === "string" && current.length > 0 ? current : null;
  }

  ensureCurrentSessionLifecycle(session) {
    invariant(session?.sessionId, "HANDOFF_SOURCE_CHANGED", "The Runner has no current source session");
    if (this.sessionLifecycle === null) {
      this.sessionLifecycleEpoch += 1;
      this.sessionLifecycle = Object.freeze({ sessionId: session.sessionId, epoch: this.sessionLifecycleEpoch, active: true });
    }
    invariant(this.sessionLifecycle.sessionId === session.sessionId && this.sessionLifecycle.active,
      "HANDOFF_SOURCE_CHANGED", "The current Runner session lifecycle is not ACTIVE");
    return this.sessionLifecycle;
  }

  noteSessionStart(_event, ctx = null) {
    const sessionId = this.lifecycleSessionId(ctx);
    if (!sessionId) return null;
    if (this.sessionLifecycle?.sessionId === sessionId && this.sessionLifecycle.active) return this.sessionLifecycle;
    this.sessionLifecycleEpoch += 1;
    this.sessionLifecycle = Object.freeze({ sessionId, epoch: this.sessionLifecycleEpoch, active: true });
    return this.sessionLifecycle;
  }

  noteSessionShutdown(_event, ctx = null) {
    const sessionId = this.lifecycleSessionId(ctx);
    if (!sessionId || (this.sessionLifecycle && this.sessionLifecycle.sessionId !== sessionId)) return false;
    this.sessionLifecycleEpoch += 1;
    this.sessionLifecycle = Object.freeze({ sessionId, epoch: this.sessionLifecycleEpoch, active: false });
    return true;
  }

  noteCurrentReplacementActive(session) {
    invariant(this.runtime?.session === session && session?.sessionId, "HANDOFF_SOURCE_CHANGED", "Replacement lifecycle does not match the current Runner session");
    if (this.sessionLifecycle?.sessionId === session.sessionId && this.sessionLifecycle.active) return this.sessionLifecycle;
    this.sessionLifecycleEpoch += 1;
    this.sessionLifecycle = Object.freeze({ sessionId: session.sessionId, epoch: this.sessionLifecycleEpoch, active: true });
    return this.sessionLifecycle;
  }

  currentRecoverySourceAttestation() {
    const session = this.runtime?.session;
    invariant(session && session === this.recoverySourceSession, "CONTINUITY_RECOVERY_SOURCE_INVALID", "Recovery must start from the fresh session created by the current Runner");
    return Object.freeze({ session_id: session.sessionId, runner_instance_id: this.runnerInstanceId });
  }

  permitReplacement() { this.replacementPermit += 1; }
  revokeReplacementPermit() { this.replacementPermit = Math.max(0, this.replacementPermit - 1); }
  consumeReplacementPermit() {
    if (this.replacementPermit <= 0) return false;
    this.replacementPermit -= 1;
    return true;
  }

  commandTarget(replacementCtx) {
    const session = this.runtime.session;
    this.noteCurrentReplacementActive(session);
    return {
      session,
      setEditor: (text) => replacementCtx.ui.setEditorText(text),
      confirm: (h) => replacementCtx.ui.confirm("Aiopago resume", `Continuity passed for ${h.handoff_id}. Authorize the single resume admission?`),
      sendResume: (prompt) => replacementCtx.sendUserMessage(prompt),
      notify: (text, type = "info") => replacementCtx.ui.notify(text, type),
    };
  }

  requireCalibrationRuntime(requestModel = null) {
    if (!this.calibration) return null;
    return verifyCalibrationRuntimeState({ runner: this, attestationPath: this.calibration.attestationPath, requestModel });
  }

  captureTrustedSource(expectedEligibility = null) {
    const sourceSession = this.runtime?.session;
    invariant(sourceSession?.sessionId, "HANDOFF_SOURCE_CHANGED", "The Runner has no current source session");
    const lifecycle = this.ensureCurrentSessionLifecycle(sourceSession);
    if (expectedEligibility !== null) {
      assertGuidedHandoffEligibilityIdentity(expectedEligibility);
      invariant(expectedEligibility.runnerInstanceId === this.runnerInstanceId, "HANDOFF_RUNNER_CHANGED", "Guided consent belongs to a different Runner instance");
      invariant(expectedEligibility.sessionId === sourceSession.sessionId, "HANDOFF_SOURCE_CHANGED", "Guided consent belongs to a different source session");
    }
    const sourceSessionId = sourceSession.sessionId;
    const runnerInstanceId = this.runnerInstanceId;
    const lifecycleEpoch = lifecycle.epoch;
    const verifyCurrentSource = () => {
      invariant(this.runnerInstanceId === runnerInstanceId, "HANDOFF_RUNNER_CHANGED", "Runner identity changed before handoff reservation");
      invariant(this.runtime?.session === sourceSession && this.runtime.session.sessionId === sourceSessionId,
        "HANDOFF_SOURCE_CHANGED", "Runner source session changed before handoff reservation");
      invariant(this.sessionLifecycle?.active === true
        && this.sessionLifecycle.sessionId === sourceSessionId
        && this.sessionLifecycle.epoch === lifecycleEpoch,
      "HANDOFF_SOURCE_CHANGED", "Runner source session lifecycle changed or is no longer ACTIVE");
      return Object.freeze({ sessionId: sourceSessionId, runnerInstanceId, lifecycleEpoch, active: true });
    };
    verifyCurrentSource();
    return Object.freeze({ sourceSession, verifyCurrentSource });
  }

  async handoffFromCommand(ctx, mode, options = {}) {
    invariant(["manual", "confirm"].includes(mode), "HANDOFF_MODE_INVALID");
    if (this.confirmMode === "confirm") invariant(mode === "confirm", "CALIBRATION_CONFIRM_MODE_REQUIRED");
    const guided = options.intent === "guided-advisor";
    invariant(guided || options.intent === undefined || options.intent === "explicit-command", "HANDOFF_INTENT_INVALID");
    invariant(!guided || options.expectedEligibility !== undefined, "HANDOFF_CONSENT_REQUIRED", "Guided advisor handoff requires its approved eligibility identity");
    const expectedEligibility = guided ? options.expectedEligibility : null;
    const trustedSource = this.captureTrustedSource(expectedEligibility);
    return this.handoffService.handoff({
      sourceSession: trustedSource.sourceSession,
      currentSourceVerifier: trustedSource.verifyCurrentSource,
      expectedEligibility,
      mode,
      actor: "human:/aio-handoff",
      replacePaused: async (parentSession, ownership, onPaused) => {
        this.permitReplacement();
        let pausedResult;
        try {
          const result = await ctx.newSession({
            parentSession,
            setup: async (sessionManager) => { installRunnerSessionBinding(sessionManager, ownership); },
            withSession: async (replacementCtx) => {
              const target = this.commandTarget(replacementCtx);
              pausedResult = await onPaused(target);
              target.notify(pausedResult.state === "RESUMED" ? "Aiopago handoff resumed" : `Aiopago target paused: ${pausedResult.handoff_id}`);
            },
          });
          return { ...result, pausedResult };
        } finally { this.revokeReplacementPermit(); }
      },
      confirmResume: async (target, h) => target.confirm(h),
    });
  }

  async recoverHandoffFromCommand(ctx, failedHandoffId) {
    invariant(typeof failedHandoffId === "string" && failedHandoffId.length > 0, "CONTINUITY_RECOVERY_HANDOFF_ID_REQUIRED");
    const trustedSource = this.captureTrustedSource();
    return this.handoffService.recoverContinuityFailure({
      failedHandoffId,
      sourceSession: trustedSource.sourceSession,
      currentSourceVerifier: trustedSource.verifyCurrentSource,
      sourceAttestation: this.currentRecoverySourceAttestation(),
      actor: "human:/aio-handoff-recover",
      replacePaused: async (parentSession, ownership, onPaused) => {
        this.permitReplacement();
        let pausedResult;
        try {
          const result = await ctx.newSession({
            parentSession,
            setup: async (sessionManager) => { installRunnerSessionBinding(sessionManager, ownership); },
            withSession: async (replacementCtx) => {
              const target = this.commandTarget(replacementCtx);
              pausedResult = await onPaused(target);
              target.notify(pausedResult.state === "RESUMED" ? "Aiopago recovered handoff resumed" : `Aiopago recovered target paused: ${pausedResult.handoff_id}`);
            },
          });
          return { ...result, pausedResult };
        } finally { this.revokeReplacementPermit(); }
      },
      confirmResume: async (target, h) => target.confirm(h),
    });
  }

  async takeoverFromCommand(ctx) {
    const result = await this.safePoint.request(this.runtime.session, "human:/aio-takeover", "HUMAN_TAKEOVER");
    ctx.ui.notify(`Aiopago paused at ${result.state}; latch generation=${result.latch_generation}`, "warning");
    return result;
  }

  async resumeFromCommand(ctx, handoffId = undefined) {
    const current = this.runtime.session;
    const h = handoffId ? this.storage.getHandoff(handoffId) : this.storage.findHandoffByTarget(current.sessionId);
    invariant(h, "HANDOFF_NOT_FOUND");
    if (h.state === "RESUME_READY") this.handoffService.continuity(h.handoff_id, current);
    const confirmed = await ctx.ui.confirm("Aiopago resume", `Authorize resume for ${h.handoff_id}?`);
    if (!confirmed) return h;
    const result = await this.handoffService.resume(h.handoff_id, { actor: "human:/aio-resume", sendResume: (prompt) => current.sendUserMessage(prompt) });
    ctx.ui.notify(`Aiopago ${result.state}`, "info");
    return result;
  }

  async handoffDirect({ mode = "confirm", confirm = true } = {}) {
    const trustedSource = this.captureTrustedSource();
    return this.handoffService.handoff({
      sourceSession: trustedSource.sourceSession,
      currentSourceVerifier: trustedSource.verifyCurrentSource,
      mode,
      actor: "human:test-or-host",
      replacePaused: async (parentSession, ownership, onPaused) => {
        this.permitReplacement();
        try {
          const result = await this.runtime.newSession({
            parentSession,
            setup: async (sessionManager) => { installRunnerSessionBinding(sessionManager, ownership); },
          });
          if (result.cancelled) return result;
          this.noteCurrentReplacementActive(this.runtime.session);
          const target = {
            session: this.runtime.session,
            setEditor: () => {},
            confirm: async () => confirm,
            sendResume: (prompt) => this.runtime.session.sendUserMessage(prompt),
          };
          const pausedResult = await onPaused(target);
          return { ...result, pausedResult };
        } finally { this.revokeReplacementPermit(); }
      },
      confirmResume: (target, h) => target.confirm(h),
    });
  }

  async recoverHandoffDirect(failedHandoffId, { confirm = true } = {}) {
    const trustedSource = this.captureTrustedSource();
    return this.handoffService.recoverContinuityFailure({
      failedHandoffId,
      sourceSession: trustedSource.sourceSession,
      currentSourceVerifier: trustedSource.verifyCurrentSource,
      sourceAttestation: this.currentRecoverySourceAttestation(),
      actor: "human:test-or-host-recovery",
      replacePaused: async (parentSession, ownership, onPaused) => {
        this.permitReplacement();
        try {
          const result = await this.runtime.newSession({
            parentSession,
            setup: async (sessionManager) => { installRunnerSessionBinding(sessionManager, ownership); },
          });
          if (result.cancelled) return result;
          this.noteCurrentReplacementActive(this.runtime.session);
          const target = {
            session: this.runtime.session,
            setEditor: () => {},
            confirm: async (handoff) => typeof confirm === "function" ? confirm(handoff, this.runtime.session) : confirm,
            sendResume: (prompt) => this.runtime.session.sendUserMessage(prompt),
          };
          const pausedResult = await onPaused(target);
          return { ...result, pausedResult };
        } finally { this.revokeReplacementPermit(); }
      },
      confirmResume: (target, h) => target.confirm(h),
    });
  }

  async runInteractive() {
    const mode = new this.pi.coding.InteractiveMode(this.runtime, {
      migratedProviders: [],
      modelFallbackMessage: this.runtime.modelFallbackMessage,
      initialImages: [],
      initialMessages: [],
    });
    await mode.run();
  }

  async dispose() {
    if (this.runtime) await this.runtime.dispose();
    await this.settingsManager.flush?.();
    this.storage.close();
  }
}
