# ADR-0021 — External-stateful read/query-only tool profile

- **Status:** PROPOSED / P5 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36
- **Depends on:** ADR-0015 through ADR-0020

## Decision

The first supported external-stateful Pi tool surface is a closed, versioned profile:

```text
profile: external-stateful-read-query-only
admitted: read, grep, find, ls
mutation: deferred
```

Admission requires both: (1) the tool name is in this exact P5 allowlist and the context domain advertises `pi_tools=true`; and (2) the generic Aiopago safety core still classifies that tool as `READ_ONLY`.

This is deliberately a double gate. Adding a new generic read-only tool does not automatically expose it externally. Reclassifying an admitted tool as mutating causes external admission to fail closed. Pi-native providers remain outside this external-only profile and keep existing Pi/Aiopago tool semantics.

The public `aiopago/context-continuity` facade exposes only the frozen profile metadata/version. The admission evaluator and extension wiring stay internal.

## Deferred

`edit`, `write`, `bash` and every mutation-capable external tool remain blocked. A later gate must define cancellation, interruption, result correlation and effect evidence before any such capability can be admitted.

## Acceptance

P5 requires tests proving the exact closed allowlist, `pi_tools=false` denial, generic-profile drift can only narrow the surface, mutation/unknown tools never reach ToolOperationTracker for external domains, Pi-native behavior is unchanged, and P1-P5 + S1-S8 + full regression remain green.
