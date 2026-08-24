import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ArtifactStore } from "./artifact-store.mjs";
import { verifyCalibrationRuntimeState } from "./calibration-preflight.mjs";
import { opaqueId, stableId } from "./canonical.mjs";
import { ContextHandoffAdvisor, contextHandoffThresholdEnvironment } from "./context-advisor.mjs";
import { createGuardianExtension } from "./extension.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { observeGitState } from "./git-state.mjs";
import { assertGuidedHandoffEligibilityIdentity, registerTrustedCurrentSourceVerifier } from "./handoff-consent.mjs";
import { HandoffService } from "./handoff.mjs";
import { claimTrustedHumanTakeoverCurrentPlan } from "./handoff-plan-internal.mjs";
import { TaskLedger } from "./ledger.mjs";
import { MeasurementInstrumentation } from "./metrics.mjs";
import { installRunnerSessionBinding } from "./runner-ownership.mjs";
import { loadPi } from "./pi-loader.mjs";
import { AdmissionGate, SafePointCoordinator, ToolOperationTracker } from "./safety.mjs";
import { GuardianStorage } from "./storage.mjs";

export const DEFAULT_PORTABLE_TOOLS = Object.freeze(["read", "edit", "write", "grep", "find", "ls", "bash"]);

// A public Runner is an observation/control entrypoint, not an object-graph
// capability container. Mutable runtime authorities stay in this lexical
// registry. The Pi extension receives a closure-backed trusted facade; ordinary
// consumers receive only detached read projections and guarded methods.
const runnerInternals = new WeakMap();
const trustedRunnerFacades = new WeakMap();
const RUNNER_INTERNAL_AUTHORITY = Object.freeze({});
const TRUSTED_RUNNER_AUTHORITY_INDEX = new Map(Object.entries({
  createRuntime: 1,
  ensureCurrentSessionLifecycle: 1,
  noteSessionStart: 2,
  noteSessionShutdown: 2,
  noteCurrentReplacementActive: 1,
  verifyCurrentTarget: 1,
  currentRecoverySourceAttestation: 0,
  permitReplacement: 0,
  revokeReplacementPermit: 0,
  consumeReplacementPermit: 0,
  commandTarget: 1,
  requireCalibrationRuntime: 1,
  captureTrustedSource: 1,
  handoffFromCommand: 3,
  recoverHandoffFromCommand: 2,
  takeoverFromCommand: 1,
  resumeFromCommand: 2,
  handoffDirect: 1,
  recoverHandoffDirect: 2,
}));

function deepFreezeProjection(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeProjection(child);
  return Object.freeze(value);
}

function detached(value) {
  return value === null || value === undefined ? value : deepFreezeProjection(structuredClone(value));
}

const ledgerReadFacades = new WeakMap();
function ledgerReadFacade(ledger) {
  if (!ledger) return null;
  let facade = ledgerReadFacades.get(ledger);
  if (facade) return facade;
  facade = Object.freeze(Object.assign(Object.create(null), {
    path: ledger.path,
    read: () => detached(ledger.read()),
    validate: (task) => detached(ledger.validate(structuredClone(task))),
  }));
  ledgerReadFacades.set(ledger, facade);
  return facade;
}

const storageReadFacades = new WeakMap();
function storageReadFacade(storage) {
  if (!storage) return null;
  let facade = storageReadFacades.get(storage);
  if (facade) return facade;
  const read = (method) => (...args) => detached(storage[method](...args));
  facade = Object.freeze(Object.assign(Object.create(null), {
    path: storage.path,
    getCalibrationRuntimeIdentity: read("getCalibrationRuntimeIdentity"),
    getLatch: read("getLatch"),
    isAdmissionOpen: (...args) => storage.isAdmissionOpen(...args),
    getHandoff: read("getHandoff"),
    findHandoffByTarget: read("findHandoffByTarget"),
    findHandoffBySource: read("findHandoffBySource"),
    pendingContinuityFailureForTask: read("pendingContinuityFailureForTask"),
    getRunnerSessionBinding: read("getRunnerSessionBinding"),
    latestHandoffForTask: read("latestHandoffForTask"),
    operationsForTask: read("operationsForTask"),
    getMetricSession: read("getMetricSession"),
    metricSessions: read("metricSessions"),
    metricSamples: read("metricSamples"),
    handoffMetricEvents: read("handoffMetricEvents"),
    metricDiagnostics: read("metricDiagnostics"),
    getArtifact: read("getArtifact"),
    events: read("events"),
  }));
  storageReadFacades.set(storage, facade);
  return facade;
}

function runtimeReadFacade(internal) {
  const facade = Object.create(null);
  Object.defineProperty(facade, "session", {
    enumerable: true,
    get() {
      const session = internal.runtime?.session;
      if (!session) return null;
      return detached({
        sessionId: session.sessionId ?? null,
        sessionFile: session.sessionFile ?? null,
        model: session.model ? { provider: session.model.provider ?? null, id: session.model.id ?? null } : null,
        thinkingLevel: session.thinkingLevel ?? null,
        isIdle: session.isIdle === true,
        isStreaming: session.isStreaming === true,
        pendingMessageCount: session.pendingMessageCount ?? null,
        isRetrying: session.isRetrying === true,
        isCompacting: session.isCompacting === true,
      });
    },
  });
  return Object.freeze(facade);
}

function requireRunnerAuthority(authority) {
  invariant(authority === RUNNER_INTERNAL_AUTHORITY, "RUNNER_TRUSTED_PATH_REQUIRED", "Runner mutation is available only to its lexical Pi integration capability");
}

function trustedRunnerFacade(runner) {
  let facade = trustedRunnerFacades.get(runner);
  if (facade) return facade;
  const internal = runnerInternals.get(runner);
  invariant(internal, "RUNNER_INTERNAL_INVALID");
  facade = new Proxy(runner, {
    get(target, property) {
      if (Object.hasOwn(internal, property)) return internal[property];
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (TRUSTED_RUNNER_AUTHORITY_INDEX.has(property)) {
        return (...args) => {
          const authorityIndex = TRUSTED_RUNNER_AUTHORITY_INDEX.get(property);
          const callArgs = [...args];
          while (callArgs.length < authorityIndex) callArgs.push(undefined);
          callArgs[authorityIndex] = RUNNER_INTERNAL_AUTHORITY;
          return value.apply(facade, callArgs);
        };
      }
      return value.bind(target);
    },
    set(_target, property, value) {
      internal[property] = value;
      return true;
    },
  });
  trustedRunnerFacades.set(runner, facade);
  return facade;
}

// @source-test-support-start
export function runnerForInternalTest(runner) { return trustedRunnerFacade(runner); }
// @source-test-support-end

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
    const publicRunner = new GuardianRunner({ cwd, roots, repository, pi, ledger, storage, artifacts, modelRuntime, gate, model, reasoningPolicy, settingsManager, contextAdvisor, runnerInstanceId, confirmMode: options.confirmMode ?? "confirm-or-manual", calibration: options.calibration ?? null, tools: options.tools ?? DEFAULT_PORTABLE_TOOLS });
    const runner = trustedRunnerFacade(publicRunner);
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
    return publicRunner;
  }

  constructor(fields = {}) {
    const internal = {
      ...fields,
      replacementPermit: 0,
      runtime: null,
      sessionLifecycleEpoch: 0,
      sessionLifecycle: null,
    };
    runnerInternals.set(this, internal);
    internal.runtimeReadFacade = runtimeReadFacade(internal);
    Object.preventExtensions(this);
  }

  get cwd() { return runnerInternals.get(this)?.cwd ?? null; }
  get roots() { return detached(runnerInternals.get(this)?.roots ?? null); }
  get repository() { return detached(runnerInternals.get(this)?.repository ?? null); }
  get ledger() { return ledgerReadFacade(runnerInternals.get(this)?.ledger); }
  get storage() { return storageReadFacade(runnerInternals.get(this)?.storage); }
  get runtime() { return runnerInternals.get(this)?.runtimeReadFacade ?? null; }
  get runnerInstanceId() { return runnerInternals.get(this)?.runnerInstanceId ?? null; }
  get contextAdvisor() {
    const advisor = runnerInternals.get(this)?.contextAdvisor;
    return advisor ? Object.freeze({ thresholdPercent: advisor.thresholdPercent }) : null;
  }
  get handoffService() {
    const service = runnerInternals.get(this)?.handoffService;
    return service ? Object.freeze({ observeGit: () => detached(service.observeGit()) }) : null;
  }

  async createRuntime(options, authority = null) {
    requireRunnerAuthority(authority);
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

  ensureCurrentSessionLifecycle(session, authority = null) {
    requireRunnerAuthority(authority);
    invariant(session?.sessionId, "HANDOFF_SOURCE_CHANGED", "The Runner has no current source session");
    if (this.sessionLifecycle === null) {
      this.sessionLifecycleEpoch += 1;
      this.sessionLifecycle = Object.freeze({ sessionId: session.sessionId, epoch: this.sessionLifecycleEpoch, active: true });
    }
    invariant(this.sessionLifecycle.sessionId === session.sessionId && this.sessionLifecycle.active,
      "HANDOFF_SOURCE_CHANGED", "The current Runner session lifecycle is not ACTIVE");
    return this.sessionLifecycle;
  }

  noteSessionStart(_event, ctx = null, authority = null) {
    requireRunnerAuthority(authority);
    const sessionId = this.lifecycleSessionId(ctx);
    if (!sessionId) return null;
    if (this.sessionLifecycle?.sessionId === sessionId && this.sessionLifecycle.active) return this.sessionLifecycle;
    this.sessionLifecycleEpoch += 1;
    this.sessionLifecycle = Object.freeze({ sessionId, epoch: this.sessionLifecycleEpoch, active: true });
    return this.sessionLifecycle;
  }

  noteSessionShutdown(_event, ctx = null, authority = null) {
    requireRunnerAuthority(authority);
    const sessionId = this.lifecycleSessionId(ctx);
    if (!sessionId || (this.sessionLifecycle && this.sessionLifecycle.sessionId !== sessionId)) return false;
    this.sessionLifecycleEpoch += 1;
    this.sessionLifecycle = Object.freeze({ sessionId, epoch: this.sessionLifecycleEpoch, active: false });
    return true;
  }

  noteCurrentReplacementActive(session, authority = null) {
    requireRunnerAuthority(authority);
    invariant(this.runtime?.session === session && session?.sessionId, "HANDOFF_SOURCE_CHANGED", "Replacement lifecycle does not match the current Runner session");
    if (this.sessionLifecycle?.sessionId === session.sessionId && this.sessionLifecycle.active) return this.sessionLifecycle;
    this.sessionLifecycleEpoch += 1;
    this.sessionLifecycle = Object.freeze({ sessionId: session.sessionId, epoch: this.sessionLifecycleEpoch, active: true });
    return this.sessionLifecycle;
  }

  verifyCurrentTarget(targetSession, authority = null) {
    requireRunnerAuthority(authority);
    invariant(this.runtime?.session === targetSession && targetSession?.sessionId,
      "RESUME_EXPECTATION_STALE", "The current Runner target changed after resume confirmation was displayed");
    invariant(this.runnerInstanceId === this.handoffService.runnerInstanceId,
      "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "Runner identity changed after resume confirmation was displayed");
    const lifecycle = this.sessionLifecycle;
    invariant(lifecycle?.active === true && lifecycle.sessionId === targetSession.sessionId,
      "RESUME_EXPECTATION_STALE", "The current target lifecycle is no longer ACTIVE");
    return Object.freeze({ sessionId: targetSession.sessionId, runnerInstanceId: this.runnerInstanceId, lifecycleEpoch: lifecycle.epoch });
  }

  currentRecoverySourceAttestation(authority = null) {
    requireRunnerAuthority(authority);
    const session = this.runtime?.session;
    invariant(session && session === this.recoverySourceSession, "CONTINUITY_RECOVERY_SOURCE_INVALID", "Recovery must start from the fresh session created by the current Runner");
    return Object.freeze({ session_id: session.sessionId, runner_instance_id: this.runnerInstanceId });
  }

  permitReplacement(authority = null) { requireRunnerAuthority(authority); this.replacementPermit += 1; }
  revokeReplacementPermit(authority = null) { requireRunnerAuthority(authority); this.replacementPermit = Math.max(0, this.replacementPermit - 1); }
  consumeReplacementPermit(authority = null) {
    requireRunnerAuthority(authority);
    if (this.replacementPermit <= 0) return false;
    this.replacementPermit -= 1;
    return true;
  }

  commandTarget(replacementCtx, authority = null) {
    requireRunnerAuthority(authority);
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

  requireCalibrationRuntime(requestModel = null, authority = null) {
    requireRunnerAuthority(authority);
    if (!this.calibration) return null;
    return verifyCalibrationRuntimeState({ runner: this, attestationPath: this.calibration.attestationPath, requestModel });
  }

  captureTrustedSource(expectedEligibility = null, authority = null) {
    requireRunnerAuthority(authority);
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
    registerTrustedCurrentSourceVerifier(verifyCurrentSource, { sourceSession, runnerInstanceId });
    verifyCurrentSource();
    return Object.freeze({ sourceSession, verifyCurrentSource });
  }

  async handoffFromCommand(ctx, mode, options = {}, authority = null) {
    requireRunnerAuthority(authority);
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
      verifyCurrentTarget: (session) => this.verifyCurrentTarget(session),
    });
  }

  async recoverHandoffFromCommand(ctx, failedHandoffId, authority = null) {
    requireRunnerAuthority(authority);
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
      verifyCurrentTarget: (session) => this.verifyCurrentTarget(session),
    });
  }

  async takeoverFromCommand(ctx, authority = null) {
    requireRunnerAuthority(authority);
    const actor = "human:/aio-takeover";
    const taskId = this.safePoint.taskId;
    const timeoutMs = 10_000;
    const started = performance.now();
    const coordinationDeadline = Object.freeze({ startedAt: started, expiresAt: started + timeoutMs, timeoutMs });
    const returnGuardMs = 100;
    const remaining = () => coordinationDeadline.expiresAt - performance.now();
    const timeout = (attempts) => {
      const elapsed = performance.now() - started;
      return new GuardianError("HUMAN_TAKEOVER_COORDINATION_TIMEOUT", "Human takeover could not establish canonical current-plan authority before the bounded coordination deadline", {
        attempts,
        elapsed_ms: elapsed,
        deadline_ms: timeoutMs,
      });
    };
    let attempt = 0;
    let takeoverAuthority;
    while (!takeoverAuthority) {
      if (remaining() <= returnGuardMs) throw timeout(attempt);
      try {
        takeoverAuthority = claimTrustedHumanTakeoverCurrentPlan(this.ledger, {
          storage: this.storage, taskId, actor, coordinationDeadline,
        });
      } catch (error) {
        const deadlineExpired = error?.code === "PLAN_COORDINATION_DEADLINE_EXCEEDED" || remaining() <= returnGuardMs;
        if (deadlineExpired) throw timeout(attempt + 1);
        if (error?.code !== "PLAN_WRITE_LOCKED") throw error;
        const delay = Math.min(250, 20 + attempt * 15, remaining() - returnGuardMs);
        if (delay <= 0) throw timeout(attempt + 1);
        attempt += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
    }
    const coordinationAcquiredMs = performance.now() - started;
    const result = await this.safePoint.request(this.runtime.session, actor, "HUMAN_TAKEOVER", { acquiredLatch: takeoverAuthority.latch });
    ctx.ui.notify(`Aiopago paused at ${result.state}; latch generation=${result.latch_generation}`, "warning");
    return Object.freeze({
      ...result,
      task_id: takeoverAuthority.taskId,
      plan_revision_id: takeoverAuthority.planRevisionId,
      plan_content_digest: takeoverAuthority.contentDigest,
      coordination_acquired_ms: coordinationAcquiredMs,
      coordination_deadline_ms: timeoutMs,
    });
  }

  async resumeFromCommand(ctx, handoffId = undefined, authority = null) {
    requireRunnerAuthority(authority);
    const current = this.runtime.session;
    const h = handoffId ? this.storage.getHandoff(handoffId) : this.storage.findHandoffByTarget(current.sessionId);
    invariant(h, "HANDOFF_NOT_FOUND");
    if (h.state === "RESUME_READY") this.handoffService.continuity(h.handoff_id, current);
    const expectedResume = this.handoffService.prepareResumeConfirmation(h.handoff_id, current, {
      currentTargetVerifier: () => this.verifyCurrentTarget(current),
    });
    const confirmed = await ctx.ui.confirm("Aiopago resume", `Authorize resume for ${h.handoff_id}?`);
    if (!confirmed) {
      this.handoffService.discardResumeConfirmation(expectedResume);
      return this.storage.getHandoff(h.handoff_id);
    }
    const result = await this.handoffService.resume(h.handoff_id, {
      actor: "human:/aio-resume",
      sendResume: (prompt) => current.sendUserMessage(prompt),
      expectedResume,
      targetSession: current,
    });
    ctx.ui.notify(`Aiopago ${result.state}`, "info");
    return result;
  }

  async handoffDirect({ mode = "confirm", confirm = true } = {}, authority = null) {
    requireRunnerAuthority(authority);
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
            confirm: async (handoff) => typeof confirm === "function" ? confirm(handoff, this.runtime.session) : confirm,
            sendResume: (prompt) => this.runtime.session.sendUserMessage(prompt),
          };
          const pausedResult = await onPaused(target);
          return { ...result, pausedResult };
        } finally { this.revokeReplacementPermit(); }
      },
      confirmResume: (target, h) => target.confirm(h),
      verifyCurrentTarget: (session) => this.verifyCurrentTarget(session),
    });
  }

  async recoverHandoffDirect(failedHandoffId, { confirm = true } = {}, authority = null) {
    requireRunnerAuthority(authority);
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
      verifyCurrentTarget: (session) => this.verifyCurrentTarget(session),
    });
  }

  async runInteractive() {
    const internal = runnerInternals.get(this);
    invariant(internal, "RUNNER_INTERNAL_INVALID");
    const mode = new internal.pi.coding.InteractiveMode(internal.runtime, {
      migratedProviders: [],
      modelFallbackMessage: internal.runtime.modelFallbackMessage,
      initialImages: [],
      initialMessages: [],
    });
    await mode.run();
  }

  async dispose() {
    const internal = runnerInternals.get(this);
    invariant(internal, "RUNNER_INTERNAL_INVALID");
    if (internal.runtime) await internal.runtime.dispose();
    await internal.settingsManager?.flush?.();
    internal.storage?.close?.();
  }
}
