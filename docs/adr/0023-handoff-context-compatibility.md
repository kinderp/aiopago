# ADR-0023 — Handoff compatibility for provider-neutral context domains

- **Status:** PROPOSED / P7 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36

P7 ratifies behavior already proven by the S1/S2 and S8 seams instead of replacing it.

A normal Pi `/model` change is an inference-engine change inside the same Pi session and must never invoke Aiopago full-session replacement. A true Aiopago handoff creates a fresh history-zero Pi session, carries the versioned provider-neutral context-domain binding/epoch through the manifest, and completes external rebind before `RESUME_READY` is emitted. If rebind cannot be established, continuity fails closed and no misleading `RESUME_READY` telemetry survives.

## Crash-idempotent rebind

The context-domain rebind is a durable mini-saga because base handoff continuity can already have persisted `RESUME_READY` when the process is lost. Rebind therefore uses this order:

1. validate the source cursor and durable remote binding;
2. persist the complete context epoch for the handoff, including source lineage, checkpoint and target root cursor;
3. persist one target-session cursor write;
4. update the in-process cursor book.

It deliberately does **not** use a durable `RESET -> SET` pair during handoff.

On retry after restart:

- same handoff epoch + source cursor means the process was lost after epoch persistence and before cursor rebase; Aiopago completes the target cursor write;
- same handoff epoch + target cursor means the durable rebind already completed; Aiopago returns idempotently without rewriting either record;
- an epoch whose handoff/checkpoint/binding/source/target lineage does not exactly match the manifest fails closed;
- any other cursor mismatch fails closed rather than guessing which context was delivered.

The replacement target cursor is the root of the new history-zero Pi session. The external provider has not acknowledged any replacement-session entry at rebind time; the durable context epoch carries the prior source lag/checkpoint baseline until the first successful external acknowledgement.

The public contract exposes the handoff binding version and a frozen compatibility-policy descriptor. `ContextAwareHandoffService`, manifest orchestration, cursor books, state stores and recovery machinery remain internal.

Acceptance evidence is the dedicated P7 contract gate, the P7 two-crash rebind gate, the supported-profile S1/S2 same-session model-switch test, S8 history-zero rebind test, S8 telemetry-ordering test and complete regression suite.

This ADR does not make `ChatGPT Normal` available; ADR-0016A Q1-Q7 remain independent transport gates.
