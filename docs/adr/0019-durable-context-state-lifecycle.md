# ADR-0019 — Durable context-state lifecycle and migration boundary

- **Status:** PROPOSED / P3 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36
- **Depends on:** ADR-0015, ADR-0016, ADR-0017, ADR-0018
- **Scope:** P3 durable lifecycle for cursor, binding, delivery journal and context epoch only

## 1. Context

The S1–S8 spike already persisted cursor, external-thread binding, delivery state and the post-handoff durable `baseline` in the Guardian journal. Durability alone is not a product migration contract: older/future payloads could otherwise be read as if their meaning were unchanged.

P3 must add version/migration behavior without making general GuardianStorage depend on optional multi-model provider internals and without rewriting historical operational evidence.

## 2. Decision

### D1 — Context state owns a feature-local migration ledger

P3 introduces:

```text
context_state_migrations
schema 1
```

This is deliberately separate from the general `schema_migrations` table. GuardianStorage remains the operational journal authority, but the optional context-continuity subsystem owns the lifecycle of its own payload contracts.

Constructing `ContextStateStore` performs the context-state preflight. Other Aiopago workflows that never install/use context continuity do not acquire a dependency on this feature schema.

### D2 — Adoption validates before it writes

Before the first context-state migration is recorded, Aiopago scans journal rows whose event keys belong to the `context-*` namespace and validates their event type and payload version.

If any row is invalid, future-versioned or unknown:

- `CONTEXT_STATE_MIGRATION_BLOCKED` is raised;
- the cause code and offending journal identity are retained in bounded error details;
- no context-state migration row is written;
- no context-state access index is created;
- historical `data_json` bytes are not rewritten.

Compatible legacy state is therefore *ratified*, not silently reinterpreted.

### D3 — Migration schema 1 is representation-preserving

Schema 1 recognizes the already-persisted 0.1.0 forms of:

- Pi cursor;
- external provider/thread binding;
- delivery state journal;
- post-handoff context epoch.

The migration writes only its migration/authority metadata. It never rewrites context journal rows.

Every new ContextStateStore append is validated through the same versioned validators before the journal write, and replay validates again before returning state.

### D4 — `baseline` is the storage-compatible name for ContextEpoch 0.1.0

The spike called the post-handoff lineage object a durable `baseline`. P3 ratifies its exact existing wire shape as:

```text
CONTEXT_EPOCH_SCHEMA_VERSION = 0.1.0
```

Its semantics are:

- source Pi session/cursor and source tail;
- target fresh Pi session/cursor;
- handoff + checkpoint identity;
- durable provider binding identity when available;
- lag count;
- `durable_checkpoint_epoch` rebase policy.

`ContextStateStore.getEpoch/setEpoch/clearEpoch` are now the semantic methods. `getBaseline/setBaseline/clearBaseline` remain compatibility aliases and keep the historical `CONTEXT_BASELINE_*` journal event names/payload key. This avoids a fake migration that would merely rename durable bytes.

The provider-neutral facade exposes only `CONTEXT_EPOCH_SCHEMA_VERSION`, not the state store, migration machinery or validators. The additive facade version becomes `0.3.0`.

### D5 — Future context-state storage fails closed

If `context_state_migrations` contains a version newer than this implementation, startup of the context-continuity subsystem fails with `CONTEXT_STATE_STORAGE_VERSION_UNSUPPORTED`.

The deterministic remediation is: use an Aiopago version compatible with that writer; do not downgrade or delete state. If the operator intentionally abandons continuity, archive `guardian.sqlite` and its `-wal`/`-shm` sidecars before an explicit reinitialization. Aiopago never performs this destructive action automatically.

### D6 — Schema versions are semantic gates

For schema 0.1.0, unknown fields, unknown delivery states, unsupported rebase policy, scope mismatch and cursor/session inconsistency fail closed. A future producer must bump the relevant schema instead of relying on an old reader to ignore semantic changes.

## 3. Consequences

### Positive

- existing compatible runtime state upgrades without journal mutation;
- future/corrupt context state cannot masquerade as current state;
- migration ownership remains local to the feature that understands the payload;
- Pi-session lineage becomes an explicit versioned ContextEpoch contract;
- restart behavior uses the same validators as live writes.

### Cost

ContextStateStore startup validates the existing `context-*` journal namespace. This is intentional for P3 correctness. If operational evidence volume later makes the scan material, a future migration may add a validated watermark/index without weakening fail-closed behavior.

## 4. Acceptance evidence

P3 is acceptable when tests prove:

1. compatible pre-P3 cursor/binding/delivery/baseline rows migrate without byte rewrite;
2. migration metadata is recorded only after validation;
3. an incompatible legacy payload blocks migration with deterministic remediation;
4. a future context-state storage schema blocks downgrade before the access index is created;
5. malformed epoch lineage is rejected rather than inferred;
6. cursor, binding, delivery and epoch survive a process-style restart under versioned replay validation;
7. the public facade exposes epoch version but not storage/migration internals;
8. P1/P2/P3 targeted gates, S1–S8 and the complete historical regression remain green.

## 5. Deferred / non-goals

- P4 mutation-capable external tool policy;
- P5 operator-facing model/domain UX;
- P6 reconciliation operator workflow;
- automatic provider routing;
- browser automation, cookies, DOM scraping or private ChatGPT endpoints;
- any API fallback labeled `ChatGPT Normal`;
- empirical billing/quota claims;
- any merge to `main` before the stacked productization review is accepted.
