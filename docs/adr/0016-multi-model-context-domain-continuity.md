# ADR-0016 — Multi-model context-domain continuity and ChatGPT adapter boundary

- **Status:** ACCEPTED — PROVIDER-NEUTRAL ARCHITECTURE; `ChatGPT Normal` REMAINS BLOCKED BY ADR-0016A
- **Date:** 2026-09-02
- **Accepted:** 2026-09-03
- **Reviewed implementation evidence:** 2026-09-03
- **Issues:** #32 spike, #36 provider-neutral productization
- **Depends on:** ADR-0015
- **Companion constraint:** ADR-0016A
- **Scope:** provider-neutral multi-model/context-domain architecture. A production provider labelled `ChatGPT Normal` remains independently gated by ADR-0016A.

## 1. Context

Aiopago already treats Pi conversation history as temporary. Durable project continuity comes from authority-by-data-type: the Master Task Ledger, Git/worktree state, sealed checkpoint/manifest artifacts, runtime control state and bounded semantic reads. A normal Aiopago handoff creates a fresh Pi session with zero copied conversation history.

The multi-model requirement is related but different: one Pi experience should be able to switch inference engines through Pi's ordinary `/model` command without introducing a second user-visible routing abstraction.

Target UX:

```text
Pi session
   |
 /model
   |
   +-- external-stateful provider  -> separate remote conversational state
   +-- OpenAI Codex                -> ordinary Pi-native context
   +-- Claude / Gemini / local     -> ordinary Pi-native context
```

`ChatGPT Normal` is the motivating future external-stateful provider, but the architecture must remain useful even if that transport never becomes available.

## 2. Decisions

### D1 — `/model` is the only required user-facing model switch

Aiopago does not introduce a required `/lane` command.

A Pi `/model` change is a model/inference-engine change inside the current Pi session. A convenience hotkey may later wrap model selection, but it must not become a second routing state machine.

Model identifiers are treated as `provider` plus an opaque model ID. The provider/model policy parser splits only at the first `/`, so model IDs that themselves contain `/` remain valid.

### D2 — Model and context domain are separate concepts

A **model** identifies the selected inference engine.

A **context domain** identifies where conversational state lives and what continuity semantics are required.

Supported kinds:

- `pi-native`: ordinary Pi session/provider context is sufficient;
- `external-stateful`: the provider also owns remote conversational state that can lag behind Pi and therefore requires a durable binding, cursor/watermark, bounded transfer and explicit reconciliation.

Codex, Claude, Gemini and local models are not separate Aiopago lanes merely because they are different models. When they use ordinary Pi semantics, `/model` is sufficient.

### D3 — External-stateful providers use the normal Pi provider/model seam

An eligible external provider is registered into Pi's normal model catalog rather than hidden behind a separate Chat/Code UX.

The Pi 0.83 provider-neutral implementation demonstrates registration, same-session A→B→A switching, isolated transports and Pi-mediated tool use without patching Pi.

A provider may be labelled `ChatGPT Normal` only after ADR-0016A qualifies a real OpenAI-supported transport. No OpenAI API fallback, Codex route, browser automation or private ChatGPT endpoint may be relabelled as normal ChatGPT.

### D4 — Aiopago owns continuity; adapters own provider-specific transport

Aiopago owns:

- context-domain identity;
- durable cursor/watermark;
- durable opaque remote binding;
- external delivery/reconciliation state;
- bounded transfer/hydration policy;
- Git/Ledger/evidence provenance;
- provider-neutral telemetry/attribution;
- durable Pi-session handoff compatibility.

Provider-specific authentication, wire protocol and remote-session lifecycle stay outside Aiopago core.

Adapter installation does **not** transfer Aiopago continuity-state authority. An adapter install callback never receives `ContextStateStore`, cursor/delivery/reconciliation/epoch mutation APIs or raw journal ownership. It may receive an immutable restored binding snapshot and, after provider/model validation succeeds, one narrow capability:

```text
bindExternalThread(externalThreadId)
```

That capability can bind only the configured domain's opaque remote-thread identifier.

### D5 — No generic bidirectional synchronization

ADR-0015 remains authoritative. There is no generic last-write-wins merge among Pi, a remote provider, Git and the Ledger.

Authority remains category-specific:

- task/project plan: Master Task Ledger;
- files/worktree: Git/repository;
- runtime control and context continuity: Aiopago runtime state;
- checkpoint/manifest: sealed Aiopago artifacts;
- remote conversational thread: provider transport state, never project authority.

A remote response may propose a decision; it does not become durable project truth merely by existing remotely.

### D6 — External synchronization is incremental, durable and fail-closed

Each external-stateful domain has a durable acknowledged cursor.

```text
Pi/project tail = N
external acknowledged cursor = K
next transfer = (K, N]
```

The default transfer is a bounded delta, not the whole Pi transcript.

The durable provider-neutral lifecycle includes separately versioned:

- `ContextDomainBinding` — provider/domain/adapter/thread identity;
- `ContextCursor` — acknowledged Pi-session branch position;
- delivery state — prepared / acknowledged / reconciliation-required / retry-approved;
- context epoch — full-session handoff lineage and target baseline.

Binding and cursor are deliberately **separate contracts**. Advancing a cursor does not redefine remote provider/thread identity.

Restart invariants:

- acknowledged entries are not silently replayed;
- stale/divergent cursors fail closed;
- a prepared or otherwise ambiguous delivery becomes reconciliation-required;
- ambiguous delivery is never automatically retried;
- opaque remote binding survives restart and rejects conflicts/secrets;
- incompatible/future durable state or conflicting authority metadata fails closed with deterministic remediation;
- migration metadata is never recorded over an incompatible authority claim.

### D7 — Hydration is deterministic, bounded and privacy-first

For an external-stateful domain that cannot directly inspect local files, Aiopago builds one bounded projection.

Budget priority is:

1. Task Ledger/durable project state;
2. Git observation;
3. explicit evidence;
4. post-watermark recent Pi context.

Properties:

- no raw transcript/window export;
- no hidden LLM summarization call;
- historical raw `toolResult` text excluded from hydration;
- explicit truncation reasons and budgets;
- provenance/source refs where available;
- complete outbound envelope secret-shaped scan before durable PREPARED state or transport exposure.

A tool result requested by the external model is a separate **live correlated continuation**, not historical hydration. It is eligible only when branch replay establishes one unambiguous outstanding call owned by the selected context domain, with matching tool name and a post-watermark result. Cross-model/overlapping tool-call ID collisions fail closed rather than leaking another model's result.

### D8 — Initial external tool surface is read/query-only

External-stateful domains are not chat-only: they may request Pi-mediated tools.

The first supported external profile is a closed versioned allowlist:

```text
read
grep
find
ls
```

Admission requires both explicit membership in this external profile and the generic Aiopago safety classification `READ_ONLY`.

`edit`, `write`, `bash`, unknown tools and future generic read-only tools are not automatically exposed. Mutation requires a later gate for cancellation, interruption, effect evidence and result correlation.

Codex must never be invoked as a hidden executor for an external-provider tool call.

### D9 — Telemetry exposes exact primitives, not billing fiction

Provider-neutral telemetry may expose:

- provider/model;
- context domain;
- configured `usage_pool` label;
- captured input/output/reasoning/cache token fields;
- model-call and primary-token shares;
- bounded tool outcomes;
- successful file-target provenance where defensible.

The `usage_pool` semantic is explicitly:

```text
configured_label_not_billing_or_quota_proof
```

Primary-token share uses input+output only. Reasoning/cache remain separate because provider accounting may overlap those categories.

Tool outcomes correlate by authoritative `task_id + tool_call_id`; `uncorrelated` is distinct from `pending`; duplicate authoritative operation identities fail closed. Provider/model grouping is collision-safe even when IDs contain `/`.

`work_mix` remains `not_computed` until a transparent weighting policy is separately ratified.

### D10 — External context-size estimates must look estimated

If a remote product does not expose authoritative context occupancy, Aiopago must not display an exact-looking percentage.

Example:

```text
Pi       43%
Remote  ~51%
```

The estimate marker or equivalent wording is mandatory.

### D11 — `/model` switching and full-session handoff are different operations

A normal `/model` switch stays in the same Pi session and never invokes full Aiopago handoff.

A true Aiopago handoff creates a fresh **history-zero** replacement Pi session.

For external-stateful domains, rebind is a durable pre-`RESUME_READY` operation. The handoff remains `MANIFEST_PERSISTED` until external context rebind succeeds. Only then may Aiopago persist and emit `RESUME_READY`.

Rebind is a crash-idempotent mini-saga:

1. validate source cursor and durable remote binding;
2. persist the complete target context epoch;
3. persist one target-root cursor write;
4. update the in-process cursor book.

No durable reset/set pair is used during rebind.

On restart:

- same handoff epoch + source cursor means the crash occurred before target cursor persistence; Aiopago completes it;
- same handoff epoch + target cursor means rebind already completed; retry returns idempotently without duplicate writes;
- mismatched epoch/cursor lineage fails closed.

If rebind fails, durable state becomes `CONTINUITY_FAILED`; neither durable nor telemetric `RESUME_READY` is produced. `/aio resume` may rerun continuity from an interrupted `MANIFEST_PERSISTED` target.

## 3. Minimal public contract boundary

Productization issue #36 deliberately exposes a small facade:

```text
aiopago/context-continuity
```

Public surfaces include versioned provider/context descriptors, provider installation declarations, bounded hydration policy, external tool-profile metadata, conservative telemetry projection and handoff compatibility policy.

The following remain implementation details:

```text
ContextDomainRegistry
ContextCursorBook / DurableContextCursorBook
ContextStateStore
ContextSyncCoordinator
installProviderAdapters / installConfiguredProviderAdapters
ContextAwareHandoffService
raw SQL/journal representation
```

A matching `schema_version` tag is never proof that caller-supplied input is valid; install/state boundaries revalidate their inputs.

## 4. Provider-neutral evidence

The architecture has two evidence layers:

1. **S1–S8 spike evidence** — provider seam, isolated transports, same-session switching, bounded hydration, Pi read tool loop, telemetry primitives, restart durability and history-zero rebind.
2. **P1–P7 productization/review evidence** — intentional public API, explicit install policy, durable-state migration semantics, privacy/correlation hardening, closed external tool profile, conservative telemetry and durable pre-ready handoff behavior.

Final cumulative reviewed rollup:

- PR #44 — `0.3-A rollup: provider-neutral continuity P1-P7`;
- head `36aac13f5ddc19b8ea0a62c6a2ae269c31bd8010`;
- GitHub Actions run `33731877603`, job `100573451580`;
- Node 22.19 / Pi 0.83.0;
- public context-continuity API and release-surface gate PASS;
- P1–P7 targeted gates PASS;
- S1–S8 PASS;
- safety/durability gates PASS;
- complete historical regression PASS.

The cumulative and integration reviews additionally closed cross-slice findings for adapter validation trust, migration/authority atomicity, tool-result ID collisions, telemetry correlation/model collisions, slash-containing model IDs, true durable pre-ready ordering, crash-safe rebind, adapter continuity-state authority leakage, the public Runner bypass around P2 installation semantics, and release/package documentation of the public boundary.

This evidence validates **provider-neutral Aiopago/Pi mechanics**. It does not prove the existence of a qualifying normal-ChatGPT transport or its quota semantics.

## 5. Roadmap boundary

This ADR does **not** widen 0.2-E/#30. The existing 0.2-E interactive-human-UX scope remains separate and the Aiopago 0.2 sequence remains authoritative.

The provider-neutral productization tracked by #36 is accepted as **0.3-A**, the first post-0.2 slice. Its implementation candidate may remain fully reviewed ahead of the roadmap, but runtime code must not land in `main` as a silent widening of 0.2-E.

When 0.3-A reaches its landing gate, integration uses one coherent candidate against the then-current `main`, not seven independent stacked merges. PRs #37–#43 remain per-slice evidence; PR #44 is the cumulative review boundary. The supported-profile matrix must be rerun on the integration head before any merge to `main`.

## 6. ChatGPT Normal remains independently blocked

ADR-0016A is mandatory for any future adapter labelled `ChatGPT Normal`.

No implementation may use consumer-web Playwright/Selenium/CDP/DOM extraction, browser cookie/session-token reuse, undocumented/private ChatGPT endpoints, or OpenAI API usage relabelled as ordinary ChatGPT.

A future adapter must pass the ADR-0016A qualification gates, including an OpenAI-documented external-client conversational transport, bounded retry/idempotency semantics, tool-loop compatibility without hidden Codex and empirical evidence distinguishing ordinary ChatGPT, Codex and API usage pools.

Until then, `ChatGPT Normal` is unavailable by design.

## 7. Consequences

### Positive

- one user-facing model-selection mechanism;
- provider-neutral continuity rather than ChatGPT-specific core logic;
- same-session Pi-native switching remains simple;
- external state is durable, bounded and fail-closed;
- authority boundaries remain explicit;
- public API is intentionally smaller than the runtime implementation;
- billing/quota and work-contribution claims remain conservative.

### Costs / deferred work

- external-stateful providers require durable cursor/binding/delivery/epoch machinery;
- remote transport semantics remain provider-dependent;
- mutation-capable external tools require another safety gate;
- external context occupancy may remain approximate;
- real ChatGPT Normal cannot ship until ADR-0016A is satisfied.

## 8. Acceptance record

ADR-0016 is accepted on 2026-09-03 with the following governance decisions:

1. the provider-neutral architecture and authority boundaries above are accepted;
2. ADR-0016A remains a mandatory blocking constraint for any provider labelled `ChatGPT Normal`;
3. #36 is ratified as **0.3-A**, post-0.2, and does not widen 0.2-E/#30;
4. PRs #37–#43 are evidence slices and are not to be merged independently into `main`;
5. PR #44 is the coherent reviewed productization boundary;
6. the package version remains unchanged until the actual 0.3-A landing/release candidate is prepared;
7. a fresh supported-profile matrix on the then-current integration head is mandatory before runtime code may enter `main`.
