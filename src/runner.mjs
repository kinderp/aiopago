import { join, resolve } from "node:path";
import { ArtifactStore } from "./artifact-store.mjs";
import { opaqueId, stableId } from "./canonical.mjs";
import { ContextHandoffAdvisor } from "./context-advisor.mjs";
import { createGuardianExtension } from "./extension.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { observeGitState } from "./git-state.mjs";
import { HandoffService } from "./handoff.mjs";
import { TaskLedger } from "./ledger.mjs";
import { MeasurementInstrumentation } from "./metrics.mjs";
import { installRunnerSessionBinding } from "./runner-ownership.mjs";
import { loadPi } from "./pi-loader.mjs";
import { AdmissionGate, SafePointCoordinator, ToolOperationTracker } from "./safety.mjs";
import { GuardianStorage } from "./storage.mjs";

export class GuardianRunner {
  static async create(options = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const pi = options.pi ?? await loadPi();
    const ledger = options.ledger ?? new TaskLedger(options.ledgerPath ?? join(cwd, "TASK_PLAN.md"));
    const plan = ledger.read();
    const storage = options.storage ?? new GuardianStorage(options.storagePath ?? join(cwd, ".guardian", "runtime", "guardian.sqlite"));
    storage.ensureLatch(plan.task_id);
    const artifacts = options.artifacts ?? new ArtifactStore(options.artifactRoot ?? join(cwd, ".guardian"), storage);
    const modelRuntime = options.modelRuntime ?? await pi.coding.ModelRuntime.create();
    const gate = new AdmissionGate(storage, plan.task_id);
    gate.install(modelRuntime);
    const modelPolicy = options.modelPolicy ?? plan.model_policy ?? null;
    const [policyProvider, policyModel] = modelPolicy?.split("/") ?? [];
    const model = options.model ?? (policyProvider && policyModel ? modelRuntime.getModel(policyProvider, policyModel) : undefined);
    const reasoningPolicy = options.reasoningPolicy ?? plan.reasoning_policy ?? "high";
    if (!options.allowMissingModel) invariant(model, "MODEL_POLICY_UNAVAILABLE", modelPolicy);
    const settingsManager = options.settingsManager ?? pi.coding.SettingsManager.create(cwd, options.agentDir);
    settingsManager.applyOverrides({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const contextAdvisor = options.contextAdvisor ?? new ContextHandoffAdvisor({
      thresholdPercent: options.contextHandoffThresholdPercent ?? process.env.EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT,
    });
    const runnerInstanceId = options.runnerInstanceId ?? opaqueId("RUNNER");
    const runner = new GuardianRunner({ cwd, pi, ledger, storage, artifacts, modelRuntime, gate, model, reasoningPolicy, settingsManager, contextAdvisor, runnerInstanceId, tools: options.tools ?? ["read", "edit", "write", "grep", "find", "ls"] });
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
    return runner;
  }

  constructor(fields) {
    Object.assign(this, fields);
    this.replacementPermit = 0;
    this.runtime = null;
  }

  async createRuntime(options) {
    const { coding } = this.pi;
    const inline = { name: "eiopago-m1-h2", factory: createGuardianExtension(this) };
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
      confirm: (h) => replacementCtx.ui.confirm("Eiopago resume", `Continuity passed for ${h.handoff_id}. Authorize the single resume admission?`),
      sendResume: (prompt) => replacementCtx.sendUserMessage(prompt),
      notify: (text, type = "info") => replacementCtx.ui.notify(text, type),
    };
  }

  async handoffFromCommand(ctx, mode) {
    invariant(["manual", "confirm"].includes(mode), "HANDOFF_MODE_INVALID");
    return this.handoffService.handoff({
      sourceSession: this.runtime.session,
      mode,
      actor: "human:/eio-handoff",
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
              target.notify(pausedResult.state === "RESUMED" ? "Eiopago handoff resumed" : `Eiopago target paused: ${pausedResult.handoff_id}`);
            },
          });
          return { ...result, pausedResult };
        } finally { this.revokeReplacementPermit(); }
      },
      confirmResume: async (target, h) => target.confirm(h),
    });
  }

  async takeoverFromCommand(ctx) {
    const result = await this.safePoint.request(this.runtime.session, "human:/eio-takeover", "HUMAN_TAKEOVER");
    ctx.ui.notify(`Eiopago paused at ${result.state}; latch generation=${result.latch_generation}`, "warning");
    return result;
  }

  async resumeFromCommand(ctx, handoffId = undefined) {
    const current = this.runtime.session;
    const h = handoffId ? this.storage.getHandoff(handoffId) : this.storage.findHandoffByTarget(current.sessionId);
    invariant(h, "HANDOFF_NOT_FOUND");
    if (h.state === "RESUME_READY") this.handoffService.continuity(h.handoff_id, current);
    const confirmed = await ctx.ui.confirm("Eiopago resume", `Authorize resume for ${h.handoff_id}?`);
    if (!confirmed) return h;
    const result = await this.handoffService.resume(h.handoff_id, { actor: "human:/eio-resume", sendResume: (prompt) => current.sendUserMessage(prompt) });
    ctx.ui.notify(`Eiopago ${result.state}`, "info");
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
