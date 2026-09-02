# Spike #32 — S5/S6 context cursor and bounded hydration

**Date:** 2026-09-02  
**Status:** IMPLEMENTED / EXECUTION EVIDENCE PENDING  
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

commit(window)
   -> advance cursor only after target acknowledgement
```

Properties required by the spike:

- planning does not advance the watermark;
- repeated planning from the same acknowledged tail is deterministic;
- stale commits fail with `CONTEXT_CURSOR_STALE_COMMIT`;
- if the acknowledged entry is no longer on the active Pi branch, planning fails with `CONTEXT_CURSOR_DIVERGED` rather than silently merging branches;
- a cursor from another Pi session fails with `CONTEXT_CURSOR_SESSION_MISMATCH` in this slice.

Cross-session rebinding is intentionally deferred to S8. It must be explicit and checkpoint-aware rather than weakening the same-session guard.

## S6 — Deterministic Context Hydrator prototype

`hydrateContextTransfer()` converts a planned delta into a bounded provider-neutral bundle.

Priority is intentionally **durable state before transcript**:

1. Task/Ledger identity, objective, next step, decisions and tests;
2. bounded Git identity/status projection;
3. bounded recent user/assistant/model-change/summary entries;
4. explicitly supplied bounded evidence such as selected diff/file excerpts.

Raw tool results are excluded from recent context by default. A large `pytest`, `grep` or shell transcript therefore does not get copied merely because it exists in the Pi session.

Default limits:

```text
max_entries             16
max_total_chars         12000
max_entry_chars          2000
max_evidence_items          8
max_git_status_entries     64
max_metadata_chars        512
```

All limits are deterministic; there is no LLM compaction call in this path. The result exposes `truncated` and `remaining_chars` so a future adapter/UI can make loss/budget visible.

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

Execution evidence remains pending in this environment.

## Relationship to blocked ChatGPT transport

ADR-0016A rejects consumer-web response scraping and requires an officially supported ChatGPT transport. S5/S6 remain useful because they are independent of the transport: the same cursors/bundles can be tested with fake/adversarial transports now and connected to an eligible official transport later.
