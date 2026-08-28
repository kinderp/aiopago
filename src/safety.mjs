import { sha256 } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { portableOperationAuthority } from "./operation-authority.mjs";

const TOOL_PROFILES = Object.freeze({
  read: "READ_ONLY",
  grep: "READ_ONLY",
  find: "READ_ONLY",
  ls: "READ_ONLY",
  edit: "LOCAL_ATOMIC_MUTATION",
  write: "LOCAL_ATOMIC_MUTATION",
  bash: "SHELL_ATOMIC_OPERATION",
});

function shellEffectReference(toolCallId) {
  return `shell:${sha256(Buffer.from(toolCallId, "utf8"))}`;
}

function bashTerminalOutcome(isError, result, interrupted) {
  if (interrupted) return "UNKNOWN";
  if (typeof isError !== "boolean" || !result || !Array.isArray(result.content)) return "UNKNOWN";
  if (!isError) return "KNOWN_SUCCESS";
  const text = result.content
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
  // Pi 0.83.0's built-in bash tool throws this terminal diagnostic when its
  // AbortSignal kills the process tree. isError alone cannot distinguish that
  // interruption from a known command failure, so interruption stays unknown.
  if (text === "Command aborted" || text.endsWith("\n\nCommand aborted")) return "UNKNOWN";
  return "KNOWN_FAILURE";
}

export class AdmissionGate {
  constructor(storage, taskId) {
    this.storage = storage;
    this.taskId = taskId;
    this.activeStreams = 0;
    this.waiters = new Set();
    this.preflightVerifier = null;
  }

  setPreflightVerifier(verifier) {
    invariant(typeof verifier === "function", "PREFLIGHT_VERIFIER_INVALID");
    this.preflightVerifier = verifier;
  }

  guardProvider(provider) {
    const gate = this;
    const guarded = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      auth: provider.auth,
      getModels: provider.getModels.bind(provider),
      stream(model, context, options) { return gate.admit(() => provider.stream(model, context, options), model); },
      streamSimple(model, context, options) { return gate.admit(() => provider.streamSimple(model, context, options), model); },
    };
    if (provider.refreshModels) guarded.refreshModels = provider.refreshModels.bind(provider);
    if (provider.filterModels) guarded.filterModels = provider.filterModels.bind(provider);
    return guarded;
  }

  install(modelRuntime) {
    for (const provider of [...modelRuntime.getProviders()]) modelRuntime.registerNativeProvider(this.guardProvider(provider));
  }

  admit(openStream, requestModel = null) {
    if (!this.storage.isAdmissionOpen(this.taskId)) throw new GuardianError("LLM_ADMISSION_BLOCKED", "Guardian latch is engaged or unreadable");
    if (this.preflightVerifier) this.preflightVerifier(requestModel);
    this.activeStreams += 1;
    let stream;
    try { stream = openStream(); }
    catch (error) { this.streamDone(); throw error; }
    Promise.resolve(stream.result()).catch(() => {}).finally(() => this.streamDone());
    return stream;
  }

  streamDone() {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
    if (this.activeStreams === 0) for (const resolve of this.waiters) resolve();
    if (this.activeStreams === 0) this.waiters.clear();
  }

  async waitForNoStreams(timeoutMs = 10_000) {
    if (this.activeStreams === 0) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(done); reject(new GuardianError("SAFE_POINT_TIMEOUT")); }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      this.waiters.add(done);
    });
  }
}

export class ToolOperationTracker {
  constructor(storage, taskId, { operationAuthority = null } = {}) {
    this.storage = storage;
    this.operationAuthority = operationAuthority ?? portableOperationAuthority(storage);
    this.authoritySecurity = this.operationAuthority.security;
    this.taskId = taskId;
    this.admittedTools = new Map();
    this.effectReferences = new Map();
  }
  admit(toolCallId, toolName, input = {}) {
    const profile = TOOL_PROFILES[toolName];
    invariant(profile, "TOOL_PROFILE_REQUIRED", `Tool ${toolName} is outside the M1-H0 allowlist`);
    const latch = this.storage.ensureLatch(this.taskId);
    this.operationAuthority.admitOperation({ operationId: toolCallId, taskId: this.taskId, generation: latch.generation, profile });
    this.admittedTools.set(toolCallId, toolName);
    if (toolName === "bash") {
      this.effectReferences.set(toolCallId, shellEffectReference(toolCallId));
    } else if (profile !== "READ_ONLY" && typeof input.path === "string" && input.path.length > 0) {
      this.effectReferences.set(toolCallId, `file:${input.path.replaceAll("\\", "/")}`);
    }
  }
  finish(toolCallId, isError, result = undefined, interrupted = false) {
    const toolName = this.admittedTools.get(toolCallId);
    const outcome = toolName === "bash"
      ? bashTerminalOutcome(isError, result, interrupted)
      : isError ? "KNOWN_FAILURE" : "KNOWN_SUCCESS";
    const effectReference = outcome === "KNOWN_SUCCESS" ? this.effectReferences.get(toolCallId) ?? null : null;
    this.admittedTools.delete(toolCallId);
    this.effectReferences.delete(toolCallId);
    this.operationAuthority.finishOperation(toolCallId, outcome, effectReference);
  }
  unknown(toolCallId) {
    this.admittedTools.delete(toolCallId);
    this.effectReferences.delete(toolCallId);
    this.operationAuthority.finishOperation(toolCallId, "UNKNOWN");
  }
}

export class SafePointCoordinator {
  constructor({ storage, taskId, gate, operationAuthority = null }) {
    this.storage = storage;
    this.operationAuthority = operationAuthority ?? portableOperationAuthority(storage);
    this.taskId = taskId;
    this.gate = gate;
  }

  acquiredLatch(latch, reason) {
    const current = this.storage.getLatch(this.taskId);
    if (reason !== "HUMAN_TAKEOVER" && current?.state === "ENGAGED" && current.reason === "HUMAN_TAKEOVER") {
      throw new GuardianError("HUMAN_TAKEOVER_ACTIVE", "Human takeover interrupted safe-point acquisition");
    }
    invariant(current?.state === "ENGAGED" && current.generation === latch.generation && current.reason === reason,
      "LATCH_GENERATION_MISMATCH", "Safe-point latch identity changed during asynchronous drain");
    return current;
  }

  async request(session, actor = "human:handoff", reason = "INTEGRITY", options = {}) {
    const observed = options.expectedLatch ?? this.storage.getLatch(this.taskId) ?? this.storage.ensureLatch(this.taskId);
    const expectedLatch = {
      task_id: this.taskId,
      state: observed.state,
      generation: observed.generation,
      reason: observed.reason ?? null,
    };
    let latch;
    if (reason === "HUMAN_TAKEOVER") {
      latch = options.acquiredLatch;
      invariant(latch?.task_id === this.taskId && latch.state === "ENGAGED" && latch.reason === "HUMAN_TAKEOVER",
        "HUMAN_TAKEOVER_TRUSTED_PATH_REQUIRED", "Takeover drain requires the synchronously plan-coordinated latch claim");
      this.acquiredLatch(latch, reason);
    } else if (options.acquiredLatch) {
      latch = options.acquiredLatch;
      invariant(latch.task_id === this.taskId && latch.state === "ENGAGED" && latch.reason === reason,
        "HANDOFF_LATCH_AUTHORITY_INVALID", "SafePoint drain requires the exact plan-coordinated latch claim");
      this.acquiredLatch(latch, reason);
    } else {
      throw new GuardianError("HANDOFF_LATCH_AUTHORITY_INVALID", "SafePoint requires a package-private plan-coordinated latch claim");
    }
    session.clearQueue();
    session.abortRetry();
    session.abortCompaction();
    session.abortBranchSummary?.();
    const admittedBeforeLatch = this.operationAuthority.operationsForTask(this.taskId).filter((operation) => operation.state === "ACTIVE");
    // FINISH CURRENT ATOMIC OPERATION: abort only a bare LLM stream. An admitted
    // tool keeps its signal and is allowed to reach its declared terminal boundary;
    // the closed transport gate rejects the subsequent LLM continuation.
    if (admittedBeforeLatch.length === 0 && (!session.isIdle || session.isStreaming)) {
      await session.abort();
      this.acquiredLatch(latch, reason);
    }
    await session.waitForIdle();
    this.acquiredLatch(latch, reason);
    await this.gate.waitForNoStreams();
    this.acquiredLatch(latch, reason);
    const operations = this.operationAuthority.operationsForTask(this.taskId);
    const active = operations.filter((operation) => operation.state === "ACTIVE");
    if (active.length > 0) throw new GuardianError("SAFE_POINT_ACTIVE_OPERATION", "FINISH CURRENT ATOMIC OPERATION has not reached a terminal boundary", active.map((row) => row.operation_id));
    const unknown = operations.filter((operation) => operation.outcome === "UNKNOWN" || (operation.outcome === "KNOWN_SUCCESS" && operation.profile !== "READ_ONLY" && !operation.effect_reference));
    if (unknown.length > 0) throw new GuardianError("HUMAN_DECISION_REQUIRED", "A mutating operation has no known/evidenced outcome", unknown.map((row) => row.operation_id));
    invariant(session.pendingMessageCount === 0 && !session.isRetrying && !session.isCompacting && session.isIdle, "SAFE_POINT_INVARIANT_FAILED");
    const finalLatch = this.acquiredLatch(latch, reason);
    return {
      state: reason === "HUMAN_TAKEOVER" ? "HUMAN_TAKEOVER" : "SAFE_TO_HANDOFF",
      latch_generation: finalLatch.generation,
      latch: Object.freeze({ task_id: this.taskId, state: finalLatch.state, generation: finalLatch.generation, reason: finalLatch.reason }),
      operations,
    };
  }
}

export { TOOL_PROFILES };
