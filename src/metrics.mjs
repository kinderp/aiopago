import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { opaqueId, utcNow } from "./canonical.mjs";

export const METRICS_SCHEMA_VERSION = "1.0.0";
export const DEFAULT_METRICS_RETENTION = Object.freeze({ sessions: 100, samples: 2000, handoffEvents: 1000, diagnostics: 100 });

const FORBIDDEN_RECORD_KEYS = new Set(["conversation", "history", "messages", "prompt", "response", "content", "transcript"]);

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isoFromMilliseconds(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function unknownCost(semantic) {
  return { amount: null, currency: null, status: "unknown", semantic };
}

function qualityAssociations() {
  return {
    acceptance_result: null,
    review_findings: null,
    test_failures: null,
    regressions: null,
    rework_count: null,
    fix_required: null,
  };
}

function addKnown(total, value) {
  if (total === null || value === null) return null;
  return total + value;
}

export function assertTelemetrySafe(record) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_RECORD_KEYS.has(key.toLowerCase())) throw new Error(`METRICS_FORBIDDEN_FIELD:${key}`);
      visit(child);
    }
  };
  visit(record);
  return record;
}

export function measureHandoffArtifacts({ taskPlanPath = null, checkpointBytes = null, manifestBytes = null, resumePrompt = null, minimalReads = null } = {}) {
  let taskPlanBytes = null;
  if (taskPlanPath) {
    try { taskPlanBytes = statSync(taskPlanPath).size; } catch { taskPlanBytes = null; }
  }
  return {
    task_plan_bytes: numberOrNull(taskPlanBytes),
    checkpoint_sealed_bytes: Buffer.isBuffer(checkpointBytes) || checkpointBytes instanceof Uint8Array ? checkpointBytes.byteLength : null,
    manifest_bytes: Buffer.isBuffer(manifestBytes) || manifestBytes instanceof Uint8Array ? manifestBytes.byteLength : null,
    resume_prompt_bytes: typeof resumePrompt === "string" ? Buffer.byteLength(resumePrompt, "utf8") : null,
    minimal_reads_count: null,
    minimal_reads_declared_count: Array.isArray(minimalReads) ? minimalReads.length : null,
  };
}

export class MeasurementInstrumentation {
  constructor({ storage, ledger, runnerInstanceId, thresholdPercent, retention = {} }) {
    this.storage = storage;
    this.ledger = ledger;
    this.runnerInstanceId = runnerInstanceId;
    this.thresholdPercent = thresholdPercent;
    this.retention = Object.freeze({ ...DEFAULT_METRICS_RETENTION, ...retention });
    this.handoffStarts = new Map();
  }

  diagnostic(operation, error, identity = {}) {
    const record = assertTelemetrySafe({
      schema_version: METRICS_SCHEMA_VERSION,
      diagnostic_id: opaqueId("MDIAG"),
      timestamp: utcNow(),
      operation,
      error_name: error?.name ?? "Error",
      error_code: typeof error?.code === "string" ? error.code : null,
      session_id: identity.session_id ?? null,
      task_id: identity.task_id ?? null,
      handoff_id: identity.handoff_id ?? null,
      status: "collection_failed_no_metric_substitution",
    });
    try { this.storage.appendMetricDiagnostic(record, this.retention.diagnostics); }
    catch { console.error(`[eiopago] metrics diagnostic unavailable (${operation})`); }
    return null;
  }

  safe(operation, fn, identity = {}) {
    try { return fn(); }
    catch (error) { return this.diagnostic(operation, error, identity); }
  }

  identity({ ctx = null, sessionId = null, task = null, handoff = null, checkpointId = null, itemId = undefined } = {}) {
    const plan = task ?? this.ledger.read();
    const resolvedSessionId = sessionId ?? ctx?.sessionManager?.getSessionId?.() ?? null;
    const related = handoff
      ?? (resolvedSessionId ? this.storage.findHandoffByTarget(resolvedSessionId) : null)
      ?? (resolvedSessionId ? this.storage.findHandoffBySource?.(resolvedSessionId) : null)
      ?? null;
    return {
      session_id: resolvedSessionId,
      runner_instance_id: this.runnerInstanceId,
      task_id: plan.task_id,
      item_id: itemId === undefined ? plan.current_item ?? null : itemId,
      checkpoint_id: checkpointId ?? related?.checkpoint_id ?? null,
      handoff_id: related?.handoff_id ?? null,
    };
  }

  startSession(ctx, event = {}) {
    return this.safe("session_start", () => {
      const identity = this.identity({ ctx });
      if (!identity.session_id) throw new Error("METRICS_SESSION_ID_UNAVAILABLE");
      const now = utcNow();
      const prior = this.storage.getMetricSession(identity.session_id);
      const record = assertTelemetrySafe(prior ? {
        ...prior,
        ...identity,
        updated_at: now,
        lifecycle: { ...prior.lifecycle, last_start_reason: event.reason ?? null },
      } : {
        schema_version: METRICS_SCHEMA_VERSION,
        ...identity,
        started_at: now,
        ended_at: null,
        duration_ms: null,
        updated_at: now,
        lifecycle: { status: "ACTIVE", start_source: "pi.session_start", last_start_reason: event.reason ?? null, end_reason: null },
        model_calls: 0,
        totals: {
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          equivalent_cost_usd: 0,
          charged_provider_cost: null,
          subscription_cost: null,
        },
        latest_context: { tokens: null, context_window: null, occupancy_percent: null, status: "unknown" },
        quality: qualityAssociations(),
        collection_status: "ok",
      });
      this.storage.upsertMetricSession(record, this.retention.sessions);
      return record;
    });
  }

  endSession(ctx, event = {}) {
    return this.safe("session_end", () => {
      const identity = this.identity({ ctx });
      let prior = this.storage.getMetricSession(identity.session_id);
      if (!prior) prior = this.startSession(ctx, { reason: "observed_at_shutdown" });
      if (!prior) return null;
      const endedAt = utcNow();
      const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(prior.started_at));
      const record = assertTelemetrySafe({
        ...prior,
        ...identity,
        ended_at: endedAt,
        duration_ms: durationMs,
        updated_at: endedAt,
        lifecycle: { ...prior.lifecycle, status: "ENDED", end_reason: event.reason ?? null },
      });
      this.storage.upsertMetricSession(record, this.retention.sessions);
      return record;
    }, { session_id: ctx?.sessionManager?.getSessionId?.() ?? null });
  }

  readContext(ctx, identity) {
    try {
      const value = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      return {
        tokens: numberOrNull(value?.tokens),
        context_window: numberOrNull(value?.contextWindow),
        occupancy_percent: numberOrNull(value?.percent),
        status: value && value.tokens !== null && value.percent !== null ? "available_runtime_estimate" : "unknown",
      };
    } catch (error) {
      this.diagnostic("context_usage", error, identity);
      return { tokens: null, context_window: null, occupancy_percent: null, status: "unknown" };
    }
  }

  captureModelCall(event, ctx) {
    const sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
    return this.safe("model_call_sample", () => {
      const identity = this.identity({ ctx });
      if (!identity.session_id || event?.message?.role !== "assistant") throw new Error("METRICS_AUTHORITATIVE_ASSISTANT_USAGE_UNAVAILABLE");
      let session = this.storage.getMetricSession(identity.session_id);
      if (!session) session = this.startSession(ctx, { reason: "first_observed_model_call" });
      if (!session) return null;
      const usage = event.message.usage ?? {};
      const capturedAt = utcNow();
      const equivalentAmount = numberOrNull(usage.cost?.total);
      const sample = assertTelemetrySafe({
        schema_version: METRICS_SCHEMA_VERSION,
        sample_id: opaqueId("MS"),
        ...identity,
        timestamp: isoFromMilliseconds(event.message.timestamp, capturedAt),
        captured_at: capturedAt,
        call_index: session.model_calls + 1,
        task_phase: identity.item_id,
        model: {
          provider: typeof event.message.provider === "string" ? event.message.provider : null,
          id: typeof event.message.model === "string" ? event.message.model : null,
        },
        context: this.readContext(ctx, identity),
        usage: {
          input_tokens: numberOrNull(usage.input),
          output_tokens: numberOrNull(usage.output),
          reasoning_tokens: numberOrNull(usage.reasoning),
          cache_read_tokens: numberOrNull(usage.cacheRead),
          cache_write_tokens: numberOrNull(usage.cacheWrite),
          cache_hit: null,
          cache_hit_rate: null,
          model_calls: 1,
        },
        cost: {
          charged_provider: unknownCost("provider_invoice_or_charge_not_exposed_by_pi"),
          equivalent: equivalentAmount === null
            ? unknownCost("pi_model_catalog_equivalent_cost")
            : { amount: equivalentAmount, currency: "USD", status: "available", semantic: "pi_model_catalog_equivalent_cost_not_provider_charge" },
          subscription: unknownCost("subscription_equivalent_not_exposed_by_pi"),
        },
      });
      const totals = session.totals;
      const nextSession = assertTelemetrySafe({
        ...session,
        ...identity,
        updated_at: capturedAt,
        model_calls: session.model_calls + 1,
        totals: {
          ...totals,
          input_tokens: addKnown(totals.input_tokens, sample.usage.input_tokens),
          output_tokens: addKnown(totals.output_tokens, sample.usage.output_tokens),
          reasoning_tokens: addKnown(totals.reasoning_tokens, sample.usage.reasoning_tokens),
          cache_read_tokens: addKnown(totals.cache_read_tokens, sample.usage.cache_read_tokens),
          cache_write_tokens: addKnown(totals.cache_write_tokens, sample.usage.cache_write_tokens),
          equivalent_cost_usd: addKnown(totals.equivalent_cost_usd, sample.cost.equivalent.amount),
        },
        latest_context: sample.context,
        collection_status: "ok",
      });
      this.storage.appendMetricSample(sample, nextSession, this.retention.samples);
      return sample;
    }, { session_id: sessionId });
  }

  recordHandoffEvent(lifecycleState, details = {}) {
    const operation = `handoff_${String(lifecycleState).toLowerCase()}`;
    return this.safe(operation, () => {
      const identity = this.identity({
        ctx: details.ctx,
        sessionId: details.session_id,
        task: details.task,
        handoff: details.handoff,
        checkpointId: details.checkpoint_id,
        itemId: details.item_id,
      });
      const now = utcNow();
      if (lifecycleState === "STARTED" && identity.handoff_id) this.handoffStarts.set(identity.handoff_id, performance.now());
      const started = identity.handoff_id ? this.handoffStarts.get(identity.handoff_id) : undefined;
      const elapsed = started === undefined ? null : Math.max(0, performance.now() - started);
      const record = assertTelemetrySafe({
        schema_version: METRICS_SCHEMA_VERSION,
        metric_event_id: opaqueId("HME"),
        ...identity,
        timestamp: now,
        lifecycle_state: lifecycleState,
        threshold_percent: numberOrNull(details.threshold_percent ?? this.thresholdPercent),
        reason: details.reason ?? null,
        task_phase: identity.item_id,
        duration_ms: numberOrNull(details.duration_ms ?? (lifecycleState === "COMPLETED" ? elapsed : null)),
        continuity_duration_ms: numberOrNull(details.continuity_duration_ms),
        resume_duration_ms: numberOrNull(details.resume_duration_ms),
        artifacts: {
          task_plan_bytes: numberOrNull(details.artifacts?.task_plan_bytes),
          checkpoint_sealed_bytes: numberOrNull(details.artifacts?.checkpoint_sealed_bytes),
          manifest_bytes: numberOrNull(details.artifacts?.manifest_bytes),
          resume_prompt_bytes: numberOrNull(details.artifacts?.resume_prompt_bytes),
          minimal_reads_count: numberOrNull(details.artifacts?.minimal_reads_count),
          minimal_reads_declared_count: numberOrNull(details.artifacts?.minimal_reads_declared_count),
        },
      });
      this.storage.appendHandoffMetricEvent(record, this.retention.handoffEvents);
      if (lifecycleState === "COMPLETED" && identity.handoff_id) this.handoffStarts.delete(identity.handoff_id);
      return record;
    }, { session_id: details.session_id ?? null, handoff_id: details.handoff?.handoff_id ?? null });
  }
}
