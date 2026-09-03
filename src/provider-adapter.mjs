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
  contextState = null,
  allowExperimentalExternal = false,
} = {}) {
  invariant(modelRuntime && typeof modelRuntime.getProvider === "function" && typeof modelRuntime.getModels === "function", "PROVIDER_ADAPTER_MODEL_RUNTIME_REQUIRED");
  invariant(contextDomains && typeof contextDomains.register === "function", "CONTEXT_DOMAIN_REGISTRY_REQUIRED");
  invariant(!contextState || (typeof contextState.getBinding === "function" && typeof contextState.ensureBinding === "function"), "PROVIDER_ADAPTER_CONTEXT_STATE_INVALID");
  const installed = [];
  const adapterIds = new Set();
  const providerIds = new Set();

  for (const candidate of adapters) {
    // Re-run the public validator for every caller-supplied object. Matching the
    // schema tag alone must never bypass install/domain/transport validation.
    const adapter = defineProviderAdapter(candidate);
    invariant(!adapterIds.has(adapter.adapter_id), "PROVIDER_ADAPTER_ID_CONFLICT", adapter.adapter_id);
    invariant(!providerIds.has(adapter.provider_id), "PROVIDER_ADAPTER_PROVIDER_CONFLICT", adapter.provider_id);
    invariant(!modelRuntime.getProvider(adapter.provider_id), "PROVIDER_ADAPTER_PROVIDER_ALREADY_REGISTERED", adapter.provider_id);
    if (adapter.context_domain.kind === "external-stateful") {
      invariant(adapter.transport_support?.status === "official-supported" || allowExperimentalExternal === true, "PROVIDER_ADAPTER_TRANSPORT_UNVERIFIED", adapter.adapter_id);
      if (contextState) invariant(typeof contextState.bindExternalThread === "function", "PROVIDER_ADAPTER_CONTEXT_BINDING_CAPABILITY_REQUIRED");
    }
    adapterIds.add(adapter.adapter_id);
    providerIds.add(adapter.provider_id);

    const external = adapter.context_domain.kind === "external-stateful";
    const domainId = adapter.context_domain.context_domain_id;
    const existingBinding = external ? contextState?.getBinding(domainId) ?? null : null;
    let installationComplete = false;
    const bindExternalThread = external && contextState
      ? (externalThreadId) => {
          invariant(installationComplete, "PROVIDER_ADAPTER_BINDING_NOT_READY", adapter.adapter_id);
          contextState.ensureBinding(adapter.context_domain);
          return contextState.bindExternalThread(domainId, externalThreadId);
        }
      : null;

    // Adapter code receives only the existing binding snapshot and one narrow,
    // post-install capability for binding an opaque remote thread. It never gets
    // ContextStateStore, cursor, delivery, reconciliation or epoch authority.
    await adapter.install(Object.freeze({
      modelRuntime,
      pi,
      adapter,
      binding: existingBinding,
      ...(bindExternalThread ? { bindExternalThread } : {}),
    }));
    const provider = modelRuntime.getProvider(adapter.provider_id);
    invariant(provider, "PROVIDER_ADAPTER_INSTALL_FAILED", `${adapter.provider_id} was not registered`);
    const models = modelRuntime.getModels(adapter.provider_id);
    invariant(Array.isArray(models) && models.length > 0, "PROVIDER_ADAPTER_MODELS_REQUIRED", adapter.provider_id);

    if (adapter.context_domain.model_id) {
      invariant(models.some((model) => model.id === adapter.context_domain.model_id), "PROVIDER_ADAPTER_DOMAIN_MODEL_MISSING", `${adapter.provider_id}/${adapter.context_domain.model_id}`);
      invariant(models.length === 1, "PROVIDER_ADAPTER_UNCLASSIFIED_MODELS", `${adapter.provider_id} exposes ${models.length} models but the adapter classifies only ${adapter.context_domain.model_id}`);
    }
    const domain = contextDomains.register(adapter.context_domain);
    const durableBinding = domain.kind === "external-stateful" ? contextState?.ensureBinding(domain) ?? null : null;
    installationComplete = true;
    installed.push(Object.freeze({
      adapter_id: adapter.adapter_id,
      provider_id: adapter.provider_id,
      model_ids: Object.freeze(models.map((model) => model.id)),
      context_domain_id: domain.context_domain_id,
      ...(domain.kind === "external-stateful" ? {
        binding_id: durableBinding?.binding_id ?? null,
        transport_support_status: adapter.transport_support.status,
      } : {}),
    }));
  }

  return Object.freeze({
    contextDomains,
    installed: Object.freeze(installed),
  });
}
