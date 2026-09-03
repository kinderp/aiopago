# ADR-0023 — Handoff compatibility for provider-neutral context domains

- **Status:** PROPOSED / P7 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36

P7 ratifies behavior already proven by the S1/S2 and S8 seams instead of replacing it.

A normal Pi `/model` change is an inference-engine change inside the same Pi session and must never invoke Aiopago full-session replacement. A true Aiopago handoff creates a fresh history-zero Pi session, carries the versioned provider-neutral context-domain binding/epoch through the manifest, and completes external rebind before `RESUME_READY` is emitted. If rebind cannot be established, continuity fails closed and no misleading `RESUME_READY` telemetry survives.

The public contract exposes the handoff binding version and a frozen compatibility-policy descriptor. `ContextAwareHandoffService`, manifest orchestration, state stores and recovery machinery remain internal.

Acceptance evidence is the dedicated P7 contract gate plus the existing supported-profile S1/S2 same-session model-switch test, S8 history-zero rebind test, S8 telemetry-ordering test and complete regression suite.

This ADR does not make `ChatGPT Normal` available; ADR-0016A Q1-Q7 remain independent transport gates.
