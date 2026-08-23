# CHECKPOINT — AIOPAGO 0.2-E FRESH ROUND 1 OWNER-AUTHORITY REMEDIATION

- **Previous candidate / round:** `54680465427af1a0097f4a34861dd8fec31eb692`; Fresh Independent Review Round 1 = **BLOCKED**. R1-M-01 remains **CLOSED**. New findings R1-M-02, R1-M-03, R1-M-04 and R1-M-05 are remediated below. R2-H-01, R2-M-01, R2-L-01, M-01..M-08 and all historical findings remain closed. Any new candidate keeps/resets the independent gate to **0/2**.
- **Root causes:** the owner guard covered task-operation disposition but not the complete owner-authority domain. Takeover and trusted SafePoint latch acquisition could mutate SQLite outside PlanRevisionWriter arbitration; confirm had an await immediately before owner mutation and required Runner source verification only for guided callers; `TaskLedger.satisfyOwnerGate()` and `GuardianStorage.reserveHandoff()` were supported root side entrances. GuardianStorage also exposed its raw DatabaseSync handle and lifecycle transfer/dispatch mutators.
- **R1-M-02 CLOSED:** HUMAN_TAKEOVER, ordinary/recovery SafePoint latch acquisition, owner confirmation and reservation now use one package-private `PlanRevisionWriter → SQLite authority transaction` order. Takeover-first makes the owner transaction observe `HUMAN_TAKEOVER` and leaves plan bytes/history/gate exact; owner-first excludes a separate-process takeover until P1→P1′ has committed, after which takeover may engage. No plan lock spans abort, UI, provider calls, `waitForIdle`, `waitForNoStreams` or replacement work. Actual Pi/real Runner/real `takeoverFromCommand` proves takeover-first; a separate process proves owner-critical-first and post-owner acquisition. Public latch acquisition fails closed.
- **R1-M-03 CLOSED:** confirm now requires the exact registered current-source verifier for every caller, not only guided UI. All optional async preparation finishes first; immediately afterward the service re-attests exact Runner ID, source object/session ID, ACTIVE lifecycle state and exact epoch, with no await before the synchronous owner capability. Lookalike caller verifiers fail. Actual registered Pi `session_shutdown` immediately before owner mutation returns `HANDOFF_SOURCE_CHANGED` with plan bytes/digest/revision/mtime/gate/history, handoff/artifact/replacement/provider/network counts unchanged. Same-ID shutdown/start ABA stays stale; a fresh capture after legitimate restart succeeds.
- **R1-M-04 CLOSED:** `TaskLedger.prototype.satisfyOwnerGate` is absent and the writer is a private field. The only production `HANDOFF_CONFIRM` mutation is Runner → exact source → HandoffService → package-private capability → PlanRevisionWriter → exact SQLite authority → P1′. A real packed external consumer imports root TaskLedger, verifies the method and writer are unavailable, attempts the direct call, and observes byte-exact BLOCKED P1. Normal actual Pi confirm still seals/resumes P1′.
- **R1-M-05 CLOSED / lifecycle audit:** `GuardianStorage` and safety primitives are no longer package-root exports; internal subpaths remain blocked. Raw DatabaseSync is held in a module WeakMap rather than an instance property. Public raw reservation, recovery transfer, latch acquisition, handoff save/transition, Runner binding/supersession and resume dispatch mutators fail closed; the WeakMap capability binds private reservation directly. Dedicated package-private operations drive trusted HandoffService lifecycle changes. Packed root tests verify GuardianStorage/reservation/test capabilities are absent; source-level direct reservation creates no handoff, active source or `HANDOFF_STARTED`; ordinary/guided/manual/recovery happy paths remain green.
- **Owner snapshot / ordering:** final invocation-local O* binds exact P1 identity, task-operation disposition, latest handoff, exact latch/no takeover, registered Runner/source object/session/lifecycle epoch/ACTIVE state, and actor/command. O* is not persisted. Lock order is globally PlanRevisionWriter then SQLite for owner, takeover, SafePoint claim, ordinary reservation, recovery and resume plan arbitration. No supported reverse-order waiter or uncoordinated lifecycle creator remains. Final reservation after SafePoint remains a separate second arbitration; at most one P1′-bound lifecycle wins and no durable human consent was introduced.
- **Regression evidence:** R1-M-01 exact C1 `RESUME_READY` / fresh S2 actual `/aio handoff confirm` still returns `TASK_OPERATION_CONFLICT` with zero plan/history/C2/replacement/provider/network delta, then C1 resumes once. R2 stale Resume combined/per-field/direct/concurrent sentinels, recovered-child restart conflict, crash guidance/read purity, M-08/M-07/M-06 and historical races all remain covered.
- **Focused gates:** Pi E2E **152/152 PASS**; trusted boundary **69/69 PASS**; unified UX **43/43 PASS**; core **31/31 PASS**; human workflow **34/34 PASS**. 0.2-B **453 total / 451 PASS / 2 platform skips**; 0.2-C **30/30 PASS**; 0.2-D **28 total / 27 PASS / 1 platform skip**. Full suite **908 total / 905 PASS / 3 platform skips / 0 fail**. `npm run check` PASS (**56 modules**); `npm pack --dry-run` PASS (**45 files**); real tarball external root/prototype/internal-subpath boundary PASS; diff checks PASS.
- **Developer adversarial review:** attacked takeover before final source capture, at owner entry, during owner Plan preparation from a separate process and after P1′; actual registered shutdown and lifecycle ABA; direct confirm with absent/forged verifier; packed TaskLedger owner mutation; packed/raw GuardianStorage and every lifecycle transfer/dispatch method; owner versus trusted reservation/recovery lock order; source/takeover composition; R1-M-01, R2-H-01/R2-M-01/R2-L-01, M-01..M-08 and historical sentinels. No known HIGH/MEDIUM remains; developer review does not count toward the gate.
- **Candidate / PR:** the new candidate is the commit containing this section; its immutable SHA is recorded in draft PR #31 after normal push because a commit cannot contain its own SHA. Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**. Gate is **0/2**.
- **Next:** Fresh Independent Review Round 1 on the exact pushed remediation candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E owner authority closed across source, takeover and package side entrances; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E FRESH ROUND 1 R1-M-01 REMEDIATION

- **Previous candidate / round:** `766abadb2f5c90c5537ec2dce6119e01e77debc0`; Fresh Independent Review Round 1 = **BLOCKED**; only finding R1-M-01 MEDIUM. Previous R2-H-01, R2-M-01, R2-L-01, M-01..M-08 and historical findings remain CLOSED. A new candidate resets the independent gate to **0/2**.
- **Root cause / closure:** task-operation arbitration ran only at final handoff reservation, after `/aio handoff confirm` had already called `satisfyOwnerGate()` and committed plan/history mutation. The trusted confirm path now uses a narrow package-private owner-gate capability: exact P1 `PlanRevisionWriter` coordination synchronously invokes GuardianStorage task eligibility before deterministic owner mutation. GuardianStorage reuses the same `taskOperationDisposition()` / `taskOperationBlocksNewHandoff()` classification as final reservation. Unresolved/ambiguous ownership rejects before plan bytes, digest, revision, mtime, gate or history changes.
- **Coordination:** all trusted ordinary reservation, recovery transfer and resume admission paths retain the common package-private PlanRevisionWriter coordination. A competing compliant task lifecycle that wins first is observed by the SQLite guard; if owner coordination wins first, the competitor cannot enter the check→owner-write interval. There is no await, Promise callback, UI, model/network operation, SafePoint or caller-supplied public callback in that interval. No lock spans the later SafePoint. This is the bounded cooperative PlanRevisionWriter/synchronous SQLite guarantee, not global atomicity against privileged hostile filesystems.
- **Final arbitration preserved:** source arbitration, task-operation arbitration, latest-handoff consent CAS, latch identity and exact final plan attestation remain in transactional reservation. Sequence: `task eligibility → exact owner-gate transition → SafePoint → final reservation arbitration`. A legitimate operation that wins after owner mutation is still one-winner under existing latest/final arbitration; owner-gate satisfaction remains task-level authority and no durable consent token was added.
- **Regression evidence:** actual Pi `/aio handoff confirm` creates C1 `RESUME_READY` on blocked P1, reopens a fresh S2, rejects `TASK_OPERATION_CONFLICT` with byte/digest/revision/mtime/gate/history exact, C1 unchanged, C2 rows/replacement/provider/network zero, then resumes C1 exactly once under unchanged P1. Focused real Ledger/SQLite/HandoffService checks cover `REPLACEMENT_SESSION_CREATING`, `MANIFEST_PERSISTING`, `RESUME_READY`, `RESUME_DISPATCH_UNKNOWN`, ambiguous `HANDOFF_FAILED`, `CONTINUITY_FAILED` and already-satisfied owner gates. Independent-process trusted reservations cover operation-first, owner-critical-section-first and post-owner/pre-reservation one-winner orderings. Existing P2 races and no-conflict owner-gate happy path remain covered.
- **Preserved closures:** R2-H-01 stale resume matrix and direct/concurrent sentinels; R2-M-01 recovered-child/manual-S2 and two-connection arbitration; R2-L-01 read-only crash guidance; M-08 semantic evidence, M-07 temporal recovery, M-06 recovery shutdown, M-01 owner CAS, M-02 P* provenance, M-03 lifecycle, M-04 source identity, M-05 package boundary; historical H-01/M-01-R, older M-02/M-03 and L-01/L-02 remain covered. Accepted 0.2-B/C/D and read purity are unchanged.
- **Test gates:** Pi E2E **148/148 PASS**; trusted boundary **66/66 PASS**; unified UX **43/43**; core **31/31**; human workflow **34/34**. 0.2-B **453 total / 451 PASS / 2 skips**; 0.2-C **30/30**; 0.2-D **28 total / 27 PASS / 1 skip**. Full suite **901 total / 898 PASS / 3 platform skips / 0 fail**. `npm run check` PASS (**55 modules**); `npm pack --dry-run` PASS (**45 files**); real tarball/internal-subpath boundary PASS; diff checks PASS.
- **Developer adversarial review:** attacked exact C1/S2 actual command and later resume; representative active/ambiguous/recovery states; blocked and satisfied gates; P2-first/P1'-first owner CAS; independent-process operation-first, pre-critical operation-first, owner-critical-first and post-owner/pre-reserve ordering; final reservation retention; combined/per-field stale resume; recovered-child/manual-S2; crash guidance; M-08/M-07/M-06 and all historical sentinels. No known HIGH/MEDIUM remains; developer review does not count toward the independent gate.
- **Candidate / PR:** the new candidate is the commit containing this section; its immutable SHA is recorded in draft PR #31 after normal push because a commit cannot contain its own SHA. Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**. Gate is **0/2**.
- **Next:** Fresh Independent Review Round 1 on the exact pushed remediation candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E R1-M-01 closed by pre-owner task ownership arbitration under exact plan coordination; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E FRESH INDEPENDENT REVIEW ROUND 2 REMEDIATION

- **Previous candidate / gate:** `0dd474e664305eadd71c263113222552e2c8d7cc`; Round 1 **CLEAN**, Round 2 **BLOCKED**, previous gate **1/2**. Findings: R2-H-01 HIGH stale Resume YES after plan/Git/target-ownership movement; R2-M-01 MEDIUM source-scoped reservation allowed a second task lifecycle after a recovered child crash; R2-L-01 LOW lost bounded persistence/projection guidance. Any remediation creates a new candidate and resets the independent gate to **0/2**.
- **R2-H-01 root cause / closure:** continuity observed mutable authority before the UI prompt, but `resume()` accepted only actor/transport and `authorizeAndAdmit()` checked only state/human/latch. One invocation-local immutable Resume Expectation E* now binds exact handoff, canonical P1 semantics/digest, Git, target session/file/current Runner lifecycle, runtime/header/durable ACTIVE binding, model/reasoning, idle/no-history state, checkpoint/manifest/prompt identities, required paths, latch, empty resume state and task-operation owner. E* is never persisted or reusable. After YES, final U* re-attests every dimension synchronously; package-private plan coordination spans only exact P1→U*→SQLite admission, not prompt/send. SQLite revalidates the exact durable handoff/binding/artifact/prompt/P1/latch/task-owner/empty-state facts in the same rollback-safe transaction that releases the latch and inserts authorization/admission. Direct service/storage bypass fails closed; `/aio resume`, `finishPausedHandoff()` and `resumeExisting()` converge on this path.
- **R2-H-01 evidence:** actual Runner/UI regression mutates real PlanPort P1→P2, real Git G1→G2 and real SQLite binding ACTIVE→SUPERSEDED inside confirmation; YES now leaves zero authorization/admission/dispatch/send and the latch engaged. Per-dimension attacks cover plan, Git, binding, takeover, current target lifecycle, Runner identity/header, history, model, reasoning, checkpoint/manifest/prompt identities and required-path disappearance. Additional races cover resume-first/P2-first plan order, final two-connection binding supersede, post-latch-release rollback, concurrent YES, direct resume, paused completion and existing confirmation. Exact unchanged YES still admits and sends once; NO remains zero mutation beyond existing `RESUME_READY` evidence.
- **R2-M-01 root cause / closure:** `active_sources` arbitrated only a source and generic admission recognized only ACTIVE `CONTINUITY_FAILED`; after F1→C1 transfer, a crash-stalled C1 with a different source could be bypassed. One package-private state-derived task-operation disposition now runs inside every SQLite reservation transaction in addition to source uniqueness and latest-handoff CAS. Active, ambiguous and reconciliation-required states block another task lifecycle across sources/processes/restart. Atomic explicit recovery marks the failed generation transferred and reserves exactly one child in the same transaction, preserving F1→C1→C2.
- **R2-M-01 evidence:** a real F1 recovery is crashed immediately after durable C1 `REPLACEMENT_SESSION_CREATING`, storage/Runner are reopened with fresh S2, and actual manual handoff rejects with no C2/target/artifact/provider call. Representative checkpoint/replacement/manifest/resume/admission/dispatch/unknown/failure states reject across two SQLite connections. Guided advice offers no consent while unresolved ownership holds the latch; explicit command rejects transactionally; multi-generation recovery succeeds with exactly three lineage rows.
- **R2-L-01 closure:** caught checkpoint, Runner-ownership and manifest persistence failures now retain bounded `{code,message}` and `manual_recovery`. A crash intent observed under a different Runner projects unknown outcome/manual reconciliation/do-not-retry rather than indefinite wait. The projection is read-only and task-lock-consistent; no artifact rewrite, replacement retry, rollback, auto-handoff or auto-resume was added.
- **Preserved closures:** M-08 canonical semantic equality and transactional snapshot check; M-07 final R*/atomic recovery arbitration; M-06 lifecycle revalidation; M-01 owner CAS; M-02 immutable P* provenance; M-03 lifecycle; M-04 source identity; M-05 package boundary; historical H-01/M-01-R and older M-02/M-03/L-01/L-02 remain covered. Accepted 0.2-B/C/D and read purity are unchanged.
- **Regression evidence:** Pi E2E **147/147 PASS**; trusted boundary **53/53**; unified UX **43/43**; core **31/31**; human workflow **34/34**. 0.2-B **453 total / 451 PASS / 2 skips**; 0.2-C **30/30**; 0.2-D **28 total / 27 PASS / 1 skip**. Full suite **887 total / 884 PASS / 3 platform skips / 0 fail**. `npm run check` PASS (**55 modules**); `npm pack --dry-run` PASS (**45 files**); real packed-consumer boundary PASS; diff checks PASS.
- **Candidate / PR:** the new candidate is the commit containing this section; its immutable SHA is recorded in draft PR #31 after normal push because a commit cannot contain its own SHA. Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**. New independent gate is **0/2**.
- **Next:** Fresh Independent Review Round 1 on the exact pushed remediation candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E Round 2 stale resume and task lifecycle fork closed; truthful crash guidance; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E FRESH ROUND 1 M-08 REMEDIATION

- **Previous candidate / round:** `41a74c6d2316402d0d59dd4330586b48da574ac1`; Fresh Independent Review Round 1 = **BLOCKED**. The only open finding was M-08: recovery accepted cryptographically valid evidence and failed-handoff snapshots that claimed P1 identity while carrying conflicting P1 semantics. M-07, M-06, M-01..M-05 and historical findings remain CLOSED. Independent gate remains **0/2**.
- **Reproduction / root cause:** on the previous candidate, the real reviewer-style sealed-manifest attack and reserved-snapshot attack both produced `Missing expected rejection`: recovery reserved a child. R* strongly bound temporal revision/digest/position but had no single complete semantic equality contract across coordinated Ledger, failed top-level provenance, failed `reserved_plan_snapshot`, checkpoint and manifest.
- **Canonical P1 semantics:** one package-private normalized projection contains task/objective/position, revision/content digest/requirements, completion criteria, decisions/tests/evidence, minimal reads, canonical required paths and effective model/reasoning. Ordered arrays and exact scalars/nulls use existing canonical JSON; required paths use `canonicalRequiredLocalPaths()`. Its SHA-256 is consistency evidence only—`TASK_PLAN.md` and its content digest remain plan authority.
- **R* semantic coherence:** before final R* construction, coordinated P1 must equal the complete failed reserved snapshot and failed top-level aliases. The same canonical P1 validates checkpoint identity/parent/task items/session lineage/completion criteria/tests/decisions/next step/Git and manifest objective/position/plan identity/context/model/Git/session/binding/parent/checkpoint linkage. Valid sealed envelopes are necessary but insufficient. R* remains detached/deep-frozen and the recovery child is built only from canonical R* P1, never old manifest semantics.
- **Transactional defense:** R* carries the canonical semantic digest. Before any SQLite mutation, failed-handoff identity revalidation recomputes the durable `reserved_plan_snapshot` digest with canonical serialization and requires equality with R*. A deterministic post-capture semantic movement through the storage seam rejects `CONTINUITY_RECOVERY_SOURCE_INVALID`; binding stays ACTIVE and preparation/reservation journals and child rows remain unchanged.
- **Real regressions:** actual ArtifactStore envelopes are rewritten with conflicting payload semantics and recomputed payload content digest, canonical envelope bytes, envelope SHA-256, artifact index and failed expected digest. The exact objective+decisions+minimal-reads attack now rejects `MANIFEST_MISMATCH` before storage. Matrices mutate each manifest plan/model/Git/session/parent/checkpoint field, each reserved snapshot semantic field, and checkpoint completion/tests/decisions/position/Git/lineage fields. Every invalid case verifies zero recovery durable delta, zero replacement/provider/network call. Canonical-equivalent required-path duplication succeeds and the child stores one normalized P1.
- **Preserved guarantees:** M-07 temporal R* drift, both plan-lock orderings, P2/G2/M2 post-arbitration binding and atomic preparation+reservation rollback remain CLOSED. M-06 lifecycle, M-01 owner CAS, M-02 ordinary P* provenance, M-03 lifecycle, M-04 active-source arbitration, M-05 packed package boundary, H-01/M-01-R and older M-02/M-03/L-01/L-02 remain covered. Read surfaces and accepted 0.2-B/C/D contracts are unchanged.
- **Gates / candidate:** actual Pi E2E **121/121 PASS**; trusted boundary **34/34**; unified UX **43/43**; core **31/31**; human workflow **34/34**. 0.2-D **28 total / 27 PASS / 1 skip**; 0.2-C **30/30**; 0.2-B **453 total / 451 PASS / 2 skips**. Full suite **842 total / 839 PASS / 3 platform skips / 0 fail**; `npm run check` PASS (**54 modules**); `npm pack --dry-run` PASS (**44 files**); real tarball package boundary PASS; diff checks PASS. The new candidate is the commit containing this section; its immutable SHA is recorded in PR #31 after normal push because a commit cannot contain its own SHA. Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**. Gate is **0/2**.
- **Next:** Fresh Independent Review Round 1 on the exact pushed candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E M-08 closed by canonical P1 semantic equality and transactional snapshot revalidation; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E FRESH ROUND 1 M-07 REMEDIATION

- **Previous candidate / round:** `c6f369345b826b806ca874666e9a0d083437b0a6`; Fresh Independent Review Round 1 = **BLOCKED**. M-06 and M-01..M-05 remain CLOSED. The open finding was M-07: recovery durably prepared after SafePoint using stale authority-critical preconditions. Independent gate remains **0/2**.
- **Reviewer reproductions / root cause:** during recovery SafePoint, real PlanPort P1→P2, real Git G1→G2, actual Pi M1→M2, actual SessionManager history append and sealed manifest tamper all crossed the old boundary. Only source lifecycle was rechecked; `prepareContinuityRecovery()` consumed authority and the later child `handoff()` reread current mutable state.
- **Final Recovery Attestation R\*:** after SafePoint, one invocation-local detached/deep-frozen snapshot freshly re-attests exact Runner/source object/session/lifecycle epoch and ACTIVE state; zero history and idle/quiescent runtime; task/revision/digest/requirements plus current/next/next-step; actual model/reasoning; Git identity; freshly verified checkpoint/manifest IDs, envelope and content digests; semantic recovery evidence; exact latch state/generation/reason; failed handoff and ACTIVE binding. Mismatch is fail-closed and never auto-restores plan, Git, model, history or artifacts.
- **Coordination/durable boundary:** the package-private PlanRevisionWriter capability holds only the short final P1 attestation→R\* capture→durable operation interval, never SafePoint or an await. One synchronous SQLite transaction validates failed state/binding/authorization/admission/dispatch, supersedes the binding, journals recovery start and reserves the recovery child. A child-journal failure rolls all of it back. No async/UI/provider/model/network call exists in this interval.
- **Child provenance:** the reserved child is constructed only from R\*: P1 identity/position and immutable plan snapshot, G1, M1/reasoning, same recovery source/Runner/latch and `recovery_of`. It does not re-enter generic handoff admission or reread mutable current P2/G2/M2. Later drift may make continuity fail safely but cannot rewrite recovery provenance.
- **Real regressions:** actual Pi 0.83.x `setModel`, `setThinkingLevel`, `SessionManager.appendMessage` and lifecycle shutdown; accepted real PlanPort in both lock orderings; temporary real Git G1/G2; actual ArtifactStore checkpoint/manifest path tamper; post-arbitration P2/G2/M2 provenance; atomic child-journal rollback; normal recovery and rejected-then-explicit-valid retry. Every stale pre-boundary case asserts binding ACTIVE, binding-supersede/recovery-start/recovery-child deltas zero, active sources unchanged, replacement/provider/network calls zero. Pi E2E is **47/47 PASS**; trusted boundary **34/34**; unified UX **43/43**; core **31/31**; human workflow **34/34**.
- **Preserved findings/contracts:** M-06 lifecycle shutdown/wait/ABA/retry and M-01 owner CAS, M-02 artifact provenance, M-03 ordinary lifecycle, M-04 active-source conflict, M-05 package boundary remain CLOSED. Historical H-01/M-01-R and accepted 0.2-B/C/D remain unchanged. 0.2-D is **28 total / 27 PASS / 1 skip**, 0.2-C **30/30**, 0.2-B **453 total / 451 PASS / 2 skips**. Read surfaces remain pure and no public API, durable consent/approval store or 0.2-F state was added.
- **Gates / developer adversarial review:** full suite **768 total / 765 PASS / 3 platform skips / 0 fail**; `npm run check` PASS (brand guard + **53 modules**); `npm pack --dry-run` PASS (**43 files**); real tarball package-boundary sentinel PASS; `git diff --check` PASS. Attacked all reviewer reproductions, both plan orders, post-arbitration drift, lifecycle/takeover/binding/authorization sentinels, normal/retry, historical races, read purity and package boundary. No known HIGH/MEDIUM remains; developer review does not count toward the gate.
- **Candidate/PR:** the new candidate is the commit containing this section; its immutable SHA is recorded in draft PR #31 after normal push because a commit cannot contain its own SHA. Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**, no merge/mark-ready. Gate is **0/2**.
- **Next:** Fresh Independent Review Round 1 on the exact pushed candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E M-07 closed by final R* and atomic recovery preparation/reservation; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E FRESH ROUND 1 M-06 REMEDIATION

- **Previous candidate / round:** `7b3e4d5897ccb9eb12b1cdefa90fb46bea64395a`; Fresh Independent Review Round 1 = **BLOCKED**. The only finding was M-06: recovery source shutdown after SafePoint entry still allowed durable recovery preparation. Independent gate resets/remains **0/2**.
- **Observed mutation / root cause:** the rejected candidate ended with `HANDOFF_SOURCE_CHANGED` and no new handoff/replacement, but the failed target binding changed `ACTIVE` → `SUPERSEDED` and one `CONTINUITY_RECOVERY_STARTED` event committed. `recoverContinuityFailure()` verified the source before asynchronous SafePoint and did not revalidate its Runner-owned lifecycle before `prepareContinuityRecovery()`.
- **M-06 CLOSED in remediation:** immediately after SafePoint, `HandoffService` requires the same captured current-source verifier to attest exact Runner, source object/session ID, ACTIVE state and lifecycle epoch. That synchronous check is directly adjacent to the existing synchronous SQLite preparation transaction: there is no await, UI, model/network operation or promise scheduling between them. GuardianStorage remains durable arbitration authority; the lifecycle epoch remains ephemeral Runner evidence.
- **Rejected lifecycle evidence:** actual registered Pi 0.83.x `session_shutdown` during both `waitForIdle` and `waitForNoStreams`, plus same-ID shutdown/start ABA, returns `HANDOFF_SOURCE_CHANGED` with `prepareContinuityRecovery()` calls **0**, binding still **ACTIVE**, deltas **0** for `RUNNER_SESSION_BINDING_SUPERSEDED`, `CONTINUITY_RECOVERY_STARTED` and handoff rows, replacement attempts **0**, provider calls **0** and network attempts **0**. The existing INTEGRITY latch remains ENGAGED at the same generation/reason; it is not rolled back or rewritten.
- **Positive/retry/takeover evidence:** an authoritative unrelated-session shutdown leaves S1 valid and normal recovery prepares exactly once, supersedes once, creates one recovery handoff and leaves its replacement `RESUME_READY`. A stale ABA attempt followed by a fresh lifecycle capture succeeds exactly once, proving rejected preparation remains retryable. `HUMAN_TAKEOVER` during recovery SafePoint still rejects before preparation with the binding ACTIVE, no recovery journal event/handoff/replacement and the latch escalated to takeover.
- **Preserved sentinels:** M-01 owner-gate races, M-02 reserved P1 provenance, M-03 ordinary guided shutdown, M-04 active-source conflict/idempotency and M-05 real-tarball package boundary remain CLOSED. Historical H-01 SafePoint/pre-reserve/post-reserve takeover races and M-01-R plan/session/Runner/latch movement remain closed. Read projections, P* drift behavior, separate resume and accepted 0.2-B/C/D remain unchanged.
- **Regression evidence:** Pi SDK **33/33 PASS** (including real extension lifecycle recovery); trusted boundary **34/34 PASS**; unified UX **43/43 PASS**; core **31/31 PASS**; human workflow **34/34 PASS**; 0.2-D **28 total / 27 PASS / 1 platform skip**; 0.2-C **30/30 PASS**; 0.2-B **453 total / 451 PASS / 2 platform skips**; full suite **754 total / 751 PASS / 3 platform skips / 0 fail**. `npm run check` PASS (brand guard + **53 modules**); `npm pack --dry-run` PASS (**43 files**); real tarball/external package-boundary sentinel PASS; `git diff --check` PASS.
- **Developer adversarial review:** attacked shutdown during both SafePoint waits, lifecycle ABA, unrelated shutdown, takeover, normal recovery, rejected-then-fresh retry, binding/journal/handoff mutation, provider/replacement calls, ordinary guided shutdown, owner-gate races, P* provenance, active-source conflict, package boundary and all historical race sentinels. No known HIGH/MEDIUM remains; self-review does not count toward the independent gate.
- **Candidate/PR:** the new candidate is the commit containing this section; its immutable SHA is recorded in draft PR #31 immediately after normal push because a commit cannot embed its own SHA. Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**, no merge/mark-ready. Gate is **0/2**.
- **Next:** Fresh Independent Review Round 1 on the exact pushed candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E Fresh Round 1 M-06 remediated by final Runner lifecycle attestation before durable recovery preparation; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E FRESH ROUND 1 M-01..M-05 REMEDIATION

- **Previous candidate / round:** `410af5f23d66f0daa498b79e406c91deaabe03fc`; Fresh Independent Review Round 1 = **BLOCKED**. Open findings were M-01 owner-gate pre-state race, M-02 mixed post-reservation manifest provenance, M-03 missing source lifecycle revalidation, M-04 unrelated active-source adoption and M-05 public plan coordination. No HIGH and no separate LOW. Independent gate resets/remains **0/2**.
- **Root causes:** owner-gate P1 validation and mutation occupied separate authority observations; manifest creation reread current `TASK_PLAN.md`; trusted source equality omitted lifecycle ACTIVE/generation; active-source idempotence checked only source ID; `TaskLedger.withAuthorityCoordination()` exported a general callback on the root API.
- **M-01 CLOSED:** guided P1 task/revision/digest is now the `PlanRevisionWriter.commit(expected)` CAS identity for the short owner-gate operation. Fresh exact P1 attestation and deterministic HUMAN P1→P1' materialization share one accepted writer lock/commit. A real PlanPort P2 winner leaves its owner gate BLOCKED and causes `PLAN_CAS_CONFLICT` with zero reservation; a P1' winner forces the stale P2 proposal to CAS-conflict/rebase and reserves only P1'. No-gate/already-satisfied confirms perform no write but still attest exact P1. Forced preparation failure leaves P1 byte-authoritative with no handoff/checkpoint/replacement.
- **M-02 CLOSED:** one detached/deep-frozen selected reserved plan snapshot carries objective, position, revision/digest/requirements, completion criteria, decisions/tests/evidence, minimal reads, required paths and model/reasoning policy. It is persisted in the existing handoff projection and drives checkpoint, manifest and prompt; `buildManifest()` no longer reads Ledger. Checkpoint/handoff/manifest structural checks bind revision/digest and duplicated semantics before seal/resume. Real PlanPort P2 immediately after reservation and after P1 checkpoint seal cannot contaminate P1 artifacts; current P2 remains allowed and continuity rejects drift separately.
- **M-03 CLOSED:** GuardianRunner owns an ephemeral per-current-session lifecycle epoch plus ACTIVE state. Trusted capture binds source object/ID, Runner ID and epoch. Registered Pi `session_shutdown` identifies the outgoing session through 0.83.x `ctx.sessionManager.getSessionId()`, invalidates ACTIVE and advances epoch; same-ID shutdown/start ABA cannot reuse the capture, while an identified unrelated session does not invalidate it. Source must remain exact/ACTIVE through final pre-reservation verification; replacement-driven shutdown occurs only after durable arbitration and explicitly activates the new paused target. Shutdown during `waitForIdle` or `waitForNoStreams` yields `HANDOFF_SOURCE_CHANGED`, zero reservation/checkpoint/newSession; actual Pi extension emission is covered.
- **M-04 CLOSED:** active-source reuse compares one explicit stable reservation identity: handoff/source/task/revision/digest/latch/Runner/recovery plus checkpoint/manifest IDs. Exact retry returns the same row once; cross-task and same-task/different-provenance attempts throw `HANDOFF_ACTIVE_SOURCE_CONFLICT`. Two real SQLite connections and forced journal failure prove conflict behavior and transaction rollback without orphan rows/events.
- **M-05 CLOSED:** `TaskLedger.prototype.withAuthorityCoordination` is removed. Final attestation/reservation uses one narrow internal WeakMap capability registered by real TaskLedger/GuardianStorage instances; it accepts no public caller callback and is absent from `src/index.mjs`. `PlanRevisionWriter` remains non-exported and package `exports` still blocks all internal subpaths. A real npm tarball/external consumer verifies the exact public TaskLedger prototype and blocked internal import.
- **Preserved boundaries:** takeover priority and all SafePoint/reservation races remain closed; guided NO is zero mutation, guided exact YES reserves once, manual handoff/recovery/paused replacement/separate resume remain, and no automatic handoff/resume or persisted consent exists. Historical M-02 malformed runtime, M-03 nested technical identity, L-01 detached projection and L-02 plan-read movement remain closed. Read projections stay pure with zero provider/network calls. Accepted 0.2-B/C/D are unchanged.
- **Regression evidence:** trusted boundary **34/34 PASS**; unified UX **43/43 PASS**; core **31/31 PASS**; human workflow **34/34 PASS**; actual Pi SDK **28/28 PASS**; 0.2-D **28 total / 27 PASS / 1 platform skip**; 0.2-C **30/30 PASS**; 0.2-B **453 total / 451 PASS / 2 platform skips**; full suite **749 total / 746 PASS / 3 platform skips / 0 fail**. `npm run check` PASS (brand guard + **53 modules**); `npm pack --dry-run` PASS (**43 files**); real tarball/external consumer and blocked internal subpath PASS; `git diff --check` PASS.
- **Candidate/PR:** new candidate is the commit containing this remediation section; its exact immutable SHA is recorded in draft PR #31 immediately after normal push because a commit cannot embed its own SHA. Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**, no merge/mark-ready. Independent gate is **0/2**.
- **Next:** fresh Independent Review Round 1 on the exact pushed candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E Fresh Round 1 M-01..M-05 remediated through CAS-bound reserved provenance; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E FRESH ROUND 1 H-01/M-01-R REMEDIATION

- **Previous candidate / round:** `0cc285f4eda1381b657ab789de3022eabb2faa9d`; Fresh Independent Review Round 1 = **BLOCKED**. H-01 proved that `HUMAN_TAKEOVER` after UI revalidation could still start trusted handoff mutation. M-01-R proved that plan/session movement from P1/S1 to P2/S2 in the revalidate→trusted-call window could reserve P2/S2 provenance. Gate is reset/remains **0/2**.
- **Root cause:** the UI discarded its expected identity at `GuardianRunner.handoffFromCommand()`; Runner selected `runtime.session` at invocation time; `HandoffService` reread the current Ledger; SafePoint reused a stale latch object through asynchronous drains; reservation did not condition row creation on the latch actually acquired.
- **Trusted consent binding:** the canonical ephemeral task/revision/digest, source session, Runner, latch generation/reason/state and handoff identity now travels explicitly from guided UI to Runner and HandoffService. Guided calls require it and malformed/missing fields fail closed. Runner captures the exact source object and installs an invocation-local current-source verifier; P1/S1 consent cannot become P2/S2 or cross Runner instances. No consent/token is persisted and no display/context data is authoritative.
- **Plan/owner gate:** HandoffService validates the approved pre-mutation plan before `satisfyOwnerGate()`. A legitimate HUMAN owner-gate transition derives one exact post-transition plan identity. After SafePoint, TaskLedger uses the accepted plan-writer lock only around final exact revalidation plus SQLite reservation, so compliant PlanPort movement is either observed as stale or excluded from that bounded interval. No lock spans the prompt or long SafePoint waits; no arbitrary-filesystem atomicity claim is made.
- **Takeover/latch:** SQLite conditionally claims the latch against expected state/generation/reason. Existing `HUMAN_TAKEOVER` is a hard refusal for handoff and can never be downgraded. SafePoint re-reads after abort, `waitForIdle`, `waitForNoStreams` and at final return, requiring its exact acquired non-takeover identity. Reservation rechecks that identity and expected handoff state in the same SQLite transaction that inserts handoff/active-source rows. Takeover before reservation yields zero rows/artifacts/replacement attempts. Takeover after reservation is the documented durable arbitration boundary: exact failure evidence is retained and the immediate pre-replacement latch check prevents `newSession`.
- **Race evidence:** real GuardianRunner/HandoffService/SafePointCoordinator/GuardianStorage/ArtifactStore/TaskLedger tests cover takeover before trusted entry, existing takeover, takeover during `waitForIdle` and `waitForNoStreams`, post-SafePoint/pre-reserve, post-reserve/pre-replacement, P1/S1→P2/S2, plan-only, digest-only, session-only and plan/session movement during SafePoint, Runner identity/malformed consent, exact-current guided happy path, and 20 two-connection SQLite reservation interleavings. Exact-current guided handoff reserves once and leaves the target `RESUME_READY`; resume authorization stays separate.
- **Preserved findings/contracts:** previous M-01 prompt→YES remains CLOSED. M-02 malformed verified runtime, M-03 nested technical failure identity, L-01 projection detachment and L-02 `PLAN_CHANGED_DURING_READ` re-observation remain CLOSED. Manual handoff, recovery, takeover escalation, paused replacement, explicit resume and accepted 0.2-B/C/D contracts remain covered; no 0.2-F/G state or auto-handoff/auto-resume was added.
- **Gate evidence:** trusted-boundary regressions **20/20 PASS**; unified UX **43/43 PASS**; core **31/31 PASS**; actual Pi SDK **27/27 PASS**; 0.2-D **28 total / 27 PASS / 1 platform skip**; 0.2-C **30/30 PASS**; 0.2-B **453 total / 451 PASS / 2 platform skips**; full suite **734 total / 731 PASS / 3 platform skips / 0 fail**. `npm run check` PASS (brand guard + **52 modules**); `npm pack --dry-run` PASS (**42 files**); real tarball/external consumer and blocked internal subpath PASS; `git diff --check` PASS.
- **Candidate/PR:** the new candidate is the commit containing this remediation section; its immutable SHA is recorded in draft PR #31 immediately after normal push (a commit cannot embed its own SHA). Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**, no merge/mark-ready. Independent gate is **0/2**.
- **Next:** fresh Independent Review Round 1 on the exact pushed candidate. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E Fresh Round 1 H-01/M-01-R remediated at trusted handoff boundary; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E ROUND 1 REMEDIATION

- **Previous candidate / round:** `3e5a27e51fd4b8854dc42b849b515f9e9741de8e`; Fresh Independent Review Round 1 = **BLOCKED**. Gate remains **0/2**. Open findings were M-01 stale preparation consent, M-02 malformed verified runtime false healthy, M-03 nested failure-code masking, L-01 caller diagnostic alias/freeze, and L-02 change-during-read corruption wording.
- **Root causes:** guided YES was followed only by a fresh broad admission boolean rather than an exact pre-prompt identity comparison; the public projector validated only latch fragments after trusting `verified=true`; technical formatting omitted the selected nested failure; projection deep-freeze received the caller failure object directly; plan read movement entered generic invalid-plan wording.
- **M-01 CLOSED:** prompt preparation consent now binds invocation-locally to task ID, accepted plan revision/content digest, explicit session ID, Runner instance ID, latch state/generation/reason, and relevant handoff identity/state or none. After YES, a fresh coherent observation must compare exactly and admission/session epoch must still hold before `GuardianRunner.handoffFromCommand()`. Plan/session movement, latch state or ABA generation movement, takeover, handoff appearance/change, Runner replacement and malformed reread invoke zero handoff and cause no retry/second prompt. Context percentage is deliberately excluded. No persistence or authority was added.
- **M-02 CLOSED:** `validateRuntimeObservation()` is the single pre-projection coherence boundary for verified live claims. It requires live workflow/condition, null error, exact task/revision/digest binding, coherent session/Runner/model identity, latch structure and generation, known/coherent handoff state including required IDs/failure, and bounded nested context/Git evidence. Unknown, missing, malformed, contradictory and task-mismatched evidence projects `NEEDS_ATTENTION / RUNTIME_OBSERVATION_INVALID`; explicitly unavailable/unverified external CLI evidence remains supported. `WORKING` and `COMPLETED` tests require the valid shape.
- **M-03 CLOSED / L-01 CLOSED / L-02 CLOSED:** technical status renders both top-level condition/handoff state and bounded exact nested runtime failure code/message. Selected failure/diagnostic/context/Git data is cloned or explicitly selected before recursive freezing; caller objects remain mutable and detached. `PLAN_CHANGED_DURING_READ` now requests re-observation after movement and does not claim corruption; genuine invalid plans retain check/raw/manual repair guidance.
- **Focused evidence:** `test/unified-human-ux.test.mjs` **40/40 PASS** including the full stale-consent authority matrix, direct public malformed-runtime matrix, nested HANDOFF/CONTINUITY diagnostics, detachment and plan-read movement; `test/core.test.mjs` **31/31 PASS**; actual Pi 0.83.x `test/pi-e2e.test.mjs` **26/26 PASS**, including real Runner-boundary stale plan consent with zero trusted invocation/provider/network call. Read-only Pi SDK normal/technical projections, separate resume NO/YES, takeover, replacement pause and continuity remain green.
- **Broad gates:** full `npm test` **710 total, 707 PASS, 3 platform skips, 0 fail**; 0.2-D **28 total / 27 PASS / 1 platform skip**; 0.2-C **30/30 PASS**; 0.2-B **453 total / 451 PASS / 2 platform skips**; 0.2-A read/purity **34/34 PASS**. `npm run check` PASS (brand guard + 50 modules); `npm pack --dry-run` PASS (41 files); real tarball/external consumer PASS with public remediation exports, documentation and blocked internal subpath; `git diff --check` PASS.
- **Developer adversarial review:** attacked stale plan revision/digest and combined plan+session movement, same-model session swap, latch state/ABA generation, handoff none→existing and existing identity movement, Runner replacement, takeover, shutdown, duplicate events, context-only movement, malformed session/latch/handoff/failure/context/task binding, all positive states, nested code masking, caller freeze/alias, change-during-read guidance, read purity, zero provider calls, separate resume and accidental 0.2-F/G/H/I/J semantics. No known HIGH/MEDIUM remains; self-review does not count toward the gate.
- **Candidate/PR:** new candidate is the commit containing this remediation section; its exact immutable SHA is recorded in draft PR #31 immediately after normal push (a commit cannot embed its own SHA). Base/merge-base remains `6386d599e8510933786ea34822b01adac2fdb205`. PR #31 remains **OPEN / DRAFT**, no merge/mark-ready. Any new HEAD resets the independent gate to **0/2**.
- **Next:** fresh Independent Review Round 1 on the exact new PR HEAD. 0.2-F remains **NOT STARTED / BLOCKED**.
- `checkpoint_message`: “0.2-E Round 1 findings remediated; stale consent and malformed verified evidence fail closed; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-E READY FOR INDEPENDENT REVIEW

- **Stato/gate:** 0.2-E è **READY FOR INDEPENDENT REVIEW**, independent gate **0/2**. La developer adversarial review non conta come gate. Issue #30; branch `feat/unified-human-ux-0.2-e`; worktree `F:/dev/aiopago-0.2-e`; starting main/origin/main/merge-base `6386d599e8510933786ea34822b01adac2fdb205`.
- **Projection architecture:** `projectHumanWorkflow()` evolve nella sola projection concettuale `aiopago.human-workflow-projection/0.2-e`, detached e deep-frozen. `observeHumanWorkflow()` resta l’adapter CLI conservativo senza Runner; `observeRunnerHumanWorkflow()` aggiunge selected live plan/session/latch/handoff/Git/context facts, verifica stabilità di piano/sessione/latch/handoff e non espone storage, writer, service o callback. Nessuna projection persistita/cache/autoritativa.
- **CLI/TUI parity:** `aio status/why/next/plan` e `/aio [status]/why/next/plan` usano gli stessi state/reason/next/objective/current activity/progress/plan summary. `/aio status technical` e `/aio plan technical` preservano repository/Git/task/revision/digest/Runner/session/model/reasoning/latch/handoff/context e codici precisi come disclosure secondaria. `formatGuardianStatus()` è un thin technical renderer sulla projection condivisa, non una seconda business projection.
- **Runtime/read purity:** esterno `unavailable`, `unverified`, non-quiescent, changed-during-read e read failure non diventano mai claim healthy. Live Runner può produrre una observation verificata senza diventare authority. Test CLI reali e Pi SDK confrontano bytes di `TASK_PLAN.md`, SQLite `total_changes`, journal/handoff count e latch prima/dopo: invariati. Status/why/next/plan fanno zero provider/model/network call e non creano proposal/history/apply/handoff/lock/latch/sessione.
- **Guided handoff UX:** l’advisor conserva threshold e dedup. NO/close/failure UI non invoca handoff; YES chiama una volta la stessa `GuardianRunner.handoffFromCommand(ctx,"confirm")`, senza `setEditorText()` o cerimonia command-copy. `HandoffService`, SafePoint, AdmissionGate, ownership, continuity e latch restano autorità. Il target nasce/resta PAUSED; una seconda conferma esplicita governa resume. Resume NO lascia `RESUME_READY`; YES ammette/dispatcha una volta. Takeover durante prompt, handoff esistente, doppio evento e shutdown prompt falliscono chiuso; nessun retry/recovery/second target nascosto.
- **Failure/recovery:** continuity failure proietta l’exact recover command; handoff/dispatch ambiguity conserva exact code e manual recovery, vieta retry automatico. Errori guided mostrano causa, next action e codice. Manual `/aio handoff [manual|confirm]`, `handoff recover`, takeover e resume restano.
- **Authority boundaries:** `TASK_PLAN.md` plan authority; GuardianStorage runtime/latch/handoff records; Runner live observation; shared projection read-only derived; renderer presentation only; guided UI human-intent adapter; HandoffService/SafePoint/AdmissionGate mutation e control authority. Nessun contratto 0.2-B/C/D modificato; nessun 0.2-F/G/H/I/J state/API.
- **Test focalizzati:** shared human UX + 0.2-A **45/45 PASS**; core/Pi/handoff portable **57/57 PASS**; actual Pi SDK `/aio status/why/next/plan` **PASS** con zero model call; explicit resume NO/YES **PASS**; 0.2-D start **28 total, 27 PASS, 1 platform skip**; 0.2-C Intent Adapter **30/30 PASS**; 0.2-B Plan Proposal **453 total, 451 PASS, 2 platform skip**.
- **Gate completi:** full `npm test` **680 total, 677 PASS, 3 platform skip, 0 fail**; `npm run check` PASS (brand guard + **50 moduli**); `npm pack --dry-run` PASS (**41 file**); tarball reale PASS, install/consumer esterno PASS, root exports presenti, internal subpath bloccato e doc 0.2-E inclusa; `git diff --check` PASS.
- **Developer adversarial review:** attaccati contradiction CLI/TUI, unverified→healthy, read mutation, projection/formatter mutation, bypass projector TUI, no-consent auto-handoff, duplicate turn_end/YES, takeover race, continuity auto-recovery, no-consent resume, error-code masking, bypass HandoffService/SafePoint/latch, model call, regressione start, perdita technical observability e introduzione durable 0.2-F. Il malformed live observation è stato ulteriormente chiuso con `RUNTIME_OBSERVATION_INVALID`. **Nessun HIGH/MEDIUM/LOW nuovo noto**; self-review non conta.
- **Candidate/PR:** implementation commit `2b60e46bd51cbe9260cd3a214e1394404da88d1b`; draft PR #31 `https://github.com/kinderp/aiopago/pull/31`. Candidate finale = HEAD che contiene questo close-out documentale; SHA esatto è registrato nel body della PR dopo il push finale (un commit non può contenere il proprio SHA). Push normale, no force; PR resta DRAFT, non mark-ready e non merge.
- **Next:** fresh Independent Review Round 1 sul candidate HEAD esatto del draft PR. 0.2-F resta **NOT STARTED / BLOCKED** da acceptance 0.2-E.
- `checkpoint_message`: “0.2-E projection umana condivisa e guided handoff consentito esplicitamente; READY FOR INDEPENDENT REVIEW, gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-F.

# CHECKPOINT — AIOPAGO 0.2-D CLOSED / ACCEPTED

- **Stato:** 0.2-D è **CLOSED / ACCEPTED** al candidate `95b0c93baab323c4cddd12b030d62798f035ed37`.
- **Independent gate:** Round 1 **CLEAN**; Round 2 **CLEAN**; gate finale **2/2 CLEAN**.
- **Integrazione:** merge commit `f670b6ea81980cdfd33b69d2f4817964a47d878a`; PR #28 **MERGED**; issue #27 **CLOSED / COMPLETED**.
- **Risultato:** `aio start <objective>` lega un'unica observation immutabile a un planner Pi isolato e a una full candidate strutturata, passa da preview e autorizzazione TTY interattiva in due fasi, applica tramite 0.2-C/0.2-B e poi si ferma senza esecuzione automatica.
- **0.2-E:** **NOT STARTED / READY TO START**. “Ready to start” non indica lavoro in corso.
- **Next session:** iniziare discovery/design 0.2-E soltanto quando richiesto esplicitamente; nessun issue, branch, worktree, progetto o implementazione 0.2-E è stato avviato.
- `checkpoint_message`: “0.2-D CLOSED / ACCEPTED; independent gate 2/2 CLEAN; 0.2-E NOT STARTED / READY TO START”.

**STOP operativo:** stato odierno chiuso. Nessun altro lavoro oggi.

# CHECKPOINT — AIOPAGO 0.2-D FRESH ROUND 1 H-01/L-01 REMEDIATION

- **Stato/gate:** fresh Independent Review Round 1 sul candidate precedente `5f292dcb7aafb0dc5a2196cdf69636692588f396` = **BLOCKED**. H-01 real TTY multiline paste e L-01 pipe lifecycle/documentation mismatch sono rimediati; 0.2-D torna `READY FOR INDEPENDENT REVIEW`, gate nuovo `0/2`; developer review non conta. Issue #27; draft PR #28; branch `feat/start-objective-0.2-d`; worktree `F:/dev/aiopago-0.2-d`; `origin/main` e merge-base `488c4fd696003a6987ea50996bbab644e63ab56c`.
- **Root cause:** una read canonica TTY/completed-line boundary non è una transaction/paste boundary. `yes\nno\n` inviato in un solo paste può essere esposto dal PTY come due read; il vecchio authorizer applicava dopo la prima.
- **H-01/remediation:** produzione interattiva in due fasi bounded. Fase 1 accetta solo `y|yes` case-insensitive con LF/CRLF. Solo dopo il successo genera una challenge invocation-local di 10 caratteri con `node:crypto` e alfabeto ASCII non ambiguo. Fase 2 richiede l'esatta challenge con LF/CRLF; wrong/partial/EOF/whitespace/control/binary/oversize/error ed extra già osservato dopo il terminatore negano. Challenge non persistita, riusata o inserita in Ledger/provenance/session/settings.
- **Shared reader/lifecycle:** le due fasi usano un solo `Readable.iterator({ destroyOnReturn:false })`, un solo pending buffer e parser record byte-level. `yes\nno\n` nello stesso chunk o in read canoniche separate lascia/fornisce `no` alla fase 2 e nega. Cleanup chiude l'iterator senza distruggere `process.stdin`, senza listener attivi o timer euristici.
- **L-01/non-TTY:** pipe, redirect, file, CI e ogni `input.isTTY !== true` negano immediatamente e non vengono drenati. I test/caller programmatici conservano l'injected `authorize`; non esiste `--yes`. Documentazione pipe-through-EOF rimossa.
- **Regressioni auth:** shared buffer/chunk split, challenge ordering 0-before-YES/1-after-YES, happy y/yes, CRLF, wrong/partial challenge, EOF, whitespace/control/binary/oversize/error, trailing buffered bytes, non-TTY deny e cancel purity coperti. Stale A→C fra le due fasi arriva al CAS conflict e preserva C. La generic confirmation non soddisfa né rilascia `HANDOFF_CONFIRM`.
- **Real PTY evidence:** harness Python `pty` standard, vero canonical Linux PTY, Node 22.19.0 e vero `bin/aio.mjs`/production authorizer. Un singolo `os.write("yes\\nno\\n")` nega con `apply=0` e `TASK_PLAN.md` byte-esatto; YES seguito dalla challenge letta dal prompt applica una volta; wrong challenge nega. Nessuna dipendenza runtime/native aggiunta.
- **M-01 resta CLOSED:** actual Pi SDK 0.83.0, retry false/zero, provider `maxRetries=0`, compaction false, una provider/model call, nessuna settings/session persistence; nessun redesign Pi.
- **Contratti preservati:** one observed base, stale planning/approval, exact frozen display/authorize/apply proposal, strict JSON/duplicate rejection, owner gate, no-auto-execution, no-tools/resource isolation, alias `eio` e 0.2-B/C restano invariati.
- **Test/gate:** Node `v22.19.0`; focused tracked **27 PASS, 1 Windows PTY skip**; real Linux PTY focused **1/1 PASS**; Intent Adapter **30/30 PASS**; Plan Proposal **453 total, 451 PASS, 2 platform skip**; full **667 total, 664 PASS, 3 platform skip**; `npm run check` PASS (brand guard + 49 moduli); `npm pack --dry-run` e tarball reale PASS (40 file); install/consumer esterno PASS per public `plan.*`, internal subpath blocked e non-TTY deny; tarball su Linux PTY PASS per old paste deny byte-esatto e challenge happy apply.
- **Developer adversarial review:** vecchio exploit PTY reale, one-write e canonical split, queued phase 2, generation timing, wrong challenge, non-TTY yes, EOF, CRLF, cleanup, stale fra fasi, owner gate, exact proposal/no-auto-execution e M-01 rieseguiti. Nessun finding HIGH/MEDIUM noto; self-review non conta.
- **Candidate:** il nuovo candidate HEAD è il commit che contiene questa sezione; lo SHA esatto viene registrato nel draft PR #28 dopo il push normale (un commit non può contenere il proprio SHA). Gate `0/2`.
- **Next:** fresh Independent Review Round 1 sul nuovo candidate HEAD esatto di draft PR #28. 0.2-E resta `BLOCKED / NOT STARTED`.
- `checkpoint_message`: “0.2-D fresh Round 1: H-01/L-01 chiusi con challenge TTY post-record e non-TTY deny; gate 0/2”.

**STOP operativo:** non mark-ready, non fare merge e non iniziare 0.2-E.

# CHECKPOINT — AIOPAGO 0.2-C ROUND 1 H-01 REMEDIATION

- **Stato:** Independent Review Round 1 sul candidate `ce87816b83a4439357c230dbbdd6ac8a9fc78e37` = **BLOCKED**. H-01 è rimediato e 0.2-C torna `READY FOR INDEPENDENT REVIEW`; il nuovo gate è `0/2`, non CLOSED. 0.2-B resta CLOSED/ACCEPTED; 0.2-D resta NOT STARTED/BLOCKED.
- **Base/worktree:** `origin/main=091c481d96064d4481d7e5514b269fda3202f6af`; branch `feat/intent-adapter-0.2-c`; worktree `F:/dev/aiopago-0.2-c`; issue #25; draft PR #26. Nessun rebase/merge e main non è stato modificato.
- **H-01/root cause:** `propose()` legava sempre B all'autorità appena osservata C, perdendo l'identità A dalla quale il caller aveva derivato B; questo consentiva un falso C→B e un silent lost update. Il draft intent ora richiede nested `base { task_id, plan_revision_id, content_digest }` come expected-observation/CAS precondition.
- **Remediation design:** strict clone ed exact-field validation precedono la lettura; task, revision ed exact-byte digest dichiarati devono tutti uguagliare l'autorità corrente. Qualunque mismatch produce `PLAN_PROPOSAL_STALE` con expected/observed e tre match boolean prima della costruzione `PlanProposal` e senza `.guardian`. Soltanto dopo il match la proposal usa l'identità dell'osservazione autorevole, non valori caller copiati ciecamente. `TASK_PLAN.md` resta unica authority; nessun rebase/merge/replay/LWW o secondo store.
- **Regressioni:** public API `observe(A)→build(B)→external C→propose(B/base A)` preserva C byte-esatto e non crea `.guardian`; normal A→B percorre propose/validate/diff/apply; movimento A→C dopo propose rende validate/diff stale e apply CAS-conflict senza overwrite. Coperti separatamente revision+digest mismatch, same revision/digest mismatch, revision mismatch/digest match e task mismatch.
- **Strict/adversarial:** base omessa/missing/extra, digest malformed, stringhe oversized, custom prototype, accessor, symbol, `undefined`, `NaN`, `BigInt`, function e cycle sono rifiutati; caller mutation post-boundary non altera la proposal. Due adapter restano isolati; owner-gate generic proposal non può release/remove/rewrite/advance `HANDOFF_CONFIRM/BLOCKED`; retry same-runtime e ambiguity su nuovo adapter restano invariati.
- **0.2-B core:** nessun production diff in `plan-proposal`, `plan-store`, `ledger`, `owner-gate-internal`, `plan-markdown`, `canonical` o `errors`; `PlanPort.apply()` e CAS 0.2-B sono invariati.
- **Test/gate:** Node `v22.19.0`; focused adapter **30/30 PASS**; Plan Proposal **453 test: 451 PASS, 2 platform skip, 0 fail**; full suite **639 test: 637 PASS, 2 platform skip, 0 fail**; `npm run check` PASS (46 moduli); `npm pack --dry-run` PASS (37 file); tarball reale estratto fuori repo con H-01, exact C preservation, no `.guardian`, root surface e internal-subpath boundary PASS; `git diff --check` PASS.
- **Developer adversarial review:** omission/forgery/mutation della base, partial identity match, proposal tampering, stale-before-construction, read-side purity, owner-gate bypass, error transparency, due adapter, retry/restart e accidental trust del caller come authority verificati. Il caller deve propagare la vera observation identity e non sostituirne una più nuova: l'adapter può verificare la precondition dichiarata ma non dedurre l'origine mentale di arbitrary candidate bytes. Zero nuovi finding HIGH/MEDIUM aperti; self-review non conta come acceptance.
- **Candidate:** il nuovo candidate HEAD è il commit che contiene questa sezione; lo SHA completo viene registrato nel draft PR #26 subito dopo il push normale (un commit non può contenere il proprio SHA). Gate resettato a `0/2`.
- **Known LOW:** nessun nuovo LOW 0.2-C noto. Restano soltanto i residual 0.2-B accettati: intervallo irreducibile prima dell'ingresso in rename contro writer non cooperativi; directory fsync esplicitamente unsupported; ACL/extended metadata non portabili; stale lock e restart ambiguity richiedono riconciliazione umana.
- `checkpoint_message`: “0.2-C Round 1 H-01 rimediato con observed-base precondition; nuovo candidate pronto, gate 0/2”.

**STOP operativo:** candidate congelato dopo il push finale. Non dichiarare CLOSED, non mark-ready, non fare merge e non iniziare 0.2-D.

**Prossimo passo ESATTO:** fresh Independent Review Round 1 sul nuovo candidate HEAD esatto del draft PR #26.

# CHECKPOINT — AIOPAGO 0.2-B INDEPENDENT REVIEW ROUND 1 BLOCKED REMEDIATION

- **Stato:** `0.2-B = READY FOR INDEPENDENT REVIEW`; gate indipendente `0/2`. La developer review non conta. 0.2-C resta `NOT STARTED / BLOCKED` e l'Efficiency Benchmark non è implementato.
- **Base/perimetro:** remediation partita dal feature HEAD atteso `433dc3de1f76303307f6c5e21363d37936356dc8` con `origin/main=323782ee7c491dfbf097606b7313f4d7c98865b1`; nessun rebase/merge, nessuna modifica a main.
- **H-01:** una generic proposal con `HANDOFF_CONFIRM/BLOCKED` preserva owner gate, task status, current/next item, next step, item set/status e dependency/supersession topology; il protected item resta BLOCKED e nessun item diventa IN_PROGRESS. Soltanto `satisfyOwnerGate()` HUMAN con exact command rilascia la latch.
- **H-02:** dopo semantic validation/preparation e lock attestation, la final primitive legge soltanto raw authority bytes con fingerprint pre/open/post (identity, regular state, size, nlink, mtime/ctime nanosecondi dove disponibili), li confronta con la copia esatta dell'initial authority e invoca immediatamente rename senza decode, parse, callback o altro filesystem I/O.
- **H-03/timestamp:** proposal/intent/applied/history e witness filesystem sono derived audit evidence, non autenticatori. Restart/new `PlanPort` con exact candidate resta sempre `PLAN_RECOVERY_AMBIGUOUS`; soltanto una receipt privata volatile installata dopo il live post-rename path consente same-instance idempotence. `applied.json` è exclusive, `applied_at >= prepared_at`, e clock rollback produce pending/ambiguity.
- **M-01/M-02:** contract e bootstrap 0.1.0 sono ripristinati byte-identici a main. Il validator accetta legacy `reason/actor/timestamp`, alias `terminal_*` o entrambi coerenti senza nuova reciprocità/cardinalità supersession. Layout compact bootstrap ed extended metadata sono mutabili; partial/duplicate/mismatch falliscono chiuso.
- **M-03/L-01:** immutable exact-existing viene file-fsynced e directory-risynced a ogni retry; errori inattesi riemergono. Il preflight UTF-8/structure/semantic avviene prima del lock, quindi authority malformata non crea `.guardian`; il reread sotto lock resta autorevole.
- **Regressioni/scope:** strict JSON, reconstruction, 32 MiB, exact history, lock ownership/release, no public raw replace, UTF-8 fatal, attempt bound e 0.2-A read-only restano coperti. Root `TASK_PLAN.md` invariato; nessun lavoro 0.2-C/Efficiency Benchmark.
- **Gate locale:** Node `v22.19.0`; Plan Proposal **181 test: 180 PASS, 1 platform skip, 0 fail**; full suite **337 test: 336 PASS, 1 platform skip, 0 fail**; `npm run check` PASS. Pack/diff finali registrati al commit di remediation.
- **Residual LOW:** irreducibile transizione user-space→rename contro editor non cooperativo; directory sync esplicitamente unsupported non garantisce power-loss durability; ACL/Windows extended metadata non sono preservabili atomicamente con Node standard; stale lock e restart ambiguity richiedono riconciliazione umana.
- `checkpoint_message`: “0.2-B Round 1 BLOCKED remediation completa; pronta per independent review, gate 0/2”.

**STOP operativo:** non dichiarare CLOSED e non iniziare 0.2-C o Efficiency Benchmark prima delle relative autorizzazioni/gate.

# CHECKPOINT — AIOPAGO RENAME COMPLETE

- **Brand:** Aiopago. **Repository:** `kinderp/aiopago` (`https://github.com/kinderp/aiopago`). **Default branch:** `main`. **CLI canonical:** `aio`. **Legacy CLI:** `eio` (deprecated, thin wrapper, warning soltanto su stderr). **0.2-A:** CLOSED. **Rename:** COMPLETE. **Next:** 0.2-B Plan Proposal Foundation.
- Baseline canonica: `ab5100207f7714852b121352d8f389dfe92133a4`; HEAD applicativo 0.2-A: `f0faab642c4a2ed52b40417aab577e74fcd253ba`; implementation commit del rename: `3c7a786444c51931ef6cdb31d3e5945e03e9cf5d`. Il commit documentale che contiene questa sezione chiude il checkpoint; nessuna feature 0.2-B è stata iniziata.
- Worktree/branch dedicati: `F:/dev/aiopago-rename`, `chore/rename-aiopago`. Il worktree storico `F:/dev/eiopago-ux-0.2` è rimasto intatto a `ab5100207f7714852b121352d8f389dfe92133a4`.
- Remote rename eseguito sullo stesso repository GitHub, non tramite copia: repository ID prima/dopo `1324222061`, node ID `R_kgDOTu4GbQ`; `kinderp/eiopago` → `kinderp/aiopago`. `default_branch=main` è rimasto invariato. `origin` finale è `https://github.com/kinderp/aiopago.git`; fetch, `ls-remote` e dry-run push autenticato PASS.
- Package: nome `aiopago`, metadata repository/homepage/bugs canonici e npm registry check del vecchio nome = `E404`, quindi nessun compatibility package e nessuna pubblicazione. Non esisteva un package/module tree interno `eiopago`: nessun namespace o implementation duplicata è stato inventato.
- CLI/TUI: `bin/aio.mjs` è l'entrypoint canonico; `bin/eio.mjs` delega alla stessa `src/cli-entry.mjs`. `/aio` è canonico; `/eio` e `/eiopago` sono alias deprecati dello stesso handler. Help, version, status e `plan --raw` hanno stdout ed exit code equivalenti; i warning legacy non contaminano stdout.
- Environment: canonica `AIOPAGO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`; fallback deprecato `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`; valori duali diversi falliscono con conflitto esplicito. Non esisteva alcuna variabile pubblica `EIOPAGO_*`, quindi nessuna layer artificiale è stata aggiunta.
- Persistent state: nessun path `~/.eiopago`, `.eiopago`, database/config brandizzato o directory equivalente esisteva. `.guardian/`, config, runtime SQLite e artifact restano nello stesso path e non vengono spostati, uniti o sovrascritti. `aio init` preserva byte per byte config, Ledger, runtime e managed `.gitignore` legacy validi; la presenza simultanea dei due blocchi managed fallisce esplicitamente.
- Schemi/protocolli: nuovi writer usano `aiopago.repository/1.0.0`, `aiopago.task-ledger/0.1.0`, `aiopago.runner-session-binding.v1`, schemi calibration `aiopago.*`, producer `aiopago-runner` e marker `AIOPAGO_RESUME_V1`. I reader accettano gli identificatori pre-rename esatti necessari (`eiopago.repository/1.0.0`, `eiopago.runner-session-binding.v1` e schemi calibration `eiopago.*`); Ledger/owner command pre-rename restano leggibili. Nessun dato persistito è stato riscritto retroattivamente.
- Provenance immutabile: `TASK_PLAN.md` e `docs/m1-h2-calibration-pilot.json` hanno diff byte nullo da `origin/main`; `TASK-EIOPAGO-*`, i record `PLAN-EIOPAGO-*`, il marker storico `EIOPAGO_RESUME_V1`, worktree/remotes realmente usati e le sezioni checkpoint precedenti restano invariati. Audit e documenti calibration chiusi sono marcati esplicitamente come historical pre-rename records.
- Legacy allowlist finale: (1) storia immutabile in `CHECKPOINT.md`, `TASK_PLAN.md`, protocollo pilot, audit e documenti H2 storici; (2) reader/fallback precisi per config, managed ignore, Ledger command, runner binding, calibration ed environment; (3) alias CLI/TUI deprecati; (4) migration note e test di compatibilità. Nessun uso legacy corrente fuori da queste categorie è autorizzato.
- Brand guard: `scripts/check-brand-migration.mjs`, integrato in `npm run check`, scansiona file tracked/untracked pertinenti, nomi path e token brevi separatamente, con path/count/rationale esatti; nuove occurrence o variazioni della allowlist falliscono.
- Gate pre e post GitHub rename: `npm test` **156/156 PASS**; `npm run check` **PASS, brand guard + 39 moduli**; `npm pack --dry-run` **PASS, 30 file**; `git diff --check` **PASS**. Warning SQLite experimental e LF→CRLF dei fixture sono informativi. Review `origin/main...HEAD`: zero finding HIGH/MEDIUM noti, nessun URL corrente stale, nessuna perdita di compatibilità/schema, nessun lavoro accidentale 0.2-B.
- Residual non bloccanti e intenzionali: alias `eio`/`/eio`/`/eiopago`, env fallback, reader legacy e provenance storica sopra; rimozione futura richiede una migration separata. Nessuna CI configurata da osservare. Nessun blocker aperto.
- `checkpoint_message`: “Aiopago rename completo: repository, package, CLI e compatibilità legacy verificati”.

**STOP operativo:** Dedicated Rename Migration chiusa. Non iniziare 0.2-B, Core Observation Port o nuove feature in questa sessione.

**Prossimo passo ESATTO:** `0.2-B Plan Proposal Foundation` in una nuova sessione e branch dedicati, partendo dalla `main` Aiopago canonica.

**Nome sessione suggerito:** `aiopago-0.2-b-plan-proposal-foundation`

**Prompt minimo di ripresa:**

> Lavora su `kinderp/aiopago`. Leggi `AGENTS.md` se presente, la prima sezione di `CHECKPOINT.md`, `docs/roadmap.md` e `docs/rename-aiopago-migration.md`; verifica repository, `origin`, default `main`, HEAD e status. Il rename Aiopago è COMPLETE e 0.2-A è CLOSED: non riaprire il rename o rimuovere compatibility legacy senza finding dimostrato. Crea branch/worktree dedicati da `main` e avvia esclusivamente 0.2-B Plan Proposal Foundation, preservando le invarianti safety-critical e senza anticipare 0.2-C o il Core Observation Port.

# CHECKPOINT — Eiopago 0.2-A CLOSED

- Worktree/branch: `F:/dev/eiopago-ux-0.2`, `feat/human-workflow-ux-0.2`; baseline `72461f653d217e8f18b3cba2c1b7ed46220cee4e`; **HEAD finale applicativo 0.2-A** `f0faab642c4a2ed52b40417aab577e74fcd253ba`. Il commit documentale che contiene questa sezione formalizza la chiusura senza cambiare il codice applicativo.
- **Status: 0.2-A CLOSED.** La Human Workflow UX read-only espone `status`, `why`, `next`, `plan`, `plan --raw`, `plan --check` e `plan --technical` senza avviare Pi, selezionare modelli, effettuare provider call o acquisire ownership runtime.
- Finding chiusi: tre HIGH su operation futura ignorata, mismatch latch/journal capace di occultare `HUMAN_TAKEOVER` e authorization/admission/journal incompleti; un MEDIUM sulla projection pubblica fail-open per `includeRuntime:false` e condition futura/sconosciuta.
- Boundary accettato: il core 0.1 non possiede un verifier read-only complessivo estraibile con puro refactor. `runtime-reader.mjs` osserva soltanto presenza, sidecar e stabilità dei byte, non apre/interpreta SQLite e non contiene una lifecycle state machine. Runtime assente, presente, concorrente, non osservato o non verificabile resta `NEEDS_ATTENTION`/`RUNTIME_NOT_VERIFIED`; nessun percorso pubblico costruisce `READY` o `SUSPENDED`.
- Acceptance: piano Markdown autorevole e modifiche umane preservati; `plan --raw` indipendente dal validator; `plan --check` usa `TaskLedger`; output normale bounded e senza dati runtime privati; repository non inizializzati, directory nested e linked worktree coperti; byte/hash/mtime di piano e runtime invariati; nessuna mutation o migrazione.
- Invarianti core preservate: `runner.mjs`, `handoff.mjs`, `safety.mjs`, `storage.mjs` e `runner-ownership.mjs` hanno diff nullo dalla baseline. Nessun Plan Proposal, Intent Adapter, start/stop, Human Action Broker, control channel o altro scope 0.2-B è stato introdotto.
- Gate finali: test mirati `test/human-workflow.test.mjs` **34/34 PASS**; `npm test` **147/147 PASS**; `npm run check` **PASS, 36 moduli**; `npm pack --dry-run` **PASS, 26 file**; `git diff --check` **PASS**. Warning SQLite experimental e LF→CRLF dei fixture sono informativi.
- Review finale: **APPROVE**, zero finding HIGH/MEDIUM/LOW bloccanti, nessun TODO/FIXME bloccante. Residual non bloccante e deliberatamente futuro: una runtime projection positiva richiede un Core Observation Port condiviso col core.
- Roadmap persistita in `docs/roadmap.md`. Il repository remoto resta `kinderp/eiopago`; il default branch remoto resta `feat/pi-usage-guardian-foundation`. Nessun rename è stato iniziato in 0.2-A.

**STOP operativo:** dopo la chiusura di 0.2-A non iniziare il rename né 0.2-B in questa sessione.

**Prossimo passo ESATTO:**

1. **Dedicated rename migration: Eiopago -> Aiopago**
2. dopo il rename: **0.2-B Plan Proposal Foundation**

**Nome sessione suggerito:** `eiopago-aiopago-dedicated-rename`

**Prompt minimo di ripresa:**

> Leggi integralmente `AGENTS.md` se presente, la prima sezione di `CHECKPOINT.md`, `docs/roadmap.md` e la documentazione di migrazione che verrà autorizzata. Verifica worktree, branch, HEAD, remotes, upstream e default branch. 0.2-A è CLOSED a `f0faab642c4a2ed52b40417aab577e74fcd253ba`; non riaprirla salvo regressione dimostrata. Esegui in una sessione dedicata soltanto il rename completo Eiopago -> Aiopago, con inventario, piano atomico, test e remote strategy esplicita. Non iniziare 0.2-B durante il rename. Dopo acceptance del rename, il passo successivo è 0.2-B Plan Proposal Foundation.

# CHECKPOINT — M1-P0-A Portable Bootstrap, Packaging e Config PASS

- Baseline e branch verificati: `9ed10f6148a144179cccce3c9141e4fa61c808e5`, `feat/m1-p0-portable-alpha`; nessun commit creato.
- Audit reale chiuso: il vecchio bin usava `process.cwd()` come root unico, non esistevano `eio init`, config repository, `bin` package/exports/files o target esplicito; il loader Pi cercava soltanto env/node adiacente e il Runner creava stato direttamente sotto il cwd.
- Contratto implementato: installation root del package separata da Git target root; config root `.guardian`, runtime root `.guardian/runtime`, artifact root `.guardian`, Ledger path e target vengono validati e passati esplicitamente al Runner.
- `eio init [target|--target]` verifica Node >=22.19, Git worktree e Pi 0.83.x; crea config strict `eiopago.repository/1.0.0`, template Ledger solo se assente, runtime ignored e blocco `.gitignore` bounded. Re-init preserva byte Ledger/config/ignore e non cancella runtime o file estranei; Ledger non riconosciuto/ambiguo e path riservati rediretti via symlink/junction falliscono prima delle modifiche.
- Packaging alpha Node standard: package con `bin.eio`, export ESM, files allowlist, engine e peer Pi; uso previsto `npm link` o install globale da path. Help/version, init e launch target entrypoint sono reali; il completo dogfood launcher multi-repository resta P0-B.
- Plumbing core minimo: il Runner riceve root esplicite; se il Ledger portable lascia il model policy nullo, il modello realmente selezionato da Pi diventa la policy handoff effettiva. Safe point, latch, exactly-once admission, continuity, takeover e dispatch semantics non sono cambiati.
- Cold review: corretti fail-open su Ledger duplicato, redirect symlink/junction, esposizione di file `.guardian` sconosciuti e selezione accidentale di Pi dal target; aggiunti test package-cwd e model policy Pi effettiva. Documentazione: `docs/portable-alpha.md`.
- Gate finali cold review: `npm run check` PASS (32 moduli), `npm test` PASS (81/81), `git diff --check` PASS con soli warning informativi LF/CRLF, `npm pack --dry-run` PASS (24 file).
- Nessun H2 pilot o RUN-40/50/60, nessun cambio threshold/Advisor, nessun Cost Guard, Chronicle, P0-B o dogfood Alfred/Durex/FARO.

**STOP operativo:** P0-A è chiuso. Non iniziare P0-B senza autorizzazione separata.

# CHECKPOINT — M1-H2 H2-02A-F1 Deterministic Calibration Bootstrap PASS

- Perimetro esclusivo: issue #10, `H2-02A-F1`; nessun workload/pilot, model call reale, RUN-40/50/60, Cost Guard, Advisor adattivo, modifica workload/soglie globali o commit. HEAD di partenza/precedente experiment baseline: `d6a4b9cfa1e3c15cc0c9ea9ad9ead89216346254`; il nuovo experiment baseline sarà soltanto il futuro commit di freeze/acceptance F1.
- Root cause registrata: attempt 1 RUN-40 aveva protocollo ignored non materializzato prima del Runner; il Runner creava SQLite prima del controllo interno, rendendo invalido il criterio di assenza runtime; Git clean, threshold, model, reasoning, confirm e digest completo non erano autorevolmente attestati. Il fail-closed osservato era corretto.
- Implementato bootstrap minimo `scripts/calibration-run.mjs` + `src/calibration-preflight.mjs`: verifica locale di worktree/root, HEAD completo, branch, clean status, Pi/Node, JSON/blob Git, digest protocollo/prompt e variante; genera run_id UUID e persiste copia byte-identica, attestation `eiopago.calibration-preflight/1.0.0` e run-record `PREFLIGHT_PASSED` nell'area ignored prima del Runner.
- Runtime isolation: SQLite è `.guardian/calibration/<run_id>/runtime/guardian.sqlite`; migration 4 persiste `run_id`, `runtime_store_id` e digest attestation. Path preesistente, dati domain precedenti o identità diversa falliscono chiuso; nessun database esistente viene cancellato. Corretto esplicitamente il vecchio requisito “SQLite assente dopo startup”.
- Controlled state: il launcher deriva/fissa la threshold dalla variante, imposta env process-local e opzione SDK; Pi SDK pubblica fissa modello e `thinkingLevel` e il runtime verifica `AgentSession.model`/`thinkingLevel`; confirm è opzione Runner `confirm` e rifiuta manual. Input gate e transport gate rivalidano attestation/stato prima del workload/provider stream.
- Protocollo aggiornato senza cambiare workload/prompt: digest prompt resta `d89957e5c3ccae4ad4ac57b5458fc7d45044cb1e8e22da1f4da2b7c22299af58`; digest protocollo F1 `0af31e2ee41061c153d1e7c4cfaaf098db44f58ee41f15333b31b8afeb8bd2c1`. `RUN-40-ATTEMPT-1=INVALID_PREFLIGHT`, non replica, non resumable/reclassificabile. H2-02B resta PLANNED/BLOCKED.
- Test bootstrap offline: 17/17 PASS, incluso happy path, HEAD/branch/dirty, digest/copia, threshold/model/reasoning/confirm, contaminazione/identity SQLite, duplicate ID, missing attestation, mismatch runtime e transport fail-closed prima della call. Nessun launcher TUI o provider reale avviato. Il primo full-suite attempt ha esposto l'env ambientale threshold=40 nel fixture E2E storico; il fixture è stato reso esplicito a 50 senza cambiare il default. Gate finali: `npm run check` PASS (23 moduli), `npm test` PASS (46/46, E2E 6/6), `git diff --check` PASS con soli warning LF→CRLF.
- Ledger: `PLAN-M1-H2-0005`; `ITEM-H2-02A-F1=DONE`, `ITEM-H2-02B=BLOCKED`. Comando futuro, solo dopo freeze F1 e autorizzazione H2-02B: `npm run calibration -- --variant RUN-40 --experiment-baseline <SHA_F1>`; cold review: `npm run calibration -- --resume-run <run_id>`.
- Limiti/unknown: Pi attesta modello selezionato e reasoning effettivo, non seed/temperature non esposti né un eventuale routing upstream opaco del provider; charged cost resta unknown come in H2-01. Trust boundary locale, senza firma contro amministratore filesystem. Nessun commit creato.
- Esito: **H2-02A-F1 PASS**. `checkpoint_message`: “H2-02A-F1 PASS: bootstrap attestato e SQLite run-specific; nessun pilot avviato”.

**STOP operativo:** non creare/avviare un nuovo RUN-40/50/60. Serve acceptance/commit F1 e autorizzazione H2-02B separata.

# CHECKPOINT — M1-H2 H2-02A Controlled Calibration Protocol PASS

- Perimetro eseguito esclusivamente: issue #9, `H2-02A`; application baseline H2-01 `930fc35d03d3f9795fa6402a047b0ded489e2817` invariata. L'experiment baseline è il commit di freeze che contiene questa sezione e il protocollo: il suo SHA va nei futuri run record, non nel manifest, evitando dipendenze circolari. Nessun RUN-40/50/60, Cost Guard, Advisor adattivo o cambio del default globale.
- Congelato `H2-02A-PILOT-1`: i tre futuri worktree/branch devono partire identicamente dall'experiment baseline commit, con unica variabile intenzionale threshold process-local 40/50/60, modello `openai-codex/gpt-5.6-sol`, reasoning high, Pi 0.83.0, confirm, acceptance e completion identici, zero history copiata.
- Workload scelto: `WL-HANDOFF-INCIDENT-INSPECTOR-1`, inspector locale read-only per incidenti handoff, con core, CLI, fixture/test/documentazione e cold review/fix in sessione pulita. È reale, non implementato, offline e non modifica soglie; nessun padding.
- Non è garantibile il 60% su 272k: il protocollo richiede crossing autorevole più lifecycle completo per un run VALID; completion prima soglia è `CENSORED_EARLY_COMPLETION`, non evidenza della variante.
- Quality baseline semplice: quattro gate PASS, nessuna regressione/finding bloccante/perdita di stato, quattro WCP accettati e rework registrato. Charged ed equivalent cost hanno aggregazioni e Cost per Accepted Checkpoint separati; token/costo puro handoff resta unknown se non attribuibile.
- Artefatti: `docs/m1-h2-threshold-calibration.md`, `docs/m1-h2-calibration-pilot.json`; Ledger `PLAN-M1-H2-0004`, H2-02A DONE e H2-02B PLANNED. Il commit corrente effettua il freeze; prima del pilot restano run-record/extraction preflight e autorizzazione H2-02B.
- Solo documentazione/protocollo: nessuna suite applicativa ripetuta. Validazione strutturale e `git diff --check` eseguite come gate documentali.
- Esito: **H2-02A PASS**. `checkpoint_message`: “H2-02A PASS: protocollo pilot 40/50/60 congelato; nessun run avviato”.

**STOP operativo:** non creare worktree pilot e non iniziare RUN-40 senza autorizzazione esplicita H2-02B.

# CHECKPOINT — M1-H2 H2-01 Measurement Instrumentation PASS

- Perimetro eseguito esclusivamente: issue #9, `H2-01`; baseline M1-H1 `b317f79c9723136203e24d216467ef80601cb64a` preservata. Nessun esperimento 40/50/60, cambio soglia, Cost Guard, auto-handoff, supervised-auto, routing o integrazione esterna.
- Implementato schema `eiopago.metrics/1.0.0`: summary sessione, sample automatico per assistant `turn_end`, eventi handoff misurati e diagnostici. Correlazione session/task/item/checkpoint/handoff quando nota; quality/rework predisposti con valori null senza score inventato.
- Superfici Pi 0.83.0 usate: `session_start`, `session_shutdown`, `turn_end.message.usage`, `ctx.getContextUsage()` e `ctx.sessionManager.getSessionId()`. Charged/provider cost, subscription equivalent, cache-hit rate e minimal reads realmente osservate restano explicit unknown.
- Overhead misurato da byte reali: stat di `TASK_PLAN.md`, buffer sealed checkpoint/manifest e `Buffer.byteLength` del resume prompt. Il count dichiarato nel manifest è separato dalle reads effettive unknown; nessuna conversation history/prompt/response viene salvata.
- Persistenza: tabelle bounded nello SQLite Guardian esistente; default 100 sessioni, 2.000 sample, 1.000 eventi handoff e 100 diagnostici. Il journal resta autorità del lifecycle operativo H1; le tabelle metriche sono autorità delle sole misure.
- Failure telemetry è non decisionale/non bloccante: nessuno zero inventato, diagnostico minimale bounded senza testo potenzialmente sensibile. Lifecycle H1 e soglia default 50% non sono stati modificati.
- Test H2 mirati: **7/7 PASS**. Gate finali: `npm run check` **PASS** (20 moduli); `npm test` **PASS** (29 test, 22 top-level, E2E 6/6); `git diff --check` **PASS** con solo warning informativo LF→CRLF su `TASK_PLAN.md`.
- Ledger: `PLAN-M1-H2-0002`; `ITEM-H2-01=DONE`, `ITEM-H2-02=PLANNED`, `current_item=null`, `next_item=ITEM-H2-02`. Documentazione: `docs/m1-h2-threshold-calibration.md`.
- Esito: **H2-01 PASS**. Prima di H2-02 servono nuova autorizzazione, protocollo controllato, run comparabili e associazione acceptance/quality baseline.
- `checkpoint_message`: “H2-01 PASS: telemetry Pi/runtime bounded, correlata e privacy-safe; 29/29 test verdi”.

**STOP operativo:** non avviare H2-02 o dogfood 40/50/60 e non dichiarare una soglia ottimale senza nuova autorizzazione esplicita.

# CHECKPOINT — M1-H1 PASS; dogfood post-fix e acceptance completati

## Sessione B — chiusura H1-02/H1-03

- Handoff reale post-fix: `HO-27f6d0dcd68e7349bdd149de`, source `019fe1fb-d7b3-71f5-ac0e-dfd35e3f268d`, replacement `019fe1fc-aeca-76b7-99b5-c880d3b75a7d`.
- Evidenza runtime autorizzata dall'owner: Runner ownership attestata, Continuity Check **PASS**, resume admission autorizzata una sola volta e Sessione B ripresa con `ITEM-H1-02=IN_PROGRESS`, `current_item=ITEM-H1-02`, `next_item=ITEM-H1-03`, `owner_gate=SATISFIED`.
- History transfer: **ZERO**. Il codice esclude conversation history dal target e il manifest non contiene transcript; i sei minimal read sealed sono stati letti realmente.
- Review statica F1: coerente con il runtime. `TaskLedger.satisfyOwnerGate()` avanza atomicamente il Ledger prima del safe point/seal; `newSession({ setup })` installa una sola CustomEntry non-context; SQLite e journal persistono `RUNNER_SESSION_BOUND`; manifest e Continuity richiedono uguaglianza runtime/journal/manifest/current Runner; admission e dispatch sono idempotenti/fail-closed.
- Metriche post-fix Sessione A (`019fe1fb…`) e B (`019fe1fc…`): context, token, cache e costo **unknown**, perché checkpoint e runtime evidence non contengono snapshot usage. Le metriche 140.837 input / 23.074 output / 8.367 reasoning / 3.049.472 cache-read / USD 2,921141 appartengono alla sessione storica pre-fix `019fe1c2…` e non sono attribuite al nuovo dogfood.
- Dimensioni esatte di `TASK_PLAN.md`, checkpoint, manifest e resume prompt: **unknown**; l'API file corrente non espone byte-stat e non viene sostituita con stime. Checkpoint `CP-7a6eed065a7069546349c82f` e manifest `RM-b5ec41729aab629d55ad89a4` sono disponibili come file; il resume prompt `RP-a38d491dd73939115c57fc31` è disponibile inline ma non come file standalone. Minimal reads: **6**.
- Friction umana post-fix: comando sorgente `/eio handoff confirm` e una conferma separata per l'unica resume admission. Nessun failure riportato nel run post-fix. Restano storici il tentativo API/non-TTY fallito prima del latch e i finding A/B del primo dogfood reale.
- Gate shell finali eseguiti manualmente dall'owner nel TUI: `npm run check` **PASS** (`syntax ok: 18 modules`); `npm test` **PASS** (**22/22**, 15 top-level, E2E 6/6, zero failure); `git diff --check` **PASS**, con solo warning informativo LF→CRLF su `TASK_PLAN.md`.
- Stato finale: `TASK_PLAN.md` revisionato a `PLAN-M1-H1-0007`; task `DONE`, H1-02 `DONE`, H1-03 `DONE`, `current_item=null`, `next_item=null`. Owner gate `SATISFIED`; H1-01 non ripetuto, nessun nuovo handoff, Cost Guard e M1-H2 non iniziati.
- Esito milestone: **M1-H1 PASS**.
- `checkpoint_message`: “M1-H1 PASS: dogfood F1 reale e 22/22 test accettati”.

**STOP operativo:** M1-H1 è chiusa. Non eseguire un altro handoff, non iniziare Cost Guard o M1-H2 e non creare commit senza autorizzazione separata.

# CHECKPOINT — M1-H1-F1 implementato e testato offline; stato pre-dogfood superato

## Issue #8 — owner gate persistito e Runner ownership attestabile

- Data: 2026-08-08; sessione fix `019fe1ed-0ab4-70e1-9475-8e809324c93c`; perimetro esclusivo `M1-H1-F1`. H1-01 e SP-01…SP-04 non ripetuti; Cost Guard e integrazioni esterne non iniziati.
- **Causa Finding A:** `/eio handoff confirm` leggeva il Ledger senza transizionare il gate canonico. I tre handoff reali precedenti hanno quindi sigillato correttamente artefatti tecnici ma con lifecycle stale (`current_item=null`, `next_item=ITEM-H1-02`, vecchio owner step).
- **Fix Finding A:** `TaskLedger.satisfyOwnerGate()` richiede comando esatto e attore umano, valida il lifecycle bloccato e persiste atomicamente la nuova revisione Markdown prima che il piano venga usato per checkpoint/manifest. L'E2E prova `H1-01=DONE`, `H1-02=IN_PROGRESS`, `current_item=ITEM-H1-02`, `next_item=ITEM-H1-03` e un vero next step senza nuova richiesta handoff.
- **Causa Finding B:** il solo `replacement_session_id` in projection/manifest non forniva alla sessione runtime corrente una prova Runner-owned; il fail-closed osservato era corretto.
- **Meccanismo scelto:** il processo Runner genera `runner_instance_id`; l'handoff genera `session_binding_id` casuale. La API pubblica Pi `newSession({ setup })` installa una CustomEntry non-context `eiopago.runner-session-binding.v1` nella replacement session prima di qualsiasi conversation entry. Il binding contiene `handoff_id`, vero `replacement_session_id` del SessionManager, `runner_instance_id` e nonce.
- **Persistenza/attestazione:** la relazione è salvata nella tabella SQLite `runner_session_bindings`, nell'evento append-only `RUNNER_SESSION_BOUND` e nel manifest sealed. Continuity richiede `runtime binding == SQLite/journal event == manifest == handoff/current Runner`; binding assente/duplicato, Runner/target/nonce/handoff diverso o stato `SUPERSEDED` produce `RUNNER_OWNERSHIP_ATTESTATION_FAILED` e nessuna admission.
- **Test aggiunti:** attestation PASS e tutti i mismatch richiesti fail-closed; sessione Pi non Runner-owned; binding SQLite/journal active→superseded; owner gate blocked→confirm→Ledger avanzato→checkpoint/manifest→replacement Runner-owned→continuity→resume; resume prompt senza seconda richiesta; duplicate resume con una sola admission.
- **Verifiche finali:** `npm run check` PASS, **18 moduli**; `npm test` PASS, **22/22** (**15** top-level, E2E **6/6**), zero failure e provider fake offline; `git diff --check` PASS con soli warning informativi LF→CRLF.
- `TASK_PLAN.md` è `PLAN-M1-H1-0005`, stato `IN_PROGRESS`, `owner_gate=SATISFIED`, `current_item=ITEM-H1-02`, `next_item=ITEM-H1-03`. H1-01 non è stato ripetuto e H1-02 non è dichiarato DONE.
- Documentazione: `docs/m1-h1-context-handoff-advisor.md`. Limite esplicito: il trust boundary è il processo/filesystem locale; nessuna firma anti-amministratore locale e nessun recovery automatico post-crash/general-purpose orchestrator.
- Il precedente vincolo sul nuovo dogfood è stato successivamente revocato dall'owner: il run post-fix `HO-27f6d0dcd68e7349bdd149de` è riuscito ed è registrato nella sezione corrente sopra. I vecchi artefatti sealed non sono stati riscritti.
- `checkpoint_message`: “M1-H1-F1: owner gate avanzato prima del seal e replacement ownership attestata runtime/journal/manifest”.

**STOP operativo storico superato:** review e dogfood reale post-fix sono avvenuti. Non eseguire un altro handoff e non iniziare Cost Guard.

# CHECKPOINT — M1-H1 PARTIAL/BLOCKED prima dell'input handoff reale

## Safe point Sessione A — Context Handoff Advisor

- Data: 2026-08-08; sessione Pi A `019fe1c2-19f4-7e45-88df-e89e35f4f83c`; profilo verificato `openai-codex/gpt-5.6-sol`, reasoning `high`.
- Isolamento verificato: branch `feat/m1-h1-context-handoff-advisor`, worktree `F:/dev/eiopago-m1-h1`, HEAD baseline `84953671bc97d40efbf6f838f8ae08f3a40a4bd4`. Il worktree principale e le sue modifiche storiche non sono stati alterati, stageati o inclusi.
- Issue #7 letta in sola lettura. Non sono stati ripetuti M0.1 o SP-01…SP-04 e non sono stati iniziati Cost Guard, hard budget, billing, supervised-auto, TokenSave o router.
- `TASK_PLAN.md` è il Ledger M1-H1 revisionato `PLAN-M1-H1-0004`: task `BLOCKED`, `ITEM-H1-01=DONE` con evidenza, `current_item=null`, `next_item=ITEM-H1-02` bloccato; H1-03 non avviato.
- H1-01 implementato: `ContextHandoffAdvisor` usa `ctx.getContextUsage()` quando disponibile, soglia validata configurabile tramite opzione Runner o `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`, default indicativo 50%, una proposta per permanenza sopra soglia e riarmo sotto soglia.
- UX advisory: a soglia raggiunta chiede consenso; soltanto dopo risposta positiva precompila `/eio handoff confirm`. Non esegue handoff autonomo, non impegna latch, non blocca transport/richieste e non introduce hard stop.
- Evidenza: test mirati advisor **2/2 pass**; `npm run check` **17 moduli pass**; `npm test` **12/12 pass**; `git diff --check` pass.
- Metriche A al snapshot pre-report: 110 entry JSONL, 37 usage entry; input 140.837, output 23.074, reasoning 8.367, cache read 3.049.472, cache write 0, costo equivalente riportato USD 2,921141. Prima usage 3.569 token (1,31% derivato su 272.000); ultima usage completata 120.909 (44,45% derivato). `ctx.getContextUsage()` corrente non è esposto a questa sessione API, quindi l'occupazione finale corrente resta `unknown` e non viene inventata.
- Gate dogfood eseguito senza harness/fake di handoff: `npm run eio` dal worktree isolato ha avviato il vero Guardian Runner e caricato `<inline:eiopago-m1-h1>`, modello/reasoning corretti. Il tool API espone però stdin/stdout non-TTY e nessun canale per inviare il comando TUI; dopo 20 secondi il tentativo è scaduto prima di poter digitare `/eio handoff confirm`.
- Failure point esatto: **prima** di latch, safe point M1-H0, checkpoint, replacement e manifest. Stato verificato: latch `RELEASED`, generation `0`, `latestHandoff=null`; checkpoint/manifest/resume prompt/Sessione B non generati. Conversation history copiata: zero, ma non esiste un happy path completato.
- Il processo TUI PID 22268 è rimasto attivo dopo il timeout del tool ed è stato terminato in modo mirato con `taskkill`; nessun altro processo è stato toccato. Il fallback manuale M1-H0 non esiste per questo failure pre-command, quindi non è stato inventato né sostituito con copia/incolla.
- Intervento necessario: avviare il task fin dall'inizio dentro un TUI posseduto dal Guardian Runner M1-H0 e usare lì `/eio handoff confirm`. Collegare retroattivamente il Runner alla sessione API corrente o automatizzare `handoffDirect` sarebbe una simulazione vietata.
- Esito milestone corrente: **PARTIAL/BLOCKED**. H1-01 funziona, ma acceptance issue #7 non passa perché Sessione A → B e Continuity Check non sono avvenuti.
- `checkpoint_message`: “M1-H1 advisor verificato; dogfood bloccato prima dell'input /eio nel TUI”.

**Nome sessione suggerito:** `eiopago-m1-h1-dogfood-resume`

**Prompt minimo di ripresa:**

> Avvia Pi dal worktree `F:/dev/eiopago-m1-h1` sotto il Guardian Runner M1-H0 con TUI interattivo; verifica Git e profilo high e leggi `TASK_PLAN.md` revisione `PLAN-M1-H1-0004` più la prima sezione di `CHECKPOINT.md`. H1-01 è DONE (advisor 2/2, check 17, suite 12/12): non ripeterlo. Sblocca H1-02 soltanto tramite handoff reale `/eio handoff confirm`, senza history copiata o `handoffDirect`; poi misura Sessione B e artefatti. Non iniziare Cost Guard.

# CHECKPOINT — M1-H0 riaccettato sui tre finding mirati

## Ultima sessione — nuova acceptance sul diff corrente

- Data: 2026-08-08; sessione Pi `019fe0d1-9320-756b-b429-96e43af51ac4`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD `7439ef68f3e859c8655c8be07846a07064c0edb4`, upstream `80b8193b5a9559bde7c6c20d806042c4c5263d18`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock. Worktree dirty preesistente preservato.
- Ambito eseguito esclusivamente come nuova acceptance dei tre finding M1-H0 sul diff corrente. Audit e SP-01…SP-04 non ripetuti; Cost Guard, M1.1/M1.2 e integrazioni esterne non iniziati.
- Esito: **PASS**. Il takeover escalato a `HUMAN_TAKEOVER` resta engaged e la stale confirm non rilascia il latch, non crea authorization/admission e non raggiunge il dispatch.
- Esito: **PASS**. I digest SHA-256 di index e worktree sono valorizzati, trasportati e confrontati fail-closed; il test rileva byte dirty e staged diversi anche con status porcelain invariato.
- Esito: **PASS**. Il Ledger canonico valida `current_item`/`next_item`; manifest e resume prompt li preservano e l'E2E aggiorna realmente la fonte da `PLAN-E2E-1` a `PLAN-E2E-2` dopo il lavoro source e prima dell'handoff.
- Verifiche eseguite: test mirati **3/3 pass**; `npm run check` pass su 16 moduli; `npm test` **10/10 pass** (core offline 6/6, E2E Pi reale/provider fake 4/4); `git diff --check` pass, con soli warning informativi LF→CRLF.
- `TASK_PLAN.md` avanzato a `PLAN-M1-H0-0003`, stato `DONE`, lifecycle chiuso (`current_item=null`, `next_item=null`) con evidenza di questa acceptance. Nessun file applicativo modificato durante l'acceptance e nessun commit eseguito.
- Invarianti confermati nel solo ambito valutato: `REQUIRES_RUNNER`, **FINISH CURRENT ATOMIC OPERATION** e `RESUME_DISPATCH_UNKNOWN` fail-closed senza retry cieco.
- `checkpoint_message`: “M1-H0 riaccettato: tre finding corretti e 10/10 test pass”.

**Nome sessione suggerito:** `eiopago-post-m1-h0-owner-gate`

**Prompt minimo di ripresa:**

> Verifica Git/profilo e leggi la prima sezione di `CHECKPOINT.md`. M1-H0 è accettato e il Ledger è chiuso; non iniziare Cost Guard, M1.1/M1.2 o integrazioni esterne senza nuova autorizzazione esplicita.

# CHECKPOINT — Tre finding M1-H0 corretti, nuova acceptance pendente

## Ultima sessione — correzioni mirate sul commit 7439ef6

- Data: 2026-08-08; sessione Pi `019fe0c5-a9b8-71b8-a6a8-5542af82887c`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD `7439ef68f3e859c8655c8be07846a07064c0edb4`, upstream `80b8193b5a9559bde7c6c20d806042c4c5263d18`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock. Worktree preesistente dirty preservato.
- Ambito eseguito esclusivamente sui tre finding M1-H0 autorizzati. Audit e SP-01…SP-04 non ripetuti; Cost Guard, M1.1/M1.2 e integrazioni esterne non iniziati.
- **Takeover corretto:** `authorizeAndAdmit()` rifiuta transazionalmente `HUMAN_TAKEOVER_ACTIVE`; una conferma handoff pendente non rilascia il latch, non crea authorization/admission e non avvia dispatch.
- **Git continuity corretta:** `GitState` calcola digest SHA-256 verificabili dell'index e dei byte/mode del worktree tracciato o untracked non ignorato; `sameGitState()` richiede e confronta entrambi. Checkpoint e manifest li trasportano e Continuity li valida. Il test riproduce byte dirty e staged diversi con status porcelain invariato.
- **Ledger lifecycle corretto:** il Ledger canonico revisionato espone e valida `current_item`/`next_item`; manifest e resume prompt li preservano. L'E2E aggiorna realmente la fonte Markdown da `PLAN-E2E-1` a `PLAN-E2E-2` dopo il lavoro source e prima dell'handoff, poi verifica revisione, digest e lifecycle ripreso. `TASK_PLAN.md` è ora `PLAN-M1-H0-0002`, con item dei finding corrente fino alla nuova acceptance esterna.
- Verifiche finali: `npm run check` pass su 16 moduli; `npm test` **10/10 pass** (core offline 6/6, E2E Pi reale/provider fake 4/4); `git diff --check` pass. Nessun commit eseguito.
- Garanzie invarianti preservate: `REQUIRES_RUNNER`, **FINISH CURRENT ATOMIC OPERATION** e `RESUME_DISPATCH_UNKNOWN` fail-closed senza retry cieco.
- `checkpoint_message`: “M1-H0: corretti takeover stale-confirm, digest Git e lifecycle Ledger current/next”.

**Nome sessione suggerito:** `eiopago-m1-h0-reacceptance`

**Prompt minimo di ripresa:**

> Verifica Git/profilo e leggi la prima sezione di `CHECKPOINT.md`. Esegui soltanto nuova acceptance dei tre finding M1-H0 sul diff corrente; non ripetere audit/SP e non iniziare Cost Guard, M1.1/M1.2 o integrazioni esterne.

# CHECKPOINT — M1-H0 acceptance bloccata da finding mirati

## Ultima sessione — acceptance issue #6 sul commit 7439ef6

- Data: 2026-08-08; sessione Pi `019fe0c1-0a7c-77db-8563-b7eb915fc746`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD `7439ef68f3e859c8655c8be07846a07064c0edb4`, upstream `80b8193b5a9559bde7c6c20d806042c4c5263d18`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock. Worktree preesistente dirty preservato; il codice/test valutato coincide col commit.
- Letti regole operative, sola precedente prima sezione del checkpoint, `TASK_PLAN.md`, handoff MVP, ADR-0015 e issue GitHub #6 in sola lettura. Audit e SP-01…SP-04 non ripetuti; Cost Guard, M1.1/M1.2 e integrazioni esterne non iniziati.
- Esito acceptance: **BLOCKED**. Il commit copre gran parte del vertical slice e `npm run check` passa su 16 moduli; `npm test` passa **8/8**, ma restano tre finding vincolanti.
- **P1 — takeover aggirabile:** `authorizeAndAdmit()` verifica solo stato/generation del latch e non la causa `HUMAN_TAKEOVER`; una conferma handoff già pendente può quindi rilasciare il takeover, committare admission e proseguire. Riproduzione locale: latch escalato a takeover → admission `COMMITTED`, latch `RELEASED` da `human:stale-confirm`.
- **P1 — Git continuity incompleta:** `observeGitState()` lascia `index_digest`/`worktree_digest` null e `sameGitState()` confronta solo identità e righe porcelain. Cambiare i byte di un file già dirty senza cambiarne lo status produce `sameGitState=true`, quindi un mismatch reale può passare continuity.
- **P2 — Ledger/E2E non soddisfa current/next e update:** il Ledger canonico non contiene `current_item`/`next_item`; il reader deriva soltanto `current_item` dal primo item `IN_PROGRESS` e non espone `next_item`. Nel Ledger committato, tutto `DONE` produce `current_item=null`. Inoltre l'handoff importa il Ledger read-only e l'E2E usa una fixture già predisposta, senza dimostrare il criterio issue #6 “Ledger aggiornato” durante il flusso.
- Nessun file applicativo modificato e nessun commit eseguito. Unica modifica della sessione: questo checkpoint operativo.
- `checkpoint_message`: “M1-H0 acceptance bloccata: takeover, digest Git dirty e lifecycle Ledger/E2E da correggere”.

**Nome sessione suggerito:** `eiopago-m1-h0-fix-acceptance`

**Prompt minimo di ripresa:**

> Verifica Git/profilo; leggi regole operative, prima sezione di `CHECKPOINT.md`, issue #6, `TASK_PLAN.md`, `docs/m1-h0-handoff-mvp.md` e ADR-0015. Con nuova autorizzazione, correggi soltanto i tre finding M1-H0 sul commit 7439ef6: takeover non rilasciabile da conferma pendente, digest Git index/worktree verificabili e lifecycle Ledger current/next con E2E che dimostri l'update. Mantieni `REQUIRES_RUNNER`, FINISH CURRENT ATOMIC OPERATION e `RESUME_DISPATCH_UNKNOWN` fail-closed; non ripetere audit/SP-01…SP-04 e non iniziare Cost Guard, M1.1/M1.2 o integrazioni esterne.

# CHECKPOINT — M1-H0 revisionato e consolidato

## Ultima sessione — review mirata e commit issue #6

- Data: 2026-08-08; sessione Pi `019fe02e-522e-714d-b0e2-8cd1ff15d3b9`.
- Gate verificato: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`; repository `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD/upstream iniziale `80b8193`, identità Git `kinderp <a.caristia@gmail.com>`, nessun index lock.
- Letti regole operative, sola precedente prima sezione del checkpoint, Ledger, handoff MVP, ADR-0015 e diff pertinenti. Issue GitHub #6 letta direttamente in sola lettura; audit e SP-01…SP-04 non ripetuti.
- Review mirata chiusa sulle decisioni vincolanti: `REQUIRES_RUNNER`, **FINISH CURRENT ATOMIC OPERATION**, replacement paused/no-history, admission locale unica e `RESUME_DISPATCH_UNKNOWN` fail-closed restano invariati.
- Corretto il tracking degli effetti `edit`/`write`: Pi non ripete `args` in `tool_execution_end`, quindi il Runner conserva il path ammesso da `tool_call` e lo usa come effect reference terminale; mutazioni senza riferimento restano `HUMAN_DECISION_REQUIRED`.
- Aggiunto takeover/pause minimo `/eio takeover` (`/eio pause` accettato): latch durevole `HUMAN_TAKEOVER`, queue/retry/compaction chiusi e safe point tool-aware, senza avviare integrazioni o Cost Guard.
- Rafforzato Continuity Check su GitState del checkpoint e policy model/reasoning del manifest. Il prompt E2E verifica esplicitamente `current_item` e `next_step`.
- Gestiti create cancellato/ambiguo come `HANDOFF_FAILED`: nessun secondo target, checkpoint preservato e istruzioni numerate persistite/visibili da `/eio status`; nessun manifest finale viene inventato senza il vero target ID.
- Verifiche finali: `npm run check` pass su 16 moduli; `npm test` **8/8 pass** (core offline 4/4, E2E Pi reale/provider fake 4/4, inclusi `/eio takeover`, `/eio handoff manual` e failure create), zero tentativi rete nei test.
- Consolidato esclusivamente il vertical slice M1-H0 e i suoi artefatti applicativi/documentali; PDF e lavoro preesistente SP/audit non sono stati inclusi né alterati intenzionalmente. Nessuna configurazione `~/.pi` modificata.
- Limiti invariati: `node:sqlite` experimental; provider fake offline; create-session→journal non ACID; recovery unattended/hardening fuori scope. Issue #6 resta soggetta ad acceptance esterna, che il commit non implica.
- `checkpoint_message`: “M1-H0 review chiusa: handoff paused/no-history, takeover e fallback fail-closed verificati”.

**Nome sessione suggerito:** `eiopago-m1-h0-acceptance`

**Prompt minimo di ripresa:**

> Verifica Git e profilo; leggi regole operative, prima sezione di `CHECKPOINT.md`, `TASK_PLAN.md`, `docs/m1-h0-handoff-mvp.md` e ADR-0015. Valuta soltanto acceptance/finding di M1-H0 issue #6 sul commit indicato nel messaggio precedente; non ripetere audit o SP-01…SP-04 e non iniziare Cost Guard, M1.1/M1.2, provider o integrazioni esterne senza nuova autorizzazione.

# CHECKPOINT — M1-H0 Automatic Session Handoff MVP implementato

## Ultima sessione — issue #6, vertical slice owner-controlled

- Data: 2026-08-08; sessione Pi `019fe012-6014-7a8d-8858-d04c64260f56`.
- Gate verificato prima delle decisioni: `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-sol`, `PI_REASONING_LEVEL=high`. Repository reale `F:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, HEAD/upstream `80b8193`, nessun index lock; modifiche SP-01…SP-04 e PDF preesistenti preservati.
- Letti regole operative, sola prima sezione del checkpoint, SP-01/SP-02/SP-03/SP-04, ADR-0015, roadmap, contratti pertinenti e documentazione/esempi Pi necessari. Audit e spike chiusi non sono stati ripetuti; Cost Guard completo, supervised-auto, provider esterni, dashboard e SP-05+ non sono stati iniziati.
- Creato `TASK_PLAN.md` revisionato `PLAN-M1-H0-0001`, Markdown canonico con import deterministico read-only, DAG/evidence validation e digest SHA-256 dei byte; item M1-H0 chiuso con evidenze, Cost Guard esplicitamente fuori Ledger/scope.
- Implementato storage SQLite versionato in `src/storage.mjs`: WAL, `synchronous=FULL`, authority metadata, latch fail-closed, journal append-only, active-source ownership, operation outcome, artifact index, authorization/admission unique e dispatch intent. Runtime e artefatti generati restano sotto `.guardian/` e sono ignorati da Git.
- Implementati checkpoint e Resume Context Manifest sealed in `src/artifact-store.mjs`/`src/handoff.mjs`: temp+fsync+rename, payload/content digest, digest dei byte, immutabilità per ID, secret scan, checkpoint parent/DAG, Git snapshot e manifest sigillato solo dopo il vero target ID.
- Implementato Runner minimo in `src/runner.mjs`: provider transport posseduto e wrappato dal gate, nessuna estensione/skill esterna, tool allowlist profilata, queue/retry/compaction ownership e Extension inline UI/comandi. `REQUIRES_RUNNER` resta rispettato; il soft gate Extension non viene presentato come hard stop.
- Implementato safe point SP-03 in `src/safety.mjs`: latch durevole prima degli effetti, clear queue, cancel retry/compaction, abort cooperativo, attesa terminale e policy **FINISH CURRENT ATOMIC OPERATION**. Tool non profilati non sono ammessi; mutazione unknown o senza effect reference converge su `HUMAN_DECISION_REQUIRED`.
- Implementati `/eio handoff manual|confirm`, alias `/eiopago`, `/eio resume` e `/eio status`. Il target Pi nasce con parent, paused e senza message/history; `manual` lascia latch e prompt in editor, `confirm` autorizza soltanto dopo Continuity Check nella replacement session.
- Continuity Check rilegge Ledger, checkpoint/manifest e digest, Git completo/status, source/target/parent, target no-history/idle, current item/next step, minimal reads realmente disponibili, model/reasoning policy e latch generation; non auto-corregge mismatch.
- Resume: rilascio latch esclusivamente `human:*`, authorization e admission nello stesso commit SQLite con unique `resume_prompt_id`/idempotency key; dispatch intent prima di `sendUserMessage`. Successo registra `RESUME_DISPATCHED` e ACK; ogni errore post-intent diventa `RESUME_DISPATCH_UNKNOWN` e non viene ritentato. Nessuna exactly-once provider execution dichiarata.
- Test: `npm run check` pass su 16 moduli; `npm test` **6/6 pass**. Offline core **4/4** copre Ledger, immutabilità/tamper, latch/admission/dispatch unknown e safe point. E2E **2/2** usa vero `AgentSessionRuntime`/`SessionManager` Pi 0.83.0, provider fake, source→checkpoint→target paused/no-history→resume, parent header, ordine journal, admission unica, retry/reload idempotente e manual paused; zero tentativi rete.
- Documentazione aggiunta: `docs/m1-h0-handoff-mvp.md`; roadmap aggiornata solo per registrare il gate M1-H0 locale. Contratti e ownership ADR non sono stati cambiati.
- Limiti espliciti: `node:sqlite` è ancora marcato experimental da Node 22.19; E2E usa runtime Pi reale ma provider fake offline; nessun sandbox rete OS o paid-provider test; create-session→journal resta saga non ACID e un outcome ambiguo blocca il secondo target; crash recovery unattended e hardening restano M1.1/M1.2.
- Nessun commit eseguito e nessuna configurazione `~/.pi` modificata. Stato: **M1-H0 implementato e testato localmente; review/consolidamento pendenti, acceptance esterna non implicita**.
- `checkpoint_message`: “M1-H0: handoff Pi paused/no-history e resume idempotente verificati”.

**Nome sessione suggerito:** `eiopago-m1-h0-review-consolidate`

**Prompt minimo di ripresa:**

> Verifica profilo/Git; leggi regole operative, prima sezione di `CHECKPOINT.md`, `TASK_PLAN.md`, `docs/m1-h0-handoff-mvp.md`, ADR-0015 e i diff M1-H0. Non ripetere audit o SP-01…SP-04. Esegui review mirata di issue #6, `npm run check`, `npm test` e, se conforme, consolida/committa esclusivamente M1-H0 preservando `REQUIRES_RUNNER`, FINISH CURRENT ATOMIC OPERATION e `RESUME_DISPATCH_UNKNOWN` fail-closed. Non iniziare Cost Guard completo, M1.1/M1.2, provider o integrazioni esterne senza nuova autorizzazione.

# CHECKPOINT — M0.1 Contract and Boundary Freeze completata

## Ultima sessione — M0.1 Contract and Boundary Freeze (corrente)

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Profilo verificato prima delle decisioni: `openai-codex/gpt-5.6-sol`, reasoning `high`.
- Esito: **M0.1 completata esclusivamente a livello documentale; STOP DI SESSIONE**. M1 non iniziata, nessun codice applicativo creato, nessuna dipendenza installata e nessun commit eseguito.
- Decisioni `DECIDED`: ownership ibrida distinta per categoria (Ledger Markdown; checkpoint JSON immutabile; telemetria/handoff/latch SQLite; Git tecnico; provider billing per addebito; evidenze presso artefatto owner); checkpoint come commit operativo distinto da Git; lifecycle e parent/DAG; acceptance esterna separata; handoff saga fail-closed e human latch prioritario; confini Eiopago/Durex/FARO Governance/Raiatea/Alfred; modalità standalone.
- Decisioni `PROVISIONAL`: path `TASK_PLAN.md` e `.guardian/checkpoints/`; fallback Extension-first per block-next-call; Raiatea resolver futuro. Qualsiasi cambio di autorità richiede nuovo ADR e migrazione one-way.
- API Pi 0.83.0 classificate in ADR-0015: `CONFIRMED` usage, statistiche, abort surface, input/steering, comandi, conferme, nuova sessione, parent, naming, model e reasoning; `NEEDS_SPIKE` block-next-call, safe point, prompt exactly-once, shutdown/suspend; `REQUIRES_RUNNER` per recovery automatica dopo process crash. Un block hook Extension immediatamente pre-request è `UNSUPPORTED`; Runner resta condizionale a SP-01/SP-04.
- Spike offline M0.1 in `%TEMP%`, senza provider/rete e senza modificare `~/.pi`: RPC (`get_state`, stats, naming, `new_session`, abort idle) riuscito; SessionManager ha verificato header parent v3 e sessione child senza history parent. Rilevata materializzazione differita del JSONL fino alla prima risposta assistant, da coprire nel journal.
- Spike M1 richiesti: SP-01 block race; SP-02 active-stream abort; SP-03 safe point; SP-04 prompt exactly-once; SP-05 shutdown/suspend; SP-06 reload/crash; SP-07 hotkey Windows; SP-08 failure dopo teardown `newSession`; SP-09 takeover durante commit; SP-10 import/conflitti Ledger-checkpoint.
- Contratti minimi definiti: ID e Ledger schema; checkpoint fields/lifecycle/immutabilità; `EventEnvelope`, `CheckpointSpec`, `RunContext`, `RunEvent`, `CandidateCheckpoint`, `CheckpointDecision`, `EvidenceReference`; latch e handoff transaction. JSON Schema, fixture e conformance restano M1/futuro e nessun contratto è implementato.
- Documenti creati: `docs/adr/0015-m0-boundaries-and-contract-freeze.md`, `docs/contracts/m0-contracts.md`, `docs/roadmap.md`.
- Documenti aggiornati in modo mirato: `docs/audit/guardian-requirements-coverage.md` (zero COMPLETE, 92 PARTIAL, zero MISSING), `PIANO_MAESTRO_FARO_DUREX_EIOPAGO.md` e questo checkpoint. PDF funzionali non modificati.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit. Non tracciati: checkpoint, due PDF, Piano Maestro e `docs/`; nessun file applicativo.
- Rischi aperti: nessun gate Extension pre-request; teardown del vecchio runtime prima della garanzia del nuovo; prompt replacement avvia una call; crash unattended richiede process owner; source-of-truth sicura solo se projection non scrivono indietro; `VERIFIED` non deve essere mostrato come `ACCEPTED`.
- Modello consigliato per l'avvio M1: `openai-codex/gpt-5.6-sol`, reasoning `high` per SP-01/SP-02/SP-03/SP-04 e race di sicurezza; passare a `medium` solo dopo il gate per scaffold/implementazione meccanica e test ordinari.
- Prossimo passo globale: soltanto dopo autorizzazione esplicita a iniziare M1, eseguire prima SP-01 con fake stream/no rete e decidere Extension fallback vs Runner; non integrare provider, TokenSave, pi-auto-router, Durex o FARO.
- `checkpoint_message`: “M0.1 congelata: contratti, ownership, lifecycle e API Pi classificati”.

**Nome sessione suggerito:** `eiopago-m1-block-next-call-spike`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md`, `CHECKPOINT.md`, ADR-0015, `docs/contracts/m0-contracts.md` e `docs/roadmap.md`; usa coverage/Piano Maestro solo per riscontri e non ripetere audit o M0.1. Verifica Git e profilo `openai-codex/gpt-5.6-sol`, reasoning `high`. Inizia M1 solo se esplicitamente autorizzato: esegui prima SP-01 con fake stream e zero rete per provare block-next-call; se fallisce classifica `REQUIRES_RUNNER` senza hack terminali. Non integrare provider, TokenSave, pi-auto-router, Durex o FARO e non modificare `~/.pi`.

## Sessione precedente — audit copertura requisiti

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Esito: **audit di copertura completato; STOP DI SESSIONE**. Creato `docs/audit/guardian-requirements-coverage.md`; nessuna funzionalità implementata, M0 non ampliata, M1 non iniziata e nessuna decisione critica ratificata.
- Fonti lette in modo mirato: regole canoniche, checkpoint e indice/sezioni pertinenti di `Guardian_Pi_Agent_Guida_Funzionale.pdf` v0.1. Il PDF è comparso come file non tracciato durante la sessione ed è stato incluso perché materialmente pertinente all'audit. Nessun altro documento o repository terzo è stato riletto.
- Risultato sintetico: zero funzionalità `COMPLETE`; copertura prevalentemente `PARTIAL` documentale; lacune maggiori in block-next-call verificabile, latch/handoff transazionale, ledger canonico, checkpoint/evidence model e accounting canonico. Contratti futuri nominati dal mandato non risultano documentati nelle fonti.
- Verifiche: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit. Stato finale non tracciato: `CHECKPOINT.md`, `Guardian_Pi_Agent_Guida_Funzionale.pdf` e `docs/`.
- Profilo della sessione: `openai-codex/gpt-5.6-sol`, reasoning `medium`, usato esclusivamente per audit di copertura; il gate `high` resta obbligatorio prima di ratificare decisioni M0 o verificare le API critiche.
- Modifiche: soltanto il nuovo report di audit e questo checkpoint; `~/.pi` non modificato. Nessun test eseguito perché non esiste codice Eiopago e il mandato vietava implementazioni.
- Prossimo passo: in una nuova sessione `high`, leggere il report senza ripetere l'audit e riprendere il gate M0 già previsto; non iniziare M1 prima delle decisioni/verifiche richieste.
- `checkpoint_message`: “Audit copertura completato: zero COMPLETE, gap critici M0/M1 identificati”.

**Nome sessione suggerito:** `eiopago-m0-gap-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md`, `CHECKPOINT.md` e `docs/audit/guardian-requirements-coverage.md`; usa `Guardian_Pi_Agent_Guida_Funzionale.pdf` solo per riscontri puntuali e non ripetere l’audit. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`; se non conforme aggiorna solo il checkpoint e fermati. Riprendi esclusivamente il gate M0 già previsto, partendo dai cinque gap urgenti e senza segnare COMPLETE ciò che è solo in roadmap. Non iniziare M1 né modificare `~/.pi`.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3de-0d1b-7cb8-bfd2-9b50b354432c`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le variabili `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3c2-76f7-783a-9b94-20bd2c5c83b4`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le variabili `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3b8-ecd8-72be-a936-898825b9de6b`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le tre variabili `PI_*` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Profilo Sol corretto, reasoning ancora medium; M0 rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd3b2-61c0-7724-84c9-fdfc49645e27`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, API Pi non verificate, decisioni M0 non ratificate e M1 non avviata.
- Profilo esatto rilevato dalle variabili `PI_*`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning richiesto è `high`, quindi il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` `https://github.com/kinderp/eiopago.git`, zero commit; soltanto `CHECKPOINT.md` e `docs/` sono non tracciati, coerentemente con lo stato dichiarato.
- In conformità al gate non sono stati ripetuti audit/test, non sono state svolte verifiche API mirate e `~/.pi` non è stato modificato. Modificato soltanto `CHECKPOINT.md`.
- Prossimo gate: avviare una nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning esattamente `high`; verificare Git e le tre variabili `PI_*` prima di creare il ledger o assumere decisioni M0.
- `checkpoint_message`: “Reasoning ancora medium; M0 e verifica API rinviate senza modifiche”.

**Nome sessione suggerito:** `eiopago-m0-api-ratifica-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd327-16e7-7e9f-a249-758ed2723c33`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; Master Task Ledger non creato, nessuna decisione M0 ratificata e M1 non avviata.
- Profilo rilevato da `PI_PROVIDER`, `PI_MODEL` e `PI_REASONING_LEVEL`: `openai-codex/gpt-5.6-sol`, reasoning effettivo `medium`. Provider e modello sono corretti, ma il reasoning non è esattamente `high`; il profilo obbligatorio non è soddisfatto.
- Git verificato: repository `E:/dev/eiopago`, branch `feat/pi-usage-guardian-foundation`, worktree principale, remote `origin` coerente, nessun commit; `CHECKPOINT.md` e `docs/` restano non tracciati e coerenti con lo stato dichiarato.
- Non sono stati ripetuti audit o test e `~/.pi` non è stato modificato. Una ricerca mirata iniziale nelle API/documentazione installate ha rilevato l'esempio `examples/extensions/handoff.ts`, ma è stata interrotta al riscontro del profilo non conforme: nessuna semantica API, fattibilità, state machine, latch o scelta Extension/Runner è stata ratificata.
- Modifiche: aggiornato soltanto `CHECKPOINT.md` per registrare il gate e il passaggio di sessione. Roadmap e requisiti restano quelli già acquisiti sotto.
- Prossimo gate: nuova sessione con profilo effettivo `openai-codex/gpt-5.6-sol`, reasoning `high`; verificare le tre variabili `PI_*` prima di creare il ledger o riprendere la verifica API mirata.
- `checkpoint_message`: “Profilo Sol confermato ma reasoning medium; M0 critica rinviata senza decisioni”.

**Nome sessione suggerito:** `eiopago-m0-handoff-takeover-api-high`

**Prompt minimo di ripresa:**

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna solo il checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica le API Pi mirate e ratifica confirm handoff, takeover, latch, Extension vs Runner, state machine e roadmap M1/M1.1/M1.2. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint, prompt minimo e nome sessione.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd303-d3c1-703b-95b2-7a6b423833e7`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica o attività M1 avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio richiesto non è soddisfatto.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; remote `origin` coerente; nessun commit; `CHECKPOINT.md` e `docs/` non tracciati, coerenti con i file dichiarati nel checkpoint.
- Non sono stati ripetuti audit, inventari o test già completati; `~/.pi` non è stato modificato.
- Statistiche rilevate durante il gate: 10 entry JSONL; 2 record usage; input 9.715; output 714; reasoning 150; cache read 0; cache write 0; costo riportato USD 0,069995; contesto stimato 8.509 / 272.000 = 3,13%. Nessuna soglia quantitativa raggiunta; stop esclusivamente qualitativo.
- Nuovo requisito prioritario ricevuto e registrato senza progettarlo in profilo non conforme: **Automatic Session Handoff** deve appartenere al Cost Guard MVP/M1, non a dashboard od orchestratore futuro. Deve creare una sessione pulita nello stesso processo (non clone/fork), preservare il parent, trasferire solo checkpoint/stato minimo, bloccare ulteriori chiamate nella vecchia sessione e supportare `manual`/`confirm`/`auto` (default `confirm`). Il mandato prescrive state machine, validazioni, configurazione iniziale e dieci criteri E2E; questi elementi devono essere incorporati in roadmap, requisiti, casi d'uso, architettura, ADR e criteri M1 durante la fase critica `high`.
- Modifiche: aggiornato soltanto questo checkpoint per acquisire requisito, stato reale, statistiche e handoff. Nessun documento architetturale creato perché ciò violerebbe il gate `high`; M1 non iniziata.
- Prossimo gate: nuova sessione con `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; includere Automatic Session Handoff nella fase critica delimitata e verificare le API Pi mirate necessarie senza rileggere l'intero audit.
- Integrazione strategica successiva ricevuta nella stessa sessione: la continuità dei task lunghi deve seguire il principio «cronologia corta, memoria persistente affidabile, contesto recuperato su richiesta e passaggi verificati». Il mandato amplia l'handoff con punti stabili, pacchetto persistente/versionato, aggiornamento progressivo deterministico, costo control-plane separato, Quality Gate, Continuity Check, Resume Context Manifest, lineage task/sessione, crash recovery, redazione segreti, policy per tipo di task, limiti anti-loop, estensione atomica controllata e misure di qualità/A-B. Non presume che più contesto o ogni nuova sessione migliorino automaticamente la qualità.
- Roadmap richiesta dall'ultima integrazione: M0 fondazione/decisioni; M1 Cost Guard MVP; M1.1 Automatic Session Handoff; poi M2–M11. In fase critica `high` va deciso se includere l'handoff direttamente in M1 quando l'API Pi lo consente senza ritardare eccessivamente il primo guard, altrimenti completarlo nell'estensione immediata M1.1; non può essere rinviato alla dashboard.
- Output architetturali richiesti ma **non redatti in questa sessione medium**: visione, requisiti, casi d'uso, architettura, modello dati, budget/stop, routing, roadmap, sicurezza, benchmark, domande aperte, documento dedicato e ADR non duplicati. Il gate qualitativo resta vincolante; nessuna supposizione sulle API Pi è stata ratificata.
- Statistiche dopo l'acquisizione dell'integrazione: 22 entry JSONL; 6 record usage; input 24.790; output 3.829; reasoning 742; cache read 44.032; cache write 0; costo USD 0,260836; contesto stimato 21.254 / 272.000 = 7,81%. Nessuna soglia quantitativa raggiunta; permane lo stop per reasoning `medium`.
- Ulteriore requisito ricevuto nella stessa sessione: **Persistent Master Task Ledger** canonico e versionato per l'intero task, distinto da Session Checkpoint, documentazione/ADR e repository/test. Deve mantenere requisiti versionati, DAG/lista di attività con ID e stati stabili, dipendenze, evidenze verificabili, budget/costo, lineage e prossimo passo globale; nessuna attività può diventare `DONE` senza evidenza. I cambi requisito devono restare tracciati tramite `SUPERSEDED`/`DROPPED`, senza cancellazioni silenziose.
- Il ledger deve essere aggiornato progressivamente e verificato prima dell'handoff e durante la continuity verification; il checkpoint deve restare un delta di sessione con riferimenti al ledger. Per l'MVP deve esistere una sola fonte canonica leggibile in Markdown; l'eventuale SQLite generatore della vista è futuro e non deve creare doppie fonti divergenti.
- Convenzione file e schema non ratificati: il repository non possiede ancora una convenzione oltre a checkpoint/regole; la fase `high` deve scegliere motivatamente tra `TASK_PLAN.md` e `.guardian/tasks/<task-id>/...`, creare il ledger iniziale senza ricostruzioni indipendenti e aggiungere le entità/equivalenti richieste al modello dati.
- Statistiche dopo questa integrazione: 35 entry JSONL; 11 record usage; input 34.819; output 6.965; reasoning 1.159; cache read 158.208; cache write 0; costo USD 0,462149; contesto stimato 28.927 / 272.000 = 10,63%. Nessuna soglia quantitativa raggiunta; STOP invariato perché reasoning effettivo `medium`.
- Requisito successivo ricevuto nella stessa sessione: **Visual Task Roadmap e Checkpoint History**, comando primario `/guardian roadmap` interamente locale, senza chiamate LLM/provider, con possibile CLI coerente. Deve proiettare Master Task Ledger, DAG/piano, session lineage, handoff, checkpoint effettivi/previsti/mancanti, requirement changes, review/finding/fix, test, uso e costi.
- Varianti richieste: default, `--oneline`, `--details`, filtri active/completed/planned/missing/checkpoints/sessions/reviews, `--usage`, `--cost`, `--json`; Unicode con fallback ASCII, colori opzionali e semantica non dipendente dal colore. Il DAG non deve essere falsificato come gerarchia: percorso principale, rami e riferimenti trasversali espliciti.
- `--missing` diventa una vista di controllo coerenza su checkpoint/evidenze/requisiti/handoff/continuity; `--json` richiede schema stabile e versionato. Usage e costi devono mantenere separate fonti misurate, stimate, abbonamento, API, provider riconciliato e control plane.
- Collocazione, contratto dati e nomenclatura CLI non ratificati in profilo `medium`: integrarli in specifiche, architettura, modello dati, casi d'uso, roadmap e criteri durante M0 `high`, senza iniziare la milestone d'implementazione.
- Statistiche dopo l'acquisizione: 44 entry JSONL; 15 record usage; input 43.516; output 9.650; reasoning 1.301; cache read 280.064; cache write 0; costo USD 0,647112; contesto stimato 35.842 / 272.000 = 13,18%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato.
- Completamento del requisito Visual Task Roadmap ricevuto nella stessa sessione: la vista deve modellare cicli implementazione→review→finding→fix→review→approvazione, plan/history/combined, `ExpectedCheckpoint`, requirement-change events, summary aggregate e filtri non mutanti. Ogni round/sessione/checkpoint conserva identità, lineage, Git, profilo, durata, usage/costi distinti, test/finding/handoff/continuity/evidenze; i campi assenti sono `unknown`, mai zero inventato.
- Nuovo campo richiesto `checkpoint_message`: una riga descrittiva, idealmente 72–100 caratteri, generata durante la normale chiusura senza chiamata LLM dedicata. Dettagli esclusi dalla larghezza restano accessibili con `/guardian roadmap --details <id>` o comando show da ratificare.
- `ExpectedCheckpoint` deve distinguere `PLANNED`, `NOT_YET_DUE`, `DUE`, `SATISFIED`, `MISSING`, `WAIVED`, `SUPERSEDED`; è `MISSING` solo dopo trigger/fase/task/handoff pertinente, mai prima che sia dovuto. La vista essenziale statica è proposta per M1, lineage/handoff per M1.1, review/finding/fix e filtri avanzati per M2, TUI interattiva per M9; non rinviarla alla dashboard.
- Requisiti non funzionali acquisiti: offline, deterministica, incrementale/indicizzata, nessuna rete/LLM/provider, dati parziali sicuri, terminale stretto, Unicode/ASCII/no-color, escape/CSV injection safety, output JSON versionato e tempo obiettivo locale da documentare/misurare. La source-of-truth strategy Markdown/SQLite/Git/provider deve essere decisa senza correzioni silenziose.
- Test richiesti registrati senza esecuzione: casi lineari/DAG/branch-merge, sessioni/handoff/review/fix, stati checkpoint, evidenze e requirement superseded, dati incompleti/costi non riconciliati, rendering/filtri/ordinamenti/JSON/idempotenza, assenza rete/LLM e injection. Golden/snapshot solo se leggibili e non fragili.
- `checkpoint_message` corrente: “Acquisiti ledger e roadmap visuale; fase critica ancora bloccata dal profilo”.
- Statistiche dopo il completamento del requisito: 52 entry JSONL; 19 record usage; input 52.360; output 12.145; reasoning 1.404; cache read 426.496; cache write 0; costo USD 0,839398; contesto stimato 42.272 / 272.000 = 15,54%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato (`medium` anziché `high`).
- Nuova priorità P0 ricevuta: **Session Handoff Orchestrator con Human Takeover** precede roadmap avanzata, TokenSave, auto-router, forecasting, benchmark, provider avanzati e dashboard. La modalità iniziale è `confirm`; sono richieste esattamente `manual`, `confirm`, `supervised-auto`, `auto`, con `auto` disabilitata per default e possibile Guardian Runner solo se l'Extension API non supporta automazione robusta.
- Precedenza vincolante acquisita: HUMAN TAKEOVER → emergency stop/sicurezza → hard budget → checkpoint/integrità repository → handoff → piano agente → ottimizzazione. Un persistent human-control latch blocca nuove LLM/tool agentici, handoff, cambi profilo/budget e mutazioni piano; sopravvive a session switch, reload, crash e restart, ed è rilasciabile solo dall'utente.
- Comandi richiesti registrati: pause/takeover/resume; handoff prepare/confirm/cancel/status; plan show/edit/add/remove/reprioritize/approve; mode manual/confirm/supervised-auto/auto. Hotkey configurabile senza sovrascrivere Escape e steering directives deterministiche devono convergere sullo stesso latch.
- State machine candidata imposta dal mandato: `RUNNING → THRESHOLD_DETECTED → SAFE_POINT_REQUESTED → CHECKPOINT_PREPARING → HANDOFF_PREPARED → HANDOFF_ARMED → HANDOFF_COMMIT → NEW_SESSION_PAUSED → CONTINUITY_CHECK → RESUME_READY → RESUMED`. Durante COMMIT si esegue solo lo switch tecnico minimo; un takeover concorrente viene persistito e porta la nuova sessione a `NEW_SESSION_PAUSED`, senza rollback parziale né prompt automatico.
- Nuovo ordine roadmap sostituisce quello precedente: M0 API/session-control architecture; M1 Cost Guard + confirm handoff + takeover; M1.1 supervised-auto + crash recovery; M1.2 Runner per auto solo se necessario; M2 attribuzione/review budget/roadmap completa; M3–M11 come riportato sotto. La roadmap visuale minima può restare M1 ma non ritarda handoff/takeover/block/new-session/resume prompt.
- Verifiche API richieste ma non eseguite in `medium`: session creation/parent/name/prompt, pre-next-call block, safe abort, command/input/steering/hotkey/TUI, persistence/reload e confini Extension vs AgentSession/RPC. Non dichiarare implementabile alcuna modalità finché non provata con test mirati.
- `checkpoint_message` corrente: “Promosso handoff con takeover a P0; verifica API bloccata dal profilo”.
- Statistiche dopo l'acquisizione: 62 entry JSONL; 24 record usage; input 63.310; output 15.183; reasoning 1.772; cache read 644.096; cache write 0; costo USD 1,094088; contesto stimato 50.157 / 272.000 = 18,44%. Nessuna soglia quantitativa raggiunta; STOP qualitativo invariato (`medium` anziché `high`).

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2f1-57cb-78f7-8b69-0aaba6cc227d`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio non è soddisfatto.
- Regole operative canoniche: create in `docs/it/00-regole-operative.md` su richiesta esplicita dell'utente; il mandato corrente e questo checkpoint le integrano.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; remote `origin` coerente; nessun commit; solo `CHECKPOINT.md` non tracciato.
- Confronto checkpoint/stato reale: inizialmente nessuna discrepanza. Non risultavano README, ADR o altri file di progetto; in conformità al checkpoint non sono stati ripetuti audit, test, inventari o letture terze.
- Statistiche rilevate prima dell'aggiornamento del checkpoint: 11 entry JSONL; 3 record usage; input 10.774; output 862; reasoning 181; cache read 0; cache write 0; costo riportato USD 0,079730; contesto stimato 7.790 / 272.000 = 2,86%.
- Soglie di consumo: nessun warning o stop raggiunto. Lo stop deriva esclusivamente dal gate qualitativo del reasoning.
- Modifiche: su richiesta esplicita dell'utente, creata la fonte canonica `docs/it/00-regole-operative.md` e resa obbligatoria a ogni chiusura la consegna, sia nel checkpoint sia nel messaggio finale, del prompt minimo per la sessione successiva e di un nome breve suggerito. Aggiornato anche questo checkpoint; roadmap, decisioni pregresse e prossimo passo restano invariati.
- M0 ancora mancante: intera fase critica (architettura e autorità, TokenSave/TraceDecay, accounting e dati, sicurezza/threat model, budget e hard stop verificabile, compose/fork/rewrite, metodologia benchmark, ADR e documenti canonici minimi). M1 non iniziata.
- Profilo obbligatorio per la prossima sessione: `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; verificarlo prima di qualsiasi decisione critica.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2d9-3737-701e-a520-f7ce52715c1f`.
- Esito: **STOP DI SESSIONE** al gate pre-fase critica; nessuna decisione critica avviata.
- Profilo rilevato: provider `openai-codex`, modello `gpt-5.6-sol`, reasoning effettivo `medium`. Il reasoning non è esattamente `high`, quindi il profilo obbligatorio non è soddisfatto.
- Repository verificato: `E:/dev/eiopago`; branch `feat/pi-usage-guardian-foundation`; worktree principale; nessun commit; solo `CHECKPOINT.md` non tracciato.
- Confronto checkpoint/stato reale: **nessuna discrepanza**. Non risultano README, ADR o altri file di progetto; non sono stati ripetuti audit, test o ricerche.
- Statistiche disponibili dopo l'analisi del checkpoint: 9 entry JSONL; 2 record usage; input 10.427; output 932; reasoning 150; cache read 0; cache write 0; costo riportato USD 0,080095; contesto stimato 8.251 / 272.000 = 3,03%.
- Statistiche prima della chiusura: 13 entry JSONL; 4 record usage; input 12.613; output 2.035; reasoning 366; cache read 16.384; cache write 0; costo riportato USD 0,132307; contesto stimato 9.650 / 272.000 = 3,55%.
- Soglie di consumo: nessun warning o stop raggiunto. Lo stop deriva esclusivamente dal gate qualitativo del reasoning.
- Modifiche: aggiornato soltanto questo checkpoint; roadmap, decisioni pregresse e prossimo passo restano invariati.
- M0 ancora mancante: intera fase critica (architettura e autorità, TokenSave/TraceDecay, accounting e dati, sicurezza/threat model, budget e hard stop verificabile, compose/fork/rewrite, metodologia benchmark, ADR e documenti canonici minimi). M1 non iniziata.
- Profilo obbligatorio per la prossima sessione: `openai-codex/gpt-5.6-sol`, reasoning effettivo `high`; verificarlo prima di qualsiasi decisione critica.

## Tentativo di ripresa precedente

- Data: 2026-08-05; sessione Pi `019fd2be-9b8c-7c75-900f-662b2ce356f6`.
- Esito: fermato al gate pre-fase critica per profilo non conforme.
- Motivo: provider e modello corretti (`openai-codex/gpt-5.6-sol`), ma reasoning effettivo `medium` anziché `high`.
- Regole canoniche: verificato che nel repository non esiste ancora un file separato; valgono il mandato corrente e questo checkpoint.
- Confronto col repository: checkpoint coerente con branch `feat/pi-usage-guardian-foundation`, worktree principale, assenza di commit e solo `CHECKPOINT.md` non tracciato; nessun README, ADR o altro file di progetto presente.
- Modifiche al progetto: nessuna decisione o implementazione; aggiornato soltanto questo checkpoint.
- Decisioni critiche: nessuna avviata o ratificata.
- Statistiche dopo l'analisi del checkpoint: 11 entry JSONL; input 9.754; output 1.192; reasoning 212; cache read 4.096; cache write 0; costo riportato USD 0,086578; contesto stimato 8.467 / 272.000 = 3,11%.
- Soglie: nessun warning di consumo raggiunto; stop imposto dal gate qualitativo del reasoning.
- Ripresa consigliata: avviare una nuova sessione verificando **prima** delle decisioni che `PI_REASONING_LEVEL=high`; mantenere invariato il prossimo passo già descritto sotto.

## Data

2026-08-05

## Obiettivo

Progetto **eiopago** (nome precedente nel mandato: `pi-usage-guardian`): M0 — fondazione e audit minimo indispensabile. Questa sessione ha completato la verifica ambiente, l'audit documentale di Pi e l'audit ordinario riproducibile dei principali candidati. La fase critica di architettura/sicurezza/accounting non è iniziata perché il contesto ha superato la soglia di stop autorizzata.

## Stato

**Stabile ma M0 non completata. STOP obbligatorio prima della fase critica.**

Non sono iniziate M1 né implementazioni complete di router, TraceDecay/TokenSave, provider, benchmark o dashboard.

## Repository, branch e worktree

- Progetto: `E:/dev/eiopago`
- Remote: `https://github.com/kinderp/eiopago.git`
- Branch: `feat/pi-usage-guardian-foundation`
- Worktree: worktree principale, isolato sul branch sopra
- Commit base: nessuno; repository remoto e locale senza commit
- Modifiche non correlate iniziali: nessuna
- Regole operative canoniche nel repository: `docs/it/00-regole-operative.md` (create dopo l'audit, su richiesta dell'utente)

## Profilo di esecuzione e gate

### Profilo corrente prima del gate

- Provider: `openai-codex`
- Modello: `gpt-5.6-sol`
- Model ID: `gpt-5.6-sol`
- Reasoning effettivo: `medium`
- Profilo operativo: Quality/medium per audit ordinario
- Context window catalogo Pi: 272.000 token
- Fonte accesso: OAuth, coerente con abbonamento OpenAI Codex; nessun segreto letto o registrato
- Prezzo: non esposto dal catalogo CLI per questa fonte; costo per messaggio disponibile nel JSONL Pi

### Statistiche al gate pre-fase critica

Metodo: somma locale degli usage persistiti nel JSONL Pi; contesto stimato dall'ultimo assistant usage come `input + cacheRead + cacheWrite`. Non è stata aperta una seconda istanza RPC.

- Entry JSONL: 86
- Input cumulativo: 224.821
- Output cumulativo: 9.267
- Reasoning cumulativo: 1.886
- Cache read cumulativa: 1.277.952
- Cache write cumulativa: 0
- Costo cumulativo riportato: USD 2,041091
- Contesto stimato: 209.788 / 272.000 = 77,13%
- Esito soglie:
  - cache read: OK (< 3.000.000 warning)
  - costo: WARNING (>= USD 1,50; < USD 3,00 stop)
  - contesto: **STOP** (>= 60%)

### Decisione sul reasoning

L'utente ha autorizzato `high` esclusivamente per architettura, confini di autorità, accounting, precisione monetaria, sicurezza, threat model, budget/stop, reuse/fork/rewrite e benchmark. Il passaggio **non è stato effettuato**, perché il gate di contesto ha imposto lo stop prima della fase critica.

Per la ripresa:

- consigliato: `openai-codex/gpt-5.6-sol`, reasoning `high`, nuova sessione;
- alternativa più economica nello stesso provider: `openai-codex/gpt-5.6-terra`, reasoning `high`, solo se si accetta minore margine sulle decisioni critiche;
- dopo la fase critica: tornare a `medium` per implementazione/test e `low` per fixture, export, documentazione meccanica e checkpoint.

## Profili usati per fase

| Fase | Profilo | Provider/modello | Reasoning | Esito |
| --- | --- | --- | --- | --- |
| Verifica ambiente | Balanced | openai-codex/gpt-5.6-sol | medium | completata |
| Audit documentale Pi | Balanced/Quality | openai-codex/gpt-5.6-sol | medium | completato |
| Audit ordinario componenti terzi | Balanced/Quality | openai-codex/gpt-5.6-sol | medium | completato |
| Gate fase critica | Quality | openai-codex/gpt-5.6-sol | medium | stop per contesto |
| Architettura/sicurezza/accounting | Quality | consigliato Sol | high | non iniziata |

## Ambiente rilevato

- OS: Windows x64, shell MINGW64
- Node.js: 22.19.0
- npm: 10.9.3
- pnpm: non installato
- yarn: non installato
- TypeScript globale: non installato
- Python: 3.10.7
- Rust/Cargo: non installati
- Pi CLI: 0.83.0
- Package installati effettivi:
  - `@earendil-works/pi-coding-agent` 0.83.0
  - `@earendil-works/pi-agent-core` 0.83.0
  - `@earendil-works/pi-ai` 0.83.0
  - `@earendil-works/pi-tui` 0.83.0
- Sessioni Pi: JSONL v3 ad albero con `id`/`parentId`; usage assistant contiene input/output/reasoning/cacheRead/cacheWrite/cost/totalTokens
- Modelli disponibili e autenticati rilevati offline:
  - OpenAI Codex: gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol
  - Moonshot: catalogo Kimi disponibile tramite API key già configurata; nessun segreto mostrato
- GPT-5.6 Sol/Terra/Luna: contesto Pi 272K, output massimo 128K, reasoning e immagini supportati
- Livelli Pi CLI: off, minimal, low, medium, high, xhigh, max; per GPT-5.6 la documentazione conferma xhigh e max quando supportati

## Audit Pi completato

Documentazione installata 0.83.0 letta senza modificarla:

- README.md
- docs/extensions.md
- docs/models.md
- docs/environment-variables.md
- docs/sdk.md
- docs/tui.md
- docs/rpc.md
- docs/session-format.md
- docs/json.md
- esempi pertinenti: session-name, model-status, preset, shutdown-command, custom-footer, status-line, rpc-demo

Capacità confermate:

- eventi session/agent/turn/message/tool/model/thinking/compaction/provider response;
- usage finale assistant e usage opzionale dei tool;
- input/output/reasoning/cache read/cache write/costo nei JSONL reali;
- `ctx.getContextUsage()`, session naming, model registry e modello/reasoning correnti;
- `tool_call` bloccabile; conferme TUI/RPC; shutdown e abort;
- footer/status/widget/overlay/custom command;
- SDK `AgentSession`, JSON mode e RPC;
- RPC `get_session_stats`, `get_state`, `get_entries`, `get_available_models`, livelli thinking e abort;
- model/thinking changes persistiti nel JSONL.

Limite critico da risolvere in M1: la superficie ExtensionAPI documentata non presenta un evento dedicato `before_llm_call` con risultato bloccabile. `before_provider_request` può sostituire il payload ma non documenta un esito `block`. Il Cost Guard MVP deve dimostrare un vero `block-next-LLM-call`, probabilmente tramite controllo in `input`/`before_agent_start`, stato persistito e arresto/checkpoint prima che la richiesta raggiunga il provider; la soluzione definitiva richiede la fase critica e un test harness senza rete.

## Versioni terze auditate

Clone isolati in `%TEMP%/eiopago-m0-audit`; nessun package globale installato, nessuna configurazione personale modificata.

| Progetto | Versione auditata | SHA | Licenza | Nota |
| --- | --- | --- | --- | --- |
| pi-auto-router | repository 0.2.3; npm pubblicato 0.2.2 | `39f48d994d8abdf7ba1018ac1bffe89f44bee849` | MIT | main avanti rispetto a npm |
| TokenSave/TraceDecay core | Cargo 0.0.73, tag v0.0.73 | `e2c7971c64aa8652ae7f35ec8d3f56be38c3acd5` | MIT | progetto rinominato TraceDecay; README/security mostrano nomenclatura/versioni in transizione |
| pi-tokensaver | 0.0.2, tag v0.0.2 | `65764848f5173b5dac1f4d1dbb73c95f75ca9fa3` | MIT | peer namespace Pi precedente |
| pi-tokensave diretto | 0.1.0 | `64f735bc3286e20a4e5eec7c093bafcea7d455b5` | MIT | adapter diretto più recente e read-only |
| pi-token-usage | 0.2.1, tag v0.2.1 | `774e5fd33b49bce82eadd331cb92c95143e72856` | MIT | parser JSONL riutilizzabile/estraibile |
| pi-usage | clone 0.2.1; npm 0.3.0 | `5f0cc99c00a2668d4d903e74641cb76230426162` | MIT | clone shallow non allineato a npm; usa endpoint quota e credenziali OAuth |
| pi-harness-runtime | 0.10.19 | `68557e59670d143f2c4a65bfdd99addbd73ef005` | MIT | alternativa ampia/beta, fuori dal core M0 |
| pi-powerline-footer | 0.12.1, tag v0.12.1 | `75385f6d750331da1b480f7aceb0f3b1d2b272ff` | licenza non rilevata alla root | pattern TUI pertinente, compatibile Pi 0.83 |

## Test terzi eseguiti in isolamento

Comandi eseguiti con `npm install --ignore-scripts --no-audit --no-fund`, HOME/USERPROFILE sintetici e `PI_OFFLINE=1`.

- pi-auto-router: **429 pass, 3 fail**, 432 totali. Fallimenti riproducibili sullo SHA auditato (`buildMonthlyQuotaWindow`, due casi `formatModelLine`); nessuna chiamata provider reale autorizzata.
- pi-token-usage: **23/23 pass**.
- pi-tokensaver: build TypeScript pass; unit test **20/20 pass**. Test MCP reali non eseguiti perché il binario TokenSave non è installato.
- pi-tokensave diretto: **111 pass, 1 skip**, 112 totali; smoke test reale saltato perché il binario TokenSave non è presente.
- pi-usage: test saltati perché Bun non è installato.
- TraceDecay core: build/test non eseguiti perché Rust/Cargo non sono installati; nessun binario scaricato/installato.

Log locali nelle rispettive directory temporanee (`test.log`, `build.log`, `install.log`).

## Risultati audit ordinario e ipotesi

### pi-auto-router

Confermato/parzialmente confermato:

- routing multi-provider, subscription-first, budget giornaliero/mensile, UVI/quota pacing, shadow mode, circuit breaker, cooldown, decision explanation, JSONL append-only, report script, test e MIT;
- stesso-request failover prima di output sostanziale;
- moduli pubblicamente esportati dai file `src`, ma package senza `exports`/API programmatica stabile dichiarata;
- config e file JSON/JSONL sono contratti de facto, non ancora schema stabile formalizzato;
- legge e può aggiornare auth OAuth per quota; rischio elevato per il confine credenziali;
- a budget esaurito può ricadere sulla lista healthy se tutti i candidati sono bloccati: incompatibile con l'hard stop Guardian;
- non modella direttamente i profili Economy/Balanced/Quality/Critical né un mapping semantico completo dei reasoning level.

Decisione **provvisoria**, da ratificare in high: composizione tramite adapter/event log; nessun fork. Guardian deve imporre candidati/tetto/hard stop, auto-router ordinare candidati e gestire failover della stessa richiesta.

### TokenSave/TraceDecay

Confermato/parzialmente confermato:

- Rust, local-first, libSQL locale, MCP stdio, oltre 70 tool, oltre 50 linguaggi, sync incrementale/on-demand, branch/worktree, dashboard/monitor e metriche di saving;
- core non conserva normalmente sorgente grezzo nel grafo, ma read cache e transcript/session store possono contenere testo sorgente o conversazioni;
- rete opzionale per version check, pricing e contatore aggregato; upload counter disabilitabile con `tracedecay disable-upload-counter`;
- metriche di saving sono stime e non prova di costo monetario evitato;
- nomenclatura `tokensave`/`tracedecay` e versioning documentale sono in transizione;
- nessun test reale locale per assenza Rust/binario.

Decisione **provvisoria**, da ratificare in high: componente esterno opzionale dopo il Cost Guard MVP; adapter read-only, upload disabilitato per default, metriche stimate separate da usage/cache/billing.

### pi-tokensaver

Confermato:

- bridge MCP con lifecycle, schema conversion, sync automatico, modifica automatica `.gitignore`, prompt forte, SIGTERM/SIGKILL e test;
- package giovane 0.0.2, peer dependency su namespace precedente `@mariozechner`/`@sinclair`;
- rischio processi/tool/prompt duplicati e side effect automatici.

Decisione **provvisoria**: non adottare; preferire piccolo adapter diretto/read-only o contribuire upstream. Non attivarlo insieme a integrazione diretta.

### pi-token-usage e pi-usage

- `pi-token-usage`: parser locale semplice e testato; input/output/cache/cost, aggregazioni e TUI/footer. Non conserva reasoning, raw+normalized, accounting preciso o dedup robusta per import incrementale. Candidato per estrazione/adattamento del parser, non dipendenza strategica.
- `pi-usage`: quota live multi-provider tramite endpoint non sempre pubblici/stabili e accesso a credenziali. Utile come riferimento per adapter quota futuro, non per M0/M1 e non da invocare senza consenso/rete.
- pi-powerline-footer: pattern TUI utile; nessuna dipendenza necessaria.
- pi-harness-runtime: scope troppo ampio per il Cost Guard; escluso dal core iniziale.

## Priorità economiche autorizzate da incorporare

Ordine vincolante da riportare in documentazione/ADR/roadmap nella prossima sessione:

1. **P0 Cost Guard + Session Handoff Orchestrator**: identità e Master Task Ledger, telemetria/storage, warning/soglie, vero block-next-LLM-call, checkpoint-and-stop, `confirm` handoff in sessione pulita, prompt automatico e human takeover persistente. La roadmap visuale entra solo col minimo locale necessario e non precede questi controlli.
2. **P1 attribuzione consumo**.
3. **P2 riduzione contesto con TraceDecay/TokenSave**, solo dopo misura+stop.
4. **P3 routing economico con pi-auto-router**, Guardian autorità su budget globale/profilo minimo/autorizzazione chiamata/hard stop/telemetria.
5. **P4 riconciliazione provider**.
6. **P5 forecasting/apprendimento dopo dati reali**.
7. **P6 benchmark/condivisione/dashboard senza ritardare la protezione economica**.

Roadmap vincolante (versione più recente; sostituisce l'ordine precedente):

- M0 — Audit minimo, architettura e verifica API session control
- M1 — Cost Guard + confirm handoff + human takeover; roadmap statica solo minima e non bloccante
- M1.1 — supervised-auto + crash recovery
- M1.2 — Guardian Runner per auto, soltanto se necessario
- M2 — Attribuzione, review budget e roadmap visuale completa
- M3 — TokenSave/TraceDecay
- M4 — pi-auto-router
- M5 — Provider e riconciliazione
- M6 — Forecasting
- M7 — Routing adattivo
- M8 — Benchmark
- M9 — Grafici avanzati, inclusa TUI roadmap interattiva
- M10 — Condivisione opt-in
- M11 — Dashboard

M1 deve includere nello stesso vertical slice Persistent Master Task Ledger, telemetria/fasi/storage, warning/soglie, block-next-LLM-call, checkpoint-and-stop, **confirm handoff**, nuova sessione pulita, prompt automatico di ripresa e **human takeover persistente**. La roadmap locale entra soltanto col minimo necessario e non può ritardare questi gate. `supervised-auto` e crash recovery appartengono a M1.1; `auto` usa M1.2/Guardian Runner solo se le API Extension non risultano robuste. Il ledger canonico e il checkpoint-delta devono evitare doppie fonti di verità; handoff preserva lineage/parent e trasferisce solo pacchetto persistente e Resume Context Manifest.

## Decisioni già prese e limiti

- Nome ufficiale progetto: **eiopago**; `Guardian` resta termine di dominio/compatibilità nel mandato, non nome package definitivo.
- Extension-first per M1 `manual`/`confirm` e takeover, subordinato a verifica API. La precedente esclusione RPC dal core è qualificata dal nuovo mandato: AgentSession/RPC è ammesso in M1.2 esclusivamente per un Guardian Runner opzionale se `auto` robusto non è supportato dall'Extension API.
- SQLite previsto come archivio; denaro in integer minor/micro units o decimal text, mai floating point binario nel modello canonico.
- Raw observations separate dai record normalizzati e dalla riconciliazione.
- Local-first, nessun upload implicito, consenso esplicito.
- Composition before fork.
- Queste decisioni architetturali non sono ancora ratificate con reasoning high e ADR.

## File creati

- `CHECKPOINT.md`
- `docs/it/00-regole-operative.md`

Il file canonico delle regole operative è stato creato dopo lo stop originario, su richiesta esplicita dell'utente e senza avviare la fase critica. Nessun commit creato.

## Attività non iniziate

- fase critica high;
- documentazione obbligatoria e ADR;
- scaffold TypeScript;
- schema/migrazione SQLite;
- vertical slice M0 e fixture;
- test eiopago;
- review indipendente;
- M1 e milestone successive.

## Rischi e problemi aperti

1. Contesto sessione corrente al 77,13%: non riutilizzare per la fase critica.
2. Mancanza di hook Pi pubblico esplicitamente bloccabile immediatamente prima della request: progettare e testare il gate M1 senza affermazioni non verificate.
3. pi-auto-router ha 3 test falliti sul main auditato e può ignorare di fatto un budget quando tutti i candidati risultano bloccati.
4. pi-auto-router accede/aggiorna credenziali per quota: Guardian non deve duplicare o ampliare tale autorità.
5. TraceDecay ha rete opzionale e storage locale che può includere source cache/transcript; privacy da configurare esplicitamente.
6. Rebrand TokenSave→TraceDecay e mismatch versioni/adapter possono rompere schemi e nomi tool.
7. pi-tokensaver usa namespace Pi precedenti e side effect automatici.
8. Nessun test reale TraceDecay disponibile nell'ambiente corrente.
9. Repository senza commit base: prima del primo commit concordare se creare un initial foundation commit.
10. Automatic Session Handoff richiede verifica mirata delle semantiche reali di `waitForIdle()`, `ctx.newSession()`, `withSession`, parent linkage, accodamento del comando post-turno e blocco della chiamata successiva; non assumere che gli hook documentati garantiscano atomicità prima del test E2E.
11. Il profilo `medium` corrente impedisce di ratificare state machine, autorità e failure semantics del nuovo requisito; nessuna progettazione è stata avviata in questa sessione.
12. Il pacchetto di handoff deve evitare duplicazione col checkpoint canonico, contenuti estesi, cronologia, reasoning interno e segreti; schema/versionamento e redazione richiedono una decisione esplicita.
13. Quality Gate, Continuity Check, idempotenza e crash recovery sono confini di sicurezza: una discrepanza Git/checkpoint o un passaggio ambiguo deve bloccare modifiche e ripresa.
14. I risparmi di contesto/cache e la conservazione della qualità restano ipotesi da misurare; non dichiararli dimostrati senza A/B o osservazioni sufficienti.
15. Il task corrente non ha ancora un Master Task Ledger: prima della fase architetturale va creato e popolato in modo conciso dal checkpoint, senza duplicarlo; struttura, task ID e schema version richiedono ratifica `high`.
16. Coerenza obbligatoria: nessun requisito nuovo senza task, nessun `DONE` senza evidenza, nessuna attività attiva legata a requisiti superati e nessuna ripresa quando ledger/checkpoint/Git divergono.
17. La visual roadmap deve essere una proiezione deterministica di fonti canoniche, non una nuova fonte di verità; servono regole di ordinamento, aggregazione, deduplica e gestione dati incompleti.
18. Checkpoint previsti/mancanti e diramazioni operative richiedono entità/eventi espliciti: non dedurli ambiguamente dalla sola cronologia delle sessioni.
19. Rendering terminale stretto, fallback ASCII, output JSON stabile e riconciliazione costi richiedono criteri/test mirati; nessuna chiamata LLM/provider è consentita dal comando.
20. I valori assenti devono restare `unknown`: trattarli come zero falserebbe aggregazioni, costi e gate.
21. Renderer e output devono neutralizzare terminal escape e CSV/formula injection; nomi/messaggi non sono input fidati.
22. La relazione Markdown/SQLite resta aperta: nell'MVP, se Markdown è primario, l'import DB deve essere idempotente e i conflitti visibili; nessuna sincronizzazione silenziosa.
23. La TUI interattiva è fuori dal primo vertical slice e non deve ritardare warning, soglie o block-next-LLM-call.
24. Human takeover deve prevalere anche durante race con HANDOFF_COMMIT: il latch persistito non va perso e la nuova sessione deve restare pausata senza prompt.
25. Hotkey/input interception e steering durante esecuzione dipendono dalle API Pi effettive e dal terminale Windows; preservare Escape e non sovrascrivere binding.
26. Extension e possibile Runner devono condividere database, policy e state machine senza duplicare telemetria o piano.
27. `auto` non è supportata per assunzione: se l'Extension richiede hack fragili, progettare Runner AgentSession/RPC e mantenerla disabilitata per default.
28. Modifiche umane al piano invalidano prompt/checkpoint incoerenti, versionano il ledger e richiedono approvazione prima della ripresa.

## Operazioni da non ripetere

- Non rileggere integralmente la documentazione Pi 0.83.0 elencata sopra.
- Non ripetere inventario toolchain/Pi salvo verifica rapida di eventuali cambi.
- Non riclonare i repository se `%TEMP%/eiopago-m0-audit` esiste con gli SHA indicati.
- Non ripetere i test terzi sopra salvo cambio SHA/dipendenze o necessità mirata.
- Non leggere o mostrare credenziali; non modificare `~/.pi`.
- Non installare globalmente Rust, Bun, TraceDecay o package Pi.
- Non iniziare M1, sub-agent o review automatica.

## File da leggere alla ripresa

1. `docs/it/00-regole-operative.md`
2. `CHECKPOINT.md`
3. Il mandato originale presente nella sessione precedente, solo se necessario per verificare un requisito non riassunto qui
4. Sorgenti terzi mirati nella directory temporanea, solo per domande ancora aperte
5. Documenti di progetto man mano che vengono creati; non esistono ancora README/ADR

## Prossimo passo

Aprire una nuova sessione sullo stesso branch con `openai-codex/gpt-5.6-sol` e reasoning `high`. Verificare rapidamente branch/status e nuove statistiche. Eseguire soltanto la fase critica delimitata:

- priorità P0–P6 e roadmap M0–M11;
- architettura e confini Guardian/auto-router;
- accounting, denaro e riconciliazione;
- credenziali/threat model/privacy;
- budget/stop e fattibilità block-next-LLM-call;
- Persistent Master Task Ledger: convenzione, requisiti/versioni, task/DAG, evidenze, eventi, rapporto col checkpoint e controlli di coerenza; creare il ledger canonico iniziale senza duplicare il checkpoint;
- Visual Task Roadmap/Checkpoint History: comando locale, plan/history/combined, viste/filtri, `checkpoint_message`, `ExpectedCheckpoint`, review/finding/fix/test, DAG e lineage, usage/cost, aggregazioni, rendering sicuro e schema JSON versionato;
- Session Handoff Orchestrator P0: `confirm` + human takeover in M1, supervised-auto/crash recovery in M1.1 e Runner/auto solo se necessario in M1.2;
- comandi di controllo, persistent human-control latch, hotkey/steering deterministici, HANDOFF_ARMED/COMMIT interrompibile, precedenze e tre scenari E2E prioritari;
- verifica mirata Extension API vs AgentSession/RPC e classificazione `confermato`/`da testare`/`non supportato`/`Runner`;
- matrice reuse/composition/fork/rewrite;
- visione, requisiti, casi d'uso, architettura, modello dati, budget/stop, routing, roadmap, sicurezza, benchmark, domande aperte, documento dedicato e ADR non duplicati;
- ADR critici.

Al termine registrare le decisioni e valutare uno stop oppure una nuova sessione `medium` per scaffold/vertical slice/test.

## Comandi di ripresa

```bash
cd E:/dev/eiopago
git status --short --branch
printf '%s/%s reasoning=%s\n' "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"
```

Se i clone temporanei sono ancora presenti:

```bash
for d in "${TEMP:-/tmp}/eiopago-m0-audit"/*; do
  [ -d "$d/.git" ] && printf '%s %s\n' "$(basename "$d")" "$(git -C "$d" rev-parse HEAD)"
done
```

## Ripresa in una nuova sessione

Regola operativa: ogni checkpoint di chiusura deve riportare sia il prompt minimo di ripresa sia un nome breve e descrittivo suggerito per la nuova sessione.

**Nome sessione suggerito:** `eiopago-m0-handoff-takeover-api-high`

### Prompt minimo per la nuova sessione high

> Leggi `docs/it/00-regole-operative.md` e `CHECKPOINT.md`; non ripetere audit/test né ricreare documenti. Verifica Git e profilo esatto `openai-codex/gpt-5.6-sol`, reasoning `high`, altrimenti aggiorna checkpoint e fermati. Completa solo M0: crea il Master Task Ledger; verifica API Pi mirate per confirm handoff, new session/parent/prompt, block-next-call, abort, takeover/hotkey/steering e persistence; decidi Extension vs Runner. Ratifica state machine, latch, comandi, precedenze, tre E2E e roadmap M1/M1.1/M1.2; aggiorna requisiti, architettura, modello dati, casi d'uso, test e ADR senza duplicazioni. Non iniziare M1 né modificare `~/.pi`. Chiudi aggiornando ledger/checkpoint e prossimo gate.
