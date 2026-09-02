# ADR-0016 — Multi-model context-domain continuity and ChatGPT adapter boundary

- **Status:** PROPOSED
- **Date:** 2026-09-02
- **Issue:** #32
- **Depends on:** ADR-0015
- **Scope:** architecture/spike contract; no production browser automation in this ADR

## 1. Context

Aiopago currently provides durable continuity across Pi coding sessions by treating the conversation as temporary and reconstructing work from authoritative project state: the Master Task Ledger, Git state, sealed checkpoint/manifest artifacts, runtime ownership and bounded semantic reads. The current handoff creates a fresh Pi session with zero copied conversation history.

The new requirement is different but related: the user wants one Pi experience and one logical project context while switching inference engines with Pi's normal `/model` command. In particular, `ChatGPT Normal` should be selectable beside `openai-codex` and other Pi-native providers while preserving separate ChatGPT-vs-Codex usage pools.

The target UX is:

```text
Pi session
   |
 /model
   |
   +-- ChatGPT Normal   -> normal ChatGPT product/session
   +-- OpenAI Codex     -> Codex provider/quota
   +-- Claude/Gemini/...-> ordinary Pi-native providers
```

The user must not manage a second `/lane` abstraction. The exceptional synchronization behavior of ChatGPT is an internal continuity concern.

## 2. Decision

### D1 — `/model` is the user-facing switch

`DECIDED`

Aiopago does not introduce a required `/lane` command. The normal Pi `/model` picker remains authoritative for user-facing model selection.

A convenience hotkey may later toggle frequently used models, but it must remain a shortcut for model selection, not a second model-routing state machine.

### D2 — Model and context domain are distinct concepts

`DECIDED`

A **model** identifies the inference engine selected in Pi.

A **context domain** identifies where conversational/provider state lives and what synchronization semantics are required.

At minimum the spike must distinguish:

1. `pi-native` — context is represented by the Pi session and can be handed to ordinary Pi providers using Pi's supported model/provider semantics;
2. `external-stateful` — context also exists in an external conversational thread that can lag behind the Pi session and therefore requires cursor/watermark synchronization.

`ChatGPT Normal` is the first `external-stateful` context domain.

Claude, Gemini, local models and Codex are not separate Aiopago lanes merely because they are different models. When they operate through normal Pi semantics, `/model` is sufficient.

### D3 — ChatGPT Normal is a custom Pi provider/model

`PROPOSED / REQUIRES SPIKE`

The preferred integration surface is a Pi custom provider/model exposed in the normal `/model` picker.

The provider must use the normal ChatGPT product/session rather than silently falling back to OpenAI API billing or the Codex provider. The spike must empirically prove transport isolation before this can become `DECIDED`.

### D4 — Aiopago owns continuity, not ChatGPT transport

`DECIDED`

Aiopago owns provider-neutral continuity concerns:

- logical project continuity;
- context-domain identity and binding;
- cursors/watermarks;
- context transfer manifests;
- bounded context hydration policy;
- Git/ledger/evidence provenance;
- telemetry and attribution;
- durable Pi-session handoff compatibility.

ChatGPT-specific implementation details do **not** belong in the Aiopago core:

- browser automation;
- DOM selectors;
- browser profile/session management;
- ChatGPT page lifecycle;
- cookie/token handling;
- site-specific streaming extraction.

Those concerns live behind a versioned adapter/transport boundary, provisionally named `aiopago-chatgpt-adapter`.

### D5 — No generic bidirectional synchronization

`DECIDED`

ADR-0015 remains authoritative. There is no last-write-wins synchronization among Pi, ChatGPT, Git and the Ledger.

Authority remains category-specific:

- project/task plan: Master Task Ledger;
- technical filesystem state: Git/repository;
- durable checkpoint/transfer artifacts: Aiopago sealed artifacts;
- runtime control state: Aiopago runtime storage;
- remote ChatGPT thread: transport/conversation state, not project authority.

A ChatGPT response may propose a decision, but it does not silently mutate the Ledger or become durable authority merely because it exists in the remote thread.

### D6 — Context synchronization is incremental

`DECIDED`

Each external-stateful context domain maintains a durable/observable cursor or watermark identifying the logical Pi/project state already transferred to that domain.

On model selection into an external-stateful domain:

```text
project/Pi state now = N
external domain cursor = K
transfer delta = (K, N]
```

Only the required delta is transferred. The system must not resend the entire Pi transcript by default.

The cursor identifies transfer provenance; it must not imply that a provider exposes or accepts an exact internal token/context position.

### D7 — ChatGPT requires bounded hydration of local evidence

`DECIDED`

A normal Pi-native coding model can read repository files and Git state through Pi tools after model selection. An external ChatGPT thread cannot be assumed to see the local filesystem.

Therefore Aiopago introduces a provider-neutral **Context Hydrator** boundary. For a target domain without direct local-file visibility, it may materialize bounded evidence such as:

- current objective and next step;
- accepted/relevant decisions;
- Git branch/HEAD/status;
- files changed since the target watermark;
- bounded diff excerpts;
- selected file excerpts;
- test/build outcomes;
- unresolved findings and risks.

Whole repositories, unlimited command output and full transcripts are excluded by default.

Hydration must preserve source/provenance references where possible and must pass existing secret/redaction constraints before transport.

### D8 — ChatGPT Normal should remain agentic through Pi

`PROPOSED / REQUIRES SPIKE`

The target capability is not a chat-only provider. ChatGPT Normal should be able to request Pi-mediated tools such as read/edit/write/bash/Git through the custom provider contract.

The first spike gate requires at least a safe read-tool round trip. Mutation/tool expansion is admitted only after tool-call serialization, result correlation, cancellation and failure semantics are demonstrated.

Codex must never be invoked as a hidden executor for ChatGPT tool calls.

### D9 — Usage pools and work attribution are separate metrics

`DECIDED`

Aiopago must not conflate provider usage with contribution to the project.

The telemetry model may expose at least:

- current model/provider;
- current usage pool (`chatgpt`, `codex`, provider API/subscription, `local`, etc.);
- Pi context usage when Pi exposes an authoritative measure;
- external remote-context estimate only when clearly marked as estimated;
- turns and provider calls;
- tool calls;
- files/lines changed with attribution where technically defensible;
- tests/builds initiated;
- accepted/recorded decisions with provenance.

A derived `work_mix` score may be displayed later, but it must be documented as a heuristic with visible underlying metrics, not as a scientific measure of value.

### D10 — Estimated context must be visibly estimated

`DECIDED`

If the ChatGPT product does not expose an authoritative context-window percentage, Aiopago must not present one as exact.

Example UI:

```text
Pi       43%
ChatGPT ~51%
```

The `~` (or equivalent explicit label) is mandatory for estimates.

### D11 — Model switching and durable session handoff remain separate operations

`DECIDED`

A normal `/model` change stays within the same Pi session and must not invoke the full replacement-session handoff state machine.

The existing Aiopago durable handoff remains responsible for rotating the Pi session when its context becomes large or a durable boundary is requested:

```text
Pi session A
  ChatGPT <-> Codex <-> other models
        |
     Aiopago durable handoff
        v
Pi session B (history zero)
  providers rebound from durable project context
```

The spike must prove that external context-domain bindings can survive/rebind across this durable Pi-session handoff without importing the old Pi transcript.

## 3. Minimal proposed contracts for the spike

These names are provisional and may change after code/API inspection.

### 3.1 ContextDomainDescriptor

```text
schema_version
context_domain_id
kind                    # pi-native | external-stateful
provider_id
model_id?
usage_pool
capabilities
  local_files_direct
  pi_tools
  authoritative_context_usage
transport_adapter_id?
```

### 3.2 ContextDomainBinding

```text
schema_version
binding_id
context_domain_id
logical_session_id
external_thread_id?     # opaque/redacted; never contains credentials
cursor
created_at
updated_at
status
```

### 3.3 ContextTransferManifest

```text
schema_version
transfer_id
source_cursor
target_cursor_before
target_context_domain_id
project/task ids
ledger revision/digest
Git state reference/digest
decisions[]
changes[]
tests[]
findings[]
risks[]
hydrated_evidence[]
created_at
content_digest
```

Transfer artifacts must reuse or compose with Aiopago's existing canonicalization, secret scanning, atomic persistence and digest verification rather than creating a competing artifact store.

### 3.4 ContextHydrator interface

Conceptually:

```text
hydrate({
  targetCapabilities,
  delta,
  ledger,
  gitState,
  evidenceBudget
}) -> HydratedContextBundle
```

The first implementation must be deterministic/bounded where possible. No hidden LLM compaction call is required for the basic transfer path.

## 4. PoC acceptance flow

The minimum end-to-end demonstration is:

1. Start one Runner-owned Pi session in a fixture repository.
2. Select `ChatGPT Normal` using `/model`.
3. Discuss a bounded design decision.
4. Demonstrate at least one ChatGPT→Pi read-tool round trip.
5. Switch to `openai-codex` using `/model`.
6. Codex receives the relevant prior decision through the same Pi logical session and performs a bounded implementation/test change.
7. Switch back to `ChatGPT Normal` using `/model`.
8. Aiopago observes the external context-domain watermark, creates a bounded delta/hydration bundle and synchronizes it before/with the user's next ChatGPT turn.
9. ChatGPT can review what Codex changed without the user manually restating the work.
10. Evidence shows ChatGPT turns did not traverse Codex transport and Codex turns did not traverse ChatGPT transport.
11. Perform a normal Aiopago durable handoff and demonstrate that the new history-zero Pi session can rebind the same logical project/context-domain state.

## 5. Relationship to roadmap 0.2-E

This ADR does **not** widen 0.2-E/#30.

0.2-E remains the bounded interactive-human-UX slice and retains its explicit `no new planner/provider` exclusion.

Issue #32 owns the multi-model/context-domain spike. After the spike, roadmap placement (for example 0.3-A or another post-0.2 slice) requires an explicit decision rather than silent insertion into 0.2-E.

## 6. Consequences

### Positive

- One user-facing model switch mechanism: `/model`.
- Aiopago becomes more general without becoming ChatGPT-specific.
- Existing Pi provider switching remains usable for Codex, Claude, Gemini and local models.
- Separate provider/quota pools can be measured without fragmenting the logical project context.
- Existing durable checkpoint/handoff concepts are reused rather than duplicated.

### Negative / complexity

- External-stateful providers introduce synchronization cursors and partial failure modes absent from ordinary Pi-native model changes.
- ChatGPT browser/product transport may be fragile and must be isolated from the core.
- Remote context-size estimation may remain approximate.
- Agentic tool use through a browser-backed provider requires explicit protocol and race/cancellation testing.

## 7. Rejected alternatives

### A. Required `/lane chat|code`
Rejected as unnecessary user-facing state. `/model` already expresses model selection; lane/context-domain complexity should remain internal.

### B. Treat ChatGPT Normal as ordinary OpenAI API
Rejected because it would not satisfy the requirement to use the normal ChatGPT usage pool and would create separate API billing semantics.

### C. Route ChatGPT code mutations through Codex
Rejected because it would mix usage pools and make attribution/behavior misleading.

### D. Copy full Pi transcript into ChatGPT on every switch
Rejected for context cost, privacy, fragility and conflict with Aiopago's existing history-independent continuity principles.

### E. Put browser automation in Aiopago core
Rejected because site-specific transport must remain replaceable and optional.

## 8. Open spike questions

1. Can Pi's current custom-provider API represent the required streaming and tool-call semantics without patching Pi?
2. What is the least fragile supported way to bind to a normal ChatGPT product session while keeping credentials outside Aiopago artifacts?
3. Which transport events can be observed to prove ChatGPT-vs-Codex pool isolation?
4. What deterministic token/byte/evidence budget should the first Context Hydrator enforce?
5. How should cursors bind to Pi session entries when the Pi session itself is compacted or handed off?
6. Which attribution metrics can be made exact and which must remain heuristic?

Until these questions pass the gates in #32, production browser transport and quota guarantees remain unproven.
