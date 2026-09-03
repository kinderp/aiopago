import { invariant } from "./errors.mjs";

export const CONTEXT_DOMAIN_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_DOMAIN_KINDS = Object.freeze(["pi-native", "external-stateful"]);

function requiredString(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, code, label) {
  if (value === undefined || value === null) return null;
  return requiredString(value, code, label);
}

function capabilities(input = {}) {
  return Object.freeze({
    local_files_direct: input.local_files_direct === true,
    pi_tools: input.pi_tools !== false,
    authoritative_context_usage: input.authoritative_context_usage === true,
  });
}

export function createContextDomainDescriptor(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "CONTEXT_DOMAIN_INVALID");
  const kind = requiredString(input.kind, "CONTEXT_DOMAIN_KIND_REQUIRED", "kind");
  invariant(CONTEXT_DOMAIN_KINDS.includes(kind), "CONTEXT_DOMAIN_KIND_INVALID", kind);
  const providerId = requiredString(input.provider_id, "CONTEXT_DOMAIN_PROVIDER_REQUIRED", "provider_id");
  const modelId = optionalString(input.model_id, "CONTEXT_DOMAIN_MODEL_INVALID", "model_id");
  const transportAdapterId = optionalString(input.transport_adapter_id, "CONTEXT_DOMAIN_ADAPTER_INVALID", "transport_adapter_id");
  if (kind === "external-stateful") {
    invariant(transportAdapterId, "CONTEXT_DOMAIN_ADAPTER_REQUIRED", "external-stateful domains require transport_adapter_id");
  }
  return Object.freeze({
    schema_version: CONTEXT_DOMAIN_SCHEMA_VERSION,
    context_domain_id: requiredString(input.context_domain_id, "CONTEXT_DOMAIN_ID_REQUIRED", "context_domain_id"),
    kind,
    provider_id: providerId,
    ...(modelId ? { model_id: modelId } : {}),
    usage_pool: requiredString(input.usage_pool, "CONTEXT_DOMAIN_USAGE_POOL_REQUIRED", "usage_pool"),
    capabilities: capabilities(input.capabilities),
    ...(transportAdapterId ? { transport_adapter_id: transportAdapterId } : {}),
  });
}

function modelKey(providerId, modelId = "*") {
  return `${providerId}\u0000${modelId}`;
}

export class ContextDomainRegistry {
  constructor() {
    this.domains = new Map();
  }

  register(input) {
    const descriptor = createContextDomainDescriptor(input);
    const key = modelKey(descriptor.provider_id, descriptor.model_id ?? "*");
    invariant(!this.domains.has(key), "CONTEXT_DOMAIN_CONFLICT", `${descriptor.provider_id}/${descriptor.model_id ?? "*"}`);
    this.domains.set(key, descriptor);
    return descriptor;
  }

  get(providerId, modelId = undefined) {
    return this.domains.get(modelKey(providerId, modelId ?? "*"));
  }

  resolve(model) {
    invariant(model && typeof model.provider === "string" && typeof model.id === "string", "CONTEXT_DOMAIN_MODEL_REQUIRED");
    const exact = this.domains.get(modelKey(model.provider, model.id));
    if (exact) return exact;
    const providerDefault = this.domains.get(modelKey(model.provider));
    if (providerDefault) return providerDefault;
    return createContextDomainDescriptor({
      context_domain_id: `pi-native:${model.provider}`,
      kind: "pi-native",
      provider_id: model.provider,
      usage_pool: model.provider,
      capabilities: {
        local_files_direct: false,
        pi_tools: true,
        authoritative_context_usage: true,
      },
    });
  }

  list() {
    return Object.freeze([...this.domains.values()]);
  }
}
