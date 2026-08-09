# H2-02B-F4 — Workload feasibility and selection

**Issue:** #14, child of #9

**Related candidate:** #11 — Development Chronicle / Semantic History

**Status:** `F4_PASS_WORKLOAD_SELECTED`, frozen-ready design but not yet frozen or runnable

**Application baseline H2-01:** `930fc35d03d3f9795fa6402a047b0ded489e2817`

**H2-02B F2/F3 infrastructure baseline:** `6847c5cbf260ed4074e5f3846b130ed3e1ad3da3`

The infrastructure baseline is not a runnable experiment baseline. A future
successor commit must freeze the selected workload, exact prompt, protocol and
pre-run acceptance-command alignment before any RUN-40/50/60 worktree exists.

## 1. Empirical feasibility finding

`WL-HANDOFF-INCIDENT-INSPECTOR-1` produced 69 observed model calls, maximum
context occupancy `31.01654411764706%`, no 40% crossing and no handoff event.
Its three missing-sample diagnostics made that run `INVALID_TELEMETRY`; F2/F3
fixed the collection defect, but not the independent workload-length finding.
The 31% observation is only qualitative evidence that the inspector was too
short for this calibration. It is not used as a linear predictor and this
document makes no forecast percentage or crossing guarantee.

The old workload also placed the mandatory fresh cold review after only three
implementation WCPs. That reset was methodologically early. A replacement
should preserve one continuous implementation lineage through all substantive
work and open the fresh no-history review only after that work is complete.
Early completion remains a legitimate `CENSORED_EARLY_COMPLETION` result; no
work may be added merely to obtain a crossing.

## 2. Candidate audit

### A. Development Chronicle / Semantic History v0.1

A local semantic-history layer above Git, checkpoint references, Ledger and
documentation. It records concise, explicit and verifiable development
narratives and derives task/milestone/day/project views without preserving
conversation history or verbatim chain-of-thought.

Expected work surface:

- six new library modules for schema/privacy, evidence resolution, append-only
  storage, aggregation, retrieval and deterministic rendering;
- one CLI, public exports and one package script;
- one broad offline test matrix including an end-to-end temporary repository;
- user/authority documentation and an independent review report;
- cross-cutting work in versioned contracts, canonical bytes, immutability,
  evidence verification, Git identity, incremental projections, pagination,
  privacy, CLI behavior and deterministic rendering.

The useful v0.1 can remain standalone. It must not auto-capture Pi messages,
register `/eio` runtime commands, or modify Guardian SQLite, ArtifactStore,
Runner, Advisor, handoff or calibration code. A future `/eio recap` integration
would create self-interference risk and is explicitly deferred.

### B. CandidateCheckpoint contract conformance and export v0.1

Implement the deferred M0 contract schemas, valid/invalid fixtures, local
EvidenceReference resolver, CandidateCheckpoint verifier and JSON/Markdown
export CLI.

Expected work surface:

- approximately five new contract/conformance/export modules;
- one CLI, test fixtures, conformance tests and documentation;
- cross-cutting schema, DAG, digest, GitState, evidence and privacy checks.

This has high product value, but full value requires wiring the producer into
checkpoint/handoff creation. Doing that during the measured workload would
alter the subsystem whose threshold handoff is being measured. A standalone
validator reduces interference but also reduces the natural implementation
surface and leaves the most valuable integration unfinished.

### C. Local requirements-to-evidence traceability matrix v0.1

Build a deterministic local tool that maps Ledger criteria and requirement
references to Git/file/test/checkpoint evidence, reports missing or stale links,
and renders bounded JSON/Markdown matrices.

Expected work surface:

- approximately four new modules for contracts, local resolvers, matrix
  projection and rendering;
- one CLI, one focused test matrix, documentation and temporary-repository E2E;
- cross-cutting path safety, digest verification, unknown handling, privacy and
  stable output.

It is useful and low-interference, but its surface is closer to the old
read-only inspector: mostly read/validate/project/report. It is therefore a
weaker feasibility candidate than Chronicle, without being padded.

### D. Calibration evidence replay verifier v0.1

Build a second offline verifier for attestation, SQLite, quality evidence and
run-record replay.

Expected work surface:

- approximately four calibration-specific modules plus fixtures, CLI and docs;
- read-only SQLite, protocol, digest and classification replay concerns.

It would duplicate recent F2/F3 work and naturally invite changes to the
calibration finalizer and evidence machinery. That is direct self-interference,
so it is rejected for this experiment even though deterministic acceptance is
possible.

## 3. Comparative scoring

| Candidate | VALUE | EXPECTED_WORK_SURFACE | CONTEXT_PRESSURE | SELF_INTERFERENCE_RISK | EXTERNAL_VARIABILITY | DETERMINISTIC_ACCEPTANCE | PRIVACY_RISK | PADDING_RISK | COMPARABILITY_40_50_60 |
|---|---|---|---|---|---|---|---|---|---|
| A. Development Chronicle | alto | 6 modules, CLI, exports/script, broad tests+E2E, 2 docs; schema/storage/evidence/aggregation/query/render/privacy | alta | basso **only with standalone boundary** | bassa | forte | medio | basso | forte |
| B. Checkpoint conformance/export | alto | ~5 modules, CLI, fixtures/tests, docs; contracts/DAG/Git/evidence | medio-alta | alto when product-useful integration is included; medio standalone | bassa | forte | medio | basso | media |
| C. Requirements/evidence matrix | medio-alto | ~4 modules, CLI, tests+E2E, docs; resolvers/matrix/render/privacy | media | basso | bassa | forte | medio | basso | forte |
| D. Calibration replay verifier | medio | ~4 modules, CLI, fixtures/tests, docs; calibration authorities/classification | media | alto | bassa | forte | basso | basso | debole |

No score predicts a future context percentage. `CONTEXT_PRESSURE=alta` for A
means only that the real, cohesive implementation surface is materially broader
than the old inspector and includes several interacting correctness concerns.

## 4. Selection

**Selected:** `WL-DEVELOPMENT-CHRONICLE-1` — Development Chronicle / Semantic
History v0.1, using the strict standalone boundary below.

Reasons:

1. It closes a real human-review problem documented by #11: Git explains bytes,
   while a bounded semantic record explains goal, rationale, decisions,
   alternatives, findings, evidence, impact, debt and next step.
2. Its six-module core, immutable local store, evidence verification,
   incremental hierarchy, selective retrieval, two renderers, CLI and E2E form
   a cohesive surface significantly broader than the single-inspector core.
3. WCP-1 through WCP-5 can run as one continuous implementation phase. The
   mandatory fresh review starts only after `READY_FOR_COLD_REVIEW`.
4. Acceptance can be entirely offline and deterministic.
5. The valuable v0.1 needs no changes to threshold, Advisor, Runner admission,
   latch, handoff, metrics, finalizer or quality-evidence runtime.
6. The work is not created to consume tokens. Every component is independently
   justified by the feature contract; removal of a component would remove a
   declared capability or verification boundary.

Selection does not mark GitHub issue #11 implemented or accepted. It selects a
bounded subset as the proposed common workload for a future frozen pilot.

## 5. Self-interference boundary

### Files the workload may add or integrate

- the exact Chronicle deliverables listed in §6;
- `src/index.mjs` only to export the standalone public API;
- `package.json` only to add the Chronicle CLI script;
- `TASK_PLAN.md` only as the protocol-required workload Ledger;
- the WCP-6 review report.

### Files/subsystems the workload must not modify

- `src/context-advisor.mjs` and every threshold/default;
- `src/runner.mjs`, `src/extension.mjs` and provider admission;
- `src/safety.mjs`, latch or operation semantics;
- `src/handoff.mjs`, `src/runner-ownership.mjs` and handoff lifecycle;
- `src/metrics.mjs` and `src/storage.mjs` runtime telemetry;
- `src/calibration-*.mjs`, `scripts/calibration-*.mjs` and quality evidence;
- the frozen pilot protocol and calibration documentation;
- existing checkpoint/manifest payloads or `ArtifactStore` semantics.

Chronicle uses its own configurable root, defaulting to
`.guardian/chronicle/`, and imports only generic `canonical.mjs` and
`errors.mjs` helpers where useful. It does not use GuardianStorage or inspect Pi
session JSONL. Runtime command integration, automatic record generation and
`/eio recap|timeline|why` are future work outside v0.1.

The future experiment-baseline preparation may update the finalizer's frozen
acceptance-command allowlist from the old inspector command to the Chronicle
command in §9. That is a pre-pilot infrastructure alignment, reviewed and
frozen identically for all variants; the measured workload itself may not touch
that machinery.

## 6. Frozen-ready workload proposal

### Identity

- `protocol_id`: `H2-02B-F4-PILOT-2`
- `workload_id`: `WL-DEVELOPMENT-CHRONICLE-1`
- title: `Development Chronicle / Semantic History v0.1`
- purpose: implement a bounded, local, verifiable and human-readable semantic
  history with incremental hierarchical views and selective retrieval, without
  replacing or mutating Git, Ledger, checkpoints, ADRs or current docs.

### Exact deliverables

1. `src/chronicle-schema.mjs`
2. `src/chronicle-evidence.mjs`
3. `src/chronicle-store.mjs`
4. `src/chronicle-aggregate.mjs`
5. `src/chronicle-query.mjs`
6. `src/chronicle-render.mjs`
7. `bin/eio-chronicle.mjs`
8. `test/chronicle.test.mjs`
9. `docs/development-chronicle.md`
10. `docs/reviews/development-chronicle-review.md` (created only in WCP-6)
11. `src/index.mjs` export additions only
12. `package.json` script `chronicle: node bin/eio-chronicle.mjs` only

No third-party runtime dependency may be added.

### Complete requirements

1. Define `eiopago.chronicle-record/0.1.0` with exact-key validation and
   explicit `record_id`, `occurred_at`, scope, lineage, Git references, goal,
   `what_changed`, rationale, decisions, alternatives, findings, evidence,
   impact, risks/debt, next steps and tags.
2. Keep facts, decisions, alternatives, findings and declared inference
   distinguishable. An inference must be labelled and may not be emitted as a
   verified fact.
3. Require opaque IDs and exact parent record IDs; detect missing parents,
   self-parenting and cycles. Preserve task/checkpoint lineage when supplied;
   never invent missing correlation IDs.
4. Bound every string and collection, reject unknown major versions, reject
   unknown top-level fields, and cap a canonical record at 256 KiB. Suggested
   maxima are 2,048 UTF-8 bytes per ordinary statement, 64 entries per semantic
   category, 64 evidence references, 512 changed-file paths, 32 tags and 16
   parent records.
5. Use explicit RFC3339 UTC `occurred_at`; do not generate capture time during
   validation/rendering. Day buckets are UTC. Identical records and source
   bytes must produce identical output bytes.
6. Define local EvidenceReference kinds for relative file bytes, Git commits,
   Ledger revisions, checkpoint artifacts and command-output artifacts. A
   `VERIFIED` reference requires a supported local resolver and matching
   SHA-256; unsupported/mutable evidence remains `UNVERIFIED` or fails according
   to the caller's minimum policy.
7. Reject absolute/path-escaping locators, secret-shaped keys/values and
   forbidden semantic payload keys: conversation, history, messages, prompt,
   response, transcript, chain-of-thought and internal reasoning. Rationale is
   concise declared justification, not hidden reasoning capture.
8. Persist each record as canonical JSON using create-exclusive,
   temp+fsync+rename semantics. The same ID and identical bytes are idempotent;
   the same ID with different bytes is a conflict. Existing records are never
   edited or deleted by the API.
9. Maintain incremental, rebuildable per-record index projections. Index loss
   or corruption must be diagnosable and rebuild must not modify record bytes.
   No index is authoritative over the sealed record.
10. Produce deterministic task, milestone, UTC-day and project recaps by
    aggregating record references incrementally, not by rewriting prior records
    or calling an LLM. Preserve category and evidence links in every level.
11. Produce a deterministic project timeline ordered by `occurred_at` then
    `record_id`; do not rely on filesystem enumeration order.
12. Support selective retrieval by exact scope IDs, UTC interval, tag,
    semantic category, finding severity/status and evidence verification
    status. Pagination uses a stable cursor and bounded page size; truncation is
    explicit and never silent.
13. Render canonical JSON and deterministic Markdown. Markdown is a projection,
    never an authority, and must escape untrusted control/markup safely.
14. Provide CLI commands `validate`, `record`, `show`, `recap`, `timeline`,
    `query`, `verify` and `rebuild-index`; stdout is result-only and diagnostics
    go to stderr. Exit 0 means success, 2 means invalid/integrity/evidence
    failure, and 64 means invalid invocation.
15. The CLI accepts an explicit Chronicle root and repository root so tests and
    consumers need not touch the real `.guardian` directory.
16. Tests use temporary local repositories and fixed timestamps, block `fetch`,
    and cover valid/invalid schema, bounds, unknown fields/version, privacy and
    secret rejection, path traversal, evidence success/failure, append-only
    conflicts, crash leftovers, index rebuild, DAG failures, each recap level,
    query/pagination, deterministic JSON/Markdown, CLI exits and recursive
    privacy allowlisting.
17. E2E records at least three related checkpoint narratives in a temporary Git
    repository, verifies evidence, rebuilds the index, obtains task/day/project
    recaps and timeline, and proves sealed record bytes are unchanged.
18. Document authority boundaries, schema, storage layout, recovery,
    EvidenceReference semantics, aggregation, queries, CLI, privacy, exit codes
    and limits.
19. Never read conversation/history/prompt/response content and never infer a
    Chronicle record from Pi session history. v0.1 records only explicit,
    schema-valid input.
20. Do not modify or integrate with runtime threshold, Advisor, Runner,
    admission/latch, handoff, telemetry, calibration or quality machinery.

### Explicit non-scope

- `/eio recap`, `/eio timeline` or any Extension/Runner integration;
- automatic Chronicle generation from messages, prompts, responses or tools;
- LLM summarization, embeddings, vector search or external services;
- GitHub writes, global backlog, project acceptance or FARO synchronization;
- general evidence repository or Raiatea replacement;
- mutation of Git, Ledger, checkpoint, ADR or documentation authorities;
- retention deletion, record rewriting, signatures or multi-host replication;
- Cost Guard, adaptive Advisor, routing, crash recovery or handoff changes.

## 7. Work checkpoints

WCP boundaries represent real capability increments. They do not request a new
session and must not be used to reduce context. Advisor-triggered handoffs may
occur naturally and remain part of the experiment.

### WCP-1 — contract-schema-privacy-evidence

Acceptance:

- ChronicleRecord schema, bounds, category semantics and exact validation are
  implemented;
- local EvidenceReference resolvers, path containment and digest policy exist;
- privacy/secret rejection and valid/invalid deterministic fixtures pass;
- standalone boundary is preserved.

### WCP-2 — append-only-store-and-index

Depends on WCP-1. Acceptance:

- canonical sealed records are atomically persisted and immutable;
- idempotency/conflict, lineage DAG and crash-leftover handling are tested;
- incremental per-record indexes are rebuildable without changing records.

### WCP-3 — aggregation-retrieval-rendering

Depends on WCP-2. Acceptance:

- task, milestone, day and project recaps and project timeline are deterministic;
- selective query, stable pagination and explicit truncation work;
- canonical JSON and safe deterministic Markdown preserve evidence drill-down.

### WCP-4 — CLI-and-public-integration

Depends on WCP-3. Acceptance:

- all fixed CLI commands/options and exit codes work with explicit roots;
- stdout/stderr separation is tested;
- only the public export and package Chronicle script integrate with the repo;
- no runtime Eiopago subsystem is imported or changed.

### WCP-5 — tests-documentation-e2e

Depends on WCP-4. Acceptance:

- the complete offline matrix and temporary-repository E2E pass with network
  blocked and fixed time;
- docs cover all authority, privacy, recovery and limitation requirements;
- all deliverables except the cold-review report are complete;
- Ledger advances to WCP-6 and the session stops exactly at
  `READY_FOR_COLD_REVIEW`.

WCP-1 through WCP-5 are one continuous implementation phase. No planned fresh
session or manual context reset occurs between them.

### WCP-6 — cold-review-and-fix

Starts only in a fresh Runner session with no conversation history after the
implementation marker. Acceptance:

- `docs/reviews/development-chronicle-review.md` reviews every frozen
  requirement and the self-interference denylist;
- structured findings and evidence are recorded; every blocking finding is
  resolved and every rework cycle is registered;
- all six WCPs have evidence, the workload Ledger is `DONE`, and the session
  stops exactly at `READY_FOR_ACCEPTANCE`.

## 8. Completion markers and prompt strategy

- implementation marker: `READY_FOR_COLD_REVIEW`
- final marker: `READY_FOR_ACCEPTANCE`
- accepted checkpoints: `WCP-1` through `WCP-6`

The exact same prompt bytes are used for RUN-40, RUN-50 and RUN-60 and again for
the mandatory cold-review session. Advisor-created replacement sessions receive
only the existing sealed resume mechanism; the operator does not paste the
prompt or a summary into those replacements.

### Proposed exact workload prompt

```text
Execute frozen protocol H2-02B-F4-PILOT-2 workload WL-DEVELOPMENT-CHRONICLE-1 from the local byte-identical file .guardian/calibration/pilot-protocol.json. Read that file, TASK_PLAN.md, and only repository sources relevant to the frozen requirements. Do not modify the protocol, calibration files, threshold/default, Context Advisor, Runner/admission/latch, handoff lifecycle, telemetry/finalizer/quality machinery, or existing checkpoint semantics. If TASK_PLAN.md is still the H2 calibration ledger, first replace it with a valid workload ledger whose exact items are WCP-1 through WCP-6, WCP-1 current, this protocol in minimal_reads, the frozen requirements and both completion markers preserved. Implement the exact standalone Development Chronicle deliverables for WCP-1 through WCP-5 as one continuous implementation phase; update the Ledger only at real capability boundaries, but do not open a fresh session, stop early, split work to manage context, or add work to force a threshold. Use no external service, no third-party runtime dependency, no Pi conversation/history/prompt/response content, and no chain-of-thought capture. If the Advisor proposes a handoff, follow the operator-controlled confirm path and resume only from sealed state; do not summarize or copy history manually. After WCP-5 is complete, update the Ledger to WCP-6 and stop with exactly READY_FOR_COLD_REVIEW. In the mandatory fresh no-history cold-review session, the same prompt applies: when the Ledger shows WCP-6 current, independently review every frozen requirement and the protected-file denylist, write docs/reviews/development-chronicle-review.md, fix every blocking finding without scope expansion, update the Ledger to DONE, and stop with exactly READY_FOR_ACCEPTANCE. Do not invoke or simulate calibration setup/finalization, do not create pilot worktrees, and do not claim acceptance gates passed unless their actual machine outputs are supplied by the operator.
```

The future machine-readable protocol must store these exact UTF-8 bytes and its
SHA-256. No variant-specific prompt suffix, reminder or discretionary guidance
is allowed.

## 9. Exact final acceptance commands

Run in this order; if any command fails, record the attempt, correct only real
findings and rerun the complete ordered suite:

```text
npm run check
node --test --test-concurrency=1 test/chronicle.test.mjs
npm test
git diff --check
```

Quality PASS requires the final complete suite, all exit codes zero, six
accepted WCPs, the final marker, no blocking review finding, no unresolved
regression, complete rework evidence and no protocol/no-history deviation.
Human prose and command output text are not interpreted as PASS.

## 10. Privacy and offline rules

- No network during implementation acceptance or tests; test fixtures replace
  `fetch` with a throwing sentinel.
- Only local temporary Git repositories, files and Chronicle roots are used in
  tests. No real `.guardian` data is read.
- No Pi JSONL, conversation entry, prompt, response, transcript, message body,
  chain-of-thought or hidden reasoning is input or output.
- Semantic statements are explicit bounded fixture/user input and may include
  concise rationale, never verbatim internal reasoning.
- Records persist allowlisted fields, relative locators and digests; evidence
  file contents are verified but not copied into Chronicle records.
- Secret-shaped data fails closed. Unknown or unverifiable evidence stays
  explicit and cannot satisfy a `VERIFIED` requirement.

## 11. Operator behavior

1. Launch only through the future frozen calibration launcher and paste the
   exact workload prompt once into the initial session.
2. Provide no implementation suggestions, summaries or extra work.
3. On every Advisor suggestion, immediately accept preparation, submit the
   unedited `/eio handoff confirm`, accept the single resume admission, and add
   no intervening work or text.
4. Do not initiate a manual/planned session reset during WCP-1..WCP-5.
5. At `READY_FOR_COLD_REVIEW`, close cleanly and launch the mandatory fresh
   no-history review session for the same run; paste the same exact prompt.
6. Supply only necessary machine failure output for corrections. Record every
   gate attempt, review finding, regression and rework cycle in structured
   quality evidence.
7. Never add tasks, examples, fixtures, prose or loops to seek a crossing.

## 12. Controlled variables

Identical across variants except the attested 40/50/60 threshold:

- application baseline: `930fc35d03d3f9795fa6402a047b0ded489e2817`;
- F2/F3 infrastructure included: `6847c5cbf260ed4074e5f3846b130ed3e1ad3da3`;
- future experiment baseline: one successor freeze commit containing the
  infrastructure plus the final protocol/workload design and command alignment;
- same workload ID, protocol bytes, prompt bytes/digest and starting tree;
- `openai-codex/gpt-5.6-sol`, reasoning `high`, Pi `0.83.0`, Node `v22.19.0`;
- confirm mode, compaction/retry policy and operator behavior unchanged;
- same six WCPs, exact deliverables, acceptance suite and quality policy;
- offline execution, no dependencies, no history transfer and no external
  service;
- seed/temperature remain unknown because they are not exposed.

The future baseline must keep the Chronicle implementation absent. Each variant
implements it from the same frozen starting tree.

## 13. VALID, CENSORED and INVALID

- `VALID`: controlled inputs conform; complete authoritative telemetry contains
  a real `MetricSample.context.occupancy_percent` crossing; the associated
  SUGGESTED/PREPARED/STARTED/COMPLETED lifecycle is complete; all six WCPs and
  task are complete; the latest exact gate suite and quality evidence PASS.
- `CENSORED_EARLY_COMPLETION`: all controlled inputs, telemetry coverage, six
  WCPs, task and quality PASS, but no authoritative sample crosses the variant
  threshold. It remains useful evidence of insufficient exposure and is not
  padded or promoted to VALID.
- `INVALID`: existing finalizer semantics apply, including telemetry missing,
  lifecycle/correlation failure, controlled-variable or protected-file change,
  protocol/operator deviation, external service, manual history transfer,
  incomplete task/quality, unresolved finding/regression or fabricated data.

A nominal threshold, WCP count, elapsed time or expected workload size never
substitutes for an observed crossing.

## 14. No-padding clause

The workload must not add token-burning text, duplicate documentation, redundant
fixtures, artificial examples, generated bulk data, no-op modules, repeated
analysis, unnecessary loops, deliberate test failures, arbitrary WCPs or work
outside the exact requirements. Efficient completion is correct. If the exact
useful workload finishes without a crossing, classify it CENSORED.

## 15. Future freeze checklist

Before this proposal can become runnable, a separately reviewed successor
commit must:

1. replace the old inspector workload in the canonical machine-readable
   protocol with this exact selected design;
2. materialize the exact prompt and digest and retain the three fixed variants;
3. align the finalizer's frozen second acceptance command to
   `test/chronicle.test.mjs` and update only its infrastructure tests/docs;
4. ensure accepted checkpoints are WCP-1..WCP-6 and quality evidence handles
   them without inference;
5. update calibration documentation/Ledger status and protocol digest;
6. prove check, test and diff-check green without implementing Chronicle;
7. receive acceptance and a commit after `6847c5c...` designated as the single
   runnable experiment baseline;
8. only then create fresh pilot branches/worktrees from that exact commit.

Until all eight conditions are met, RUN-40/50/60 remain blocked.
