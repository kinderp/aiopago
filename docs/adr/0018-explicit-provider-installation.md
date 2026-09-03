# ADR-0018 — Explicit provider installation configuration

- **Status:** PROPOSED / P2 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36
- **Depends on:** ADR-0015, ADR-0016, ADR-0017
- **Scope:** provider-neutral P2 configuration/installation only; no transport implementation and no automatic routing

## 1. Context

P1 deliberately made provider declaration public while keeping `installProviderAdapters()` internal because that function receives Pi/Aiopago runtime objects, registry ownership and durable state. P2 must now make installation explicit without reversing that boundary.

The spike also has two distinct external transport trust levels: `official-supported` and `experimental-nonproduction`. A product configuration must not turn a broad boolean into an accidental authorization for every experimental adapter present in a process.

## 2. Decision

### D1 — Public configuration is declarative and versioned

`aiopago/context-continuity` exposes:

```text
PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION = 0.1.0
PROVIDER_INSTALLATION_MODES = [production, experimental-nonproduction]
defineProviderInstallationConfig(...)
```

The context-continuity public facade advances additively to `0.2.0`.

A normalized configuration contains only:

```json
{
  "schema_version": "0.1.0",
  "adapters": [
    { "adapter_id": "example", "mode": "production" }
  ]
}
```

Unknown root/entry fields, unsupported schema versions, duplicate adapter IDs and unknown installation modes fail closed. The returned configuration is immutable.

### D2 — Presence in an adapter catalog is not installation authority

An adapter is eligible for installation only when its `adapter_id` appears in the explicit configuration. A catalog may contain additional adapters; they remain uninstalled.

There is no automatic provider/model routing in P2. Pi `/model` remains the user-facing model-selection mechanism.

### D3 — Experimental admission is per adapter

An `external-stateful` adapter whose transport is `experimental-nonproduction` cannot be selected with installation mode `production`.

It may be installed only when that exact adapter has:

```json
{ "adapter_id": "...", "mode": "experimental-nonproduction" }
```

The public API does not expose the internal `allowExperimentalExternal` switch. Runtime installation derives that internal permission only from the validated explicit selection set.

### D4 — Production external adapters require official transport provenance

A configured `external-stateful` adapter in `production` mode must already satisfy the P1 adapter contract for `official-supported` transport, including documentation reference, usage-pool claim/evidence and claim/domain consistency.

P2 does not treat configured `usage_pool` labels as empirical billing or quota proof.

### D5 — Runtime installation remains internal

`installConfiguredProviderAdapters()` is an Aiopago implementation function, not part of `aiopago/context-continuity` or package-root public API.

It owns the bridge from public declarations to internal:

- Pi `ModelRuntime`;
- context-domain registry;
- durable context state/binding restoration;
- existing `installProviderAdapters()` safety checks.

External adapter authors therefore do not receive storage or orchestration ownership merely to participate in installation.

### D6 — Existing model-classification safety remains authoritative

Provider-default context descriptors may classify all models from that provider. Exact-model descriptors remain fail-closed when a provider exposes sibling models that the adapter does not classify.

P2 reuses the existing installer check; it does not create a parallel classification policy.

## 3. Consequences

### Positive

- installation intent is inspectable and deterministic;
- experimental transport opt-in is narrow and per adapter;
- catalog discovery cannot silently activate a provider;
- public configuration remains independent from Pi runtime/storage internals;
- production transport provenance requirements remain centralized in the adapter contract.

### Deferred

- durable state migration/version behavior remains P3;
- mutation-capable external tools remain deferred;
- automatic routing remains excluded;
- real `ChatGPT Normal` remains gated by ADR-0016A Q1–Q7.

## 4. Acceptance evidence

P2 is acceptable when tests prove that:

1. installation config is strict, versioned and immutable;
2. an empty config installs nothing even when adapters exist in the catalog;
3. production mode rejects experimental external transport before provider registration;
4. experimental external transport requires an explicit per-adapter non-production selection;
5. official-supported external transport can install in production mode;
6. unlisted catalog adapters remain uninstalled;
7. exact-model sibling classification remains fail-closed;
8. installer/runtime internals remain absent from the public facade and package root;
9. targeted P1/P2, S1–S8 and complete regression CI remain green.

## 5. Non-goals

- no ChatGPT browser automation, cookies, DOM scraping or private endpoints;
- no API fallback labeled `ChatGPT Normal`;
- no public ModelRuntime/registry/state-store API;
- no automatic model/provider routing;
- no generalized billing reconciliation;
- no widening of 0.2-E/#30;
- no merge to `main` before the stacked architecture/productization review is accepted.
