import assert from "node:assert/strict";
import test from "node:test";
import * as packageRoot from "../src/index.mjs";
import * as publicApi from "../src/context-continuity.mjs";
import * as packageSubpath from "aiopago/context-continuity";

const PUBLIC_KEYS = Object.freeze([
  "CONTEXT_BINDING_SCHEMA_VERSION",
  "CONTEXT_CONTINUITY_PUBLIC_API_VERSION",
  "CONTEXT_CURSOR_SCHEMA_VERSION",
  "CONTEXT_DELIVERY_SCHEMA_VERSION",
  "CONTEXT_DOMAIN_KINDS",
  "CONTEXT_DOMAIN_SCHEMA_VERSION",
  "CONTEXT_EPOCH_SCHEMA_VERSION",
  "CONTEXT_HYDRATION_POLICY_SCHEMA_VERSION",
  "CONTEXT_SYNC_ENVELOPE_VERSION",
  "CONTEXT_SYNC_PREFIX",
  "CONTEXT_SYNC_PRIVACY_BOUNDARY_VERSION",
  "CONTEXT_TRANSFER_SCHEMA_VERSION",
  "DEFAULT_CONTEXT_HYDRATION_BUDGET",
  "DEFAULT_CONTEXT_HYDRATION_POLICY",
  "PROVIDER_ADAPTER_SCHEMA_VERSION",
  "PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION",
  "PROVIDER_INSTALLATION_MODES",
  "TRANSPORT_SUPPORT_STATUSES",
  "createContextDomainDescriptor",
  "defineProviderAdapter",
  "defineProviderInstallationConfig",
  "hydrateContextTransfer",
].sort());

const INTERNAL_KEYS = Object.freeze([
  "ContextDomainRegistry",
  "ContextCursorBook",
  "DurableContextCursorBook",
  "ContextStateStore",
  "ContextSyncCoordinator",
  "CONTEXT_STATE_STORAGE_SCHEMA_VERSION",
  "validateContextStateJournalPayload",
  "installProviderAdapters",
  "installConfiguredProviderAdapters",
  "MultiModelHandoffCoordinator",
]);

test("public context-continuity facade is exact and package-addressable", () => {
  assert.deepEqual(Object.keys(publicApi).sort(), PUBLIC_KEYS);
  assert.deepEqual(Object.keys(packageSubpath).sort(), PUBLIC_KEYS);
  assert.equal(publicApi.CONTEXT_CONTINUITY_PUBLIC_API_VERSION, "0.4.0");

  for (const key of PUBLIC_KEYS) assert.equal(packageRoot[key], publicApi[key], `${key} must be re-exported by package root`);
  for (const key of INTERNAL_KEYS) {
    assert.equal(key in publicApi, false, `${key} must stay out of the public facade`);
    assert.equal(key in packageRoot, false, `${key} must stay out of the package root`);
  }
});

test("facade supports stable bounded hydration/privacy metadata without exposing runtime state", () => {
  const domain = publicApi.createContextDomainDescriptor({
    context_domain_id: "external:example",
    kind: "external-stateful",
    provider_id: "example-provider",
    usage_pool: "example-subscription",
    transport_adapter_id: "example-adapter",
    capabilities: {
      local_files_direct: false,
      pi_tools: true,
      authoritative_context_usage: false,
    },
  });
  assert.equal(domain.kind, "external-stateful");
  assert.equal(Object.isFrozen(domain), true);

  const adapter = publicApi.defineProviderAdapter({
    adapter_id: "example-adapter",
    provider_id: "example-provider",
    context_domain: domain,
    async install() {},
  });
  assert.equal(adapter.transport_support.status, "experimental-nonproduction");
  assert.equal(Object.isFrozen(adapter), true);

  const config = publicApi.defineProviderInstallationConfig({
    adapters: [{ adapter_id: "example-adapter", mode: "experimental-nonproduction" }],
  });
  assert.deepEqual(config.adapters, [{ adapter_id: "example-adapter", mode: "experimental-nonproduction" }]);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(publicApi.CONTEXT_EPOCH_SCHEMA_VERSION, "0.1.0");
  assert.equal(publicApi.CONTEXT_HYDRATION_POLICY_SCHEMA_VERSION, "0.1.0");
  assert.equal(publicApi.DEFAULT_CONTEXT_HYDRATION_POLICY.raw_tool_output, "excluded-from-hydration");
  assert.equal(publicApi.DEFAULT_CONTEXT_HYDRATION_POLICY.summarization, "none");
  assert.equal(Object.isFrozen(publicApi.DEFAULT_CONTEXT_HYDRATION_POLICY), true);
  assert.equal(Object.isFrozen(publicApi.DEFAULT_CONTEXT_HYDRATION_POLICY.projection_order), true);
  assert.equal("installProviderAdapters" in publicApi, false);
  assert.equal("installConfiguredProviderAdapters" in publicApi, false);
  assert.equal("ContextStateStore" in publicApi, false);
});
