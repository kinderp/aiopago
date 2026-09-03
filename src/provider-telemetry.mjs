import { invariant } from "./errors.mjs";

export const PROVIDER_TELEMETRY_SCHEMA_VERSION = "0.1.0";
export const USAGE_POOL_SEMANTIC = "configured_label_not_billing_or_quota_proof";

function n(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function completeUsage(sample) { return Number.isFinite(sample?.usage?.input_tokens) && Number.isFinite(sample?.usage?.output_tokens); }
function addUsage(group, sample) {
  group.model_calls += 1;
  group.usage_samples_complete += completeUsage(sample) ? 1 : 0;
  group.input_tokens += n(sample?.usage?.input_tokens);
  group.output_tokens += n(sample?.usage?.output_tokens);
  group.reasoning_tokens += n(sample?.usage?.reasoning_tokens);
  group.cache_read_tokens += n(sample?.usage?.cache_read_tokens);
  group.cache_write_tokens += n(sample?.usage?.cache_write_tokens);
  group.primary_tokens_observed = group.input_tokens + group.output_tokens;
}
function usageGroup(extra = {}) { return { ...extra, model_calls: 0, usage_samples_complete: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, primary_tokens_observed: 0 }; }
function pct(a,b) { return b > 0 ? Math.round((a / b) * 10000) / 100 : 0; }
function toolGroup(pool) { return { usage_pool: pool, requested_tool_calls: 0, known_success: 0, known_failure: 0, unknown: 0, pending: 0, read_calls: 0, query_calls: 0, mutation_calls: 0, shell_calls: 0, other_calls: 0, successful_file_targets: new Set() }; }

export function buildProviderTelemetryProjection({ metric_samples = [], operation_outcomes = [] } = {}) {
  invariant(Array.isArray(metric_samples), "PROVIDER_TELEMETRY_SAMPLES_INVALID");
  invariant(Array.isArray(operation_outcomes), "PROVIDER_TELEMETRY_OPERATIONS_INVALID");
  const operations = new Map(operation_outcomes.map((row) => [row?.operation_id, row]));
  const pools = new Map(); const models = new Map(); const domains = new Map(); const tools = new Map();

  for (const sample of metric_samples) {
    const provider = sample?.model?.provider ?? "unknown";
    const model = sample?.model?.id ?? "unknown";
    const pool = sample?.attribution?.usage_pool ?? provider;
    const domainId = sample?.attribution?.context_domain_id ?? `pi-native:${provider}`;
    const domainKind = sample?.attribution?.context_domain_kind ?? "unknown";
    if (!pools.has(pool)) pools.set(pool, usageGroup({ usage_pool: pool, usage_pool_semantic: USAGE_POOL_SEMANTIC }));
    if (!models.has(`${provider}/${model}`)) models.set(`${provider}/${model}`, usageGroup({ provider, model }));
    if (!domains.has(domainId)) domains.set(domainId, usageGroup({ context_domain_id: domainId, context_domain_kind: domainKind, usage_pool: pool }));
    addUsage(pools.get(pool), sample); addUsage(models.get(`${provider}/${model}`), sample); addUsage(domains.get(domainId), sample);

    if (!tools.has(pool)) tools.set(pool, toolGroup(pool));
    const group = tools.get(pool);
    for (const call of sample?.activity?.calls ?? []) {
      group.requested_tool_calls += 1;
      const klass = ["read","query","mutation","shell"].includes(call?.tool_class) ? call.tool_class : "other";
      group[`${klass}_calls`] += 1;
      const operation = operations.get(call?.tool_call_id);
      if (!operation || operation.state !== "TERMINAL") group.pending += 1;
      else if (operation.outcome === "KNOWN_SUCCESS") { group.known_success += 1; if (call?.target_path) group.successful_file_targets.add(call.target_path); }
      else if (operation.outcome === "KNOWN_FAILURE") group.known_failure += 1;
      else group.unknown += 1;
    }
  }

  const totalCalls = metric_samples.length;
  const totalPrimary = [...pools.values()].reduce((sum, g) => sum + g.primary_tokens_observed, 0);
  const finishUsage = (g) => Object.freeze({ ...g, usage_measurement_status: g.usage_samples_complete === g.model_calls ? "complete_captured_fields" : "partial_captured_fields", call_share_percent: pct(g.model_calls,totalCalls), primary_token_share_percent: pct(g.primary_tokens_observed,totalPrimary) });
  const poolList = [...pools.values()].map(finishUsage).sort((a,b)=>b.model_calls-a.model_calls || a.usage_pool.localeCompare(b.usage_pool));
  const modelList = [...models.values()].map(finishUsage).sort((a,b)=>b.model_calls-a.model_calls || `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  const domainList = [...domains.values()].map(finishUsage).sort((a,b)=>b.model_calls-a.model_calls || a.context_domain_id.localeCompare(b.context_domain_id));
  const toolList = [...tools.values()].map((g)=>Object.freeze({ ...g, successful_file_targets: Object.freeze([...g.successful_file_targets].sort()), successful_file_target_count: g.successful_file_targets.size })).sort((a,b)=>b.requested_tool_calls-a.requested_tool_calls || a.usage_pool.localeCompare(b.usage_pool));
  const successfulFiles = Object.freeze([...new Set(toolList.flatMap((g)=>g.successful_file_targets))].sort());

  return Object.freeze({
    schema_version: PROVIDER_TELEMETRY_SCHEMA_VERSION,
    semantics: Object.freeze({
      token_measurement: "captured_assistant_usage_fields_no_billing_inference",
      primary_token_share: "input_plus_output_only",
      reasoning_and_cache: "reported_separately_no_overlap_assumption",
      usage_pool: USAGE_POOL_SEMANTIC,
    }),
    model_calls: totalCalls,
    primary_tokens_observed: totalPrimary,
    usage_pools: Object.freeze(poolList),
    models: Object.freeze(modelList),
    context_domains: Object.freeze(domainList),
    tools_by_usage_pool: Object.freeze(toolList),
    provenance: Object.freeze({
      successful_file_targets: successfulFiles,
      tests: Object.freeze({ status: "not_available_from_metric_samples" }),
      decisions: Object.freeze({ status: "not_available_from_metric_samples" }),
    }),
    work_mix: Object.freeze({ status: "not_computed", reason: "No transparent weighting policy has been ratified." }),
  });
}
