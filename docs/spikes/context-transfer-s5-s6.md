# Spike #32 — S5/S6 context cursor and bounded hydration

**Date:** 2026-09-02  
**Status:** EXECUTED PROTOTYPE / TARGETED TESTS PASS; PRODUCTION DURABILITY NOT YET CLOSED  
**Transport:** provider-neutral; no ChatGPT web automation

## S5 — Context cursor prototype

`ContextCursorBook` uses the stable `id` values on Pi session entries from the active branch (`SessionManager.getBranch()`).

A cursor is not a token position and does not pretend to know a provider's hidden context state. It records only the Pi-side acknowledgement boundary:

```text
session_id
entry_id
branch_depth   # diagnostic only
```

Transfer is explicit two-phase state:

```text
plan(domain, sessionManager)
   -> source cursor
   -> target cursor
   -> entries in (source, target]

commit / acknowledge
   -> advance cursor only after target acknowledgement
```

Properties demonstrated by the spike:

- planning does not advance the watermark;
- repeated planning from the same acknowledged tail is deterministic;
- stale commits fail with `CONTEXT_CURSOR_STALE_COMMIT`;
- if the acknowledged entry is no longer on the active Pi branch, planning fails with `CONTEXT_CURSOR_DIVERGED` rather than silently merging branches;
- a cursor from another Pi session fails with `CONTEXT_CURSOR_SESSION_MISMATCH`;
- S8 can explicitly rebase the domain into a history-zero replacement Pi session using checkpoint/handoff provenance.

### Independent-review durability finding

The current `ContextCursorBook` is an **in-memory prototype**. S8 seals cursor/lag metadata into an explicit handoff manifest, but an ordinary Runner crash/restart outside that handoff does not yet persist the acknowledged watermark or an in-flight transfer intent.

That means S5's algorithm is validated, but ADR-0016 D6's production requirement for a durable/observable external-domain cursor is **not closed yet**. A production slice must persist at least:

- acknowledged cursor;
- in-flight transfer identity/source/target cursor;
- reconciliation-required state after ambiguous interruption;
- context-domain/session epoch binding.

After restart, an unresolved in-flight transfer must fail closed rather than be resent automatically.

## S6 — Deterministic Context Hydrator prototype

`hydrateContextTransfer()` converts a planned delta into a bounded provider-neutral bundle.

Priority is intentionally **durable state before transcript**:

1. Task/Ledger identity, objective, next step, decisions and tests;
2. bounded Git identity/status projection;
3. bounded recent user/assistant/model-change/summary entries;
4. explicitly supplied bounded evidence such as selected diff/file excerpts.

Raw tool results are excluded from recent context by default. Tool results explicitly required for an external provider's own Pi tool round-trip use a separate bounded protocol surface.

Default hydration limits:

```text
max_entries             16
max_total_chars         12000
max_entry_chars          2000
max_evidence_items          8
max_git_status_entries     64
max_metadata_chars        512
```

Protocol-level live user input and tool results have separate bounded limits. Truncation is explicit: the live user field carries `text`, `truncated`, and `original_chars`; tool-result and hydration projections expose their own truncation metadata.

There is no LLM compaction call in this path.

### Secret gate

Independent review found that the first implementation reused the ArtifactStore secret scanner only for sealed artifacts, not for the outbound context capsule. This is now corrected: the complete external transfer envelope is passed through the shared secret-shaped key/value scan **before** `transferMessage()` is created. A rejected secret creates no pending external request.

This is a fail-closed guard, not a claim that regex scanning is a complete DLP system. Production policy may later add stronger repository-specific redaction/classification.

## Failure semantics added by review

A remote `error` or `aborted` assistant turn no longer leaves the old transfer silently pending. Aiopago records an in-memory `RECONCILIATION_REQUIRED` state and blocks the next projection until an explicit `retry-from-last-acknowledged` action is chosen.

This closes the silent stale-replay bug in the live process, but persistence of that reconciliation state across Runner crash/restart remains part of the durability work above.

## Tests

`test/context-transfer-spike.test.mjs` covers:

- first transfer and explicit acknowledgement;
- post-watermark delta only;
- idempotent empty next delta;
- stale commit rejection;
- branch divergence fail-closed;
- project/Git/provenance projection;
- raw tool-result exclusion;
- hydrated evidence source retention;
- strict small-budget truncation.

`test/context-sync-safety-spike.test.mjs` adds adversarial review gates for:

- secret-shaped outbound content rejection before transport;
- explicit reconciliation after provider error;
- visible live-user truncation metadata;
- read-only external Pi tool policy;
- fail-closed experimental transport eligibility;
- rejection of unclassified sibling models.

These targeted gates execute in GitHub Actions on Node 22.19.0 + Pi 0.83.0.

## Relationship to blocked ChatGPT transport

ADR-0016A rejects consumer-web response scraping and requires an officially supported ChatGPT transport. S5/S6 remain useful because they are transport-neutral: the same cursor/bundle machinery can be hardened independently and connected to an eligible official transport later.

The provider-neutral foundation should not be merged as production-ready until restart durability/in-flight reconciliation is implemented and tested. The real ChatGPT thread binding remains transport-dependent and is intentionally not fabricated by the fake transport.
