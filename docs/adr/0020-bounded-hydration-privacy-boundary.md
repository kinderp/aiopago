# ADR-0020 — Bounded hydration and outbound privacy boundary

- **Status:** PROPOSED / P4 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36
- **Depends on:** ADR-0015 through ADR-0019
- **Scope:** P4 deterministic hydration/provenance/truncation/privacy only; tool admission remains P5

## 1. Context

The S5/S6 spike already proved a bounded deterministic hydrator and excluded Pi `toolResult` entries from ordinary context hydration. The external tool loop separately carried the result of a tool requested by the external model so that the same model could continue its turn.

Those two paths must not be conflated in the supported product contract. Otherwise “raw tool output excluded by default” could either be violated by historical replay or interpreted so broadly that a legitimate read/query tool continuation becomes impossible.

## 2. Decision

### D1 — Hydration contract 0.2.0 has a fixed privacy profile

`CONTEXT_TRANSFER_SCHEMA_VERSION` becomes `0.2.0` and exposes a versioned default policy:

```text
strategy           durable-state-first-bounded
projection order   project -> git -> hydrated_evidence -> recent_context
recent context     post-watermark projection only
raw tool output    excluded from hydration
transcript dump    false
summarization      none
```

There is deliberately no public `include_raw_tool_results` switch in P4.

The public context-continuity facade advances additively to `0.4.0` at the P4 slice; later slices may advance the facade again without changing this privacy policy.

### D2 — Durable/evidence state has budget priority

The hydrator allocates its bounded character budget in this order:

1. authoritative Task Ledger projection;
2. Git observation projection;
3. caller-provided evidence with source reference where available;
4. bounded post-watermark Pi user/assistant/model-change/summary projection.

Pi `toolResult` entries are counted as excluded but their text is never copied into hydration.

No raw `window.entries` array is returned.

### D3 — Truncation is explicit and attributable

Hydration now reports a structured `truncation` object with:

- `truncated`;
- stable reason codes;
- emitted character count;
- remaining character budget.

Recent/evidence items also expose original length and whether their text was individually clipped. Count limits (`max_entries`, `max_evidence_items`, `max_git_status_entries`) and character/metadata limits have distinct reason codes.

Unknown hydration budget fields fail closed rather than silently changing semantics.

### D4 — Provenance references travel with projected content

Where the source identity is already available, the transfer includes bounded source refs for:

- Task Ledger task/revision;
- Git repository/head;
- evidence source;
- Pi entry ID for recent context.

P4 does not invent provenance that Aiopago does not possess.

### D5 — Live tool continuation is not historical hydration

`protocol_tool_results` remains an internal sync-envelope surface required by the already-validated external tool loop, but is explicitly labeled:

```text
purpose              live-correlated-tool-continuation
historical_hydration false
```

A post-watermark `toolResult` is eligible only when replay of the Pi branch establishes one unambiguous outstanding tool call with the same `toolCallId`, the same tool name and ownership by the selected external context domain. A tool result closes that outstanding slot. Sequential reuse of an ID after its result is therefore independent; overlapping reuse/collision is treated as ambiguous and excluded fail-closed. A matching ID owned by another model/domain is never enough to carry its result into the external continuation.

Every admitted result carries Pi-entry provenance and its own truncation metadata. This is not an option to replay arbitrary historical tool stdout. P5 separately decides which tool names external-stateful domains may invoke; the product profile remains read/query-only there.

### D6 — Complete outbound envelope is scanned after assembly

The sync envelope advances to `0.2.0` and contains a versioned `privacy_boundary` plus aggregate outbound truncation reasons.

The shared `assertNoSecrets()` scan runs over the **complete final envelope** after hydration, live user input and correlated tool continuation are assembled, and before:

- durable delivery `PREPARED` state;
- pending transport state;
- construction of the provider message.

A secret-shaped value in any of those surfaces therefore fails closed before external transport.

### D7 — No transcript dump and no hidden summarizer

The hydrator is a deterministic local projection. It performs no model call and no summarization request. It may pass through an already-existing Pi compaction/branch summary as a bounded post-watermark entry, but P4 itself never creates one.

A provider receives one Aiopago capsule rather than the Pi transcript.

## 3. Consequences

### Positive

- privacy semantics are inspectable rather than implicit;
- durable facts and evidence cannot be starved by recent conversation until their own shared budget is exhausted;
- raw tool history stays outside hydration;
- live read/query continuation remains possible without hidden Codex;
- tool-call ID collisions across models fail closed instead of leaking another model's result;
- truncation can be surfaced truthfully to operators/telemetry;
- final secret scanning covers every outbound payload class.

### Deferred

- P5 read/query-only admission vocabulary;
- P6 telemetry/attribution product surface;
- P7 final handoff compatibility ratification;
- any mutation-capable external tool;
- any ChatGPT Normal transport or quota claim.

## 4. Acceptance evidence

P4 is acceptable when tests prove:

1. identical inputs hydrate byte/structure-deterministically;
2. durable/evidence projection wins budget priority over recent conversation;
3. raw tool text is excluded from hydration and no raw transcript window is exposed;
4. truncation reasons/counts are explicit;
5. available Task/Git/evidence/Pi-entry provenance survives projection;
6. unknown budget fields fail closed;
7. live external tool continuation is correlated, separate, bounded and explicitly truncated;
8. cross-model tool-call ID collisions and tool-name mismatches are excluded fail-closed;
9. a secret-shaped value in an actually correlated live continuation fails before pending/transport state;
10. P1-P4 targeted gates, S1-S8 and complete historical regression remain green.

## 5. Non-goals

- no mutation-capable external tools;
- no public transcript export surface;
- no LLM summarizer call;
- no automatic routing;
- no browser automation/cookies/private ChatGPT endpoints;
- no API fallback labeled `ChatGPT Normal`;
- no merge to `main` before stacked review acceptance.
