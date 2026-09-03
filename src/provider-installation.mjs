import { invariant } from "./errors.mjs";
import {
  defineProviderAdapter,
  installProviderAdapters,
} from "./provider-adapter.mjs";
import { defineProviderInstallationConfig } from "./provider-installation-config.mjs";

function indexAdapterCatalog(adapterCatalog) {
  invariant(Array.isArray(adapterCatalog), "PROVIDER_INSTALLATION_CATALOG_INVALID");
  const byId = new Map();
  for (const candidate of adapterCatalog) {
    // A schema/version tag is not proof that an object has passed the adapter
    // validator. Normalize every catalog entry at the trust boundary, including
    // already-frozen adapters produced by defineProviderAdapter().
    const adapter = defineProviderAdapter(candidate);
    invariant(!byId.has(adapter.adapter_id), "PROVIDER_INSTALLATION_CATALOG_ADAPTER_DUPLICATE", adapter.adapter_id);
    byId.set(adapter.adapter_id, adapter);
  }
  return byId;
}

// Internal Aiopago installation coordinator. External integrations declare
// adapters and installation config through the public facade; they do not receive
// ModelRuntime, ContextDomainRegistry or durable state ownership through this API.
export async function installConfiguredProviderAdapters(configInput, adapterCatalog = [], options = {}) {
  const config = defineProviderInstallationConfig(configInput);
  const catalog = indexAdapterCatalog(adapterCatalog);
  const selected = [];
  let allowExperimentalExternal = false;

  for (const selection of config.adapters) {
    const adapter = catalog.get(selection.adapter_id);
    invariant(adapter, "PROVIDER_INSTALLATION_ADAPTER_NOT_FOUND", selection.adapter_id);

    if (adapter.context_domain.kind === "external-stateful") {
      if (selection.mode === "production") {
        invariant(
          adapter.transport_support?.status === "official-supported",
          "PROVIDER_INSTALLATION_PRODUCTION_TRANSPORT_REQUIRED",
          selection.adapter_id,
        );
      } else {
        invariant(
          selection.mode === "experimental-nonproduction",
          "PROVIDER_INSTALLATION_MODE_UNSUPPORTED",
          `${selection.adapter_id}:${selection.mode}`,
        );
        allowExperimentalExternal = true;
      }
    } else {
      invariant(
        selection.mode === "production",
        "PROVIDER_INSTALLATION_MODE_UNSUPPORTED",
        `${selection.adapter_id}:${selection.mode}`,
      );
    }

    selected.push(adapter);
  }

  return installProviderAdapters(selected, {
    ...options,
    allowExperimentalExternal,
  });
}
