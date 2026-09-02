# ADR-0016 — Multi-model context-domain continuity and ChatGPT adapter boundary

- **Status:** PROPOSED / PROVIDER-NEUTRAL CORE HARDENED; REAL `ChatGPT Normal` TRANSPORT BLOCKED EXTERNALLY
- **Date:** 2026-09-02
- **Issue:** #32
- **Depends on:** ADR-0015
- **Companion constraint:** ADR-0016A
- **Scope:** architecture and provider-neutral continuity contract; production `ChatGPT Normal` transport is gated by ADR-0016A

## 1. Context

Aiopago provides durable continuity across Pi coding sessions by treating conversation history as temporary and reconstructing work from authoritative project state: the Master Task Ledger, Git state, sealed checkpoint/manifest artifacts, runtime ownership and bounded semantic reads. A normal Aiopago handoff creates a fresh Pi session with zero copied conversation history.

The multi-model requirement is different but related: the user wants one Pi experience and one logical project context while switching inference engines through Pi's ordinary `/model` command. In particular, the desired future UX places `ChatGPT Normal` beside `openai-codex` and other Pi-native providers while preserving distinct usage pools.

Target UX:

```text
Pi session
   |
 /model
   |
   +-- ChatGPT Normal    -> external-stateful context domain; official transport required
   +-- OpenAI Codex      -> Pi-native provider / Codex usage pool
   +-- Claude/Gemini/... -> ordinary Pi-native providers
```

The user must not manage a second `/lane` abstraction. Exceptional synchronization behavior belongs to internal context-domain continuity.

## 2. Decisions

### D1 — `/model` is the user-facing switch

`DECIDED`

Aiopago does not introduce a required `/lane` command. The normal Pi `/model` picker remains authoritative for user-facing model selection.

A convenience hotkey may later toggle frequently used models, but it must remain a shortcut for model selection rather than a second routing state machine.

### D2 — Model and context domain are distinct concepts

`DECIDED`

A **model** identifies the inference engine selected in Pi.

A **context domain** identifies where conversational/provider state lives and which synchronization semantics are required.

At minimum:

1. `pi-native` — context is represented by the Pi session and ordinary Pi provider semantics are sufficient;
2. `external-stateful` — context also exists in an external conversational state that can lag behind the Pi session and therefore requires a cursor/watermark, bounded transfer and explicit reconciliation semantics.

`ChatGPT Normal` is the motivating future `external-stateful` provider, but the abstraction is provider-neutral.

Claude, Gemini, local models and Codex are not separate Aiopago lanes merely because they are different models. When they operate through normal Pi semantics, `/model` is sufficient.

### D3 — `ChatGPT Normal` uses a custom Pi provider/model seam

`PROVIDER SEAM VALIDATED / REAL CHATGPT TRANSPORT BLOCKED`

The preferred integration surface is a Pi custom provider/model exposed in the normal `/model` picker.

The Pi 0.83 provider-neutral spike demonstrates that an external provider can be registered in the normal model catalog, switched within the same Pi session and isolated from a second provider transport without patching Pi.

A real provider labeled `ChatGPT Normal` must use normal ChatGPT product/session semantics rather than silently falling back to OpenAI API billing or the Codex provider. ADR-0016A requires an OpenAI-documented/supported external-client transport plus empirical usage-pool evidence before that label is admitted.

### D4 — Aiopago owns continuity, not provider-specific transport

`DECIDED`

Aiopago owns provider-neutral continuity concerns:

- logical project continuity;
- context-domain identity and binding;
- durable cursors/watermarks;
- bounded context transfer;
- deterministic context hydration policy;
- Git/Ledger/evidence provenance;
- telemetry and attribution;
- durable Pi-session handoff compatibility;
- fail-closed handling of ambiguous external delivery state.

Provider-specific authentication, remote-session lifecycle and wire/protocol details do **not** belong in Aiopago core.

ADR-0016A rejects consumer-web Playwright/Selenium/CDP/DOM extraction, undocumented/private ChatGPT endpoints and cookie/session-token reuse. Those are not valid implementations merely because they could be hidden behind an adapter boundary.

### D5 — No generic bidirectional synchronization

`DECIDED`

ADR-0015 remains authoritative. There is no last-write-wins synchronization among Pi, an external provider, Git and the Ledger.

Authority remains category-specific:

- project/task plan: Master Task Ledger;
- technical filesystem state: Git/repository;
- durable checkpoint/transfer artifacts: Aiopago sealed artifacts;
- runtime control state: Aiopago runtime storage;
- remote conversational thread: provider transport state, not project authority.

An external-model response may propose a decision, but it does not silently mutate the Ledger or become durable authority merely because it exists remotely.

### D6 — Context synchronization is incremental and restart-safe

`DECIDED / PROVIDER-NEUTRAL DURABILITY VALIDATED`

Each external-stateful context domain maintains a durable cursor/watermark identifying the logical Pi/project state already acknowledged by that domain.

On model selection into an external-stateful domain:

```text
project/Pi state now = N
external domain cursor = K
transfer delta = (K, N]
```

Only the required delta is transferred. The system does not resend the entire Pi transcript by default.

The cursor identifies transfer provenance; it does not imply that a provider exposes an exact internal token/context position.

The hardened provider-neutral implementation now validates ordinary process restart semantics:

- acknowledged cursor state survives `GuardianStorage` reconstruction;
- acknowledged entries are not silently replayed after restart;
- stale commits and branch divergence fail closed;
- remote conversation binding is durable, opaque, conflict-safe and secret-scanned;
- a prepared/ambiguous external delivery survives restart as explicit reconciliation-required state;
- ambiguous delivery is never silently replayed or treated as acknowledged;
- provider adapters receive restored binding state after restart;
- the durable handoff baseline survives process-style state reconstruction.

A crash must never turn an ambiguous in-flight transfer into an automatic resend. That invariant is now covered by deterministic restart tests rather than left as a future durability requirement.

### D7 — External-stateful domains use bounded hydration of local evidence

`DECIDED / PROVIDER-NEUTRAL PATH VALIDATED`

A Pi-native coding model can inspect repository files and Git state through Pi tools after model selection. An external conversational state cannot be assumed to see the local filesystem.

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

Hydration preserves provenance references where possible and must pass the shared Aiopago secret-shaped key/value scan at the complete outbound-envelope boundary before transport. This is a fail-closed minimum, not a claim of complete DLP coverage.

The basic transfer path is deterministic and bounded; it does not make a hidden LLM compaction call.

### D8 — External-stateful providers remain agentic through Pi, but mutation is deferred

`READ/QUERY TOOL PATH VALIDATED / MUTATION DEFERRED`

The target capability is not chat-only. An eligible external provider should be able to request Pi-mediated tools through the custom-provider contract.

The spike demonstrates a real Pi `read` tool round trip through an external-stateful faux provider without invoking the code-provider/Codex sentinel.

External-stateful tool admission is **read-only by default** in the hardened spike (`read`, `grep`, `find`, `ls`-style profiles). `edit`, `write` and `bash` remain blocked until cancellation, interruption, result correlation and mutation-effect evidence have dedicated passing gates.

Codex must never be invoked as a hidden executor for external-provider tool calls.

### D9 — Usage pools and work attribution are separate metrics

`DECIDED / EXACT PRIMITIVES VALIDATED`

Aiopago must not conflate configured provider usage with contribution to the project.

Telemetry may expose at least:

- current model/provider;
- configured usage-pool label (`chatgpt`, `codex`, provider API/subscription, `local`, etc.);
- Pi context usage when Pi exposes an authoritative measure;
- external remote-context estimate only when clearly marked as estimated;
- turns and provider calls;
- tool calls and bounded outcomes;
- files changed with attribution where technically defensible;
- tests/builds initiated;
- accepted/recorded decisions with provenance.

The spike records safe model/domain/pool and bounded tool metadata and correlates tool IDs with Aiopago's existing operation authority. It intentionally does **not** treat a configured `usage_pool` label as proof of real provider billing/quota semantics.

A derived `work_mix` score remains uncomputed until a transparent weighting policy is ratified; it must never be presented as a scientific measure of value.

### D10 — Estimated context must be visibly estimated

`DECIDED`

If an external product does not expose an authoritative context-window percentage, Aiopago must not present one as exact.

Example UI:

```text
Pi       43%
ChatGPT ~51%
```

The `~` or an equivalent explicit label is mandatory for estimates.

### D11 — Model switching and durable session handoff remain separate operations

`DECIDED / PROVIDER-NEUTRAL S8 + RESTART REBIND VALIDATED`

A normal `/model` change stays within the same Pi session and must not invoke the full replacement-session handoff state machine.

The existing Aiopago durable handoff remains responsible for rotating the Pi session when its context becomes large or a durable boundary is requested:

```text
Pi session A
  external <-> Codex <-> other models
        |
     Aiopago durable handoff
        v
Pi session B (history zero)
  context domains rebound from durable project state
```

The S8 provider-neutral path demonstrates that Aiopago can seal cursor/lag lineage without transcript text, create a history-zero replacement Pi session, run ordinary continuity checks and start a new context epoch from checkpoint/handoff provenance.

The hardened implementation additionally persists the generic remote binding and restores it across process-style reconstruction. What remains transport-dependent is **not** Aiopago's binding durability; it is the meaning and lifecycle of a future real ChatGPT thread identifier and the remote provider's own documented reattachment/idempotency semantics.

If context-domain rebinding fails, `RESUME_READY` telemetry is withheld. It is emitted exactly once only after a successful rebind.

## 3. Minimal contracts

### 3.1 `ContextDomainDescriptor`

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

### 3.2 `ProviderAdapter` transport provenance

For external-stateful providers:

```text
transport_support
  status                # official-supported | experimental-nonproduction
  documentation_ref
  usage_pool_claim
  usage_pool_evidence
```

Production rejects experimental/unverified external transports. Spike/test harnesses may opt into `experimental-nonproduction` explicitly.

### 3.3 `ContextDomainBinding`

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

The binding and cursor are durable provider-neutral runtime state. `external_thread_id` is opaque and optional because its concrete semantics belong to the provider adapter. Aiopago must never invent an identifier merely to make a faux provider look like a real remote service.

### 3.4 `ContextTransferManifest` / envelope

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

### 3.5 `ContextHydrator`

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

The implementation is deterministic and bounded. No hidden LLM compaction call is required for the basic transfer path.

### 3.6 External delivery state

Provider-neutral durable delivery state distinguishes at least:

```text
prepared
acknowledged
reconciliation-required
```

Cursor advancement is permitted only after acknowledged delivery. Restart from a prepared or otherwise ambiguous state must not silently retry or advance the cursor.

## 4. Spike and hardening evidence

The provider-neutral PoC exercises the intended flow using Pi 0.83 faux providers:

1. one Runner-owned Pi session starts on an external-stateful sentinel;
2. a bounded design decision is made;
3. the external provider performs a Pi-mediated `read` tool round trip;
4. `/model`-equivalent `session.setModel()` switches to a code-provider sentinel in the same session;
5. the code model consumes the prior decision;
6. returning to the external model receives one bounded Aiopago capsule containing only post-watermark/context evidence rather than the full Pi transcript;
7. transport call counters remain isolated and no hidden code-provider execution is used for the external tool round trip;
8. a normal Aiopago durable handoff creates a history-zero replacement and rebases the external context epoch from durable checkpoint/handoff provenance.

Independent hardening added adversarial and restart gates for:

- outbound secret rejection before transport;
- explicit truncation metadata for live user input;
- remote `error`/`aborted` -> `RECONCILIATION_REQUIRED`, with no automatic stale replay;
- read-only external tool admission;
- fail-closed experimental transport eligibility;
- rejection of unclassified sibling provider models;
- durable cursor survival without replay after `GuardianStorage` restart;
- durable opaque remote binding with conflict and secret checks;
- prepared-delivery restart -> reconciliation-required;
- restored binding passed to the provider adapter;
- durable handoff baseline reconstruction;
- history-zero context rebind and correct `RESUME_READY` ordering.

Final GitHub Actions evidence on the hardened spike head:

- run `33638160077`;
- Node `22.19.0`;
- `@earendil-works/pi-coding-agent@0.83.0` / `@earendil-works/pi-ai@0.83.0`;
- `npm run check`: **PASS**, syntax ok for **65 modules**;
- full regression suite: **689/689 PASS**, 0 failures/skips/cancellations.

These gates validate **Aiopago/Pi provider-neutral mechanics**. They do not prove the existence of a real `ChatGPT Normal` transport or its quota semantics.

## 5. Relationship to roadmap 0.2-E

This ADR does **not** widen 0.2-E/#30.

0.2-E remains the bounded interactive-human-UX slice and retains its explicit `no new planner/provider` exclusion.

Issue #32 owns the multi-model/context-domain spike. Productization belongs in an explicit post-0.2 slice rather than silent insertion into 0.2-E.

The existing long-range roadmap also keeps provider/reconciliation work outside the early 0.2 UX slice. A concrete post-0.2 product slice should reuse the validated provider-neutral mechanics while keeping `ChatGPT Normal` feature-gated until ADR-0016A is satisfied.

## 6. Consequences

### Positive

- One user-facing model switch mechanism: `/model`.
- Aiopago becomes more general without becoming ChatGPT-specific.
- Existing Pi provider switching remains usable for Codex, Claude, Gemini and local models.
- Provider/pool attribution can be measured without fragmenting logical project context.
- Existing durable checkpoint/handoff concepts are reused rather than duplicated.
- Cursor, binding and ambiguous-delivery recovery survive restart without transcript replay.
- External transport uncertainty is fail-closed rather than silently hidden.

### Negative / complexity

- External-stateful providers introduce cursors, delivery state and reconciliation semantics absent from ordinary Pi-native model changes.
- Durable continuity requires additional runtime storage and restart tests; this complexity is now implemented but remains part of the maintenance surface.
- A real ChatGPT thread cannot be integrated or quota-tested until an eligible official transport exists.
- Remote context-size estimation may remain approximate.
- Mutation-capable agentic tool use requires additional protocol, interruption and effect-evidence gates before admission.

## 7. Rejected alternatives

### A. Required `/lane chat|code`

Rejected as unnecessary user-facing state. `/model` already expresses model selection; context-domain complexity should remain internal.

### B. Treat `ChatGPT Normal` as ordinary OpenAI API

Rejected because ChatGPT and the API platform have separate billing/usage semantics; an API provider must be labeled as such.

### C. Route external-model code mutations through Codex

Rejected because it would mix usage pools and make attribution/behavior misleading.

### D. Copy full Pi transcript into the external domain on every switch

Rejected for context cost, privacy, fragility and conflict with Aiopago's existing history-independent continuity principles.

### E. Automate the consumer ChatGPT web UI

Rejected by ADR-0016A. Playwright/Selenium/CDP/DOM response extraction, private endpoints and cookie/session-token reuse are not admissible production transports.

## 8. Review status / remaining gates

Resolved by the Pi 0.83 provider-neutral spike and durability hardening:

1. Pi's custom-provider API can represent the required model registration, streaming and read-tool semantics without a Pi fork.
2. `/model`-equivalent switching preserves one Pi session while provider transports remain isolated in the harness.
3. Deterministic hydration/protocol budgets and explicit truncation behavior are implemented and tested.
4. Exact safe attribution primitives can be collected without inventing `work_mix`.
5. Aiopago durable handoff can rebase an external context epoch without copying the old Pi transcript.
6. Cursor state is durable across restart and acknowledged entries are not replayed.
7. Remote binding is durable, opaque, conflict-safe and secret-scanned.
8. Ambiguous/prepared external delivery becomes reconciliation-required across restart rather than silently retrying.
9. Context-domain rebind is ordered before `RESUME_READY` and survives history-zero Pi-session replacement.

Still open for the **real ChatGPT product integration** or later capability expansion:

1. **Official ChatGPT transport:** identify an OpenAI-documented/supported external-client conversation transport satisfying ADR-0016A.
2. **Real usage-pool evidence:** empirically determine which authoritative observations prove ordinary ChatGPT-vs-Codex accounting rather than merely configured routing.
3. **Real transport semantics:** validate the future provider's actual remote thread identity, retry/idempotency, tool-loop and reattachment behavior against the already-durable Aiopago binding contract.
4. **Mutation tools:** add edit/write/bash only after cancellation, interruption, result correlation and effect-evidence semantics pass dedicated gates.
5. **Work mix:** ratify a transparent weighting policy or keep the metric intentionally absent.

The provider-neutral continuity foundation is therefore ready for architectural review and post-0.2 productization. `ChatGPT Normal` itself remains unavailable until ADR-0016A's external transport gate is satisfied.
