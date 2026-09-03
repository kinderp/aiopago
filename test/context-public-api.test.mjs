import assert from "node:assert/strict";
import test from "node:test";
import * as packageRoot from "../src/index.mjs";
import * as publicApi from "../src/context-continuity.mjs";
import * as packageSubpath from "aiopago/context-continuity";
const PUBLIC_KEYS = Object.freeze(["CONTEXT_BINDING_SCHEMA_VERSION","CONTEXT_CONTINUITY_PUBLIC_API_VERSION","CONTEXT_CURSOR_SCHEMA_VERSION","CONTEXT_DELIVERY_SCHEMA_VERSION","CONTEXT_DOMAIN_KINDS","CONTEXT_DOMAIN_SCHEMA_VERSION","CONTEXT_EPOCH_SCHEMA_VERSION","CONTEXT_HYDRATION_POLICY_SCHEMA_VERSION","CONTEXT_SYNC_ENVELOPE_VERSION","CONTEXT_SYNC_PREFIX","CONTEXT_SYNC_PRIVACY_BOUNDARY_VERSION","CONTEXT_TRANSFER_SCHEMA_VERSION","DEFAULT_CONTEXT_HYDRATION_BUDGET","DEFAULT_CONTEXT_HYDRATION_POLICY","EXTERNAL_STATEFUL_TOOL_PROFILE","EXTERNAL_TOOL_PROFILE_SCHEMA_VERSION","PROVIDER_ADAPTER_SCHEMA_VERSION","PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION","PROVIDER_INSTALLATION_MODES","TRANSPORT_SUPPORT_STATUSES","createContextDomainDescriptor","defineProviderAdapter","defineProviderInstallationConfig","hydrateContextTransfer"].sort());
const INTERNAL_KEYS = Object.freeze(["ContextDomainRegistry","ContextCursorBook","DurableContextCursorBook","ContextStateStore","ContextSyncCoordinator","CONTEXT_STATE_STORAGE_SCHEMA_VERSION","validateContextStateJournalPayload","installProviderAdapters","installConfiguredProviderAdapters","evaluateExternalStatefulToolAdmission","MultiModelHandoffCoordinator"]);
test("public context-continuity facade is exact and package-addressable", () => {
  assert.deepEqual(Object.keys(publicApi).sort(), PUBLIC_KEYS); assert.deepEqual(Object.keys(packageSubpath).sort(), PUBLIC_KEYS); assert.equal(publicApi.CONTEXT_CONTINUITY_PUBLIC_API_VERSION, "0.5.0");
  for (const key of PUBLIC_KEYS) assert.equal(packageRoot[key], publicApi[key], `${key} must be re-exported by package root`);
  for (const key of INTERNAL_KEYS) { assert.equal(key in publicApi, false); assert.equal(key in packageRoot, false); }
});
test("facade exposes the closed external read/query profile without runtime admission internals", () => {
  assert.equal(publicApi.EXTERNAL_TOOL_PROFILE_SCHEMA_VERSION, "0.1.0");
  assert.deepEqual(publicApi.EXTERNAL_STATEFUL_TOOL_PROFILE.admitted_tools, ["read","grep","find","ls"]);
  assert.equal(publicApi.EXTERNAL_STATEFUL_TOOL_PROFILE.mutation_tools, "deferred");
  assert.equal(Object.isFrozen(publicApi.EXTERNAL_STATEFUL_TOOL_PROFILE), true);
  assert.equal(Object.isFrozen(publicApi.EXTERNAL_STATEFUL_TOOL_PROFILE.admitted_tools), true);
  assert.equal("evaluateExternalStatefulToolAdmission" in publicApi, false);
});
