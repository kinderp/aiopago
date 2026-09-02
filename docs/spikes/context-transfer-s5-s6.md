# Spike #32 — S5/S6 context cursor and bounded hydration

**Date:** 2026-09-02  
**Status:** EXECUTED / DURABLE RESTART GATES PASS; PRODUCTION CHATGPT TRANSPORT BLOCKED  
**Transport:** provider-neutral; no ChatGPT web automation

## S5 — Context cursor and durable state

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

### Durability closure after independent review

The first implementation kept `ContextCursorBook` only in memory. The review branch closes that gap with `ContextStateStore` and `DurableContextCursorBook` in `src/context-state.mjs`.

Context continuity state is persisted through the existing append-only `GuardianStorage.journal`; the added index changes lookup cost only and does **not** introduce a second authority beside the existing runtime SQLite journal.

The durable state now covers:

- acknowledged external-domain cursor;
- external context-domain binding identity;
- opaque external conversation/thread identifier when a transport supplies one;
- handoff/rebind baseline;
- external delivery intent and source/target cursors;
- explicit `PREPARED`, `RECONCILIATION_REQUIRED`, `RETRY_APPROVED`, and `ACKNOWLEDGED` delivery states.

The remote thread identifier is treated as opaque transport data: it is bounded, conflict-safe and checked by the shared outbound safety policy. Once a domain is bound to a non-null remote thread ID, a conflicting ID fails closed rather than silently rebinding the project to another remote conversation.

Cursor persistence is ordered before delivery acknowledgement. If the process dies between those two durable writes, restart observes the still-`PREPARED` delivery and fails closed instead of replaying it.

A `PREPARED` delivery found after process-style reconstruction therefore requires explicit reconciliation; it is never silently resent. This closes ADR-0016 D6's restart-durability requirement for the provider-neutral mechanics.

## S6 — Deterministic Context Hydrator

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

### Outbound safety gate

Independent review found that the first implementation reused the artifact safety scan only for sealed artifacts, not for the outbound context capsule. This is now corrected: the complete external transfer envelope is checked by the shared outbound safety scan **before** `transferMessage()` is created. A rejected capsule creates no pending external request.

The durable binding and baseline surfaces are checked by the same policy. This is a fail-closed guard, not a claim that the current pattern scan is a complete DLP system. Production policy may later add stronger repository-specific redaction/classification.

## Failure and restart semantics

A remote `error` or `aborted` assistant turn records `RECONCILIATION_REQUIRED` and blocks the next projection until an explicit retry-from-last-acknowledged decision is made.

That state is no longer process-local. The delivery lifecycle lives in the same authoritative runtime journal and survives `GuardianStorage` close/reopen. A restart with unresolved `PREPARED` or `RECONCILIATION_REQUIRED` state cannot silently replay the transfer.

The same restart reconstruction also restores the durable external-thread binding and the handoff baseline used to re-establish the context domain without relying on Pi conversation history.

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

- outbound safety rejection before transport;
- explicit reconciliation after provider error;
- visible live-user truncation metadata;
- read-only external Pi tool policy;
- fail-closed experimental transport eligibility;
- official-transport metadata eligibility;
- rejection of unclassified sibling models.

`test/context-state-durability-spike.test.mjs` adds process-style restart gates for:

- acknowledged cursor surviving `GuardianStorage` restart without replay;
- durable, opaque and conflict-safe remote conversation binding;
- unresolved `PREPARED` delivery becoming reconciliation-required after restart and never silently replaying;
- provider adapter receiving the restored remote-thread binding;
- durable handoff baseline surviving state reconstruction.

The final review CI profile runs Node 22.19.0 with `@earendil-works/pi-coding-agent@0.83.0` and `@earendil-works/pi-ai@0.83.0`. On the reviewed head, `npm run check` validates 65 modules; all targeted S1-S8 gates pass and the complete historical suite reports **689/689 tests PASS**, with zero failures, skips or cancellations.

## Relationship to blocked ChatGPT transport

ADR-0016A rejects consumer-web response scraping and requires an officially supported ChatGPT transport. S5/S6 are transport-neutral and their provider-neutral durability mechanics are now closed for the reviewed profile.

What remains blocked is not cursor/restart durability but the product-specific edge: an eligible official OpenAI transport for `ChatGPT Normal`, plus empirical proof that requests through it consume the intended normal ChatGPT usage pool rather than API or Codex accounting.
