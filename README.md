# Aiopago

Aiopago is a local continuity runner for Pi coding sessions. It keeps the Master Task Ledger, runtime safety state and handoff artifacts in the selected Git worktree without copying conversation history.

## Install and use

Requires Node.js 22.19 or newer. Aiopago owns `@earendil-works/pi-coding-agent` as an exact production dependency at `0.83.0`; consumers do not supply it as a peer.

```bash
npm install --global https://github.com/kinderp/aiopago.git
aio init /path/to/repository
aio status --target /path/to/repository
aio plan --target /path/to/repository
aio start "Realizza un server P2P in Python con discovery dei peer e test" --target /path/to/repository
```

`aio start <objective>` observes the initialized `TASK_PLAN.md`, asks the configured Pi model for one full structured candidate Ledger, validates it through the accepted `plan.*` adapter, and shows the canonical diff. Mutation requires an interactive terminal: first enter an exact LF/CRLF-terminated `y`/`yes` record (case-insensitive, no surrounding whitespace), then enter the exact fresh challenge generated and displayed only after that first record. Piped, redirected, file, CI, and other non-TTY stdin always deny; a queued multiline paste is consumed as the challenge response and cannot approve. Tests/programmatic callers may inject the explicit authorization boundary, but the CLI has no `--yes`. After an authorized plan apply, the command stops: it does not begin coding or execute plan items.

The production planner uses Aiopago's exact Pi 0.83.0 dependency and its model/auth/settings discovery, one in-memory no-tools call, strict JSON output, and at most one provider/model call. Retry and compaction are disabled on the effective post-reload session settings without rewriting Pi settings. See [`docs/0.2-d-start-objective.md`](docs/0.2-d-start-objective.md) for initialization behavior, observed-base/stale guarantees, authorization, provider failures, owner-gate protection, trust boundaries, and exclusions.

## Unified human workflow

Inside the Runner, `/aio` defaults to the same shared human status projection used by the CLI. `/aio status`, `/aio why`, `/aio next` and `/aio plan` are deterministic and read-only; `/aio status technical` and `/aio plan technical` add bounded technical diagnostics.

Guided handoff remains explicitly human-controlled. Context threshold crossing is advisory only. A preparation YES is bound to the observed task/plan/session/Runner/latch/handoff identity and is re-attested before mutation. The handoff path still requires SafePoint, exact plan/latch/task-operation arbitration, a paused replacement session, continuity checks and a separate resume confirmation. The replacement starts with zero copied conversation history. Takeover has priority and uses bounded coordination; ambiguous dispatch or recovery evidence fails closed and is never silently replayed.

Plan, latch, handoff, lifecycle, resume and recovery transitions are application-level authority owned by their documented Aiopago transition services. Stale revisions, changed identities, competing task ownership and inconsistent artifacts are rejected rather than merged or repaired silently. See [`docs/0.2-e-unified-human-ux.md`](docs/0.2-e-unified-human-ux.md) for the complete 0.2-E contract.

Run `aio --help` for the canonical CLI. The old `eio` executable remains temporarily available as a deprecated compatibility alias and prints its warning only to stderr.

## Runtime authority profiles

Aiopago distinguishes two security goals. ADR-0024 is currently the proposed decision record for this boundary.

### PORTABLE — current 0.2-E product profile

The normal npm-first `aio` runtime uses the authority model frozen by ADR-0015: one application-level source of truth per data category, deterministic transition-service ownership, exact revision/digest checks, idempotency and fail-closed conflict handling.

PORTABLE does **not** claim that arbitrary malicious code already executing as the same OS user is unable to open or replace project-owned `.guardian` SQLite/files or reconstruct private package implementation. That attacker is host/account/process compromise relative to the PORTABLE profile.

Package and process hardening still matters: the public package API does not expose Guardian Runner, raw runtime storage, SafePoint, handoff or lifecycle writer capabilities; trusted Pi resolution ignores ambient `NODE_PATH`, target `node_modules` and `PI_CODING_AGENT_ROOT`; supported coordination and recovery paths remain bounded and fail closed. These are supported-interface and application-integrity boundaries, not a cryptographic sandbox against arbitrary same-user code.

### SECURE — stronger OS-isolated profile, not productized

R1-M-13 additionally investigated resistance to a hostile same-user medium-integrity process. A Windows physical oracle proved that a distinct LocalService + unique service SID with protected `%ProgramData%` state can enforce canonical operation/latch/handoff/lifecycle/resume/recovery state against that attacker.

That oracle is **not the normal `aio` runtime today**. The checked-in protected service remains test-scenario driven, and the ordinary Runner does not activate the protected authority. Production SECURE activation is tracked in issue #46.

Therefore normal `aio` must not be described as OS-isolated merely because protected authority code/oracles exist in the repository. If a future SECURE profile is selected, failure to establish its protected authority must fail closed; it must never silently fall back to PORTABLE while presenting secure claims.

See [`docs/adr/0024-runtime-authority-deployment-profiles.md`](docs/adr/0024-runtime-authority-deployment-profiles.md) and [`docs/0.2-e-r1-m-13-whole-candidate-closure.md`](docs/0.2-e-r1-m-13-whole-candidate-closure.md).

## Public package trust model

`import "aiopago"` is same-process embeddable and exposes only provider-neutral plan access plus read/data/validation/error helpers. `plan.apply()` never automatically removes an existing coordination lock. If a lock owner is dead, unknown, malformed, PID-reused, unavailable, or crash-stale—or if a historical `.recovery` marker exists—the operation preserves the exact state and throws `PLAN_LOCK_RECONCILIATION_REQUIRED` (or a stricter path-integrity error). A human must inspect the exact lock and marker, ensure no Aiopago owner is still operating, and explicitly remove or reconcile stale state. There is no force flag.

The expected root namespace is explicitly classified as:

- **PLAN PORT:** `createPlanAdapter`, `plan`;
- **READ/DATA/VALIDATION/ERROR:** `TaskLedger`, canonical/validation/error helpers, context projection helpers, Git/repository/runtime readers, metrics data helpers and Runner-binding validators documented by the exported namespace;
- **PRIVILEGED RUNTIME:** none.

Expected root exports (alphabetical):

```text
CONTEXT_HANDOFF_THRESHOLD_ENV, ContextHandoffAdvisor,
DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT, DEFAULT_METRICS_RETENTION,
DEFAULT_REPOSITORY_CONFIG, GuardianError, INSTALLATION_ROOT,
LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV, LEGACY_REPOSITORY_CONFIG_SCHEMA,
LEGACY_RUNNER_BINDING_CUSTOM_TYPE, METRICS_SCHEMA_VERSION,
REPOSITORY_CONFIG_FILE, REPOSITORY_CONFIG_SCHEMA, RUNNER_BINDING_CUSTOM_TYPE,
TaskLedger, assertTelemetrySafe, canonicalJson, canonicalRequiredLocalPaths,
contextHandoffThreshold, contextHandoffThresholdEnvironment, createPlanAdapter,
digestObject, discoverTargetRepository, fail, formatHumanNext, formatHumanStatus,
formatHumanTechnical, formatHumanWhy, formatPlan, formatPlanTechnical,
guidedHandoffEligibilityIdentity, invariant, jsonClone, loadRepositoryContext,
measureHandoffArtifacts, observeGitState, observeHumanWorkflow,
observeRawTaskPlan, observeRunnerHumanWorkflow, observeTaskPlan, opaqueId, plan,
projectHumanWorkflow, readRepositoryConfig, readRuntimeProjection,
readRuntimeRunnerBinding, sameGitState, sameGuidedHandoffEligibility, sha256,
stableId, strictJsonClone, utcNow, validateRepositoryConfig,
validateRepositoryStateBoundaries, validateRequiredLocalPaths,
validateRuntimeObservation, validateTaskLedger, verifyRunnerOwnership
```

In particular the root does not export `GuardianRunner`, `loadPi`, `resolvePiRoot`, `runCli`, `createGuardianExtension`, `ToolOperationTracker`, `GuardianStorage`, `SafePointCoordinator`, `HandoffService` or their construction/writer capabilities.

## Portable privileged runtime boundary

The supported PORTABLE interactive runtime is the `aio` executable. Its thin bootstrap launches a fresh `process.execPath` child and removes `NODE_OPTIONS`, `NODE_PATH` and `PI_CODING_AGENT_ROOT` from that child environment. The child reads the exact physical dormant `dist/cli-entry.mjs`, supplies its physical URL for trusted dependency resolution, and invokes its lexical operational function only inside that fresh process. Guardian Runner and Pi capabilities are kept out of the public package namespace.

This design prevents supported package imports and ordinary ambient resolver configuration from acquiring the Runner graph. It does **not** authenticate the child against arbitrary same-user source reconstruction or direct filesystem/SQLite tampering; those stronger requirements belong to SECURE/#46.

Physical `lstat`/`realpath` redirect checks validate trusted-process installation layout as defense in depth. Replacing Aiopago's installed `dist` bytes or its accepted Pi dependency tree is installation compromise for PORTABLE. Ambient `NODE_PATH`, target/cwd `node_modules`, `PI_CODING_AGENT_ROOT`, and independent sibling searches are never trusted Pi selection mechanisms.

## Structured plan adapter

The package root exposes the provider-neutral 0.2-C adapter without exposing raw plan writers:

```js
import { createPlanAdapter } from "aiopago";

const plan = createPlanAdapter("./TASK_PLAN.md");
const observation = plan.observe();
const candidate = structuredClone(observation.plan);
candidate.plan_revision_id = "PLAN-reviewed-2";
candidate.updated_at = "2026-08-21T12:00:00.000Z";
candidate.next_step = "Implement the next reviewed item.";

const proposal = plan.propose({
  schema: "aiopago.plan-intent/0.1.0",
  proposal_id: "PPR-reviewed-2",
  producer: "example-structured-producer/1",
  change_reason: "Use the reviewed structured candidate.",
  base: {
    task_id: observation.task_id,
    plan_revision_id: observation.plan_revision_id,
    content_digest: observation.content_digest,
  },
  candidate_plan: candidate,
});
// If TASK_PLAN.md changed after observe(), propose() throws
// PLAN_PROPOSAL_STALE. base is a precondition, not authority.
plan.validate(proposal);
plan.diff(proposal);
// A human or upper layer may then choose plan.apply(proposal).
```

See [`docs/0.2-c-intent-adapter.md`](docs/0.2-c-intent-adapter.md) for the accepted structured request/response contract, authority rules, errors, and security boundaries. See [`docs/0.2-d-start-objective.md`](docs/0.2-d-start-objective.md) for objective planning and authorization. See [`docs/portable-alpha.md`](docs/portable-alpha.md) for setup, read-only workflow commands, Runner operation and recovery. See [`docs/rename-aiopago-migration.md`](docs/rename-aiopago-migration.md) for legacy data and command compatibility.

Repository: <https://github.com/kinderp/aiopago>