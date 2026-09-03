import { isAbsolute, relative, resolve, sep } from "node:path";

export const ATTRIBUTION_SCHEMA_VERSION = "0.1.0";

const TOOL_CLASS = Object.freeze({
  read: "read",
  grep: "query",
  find: "query",
  ls: "query",
  edit: "mutation",
  write: "mutation",
  bash: "shell",
});

function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function add(target, key, value) {
  target[key] = nonNegative(target[key]) + nonNegative(value);
}

function lineCount(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function normalizedTargetPath(inputPath, cwd) {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.length > 4096) return null;
  try {
    if (typeof cwd === "string" && cwd.length > 0) {
      const root = resolve(cwd);
      const absolute = resolve(root, inputPath);
      const fromRoot = relative(root, absolute);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
      const normalized = (fromRoot || ".").replaceAll("\\", "/");
      return normalized.length <= 512 ? normalized : null;
    }
    if (isAbsolute(inputPath) || inputPath === ".." || inputPath.startsWith("../") || inputPath.startsWith("..\\")) return null;
    const normalized = inputPath.replaceAll("\\", "/");
    return normalized.length <= 512 ? normalized : null;
  } catch {
    return null;
  }
}

export function resolveModelAttribution(contextDomains, provider, model) {
  const fallback = Object.freeze({
    schema_version: ATTRIBUTION_SCHEMA_VERSION,
    context_domain_id: provider ? `pi-native:${provider}` : "unknown",
    context_domain_kind: "pi-native",
    usage_pool: provider ?? "unknown",
    context_usage_semantic: "pi_session_runtime",
  });
  if (!contextDomains || typeof contextDomains.resolve !== "function" || typeof provider !== "string" || typeof model !== "string") return fallback;
  try {
    const domain = contextDomains.resolve({ provider, id: model });
    return Object.freeze({
      schema_version: ATTRIBUTION_SCHEMA_VERSION,
      context_domain_id: domain.context_domain_id,
      context_domain_kind: domain.kind,
      usage_pool: domain.usage_pool,
      context_usage_semantic: domain.kind === "external-stateful" ? "pi_session_runtime_not_remote_provider_context" : "pi_session_runtime",
    });
  } catch {
    return fallback;
  }
}

function requestedLineStats(toolName, args) {
  if (toolName === "edit") {
    return Object.freeze({
      requested_removed_lines: lineCount(args?.oldText),
      requested_added_lines: lineCount(args?.newText),
      requested_written_lines: null,
    });
  }
  if (toolName === "write") {
    return Object.freeze({
      requested_removed_lines: null,
      requested_added_lines: null,
      requested_written_lines: lineCount(args?.content),
    });
  }
  return Object.freeze({ requested_removed_lines: null, requested_added_lines: null, requested_written_lines: null });
}

export function extractToolActivity(message, { cwd = null } = {}) {
  const calls = [];
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return Object.freeze({ schema_version: ATTRIBUTION_SCHEMA_VERSION, requested_tool_calls: 0, calls: Object.freeze([]) });
  }
  for (const block of message.content) {
    if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
    const args = block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments) ? block.arguments : {};
    const toolClass = TOOL_CLASS[block.name] ?? "other";
    const targetPath = ["read", "edit", "write"].includes(block.name) ? normalizedTargetPath(args.path, cwd) : null;
    calls.push(Object.freeze({
      tool_call_id: block.id,
      tool_name: block.name.slice(0, 128),
      tool_class: toolClass,
      target_path: targetPath,
      ...requestedLineStats(block.name, args),
    }));
  }
  return Object.freeze({
    schema_version: ATTRIBUTION_SCHEMA_VERSION,
    requested_tool_calls: calls.length,
    calls: Object.freeze(calls),
  });
}

function emptyUsageGroup(key, kind = undefined) {
  return {
    key,
    ...(kind ? { kind } : {}),
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    primary_tokens_observed: 0,
  };
}

function accumulateUsage(group, sample) {
  group.model_calls += 1;
  add(group, "input_tokens", sample.usage?.input_tokens);
  add(group, "output_tokens", sample.usage?.output_tokens);
  add(group, "reasoning_tokens", sample.usage?.reasoning_tokens);
  add(group, "cache_read_tokens", sample.usage?.cache_read_tokens);
  add(group, "cache_write_tokens", sample.usage?.cache_write_tokens);
  // Input+output is the only share basis here. Reasoning/cache stay separate because
  // provider accounting may overlap those categories with primary token counts.
  group.primary_tokens_observed = group.input_tokens + group.output_tokens;
}

function operationMap(storage, samples) {
  const result = new Map();
  const taskIds = [...new Set(samples.map((sample) => sample.task_id).filter(Boolean))];
  for (const taskId of taskIds) {
    for (const operation of storage.operationsForTask?.(taskId) ?? []) result.set(operation.operation_id, operation);
  }
  return result;
}

function emptyToolGroup(usagePool) {
  return {
    usage_pool: usagePool,
    requested_tool_calls: 0,
    known_success: 0,
    known_failure: 0,
    unknown: 0,
    pending: 0,
    read_calls: 0,
    query_calls: 0,
    mutation_calls: 0,
    shell_calls: 0,
    other_calls: 0,
    requested_added_lines: 0,
    requested_removed_lines: 0,
    requested_written_lines: 0,
    successful_file_targets: new Set(),
  };
}

function percentage(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 100 : 0;
}

export function buildAttributionSnapshot({ storage, sessionId = null } = {}) {
  const samples = storage?.metricSamples?.(sessionId) ?? [];
  const operations = operationMap(storage, samples);
  const poolGroups = new Map();
  const modelGroups = new Map();
  const toolGroups = new Map();

  for (const sample of samples) {
    const usagePool = sample.attribution?.usage_pool ?? sample.model?.provider ?? "unknown";
    const domainKind = sample.attribution?.context_domain_kind ?? "unknown";
    if (!poolGroups.has(usagePool)) poolGroups.set(usagePool, emptyUsageGroup(usagePool, domainKind));
    accumulateUsage(poolGroups.get(usagePool), sample);

    const modelKey = `${sample.model?.provider ?? "unknown"}/${sample.model?.id ?? "unknown"}`;
    if (!modelGroups.has(modelKey)) modelGroups.set(modelKey, emptyUsageGroup(modelKey));
    accumulateUsage(modelGroups.get(modelKey), sample);

    if (!toolGroups.has(usagePool)) toolGroups.set(usagePool, emptyToolGroup(usagePool));
    const toolGroup = toolGroups.get(usagePool);
    for (const call of sample.activity?.calls ?? []) {
      toolGroup.requested_tool_calls += 1;
      toolGroup[`${call.tool_class}_calls`] = nonNegative(toolGroup[`${call.tool_class}_calls`]) + 1;
      add(toolGroup, "requested_added_lines", call.requested_added_lines);
      add(toolGroup, "requested_removed_lines", call.requested_removed_lines);
      add(toolGroup, "requested_written_lines", call.requested_written_lines);
      const operation = operations.get(call.tool_call_id);
      if (!operation || operation.state !== "TERMINAL") toolGroup.pending += 1;
      else if (operation.outcome === "KNOWN_SUCCESS") {
        toolGroup.known_success += 1;
        if (call.target_path) toolGroup.successful_file_targets.add(call.target_path);
      } else if (operation.outcome === "KNOWN_FAILURE") toolGroup.known_failure += 1;
      else toolGroup.unknown += 1;
    }
  }

  const totalCalls = [...poolGroups.values()].reduce((sum, group) => sum + group.model_calls, 0);
  const totalPrimaryTokens = [...poolGroups.values()].reduce((sum, group) => sum + group.primary_tokens_observed, 0);
  const usagePools = [...poolGroups.values()].map((group) => Object.freeze({
    ...group,
    call_share_percent: percentage(group.model_calls, totalCalls),
    primary_token_share_percent: percentage(group.primary_tokens_observed, totalPrimaryTokens),
  }));
  const models = [...modelGroups.values()].map((group) => Object.freeze({
    ...group,
    call_share_percent: percentage(group.model_calls, totalCalls),
    primary_token_share_percent: percentage(group.primary_tokens_observed, totalPrimaryTokens),
  }));
  const tools = [...toolGroups.values()].map((group) => Object.freeze({
    ...group,
    successful_file_targets: Object.freeze([...group.successful_file_targets].sort()),
    successful_file_target_count: group.successful_file_targets.size,
  }));

  return Object.freeze({
    schema_version: ATTRIBUTION_SCHEMA_VERSION,
    session_id: sessionId,
    model_calls: totalCalls,
    primary_tokens_observed: totalPrimaryTokens,
    usage_pools: Object.freeze(usagePools.sort((a, b) => b.model_calls - a.model_calls || a.key.localeCompare(b.key))),
    models: Object.freeze(models.sort((a, b) => b.model_calls - a.model_calls || a.key.localeCompare(b.key))),
    tools_by_usage_pool: Object.freeze(tools.sort((a, b) => b.requested_tool_calls - a.requested_tool_calls || a.usage_pool.localeCompare(b.usage_pool))),
    work_mix: Object.freeze({
      status: "not_computed",
      reason: "No weighting policy has been ratified; exact primitives are exposed instead.",
    }),
  });
}
