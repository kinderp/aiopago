# ADR-0017 — Provider-neutral public context-continuity surface

- **Status:** PROPOSED / P1 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36
- **Depends on:** ADR-0015, ADR-0016, ADR-0016A
- **Scope:** stable public contract selection only; no new provider transport and no roadmap widening

## 1. Context

The multi-model spike proved more implementation machinery than an external provider adapter should be allowed to depend on. The spike branch temporarily re-exported entire modules from `src/index.mjs`, including runtime storage, cursor books, synchronization coordinator, installer and handoff wiring.

Productization must not turn those implementation details into compatibility obligations merely because they exist and are tested.

ADR-0016 section 3.3 also used a conceptual binding sketch in which remote binding and cursor appeared as one object. The hardened implementation intentionally persists them separately: the remote binding identifies the durable provider/domain/thread relation, while the cursor identifies acknowledged position on a Pi session branch. ADR-0017 makes that separation precise for the product surface without changing the authority model of ADR-0015.

## 2. Decision

### D1 — One explicit public facade

External integrations use:

```js
import { ... } from "aiopago/context-continuity";
```

The package root may re-export the same selected symbols for convenience, but the subpath is the explicit contract boundary.

The facade version is `CONTEXT_CONTINUITY_PUBLIC_API_VERSION = "0.1.0"`.

### D2 — Public symbols are allowlisted, not inherited with `export *`

The public provider-neutral surface is limited to:

- context-domain schema/kinds and `createContextDomainDescriptor()`;
- provider-adapter schema/transport-support statuses and `defineProviderAdapter()`;
- cursor and transfer schema versions;
- deterministic `hydrateContextTransfer()` plus its default hydration budget;
- external context envelope version/prefix;
- durable binding and delivery schema versions.

A contract test owns the allowlist. Adding a new public symbol is therefore an explicit compatibility decision.

### D3 — Runtime implementation remains internal

The following are deliberately **not** public P1 contracts:

- `ContextDomainRegistry`;
- `ContextCursorBook` and `DurableContextCursorBook`;
- `ContextStateStore`;
- `ContextSyncCoordinator`;
- `installProviderAdapters()`;
- multi-model handoff coordinator/wiring;
- attribution implementation internals;
- raw journal/storage rows and SQL layout.

Aiopago may refactor those without forcing external adapters to migrate, provided the public contracts and persisted compatibility rules remain satisfied.

### D4 — Binding and cursor are separate durable contracts

The current durable `ContextDomainBinding` shape is:

```text
schema_version
binding_id
task_id
context_domain_id
provider_id
model_id?               # persisted as null when provider-default
usage_pool
transport_adapter_id
external_thread_id?     # opaque, optional, never credentials
status                  # currently ACTIVE
created_at
updated_at
```

The durable `ContextCursor` shape is separate:

```text
schema_version
session_id
entry_id?               # null means root/no acknowledged entry
branch_depth
```

The cursor is keyed by task/context-domain in Aiopago runtime state; it is not embedded in the remote binding. Advancing an acknowledged cursor therefore does not redefine the provider/thread identity.

### D5 — Delivery state is a persisted Aiopago protocol, not adapter-owned storage

The durable delivery protocol currently uses states:

```text
PREPARED
ACKNOWLEDGED
RECONCILIATION_REQUIRED
RETRY_APPROVED
```

Adapters do not write these records directly. Aiopago owns the state machine and advances the cursor only after acknowledged delivery. Restart with a prepared/ambiguous delivery must remain fail-closed and must not silently resend.

Only the delivery **schema version and semantics** are public in P1; the storage class and journal representation are internal.

### D6 — Transfer/hydration is pure contract; synchronization orchestration is not

`hydrateContextTransfer()` is public because it is deterministic, bounded and provider-neutral. The synchronization coordinator remains internal because it binds Pi session events, persistence, reconciliation and transport timing.

The public transfer contract does not authorize raw transcript dumps, unbounded tool output, hidden LLM summarization or provider-specific transport behavior.

### D7 — Provider installation stays Aiopago-owned

`defineProviderAdapter()` is public so an integration can declare its provider/domain/transport provenance.

`installProviderAdapters()` remains internal in P1 because it receives Aiopago/Pi runtime objects and durable context state. Making it public would expose orchestration/storage coupling before P2 has deliberately ratified installation and configuration semantics.

## 3. Consequences

### Positive

- external adapter authors get a small versioned dependency surface;
- spike internals can evolve during P2–P7 without accidental semver obligations;
- actual hardened binding/cursor persistence is documented instead of freezing the older conceptual combined sketch;
- package-level tests detect accidental public API expansion;
- ChatGPT-specific transport remains completely outside this decision.

### Negative / deferred

- P1 exposes schema versions for binding/delivery but does not yet expose standalone public validators for persisted snapshots;
- migration/version upgrade behavior remains P3 work;
- installation/configuration remains P2 work;
- mutation-capable tools remain deferred;
- `work_mix` remains absent.

## 4. Acceptance evidence

P1 is acceptable when:

1. `aiopago/context-continuity` resolves through the package export map;
2. its exported symbol set matches an explicit allowlist test;
3. package root exposes the same selected contract symbols but not multi-model runtime internals;
4. descriptor and adapter declaration work through the public facade;
5. existing S1–S8 and full regression tests remain green;
6. no `main` merge is performed before ADR-0016/0017 review and #36 scope acceptance.

## 5. Non-goals

- no real `ChatGPT Normal` adapter;
- no browser automation/private endpoint fallback;
- no automatic model routing;
- no generalized billing reconciliation;
- no public storage/SQL API;
- no public reconciliation coordinator;
- no widening of 0.2-E/#30.
