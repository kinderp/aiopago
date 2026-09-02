import { ContextDomainRegistry, createContextDomainDescriptor } from "./context-domain.mjs";
import { invariant } from "./errors.mjs";

export const PROVIDER_ADAPTER_SCHEMA_VERSION = "0.1.0";

function requiredString(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be a non-empty string`);
  return value.trim();
}

export function defineProviderAdapter(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "PROVIDER_ADAPTER_INVALID");
  const adapterId = requiredString(input.adapter_id, "PROVIDER_ADAPTER_ID_REQUIRED", "adapter_id");
  const providerId = requiredString(input.provider_id, "PROVIDER_ADAPTER_PROVIDER_REQUIRED", "provider_id");
  invariant(typeof input.install === "function", "PROVIDER_ADAPTER_INSTALL_REQUIRED");
  const contextDomain = createContextDomainDescriptor({
    ...(input.context_domain ?? {}),
    provider_id: providerId,
    transport_adapter_id: input.context_domain?.transport_adapter_id ?? adapterId,
  });
  invariant(contextDomain.provider_id === providerId, "PROVIDER_ADAPTER_DOMAIN_PROVIDER_MISMATCH");
  invariant(contextDomain.transport_adapter_id === adapterId, "PROVIDER_ADAPTER_DOMAIN_ADAPTER_MISMATCH");
  return Object.freeze({
    schema_version: PROVIDER_ADAPTER_SCHEMA_VERSION,
    adapter_id: adapterId,
    provider_id: providerId,
    context_domain: contextDomain,
    install: input.install,
  });
}

export async function installProviderAdapters(adapters = [], { modelRuntime, pi, contextDomains = new ContextDomainRegistry() } = {}) {
  invariant(modelRuntime && typeof modelRuntime.getProvider === "function" && typeof modelRuntime.getModels === "function", "PROVIDER_ADAPTER_MODEL_RUNTIME_REQUIRED");
  invariant(contextDomains && typeof contextDomains.register === "function", "CONTEXT_DOMAIN_REGISTRY_REQUIRED");
  const installed = [];
  const adapterIds = new Set();
  const providerIds = new Set();

  for (const candidate of adapters) {
    const adapter = candidate?.schema_version === PROVIDER_ADAPTER_SCHEMA_VERSION ? candidate : defineProviderAdapter(candidate);
    invariant(!adapterIds.has(adapter.adapter_id), "PROVIDER_ADAPTER_ID_CONFLICT", adapter.adapter_id);
    invariant(!providerIds.has(adapter.provider_id), "PROVIDER_ADAPTER_PROVIDER_CONFLICT", adapter.provider_id);
    invariant(!modelRuntime.getProvider(adapter.provider_id), "PROVIDER_ADAPTER_PROVIDER_ALREADY_REGISTERED", adapter.provider_id);
    adapterIds.add(adapter.adapter_id);
    providerIds.add(adapter.provider_id);

    await adapter.install(Object.freeze({ modelRuntime, pi, adapter }));
    const provider = modelRuntime.getProvider(adapter.provider_id);
    invariant(provider, "PROVIDER_ADAPTER_INSTALL_FAILED", `${adapter.provider_id} was not registered`);
    const models = modelRuntime.getModels(adapter.provider_id);
    invariant(Array.isArray(models) && models.length > 0, "PROVIDER_ADAPTER_MODELS_REQUIRED", adapter.provider_id);

    if (adapter.context_domain.model_id) {
      invariant(models.some((model) => model.id === adapter.context_domain.model_id), "PROVIDER_ADAPTER_DOMAIN_MODEL_MISSING", `${adapter.provider_id}/${adapter.context_domain.model_id}`);
      invariant(models.length === 1, "PROVIDER_ADAPTER_UNCLASSIFIED_MODELS", `${adapter.provider_id} exposes ${models.length} models but the adapter classifies only ${adapter.context_domain.model_id}`);
    }
    // A provider-default descriptor (no model_id) safely classifies every model.
    // Exact-model descriptors are deliberately restricted to one-model providers
    // until the adapter contract supports an explicit descriptor per model.
    const domain = contextDomains.register(adapter.context_domain);
    installed.push(Object.freeze({
      adapter_id: adapter.adapter_id,
      provider_id: adapter.provider_id,
      model_ids: Object.freeze(models.map((model) => model.id)),
      context_domain_id: domain.context_domain_id,
    }));
  }

  return Object.freeze({
    contextDomains,
    installed: Object.freeze(installed),
  });
}
