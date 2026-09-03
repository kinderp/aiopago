import assert from "node:assert/strict";
import test from "node:test";
import * as publicApi from "../src/context-continuity.mjs";
import * as packageRoot from "../src/index.mjs";
import { defineProviderAdapter } from "../src/provider-adapter.mjs";
import { installConfiguredProviderAdapters } from "../src/provider-installation.mjs";

class FakeModelRuntime {
  constructor() { this.providers = new Map(); }
  getProvider(id) { return this.providers.get(id) ?? null; }
  getModels(id) { return this.providers.get(id)?.getModels?.() ?? []; }
  registerNativeProvider(provider) { this.providers.set(provider.id, provider); }
}

function externalAdapter({
  adapterId,
  providerId,
  domainId,
  modelId = "model-a",
  usagePool = "external-test",
  transportStatus = "experimental-nonproduction",
  models = [modelId],
} = {}) {
  return defineProviderAdapter({
    adapter_id: adapterId,
    provider_id: providerId,
    context_domain: {
      context_domain_id: domainId,
      kind: "external-stateful",
      model_id: modelId,
      usage_pool: usagePool,
      capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
    },
    transport_support: transportStatus === "official-supported"
      ? {
          status: "official-supported",
          documentation_ref: "https://example.invalid/provider-contract",
          usage_pool_claim: usagePool,
          usage_pool_evidence: "contract-test-evidence",
        }
      : { status: "experimental-nonproduction" },
    install: async ({ modelRuntime }) => modelRuntime.registerNativeProvider({
      id: providerId,
      getModels: () => models.map((id) => ({ id })),
    }),
  });
}

test("P2 public installation config is strict, versioned, immutable and duplicate-safe", () => {
  const config = publicApi.defineProviderInstallationConfig({
    schema_version: "0.1.0",
    adapters: [
      { adapter_id: "official-a", mode: "production" },
      { adapter_id: "experiment-b", mode: "experimental-nonproduction" },
    ],
  });
  assert.equal(config.schema_version, publicApi.PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION);
  assert.deepEqual(publicApi.PROVIDER_INSTALLATION_MODES, ["production", "experimental-nonproduction"]);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.adapters), true);
  assert.equal(Object.isFrozen(config.adapters[0]), true);
  assert.equal("installConfiguredProviderAdapters" in publicApi, false);
  assert.equal("installConfiguredProviderAdapters" in packageRoot, false);

  assert.throws(
    () => publicApi.defineProviderInstallationConfig({ adapters: [{ adapter_id: "a", mode: "production" }, { adapter_id: "a", mode: "production" }] }),
    (error) => error?.code === "PROVIDER_INSTALLATION_ADAPTER_DUPLICATE",
  );
  assert.throws(
    () => publicApi.defineProviderInstallationConfig({ adapters: [{ adapter_id: "a", mode: "experimental" }] }),
    (error) => error?.code === "PROVIDER_INSTALLATION_MODE_INVALID",
  );
  assert.throws(
    () => publicApi.defineProviderInstallationConfig({ adapters: [], secret: "must-not-be-accepted" }),
    (error) => error?.code === "PROVIDER_INSTALLATION_CONFIG_FIELD_UNKNOWN",
  );
  assert.throws(
    () => publicApi.defineProviderInstallationConfig({ schema_version: "9.9.9", adapters: [] }),
    (error) => error?.code === "PROVIDER_INSTALLATION_CONFIG_SCHEMA_UNSUPPORTED",
  );
});

test("P2 installation is opt-in: catalog presence alone installs nothing", async () => {
  const runtime = new FakeModelRuntime();
  const candidate = externalAdapter({
    adapterId: "catalog-only",
    providerId: "catalog-only-provider",
    domainId: "external:catalog-only",
    transportStatus: "official-supported",
  });
  const result = await installConfiguredProviderAdapters({ adapters: [] }, [candidate], { modelRuntime: runtime, pi: {} });
  assert.equal(result.installed.length, 0);
  assert.equal(runtime.getProvider("catalog-only-provider"), null);
});

test("P2 production mode rejects an experimental external transport before installation", async () => {
  const runtime = new FakeModelRuntime();
  const candidate = externalAdapter({
    adapterId: "experimental-a",
    providerId: "experimental-provider",
    domainId: "external:experimental-a",
  });
  await assert.rejects(
    installConfiguredProviderAdapters(
      { adapters: [{ adapter_id: "experimental-a", mode: "production" }] },
      [candidate],
      { modelRuntime: runtime, pi: {}, allowExperimentalExternal: true },
    ),
    (error) => error?.code === "PROVIDER_INSTALLATION_PRODUCTION_TRANSPORT_REQUIRED",
  );
  assert.equal(runtime.getProvider("experimental-provider"), null);
});

test("P2 experimental external transport requires per-adapter non-production opt-in", async () => {
  const runtime = new FakeModelRuntime();
  const candidate = externalAdapter({
    adapterId: "experimental-b",
    providerId: "experimental-provider-b",
    domainId: "external:experimental-b",
  });
  const result = await installConfiguredProviderAdapters(
    { adapters: [{ adapter_id: "experimental-b", mode: "experimental-nonproduction" }] },
    [candidate],
    { modelRuntime: runtime, pi: {} },
  );
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].transport_support_status, "experimental-nonproduction");
  assert.ok(runtime.getProvider("experimental-provider-b"));
});

test("P2 production external transport installs only with official provenance metadata", async () => {
  const runtime = new FakeModelRuntime();
  const selected = externalAdapter({
    adapterId: "official-a",
    providerId: "official-provider-a",
    domainId: "external:official-a",
    transportStatus: "official-supported",
  });
  const unlisted = externalAdapter({
    adapterId: "official-b",
    providerId: "official-provider-b",
    domainId: "external:official-b",
    transportStatus: "official-supported",
  });
  const result = await installConfiguredProviderAdapters(
    { adapters: [{ adapter_id: "official-a", mode: "production" }] },
    [selected, unlisted],
    { modelRuntime: runtime, pi: {} },
  );
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].adapter_id, "official-a");
  assert.ok(runtime.getProvider("official-provider-a"));
  assert.equal(runtime.getProvider("official-provider-b"), null, "unlisted catalog adapter must remain uninstalled");
});

test("P2 keeps exact-model sibling classification fail-closed", async () => {
  const runtime = new FakeModelRuntime();
  const candidate = externalAdapter({
    adapterId: "exact-model",
    providerId: "exact-model-provider",
    domainId: "external:exact-model",
    models: ["model-a", "unclassified-model"],
  });
  await assert.rejects(
    installConfiguredProviderAdapters(
      { adapters: [{ adapter_id: "exact-model", mode: "experimental-nonproduction" }] },
      [candidate],
      { modelRuntime: runtime, pi: {} },
    ),
    (error) => error?.code === "PROVIDER_ADAPTER_UNCLASSIFIED_MODELS",
  );
});
