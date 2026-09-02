import { ContextDomainRegistry, createContextDomainDescriptor } from "./context-domain.mjs";
import { invariant } from "./errors.mjs";

export const PROVIDER_ADAPTER_SCHEMA_VERSION = "0.1.0";
export const TRANSPORT_SUPPORT_STATUSES = Object.freeze(["official-supported", "experimental-nonproduction"]);

function requiredString(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, code, label) {
  if (value === undefined || value === null) return null;
  return requiredString(value, code, label);
}

function transportSupport(input, contextDomain) {
  if (contextDomain.kind !== "external-stateful") return null;
  const raw = input ?? { status: "experimental-nonproduction" };
  invariant(raw && typeof raw === "object" && !Array.isArray(raw), "PROVIDER_ADAPTER_TRANSPORT_SUPPORT_INVALID");
  const status = requiredString(raw.status ?? "experimental-nonproduction", "PROVIDER_ADAPTER_TRANSPORT_STATUS_REQUIRED", "transport_support.status");
  invariant(TRANSPORT_SUPPORT_STATUSES.includes(status), "PROVIDER_ADAPTER_TRANSPORT_STATUS_INVALID", status);
  const documentationRef = optionalString(raw.documentation_ref, "PROVIDER_ADAPTER_TRANSPORT_DOCUMENTATION_INVALID", "transport_support.documentation_ref");
  const usagePoolClaim = optionalString(raw.usage_pool_claim, "PROVIDER_ADAPTER_USAGE_POOL_CLAIM_INVALID", "transport_support.usage_pool_claim");
  const usagePoolEvidence = optionalString(raw.usage_pool_evidence, "PROVIDER_ADAPTER_USAGE_POOL_EVIDENCE_INVALID", "transport_support.usage_pool_evidence");

  if (status === "official-supported") {
    invariant(documentationRef, "PROVIDER_ADAPTER_TRANSPORT_DOCUMENTATION_REQUIRED");
    invariant(usagePoolClaim, "PROVIDER_ADAPTER_USAGE_POOL_CLAIM_REQUIRED");
    invariant(usagePoolEvidence, "PROVIDER_ADAPTER_USAGE_POOL_EVIDENCE_REQUIRED");
    invariant(usagePoolClaim === contextDomain.usage_pool, "PROVIDER_ADAPTER_USAGE_POOL_CLAIM_MISMATCH", `${usagePoolClaim} != ${contextDomain.usage_pool}`);
  }

  return Object.freeze({
    status,
    documentation_ref: documentationRef,
    usage_pool_claim: usagePoolClaim,
    usage_pool_evidence: usagePoolEvidence,
  });
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
    ...(contextDomain.kind === "external-stateful" ? { transport_support: transportSupport(input.transport_support, contextDomain) } : {}),
    install: input.install,
  });
}

export async function installProviderAdapters(adapters = [], {
  modelRuntime,
  pi,
  contextDomains = new ContextDomainRegistry(),
  allowExperimentalExternal = process.env.AIOPAGO_ALLOW_EXPERIMENTAL_EXTERNAL === "1",
} = {}) {
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
    if (adapter.context_domain.kind === "external-stateful") {
      invariant(adapter.transport_support?.status === "official-supported" || allowExperimentalExternal === true, "PROVIDER_ADAPTER_TRANSPORT_UNVERIFIED", adapter.adapter_id);
    }
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
