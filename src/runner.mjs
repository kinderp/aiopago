import { join, resolve } from "node:path";
import { ArtifactStore } from "./artifact-store.mjs";
import { verifyCalibrationRuntimeState } from "./calibration-preflight.mjs";
import { opaqueId, stableId } from "./canonical.mjs";
import { ContextHandoffAdvisor, contextHandoffThresholdEnvironment } from "./context-advisor.mjs";
import { ContextDomainRegistry } from "./context-domain.mjs";
import { ContextSyncCoordinator } from "./context-sync.mjs";
import { createGuardianExtension } from "./extension.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { observeGitState } from "./git-state.mjs";
import { TaskLedger } from "./ledger.mjs";
import { MeasurementInstrumentation } from "./metrics.mjs";
import { ContextAwareHandoffService } from "./multi-model-handoff.mjs";
import { installRunnerSessionBinding } from "./runner-ownership.mjs";
import { loadPi } from "./pi-loader.mjs";
import { installProviderAdapters } from "./provider-adapter.mjs";
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
    const contextDomains = options.contextDomains ?? new ContextDomainRegistry();
    const adapterInstall = await installProviderAdapters(options.providerAdapters ?? [], { modelRuntime, pi, contextDomains });
    // Provider adapters must be present before the transport gate is installed.
    // Otherwise a dynamically-added provider could escape Aiopago's latch/safe-point admission boundary.
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
    const runner = new GuardianRunner({ cwd, roots, repository, pi, ledger, storage, artifacts, modelRuntime, contextDomains, installedProviderAdapters: adapterInstall.installed, gate, model, reasoningPolicy, settingsManager, contextAdvisor, runnerInstanceId, confirmMode: options.confirmMode ?? "confirm-or-manual", calibration: options.calibration ?? null, tools: options.tools ?? DEFAULT_PORTABLE_TOOLS });
    runner.metrics = options.metrics ?? new MeasurementInstrumentation({
      storage,
      ledger,
      runnerInstanceId,
      thresholdPercent: contextAdvisor.thresholdPercent,
      retention: options.metricsRetention,
      contextDomains,
    });
    runner.toolTracker = new ToolOperationTracker(storage, plan.task_id);
    runner.safePoint = new SafePointCoordinator({ storage, taskId: plan.task_id, gate });
    const gitObserver = options.observeGit ?? (() => observeGitState(cwd));
    runner.contextSync = options.contextSync ?? new ContextSyncCoordinator({
      contextDomains,
      ledger,
      observeGit: gitObserver,
      evidenceProvider: options.contextEvidenceProvider,
      hydrationBudget: options.contextHydrationBudget,
      protocolBudget: options.contextProtocolBudget,
    });
    runner.contextCursors = runner.contextSync.cursorBook;
    runner.handoffService = new ContextAwareHandoffService({
      storage,
      artifacts,
      ledger,
      observeGit: gitObserver,
      safePoint: runner.safePoint,
      runnerInstanceId,
      modelPolicy,
      reasoningPolicy,
      telemetry: runner.metrics,
      contextContinuity: runner.contextSync,
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
    this.recoverySourceSession = this.runtime.session;
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

  async handoffFromCommand(ctx, mode) {
    invariant(["manual", "confirm"].includes(mode), "HANDOFF_MODE_INVALID");
    if (this.confirmMode === "confirm") invariant(mode === "confirm", "CALIBRATION_CONFIRM_MODE_REQUIRED");
    return this.handoffService.handoff({
      sourceSession: this.runtime.session,
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
    return this.handoffService.recoverContinuityFailure({
      failedHandoffId,
      sourceSession: this.runtime.session,
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
    return this.handoffService.handoff({
      sourceSession: this.runtime.session,
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
    return this.handoffService.recoverContinuityFailure({
      failedHandoffId,
      sourceSession: this.runtime.session,
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
