import { GuardianError, invariant } from "./errors.mjs";

const TOOL_PROFILES = Object.freeze({
  read: "READ_ONLY",
  grep: "READ_ONLY",
  find: "READ_ONLY",
  ls: "READ_ONLY",
  edit: "LOCAL_ATOMIC_MUTATION",
  write: "LOCAL_ATOMIC_MUTATION",
});

export class AdmissionGate {
  constructor(storage, taskId) {
    this.storage = storage;
    this.taskId = taskId;
    this.activeStreams = 0;
    this.waiters = new Set();
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
      stream(model, context, options) { return gate.admit(() => provider.stream(model, context, options)); },
      streamSimple(model, context, options) { return gate.admit(() => provider.streamSimple(model, context, options)); },
    };
    if (provider.refreshModels) guarded.refreshModels = provider.refreshModels.bind(provider);
    if (provider.filterModels) guarded.filterModels = provider.filterModels.bind(provider);
    return guarded;
  }

  install(modelRuntime) {
    for (const provider of [...modelRuntime.getProviders()]) modelRuntime.registerNativeProvider(this.guardProvider(provider));
  }

  admit(openStream) {
    if (!this.storage.isAdmissionOpen(this.taskId)) throw new GuardianError("LLM_ADMISSION_BLOCKED", "Guardian latch is engaged or unreadable");
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
  constructor(storage, taskId) {
    this.storage = storage;
    this.taskId = taskId;
    this.effectReferences = new Map();
  }
  admit(toolCallId, toolName, input = {}) {
    const profile = TOOL_PROFILES[toolName];
    invariant(profile, "TOOL_PROFILE_REQUIRED", `Tool ${toolName} is outside the M1-H0 allowlist`);
    const latch = this.storage.ensureLatch(this.taskId);
    this.storage.admitOperation({ operationId: toolCallId, taskId: this.taskId, generation: latch.generation, profile });
    if (profile !== "READ_ONLY" && typeof input.path === "string" && input.path.length > 0) {
      this.effectReferences.set(toolCallId, `file:${input.path.replaceAll("\\", "/")}`);
    }
  }
  finish(toolCallId, isError) {
    const effectReference = isError ? null : this.effectReferences.get(toolCallId) ?? null;
    this.effectReferences.delete(toolCallId);
    this.storage.finishOperation(toolCallId, isError ? "KNOWN_FAILURE" : "KNOWN_SUCCESS", effectReference);
  }
  unknown(toolCallId) {
    this.effectReferences.delete(toolCallId);
    this.storage.finishOperation(toolCallId, "UNKNOWN");
  }
}

export class SafePointCoordinator {
  constructor({ storage, taskId, gate }) {
    this.storage = storage;
    this.taskId = taskId;
    this.gate = gate;
  }

  async request(session, actor = "human:handoff", reason = "INTEGRITY") {
    const latch = this.storage.engageLatch(this.taskId, reason, actor);
    session.clearQueue();
    session.abortRetry();
    session.abortCompaction();
    session.abortBranchSummary?.();
    const admittedBeforeLatch = this.storage.operationsForTask(this.taskId).filter((operation) => operation.state === "ACTIVE");
    // FINISH CURRENT ATOMIC OPERATION: abort only a bare LLM stream. An admitted
    // tool keeps its signal and is allowed to reach its declared terminal boundary;
    // the closed transport gate rejects the subsequent LLM continuation.
    if (admittedBeforeLatch.length === 0 && (!session.isIdle || session.isStreaming)) await session.abort();
    await session.waitForIdle();
    await this.gate.waitForNoStreams();
    const operations = this.storage.operationsForTask(this.taskId);
    const active = operations.filter((operation) => operation.state === "ACTIVE");
    if (active.length > 0) throw new GuardianError("SAFE_POINT_ACTIVE_OPERATION", "FINISH CURRENT ATOMIC OPERATION has not reached a terminal boundary", active.map((row) => row.operation_id));
    const unknown = operations.filter((operation) => operation.outcome === "UNKNOWN" || (operation.outcome === "KNOWN_SUCCESS" && operation.profile !== "READ_ONLY" && !operation.effect_reference));
    if (unknown.length > 0) throw new GuardianError("HUMAN_DECISION_REQUIRED", "A mutating operation has no known/evidenced outcome", unknown.map((row) => row.operation_id));
    invariant(session.pendingMessageCount === 0 && !session.isRetrying && !session.isCompacting && session.isIdle, "SAFE_POINT_INVARIANT_FAILED");
    return { state: "SAFE_TO_HANDOFF", latch_generation: latch.generation, operations };
  }
}

export { TOOL_PROFILES };
