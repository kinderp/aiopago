# ADR-0018 — Explicit provider installation configuration

- **Status:** PROPOSED / P2 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36
- **Depends on:** ADR-0015, ADR-0016, ADR-0017
- **Scope:** provider-neutral P2 configuration/installation only; no transport implementation and no automatic routing

## 1. Context

P1 made provider declaration public while keeping runtime installation and durable continuity state under Aiopago authority. P2 makes installation explicit without reversing that boundary.

External transports have two trust levels: `official-supported` and `experimental-nonproduction`. Configuration must not turn broad process state into accidental authorization for every adapter present in a catalog.

## 2. Decision

### D1 — Public configuration is declarative and versioned

`aiopago/context-continuity` exposes `PROVIDER_INSTALLATION_CONFIG_SCHEMA_VERSION`, `PROVIDER_INSTALLATION_MODES` and `defineProviderInstallationConfig(...)`.

A normalized configuration contains only a schema version plus explicit `{adapter_id, mode}` entries. Unknown fields, unsupported versions, duplicate IDs and unknown modes fail closed. Normalized output is immutable.

### D2 — Catalog presence is not installation authority

Only adapter IDs explicitly selected by configuration are eligible for installation. Unlisted catalog adapters stay inactive. Pi `/model` remains the user-facing model-selection mechanism; P2 introduces no automatic routing.

### D3 — Experimental admission is per adapter

An `external-stateful` adapter with `experimental-nonproduction` transport cannot be selected in production mode. Experimental permission is derived from that exact validated selection; it is not a public global switch.

### D4 — Production external adapters require declared transport provenance

A production external adapter must satisfy the `official-supported` adapter contract, including documentation reference and usage-pool claim/evidence consistency. A configured usage-pool label is not billing/quota proof.

### D5 — Runtime installation and continuity state authority remain internal

`installConfiguredProviderAdapters()` and `installProviderAdapters()` are implementation functions, not public facade exports.

An adapter install callback receives only the Pi objects needed to register its provider plus an immutable snapshot of any restored remote binding. It never receives `ContextStateStore`, cursor state, delivery state, reconciliation state or context-epoch mutation APIs.

When an external transport later creates or discovers its opaque remote conversation identifier, Aiopago may provide one narrow capability:

```text
bindExternalThread(externalThreadId)
```

That capability is disabled until provider registration and model classification have completed successfully. It can only bind the configured context domain's remote thread identifier. It cannot mutate any other continuity state.

### D6 — Every adapter object is revalidated at installation

A matching `schema_version` tag is not proof that a caller-supplied adapter is valid. Installation re-runs the public adapter validator before trust decisions.

Provider-default descriptors may classify all models from their provider. Exact-model descriptors remain fail-closed when sibling models are exposed without classification.

## 3. Consequences

Installation intent is explicit and deterministic; experimental opt-in is narrow; catalog discovery cannot activate providers; adapter code cannot acquire Aiopago journal authority; remote-thread persistence remains possible through a minimal capability; production provenance checks stay centralized.

P3 owns durable-state migration semantics. Mutation-capable external tools and automatic routing remain deferred. A real ChatGPT Normal transport remains independently gated by ADR-0016A.

## 4. Acceptance evidence

P2 is acceptable when tests prove strict immutable configuration, empty-config no-op, production rejection of experimental transport, explicit experimental opt-in, production installation with required provenance, unlisted adapter exclusion, exact-model sibling fail-closed behavior, install-boundary revalidation, absence of raw ContextStateStore from adapter install context, pre-validation binding denial, post-validation narrow thread binding, and green supported-profile regression.

## 5. Non-goals

No public ModelRuntime/registry/state-store API, no automatic model/provider routing, no generalized billing reconciliation, no widening of 0.2-E/#30, and no merge to `main` before the stacked architecture/productization review is accepted.
