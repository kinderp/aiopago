// Public provider-neutral context-continuity contract.
//
// Keep orchestration, persistence and reconciliation implementations out of this
// facade. External adapters should depend on this module rather than importing
// spike/runtime internals directly.

export const CONTEXT_CONTINUITY_PUBLIC_API_VERSION = "0.3.0";

export {
  CONTEXT_DOMAIN_SCHEMA_VERSION,
  CONTEXT_DOMAIN_KINDS,
  createContextDomainDescriptor,
} from "./context-domain.mjs";

export {
  PROVIDER_ADAPTER_SCHEMA_VERSION,
  TRANSPORT_SUPPORT_STATUSES,
  defineProviderAdapter,
} from "./provider-adapter.mjs";

export {
  PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION,
  PROVIDER_INSTALLATION_MODES,
  defineProviderInstallationConfig,
} from "./provider-installation-config.mjs";

export {
  CONTEXT_CURSOR_SCHEMA_VERSION,
  CONTEXT_TRANSFER_SCHEMA_VERSION,
  DEFAULT_CONTEXT_HYDRATION_BUDGET,
  hydrateContextTransfer,
} from "./context-transfer.mjs";

export {
  CONTEXT_SYNC_ENVELOPE_VERSION,
  CONTEXT_SYNC_PREFIX,
} from "./context-sync.mjs";

export {
  CONTEXT_BINDING_SCHEMA_VERSION,
  CONTEXT_DELIVERY_SCHEMA_VERSION,
  CONTEXT_EPOCH_SCHEMA_VERSION,
} from "./context-state.mjs";
