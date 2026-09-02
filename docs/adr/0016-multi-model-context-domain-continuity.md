# ADR-0016 — Multi-model context-domain continuity and ChatGPT adapter boundary

- **Status:** PROPOSED / PROVIDER-NEUTRAL SPIKE VALIDATED, PRODUCTION HARDENING OPEN
- **Date:** 2026-09-02
- **Issue:** #32
- **Depends on:** ADR-0015
- **Companion constraint:** ADR-0016A
- **Scope:** architecture and provider-neutral continuity contract; production `ChatGPT Normal` transport is gated by ADR-0016A

## 1. Context

Aiopago currently provides durable continuity across Pi coding sessions by treating the conversation as temporary and reconstructing work from authoritative project state: the Master Task Ledger, Git state, sealed checkpoint/manifest artifacts, runtime ownership and bounded semantic reads. The current handoff creates a fresh Pi session with zero copied conversation history.

The new requirement is different but related: the user wants one Pi experience and one logical project context while switching inference engines with Pi's normal `/model` command. In particular, the desired future UX places `ChatGPT Normal` beside `openai-codex` and other Pi-native providers while preserving distinct usage pools.

The target UX is:

```text
Pi session
   |
 /model
   |
   +-- ChatGPT Normal    -> external-stateful domain; official transport required
   +-- OpenAI Codex      -> Codex provider/quota
   +-- Claude/Gemini/... -> ordinary Pi-native providers
```

The user must not manage a second `/lane` abstraction. Exceptional synchronization behavior belongs to internal context-domain continuity.

## 2. Decision

### D1 — `/model` is the user-facing switch

`DECIDED`

Aiopago does not introduce a required `/lane` command. The normal Pi `/model` picker remains authoritative for user-facing model selection.

A convenience hotkey may later toggle frequently used models, but it must remain a shortcut for model selection, not a second model-routing state machine.

### D2 — Model and context domain are distinct concepts

`DECIDED`

A **model** identifies the inference engine selected in Pi.

A **context domain** identifies where conversational/provider state lives and what synchronization semantics are required.

At minimum:

1. `pi-native` — context is represented by the Pi session and ordinary Pi provider semantics are sufficient;
2. `external-stateful` — context also exists in an external conversational state that can lag behind the Pi session and therefore requires cursor/watermark synchronization and explicit failure semantics.

`ChatGPT Normal` is the motivating future `external-stateful` domain, but the abstraction is provider-neutral.

Claude, Gemini, local models and Codex are not separate Aiopago lanes merely because they are different models. When they operate through normal Pi semantics, `/model` is sufficient.

### D3 — ChatGPT Normal uses a custom Pi provider/model seam

`PROVIDER SEAM VALIDATED / REAL CHATGPT TRANSPORT BLOCKED`

The preferred integration surface is a Pi custom provider/model exposed in the normal `/model` picker.

The Pi 0.83 provider-neutral spike demonstrates that an external provider can be registered in the normal model catalog, switched within the same Pi session and isolated from a second provider transport without patching Pi.

A real provider labeled `ChatGPT Normal` must use the normal ChatGPT product/session semantics rather than silently falling back to OpenAI API billing or the Codex provider. ADR-0016A requires an OpenAI-documented/supported external-client transport and empirical usage-pool evidence before that label is admitted.

### D4 — Aiopago owns continuity, not provider-specific transport

`DECIDED`

Aiopago owns provider-neutral continuity concerns:

- logical project continuity;
- context-domain identity and binding;
- cursors/watermarks;
- context transfer manifests;
- bounded context hydration policy;
- Git/ledger/evidence provenance;
- telemetry and attribution;
- durable Pi-session handoff compatibility;
- fail-closed handling of ambiguous external transfer state.

Provider-specific implementation details do **not** belong in the Aiopago core, including authentication/session lifecycle and wire/protocol peculiarities of a future supported transport.

ADR-0016A additionally rejects consumer-web Playwright/Selenium/CDP/DOM extraction, undocumented/private ChatGPT endpoints and cookie/session-token reuse. Those are not valid adapter implementations merely because they would live outside core.

### D5 — No generic bidirectional synchronization

`DECIDED`

ADR-0015 remains authoritative. There is no last-write-wins synchronization among Pi, an external provider, Git and the Ledger.

Authority remains category-specific:

- project/task plan: Master Task Ledger;
- technical filesystem state: Git/repository;
- durable checkpoint/transfer artifacts: Aiopago sealed artifacts;
- runtime control state: Aiopago runtime storage;
- remote conversational thread: transport/conversation state, not project authority.

An external-model response may propose a decision, but it does not silently mutate the Ledger or become durable authority merely because it exists remotely.

### D6 — Context synchronization is incremental and must be restart-safe

`DECIDED; PRODUCTION DURABILITY STILL OPEN`

Each external-stateful context domain maintains a durable/observable cursor or watermark identifying the logical Pi/project state already transferred to that domain.

On model selection into an external-stateful domain:

```text
project/Pi state now = N
external domain cursor = K
transfer delta = (K, N]
```

Only the required delta is transferred. The system must not resend the entire Pi transcript by default.

The cursor identifies transfer provenance; it must not imply that a provider exposes or accepts an exact internal token/context position.

The spike validates stable Pi-entry cursor planning/acknowledgement, stale-commit rejection, branch-divergence failure and explicit S8 handoff rebasing. Independent review found that the current live cursor/in-flight-transfer state is still memory-resident outside an explicit handoff. Before production merge, ordinary process restart must preserve or fail closed on:

- the acknowledged cursor;
- an in-flight transfer identity and its source/target cursor;
- reconciliation-required state after ambiguous interruption;
- the context-domain/session epoch binding.

A crash must never turn an ambiguous in-flight transfer into an automatic resend.

### D7 — External-stateful domains use bounded hydration of local evidence

`DECIDED / PROVIDER-NEUTRAL PATH VALIDATED`

A normal Pi-native coding model can read repository files and Git state through Pi tools after model selection. An external conversational thread cannot be assumed to see the local filesystem.

Aiopago therefore provides a provider-neutral **Context Hydrator** boundary. For a target domain without direct local-file visibility, it may materialize bounded evidence such as:

- current objective and next step;
- accepted/relevant decisions;
- Git branch/HEAD/status;
- files changed since the target watermark;
- bounded diff excerpts;
- selected file excerpts;
- test/build outcomes;
- unresolved findings and risks.

Whole repositories, unlimited command output and full transcripts are excluded by default.

Hydration preserves source/provenance references where possible and must pass secret/redaction constraints **before** transport. Independent review added the shared Aiopago secret-shaped key/value scan at the complete outbound-envelope boundary. This is a fail-closed minimum, not a claim of complete DLP coverage.

The basic transfer path is deterministic and bounded; it does not make a hidden LLM compaction call.

### D8 — ChatGPT Normal should remain agentic through Pi

`READ/QUERY TOOL PATH VALIDATED / MUTATION DEFERRED`

The target capability is not a chat-only provider. An eligible external provider should ultimately be able to request Pi-mediated tools through the custom-provider contract.

The spike demonstrates a real Pi `read` round trip through an external-stateful faux provider without invoking the code-provider/Codex sentinel.

Mutation expansion remains deferred until tool-call serialization, result correlation, cancellation, interruption and mutation-effect semantics are demonstrated. Independent review therefore makes external-stateful tool admission **read-only by default** in the current spike (`READ_ONLY` tool profiles such as `read`, `grep`, `find`, `ls`). `edit`, `write` and `bash` are blocked for external-stateful domains even though the normal Runner exposes them to Pi-native providers.

Codex must never be invoked as a hidden executor for external-provider tool calls.

### D9 — Usage pools and work attribution are separate metrics

`DECIDED / EXACT PRIMITIVES VALIDATED`

Aiopago must not conflate configured provider usage with contribution to the project.

The telemetry model may expose at least:

- current model/provider;
- configured usage pool (`chatgpt`, `codex`, provider API/subscription, `local`, etc.);
- Pi context usage when Pi exposes an authoritative measure;
- external remote-context estimate only when clearly marked as estimated;
- turns and provider calls;
- tool calls;
- files/lines changed with attribution where technically defensible;
- tests/builds initiated;
- accepted/recorded decisions with provenance.

The spike records safe model/domain/pool and bounded tool metadata and correlates tool IDs with Aiopago's existing operation authority. It intentionally does **not** treat the configured `usage_pool` label as proof of real provider billing/quota semantics.

A derived `work_mix` score remains uncomputed until a transparent weighting policy is ratified; it must never be presented as a scientific measure of value.

### D10 — Estimated context must be visibly estimated

`DECIDED`

If an external product does not expose an authoritative context-window percentage, Aiopago must not present one as exact.

Example UI:

```text
Pi       43%
ChatGPT ~51%
```

The `~` (or equivalent explicit label) is mandatory for estimates.

### D11 — Model switching and durable session handoff remain separate operations

`DECIDED / PROVIDER-NEUTRAL S8 VALIDATED`

A normal `/model` change stays within the same Pi session and must not invoke the full replacement-session handoff state machine.

The existing Aiopago durable handoff remains responsible for rotating the Pi session when its context becomes large or a durable boundary is requested:

```text
Pi session A
  external <-> Codex <-> other models
        |
     Aiopago durable handoff
        v
Pi session B (history zero)
  context domains rebound from durable project context
```

The S8 faux-transport spike demonstrates that Aiopago can seal cursor/lag lineage without transcript text, create a history-zero replacement Pi session, run ordinary continuity checks and start a new context epoch from checkpoint/handoff provenance.

This does **not** yet prove reattachment to a real remote ChatGPT thread. A real `external_thread_id`/opaque remote binding and its restart/handoff lifecycle remain transport-dependent work.

## 3. Minimal contracts

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

An adapter that uses an exact `model_id` must not leave sibling models from the same provider silently unclassified. The current spike fails closed on that case; a provider-default descriptor may classify every model until a future multi-descriptor adapter contract is introduced.

### 3.2 ProviderAdapter transport provenance

For external-stateful providers:

```text
transport_support
  status                # official-supported | experimental-nonproduction
  documentation_ref
  usage_pool_claim
  usage_pool_evidence
```

Production rejects experimental/unverified external transports. Spike/test harnesses may opt into `experimental-nonproduction` explicitly.

### 3.3 ContextDomainBinding

```text
schema_version
binding_id
context_domain_id
logical_session_id
external_thread_id?     # opaque/redacted; never credentials
cursor
created_at
updated_at
status
```

The remote-binding portion is intentionally incomplete until a supported real transport exists. Aiopago must not invent a thread identifier merely to make the faux provider look durable.

### 3.4 ContextTransferManifest / envelope

Conceptually:

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
protocol_tool_results[]
live_user_input
created_at
```

Transfer artifacts and outbound envelopes reuse or compose with Aiopago's existing canonicalization, bounded projection and secret scanning rather than creating a competing authority.

### 3.5 ContextHydrator interface

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

The first implementation is deterministic/bounded. No hidden LLM compaction call is required for the basic transfer path.

## 4. Spike evidence and acceptance status

The provider-neutral PoC exercises the intended flow using Pi 0.83 faux providers:

1. one Runner-owned Pi session starts on an external-stateful sentinel;
2. a bounded design decision is made;
3. the external provider performs a Pi-mediated `read` tool round trip;
4. `/model`-equivalent `session.setModel()` switches to a code-provider sentinel in the same session;
5. the code model consumes the prior decision;
6. returning to the external model receives one bounded Aiopago capsule containing only post-watermark/context evidence rather than the full Pi transcript;
7. transport call counters remain isolated and no hidden code-provider execution is used for the external tool round trip;
8. a normal Aiopago durable handoff creates a history-zero replacement and rebases the external context epoch from durable checkpoint/handoff provenance.

These gates validate **Aiopago/Pi mechanics**, not the existence of a real `ChatGPT Normal` transport or its quota semantics.

Independent review then added adversarial gates for:

- outbound secret rejection before transport;
- explicit truncation metadata for live user input;
- remote `error`/`aborted` -> `RECONCILIATION_REQUIRED`, with no automatic stale replay;
- read-only external tool admission;
- fail-closed experimental transport eligibility;
- rejection of unclassified sibling provider models.

## 5. Relationship to roadmap 0.2-E

This ADR does **not** widen 0.2-E/#30.

0.2-E remains the bounded interactive-human-UX slice and retains its explicit `no new planner/provider` exclusion.

Issue #32 owns the multi-model/context-domain spike. Productionization belongs in an explicit post-0.2 slice rather than silent insertion into 0.2-E.

## 6. Consequences

### Positive

- One user-facing model switch mechanism: `/model`.
- Aiopago becomes more general without becoming ChatGPT-specific.
- Existing Pi provider switching remains usable for Codex, Claude, Gemini and local models.
- Provider/pool attribution can be measured without fragmenting the logical project context.
- Existing durable checkpoint/handoff concepts are reused rather than duplicated.
- External transport uncertainty is fail-closed rather than silently hidden.

### Negative / complexity

- External-stateful providers introduce cursors, in-flight transfer state and ambiguity/reconciliation states absent from ordinary Pi-native model changes.
- Durable restart semantics require additional runtime state beyond an in-memory cursor book.
- A real remote conversational binding cannot be completed or tested until an eligible transport exists.
- Remote context-size estimation may remain approximate.
- Mutation-capable agentic tool use requires additional protocol, interruption and effect-evidence gates before admission.

## 7. Rejected alternatives

### A. Required `/lane chat|code`
Rejected as unnecessary user-facing state. `/model` already expresses model selection; lane/context-domain complexity should remain internal.

### B. Treat ChatGPT Normal as ordinary OpenAI API
Rejected because ChatGPT and the API platform have separate billing/usage semantics; an API provider must be labeled as such.

### C. Route external-model code mutations through Codex
Rejected because it would mix usage pools and make attribution/behavior misleading.

### D. Copy full Pi transcript into the external domain on every switch
Rejected for context cost, privacy, fragility and conflict with Aiopago's existing history-independent continuity principles.

### E. Automate the consumer ChatGPT web UI
Rejected by ADR-0016A. Playwright/Selenium/CDP/DOM response extraction, private endpoints and cookie/session-token reuse are not an admissible production transport.

## 8. Review status / remaining open gates

Resolved by the Pi 0.83 provider-neutral spike:

1. Pi's custom-provider API can represent the required model registration, streaming and read-tool semantics without a Pi fork.
2. `/model`-equivalent switching preserves one Pi session while provider transports remain isolated in the harness.
3. Initial deterministic hydration/protocol budgets and explicit truncation behavior are implemented and tested.
4. Exact safe attribution primitives can be collected without inventing `work_mix`.
5. Explicit Aiopago durable handoff can rebase an external context epoch without copying the old Pi transcript.

Still open before productionization:

1. **Official ChatGPT transport:** identify an OpenAI-documented/supported external-client transport satisfying the normal ChatGPT usage-pool requirement.
2. **Real usage-pool evidence:** determine which authoritative observations prove ChatGPT-vs-Codex accounting rather than merely configured routing.
3. **Ordinary restart durability:** persist cursor, in-flight transfer and reconciliation-required state so crash/restart cannot duplicate an ambiguous transfer.
4. **Remote binding:** define and persist the opaque `external_thread_id`/binding lifecycle once a real supported transport exists.
5. **Mutation tools:** add edit/write/bash only after cancellation, interruption, result correlation and effect-evidence semantics pass dedicated gates.
6. **Work mix:** ratify a transparent weighting policy or keep the metric intentionally absent.

Until these gates are closed, the provider-neutral spike is valuable evidence and a foundation, but PR #34 should remain draft and must not be described as production-ready `ChatGPT Normal`.
