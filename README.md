# Aiopago

Aiopago is a local continuity runner for Pi coding sessions. It keeps the Master Task Ledger, runtime safety state and handoff artifacts in the selected Git worktree without copying conversation history.

## Install and use

Requires Node.js 22.19 or newer and `@earendil-works/pi-coding-agent` 0.83.x.

```bash
npm install --global https://github.com/kinderp/aiopago.git
aio init /path/to/repository
aio status --target /path/to/repository
aio plan --target /path/to/repository
aio start "Realizza un server P2P in Python con discovery dei peer e test" --target /path/to/repository
```

`aio start <objective>` observes the initialized `TASK_PLAN.md`, asks the configured Pi model for one full structured candidate Ledger, validates it through the accepted `plan.*` adapter, and shows the canonical diff. Mutation requires an interactive terminal: first enter an exact LF/CRLF-terminated `y`/`yes` record (case-insensitive, no surrounding whitespace), then enter the exact fresh challenge generated and displayed only after that first record. Piped, redirected, file, CI, and other non-TTY stdin always deny; a queued multiline paste is consumed as the challenge response and cannot approve. Tests/programmatic callers may inject the explicit authorization boundary, but the CLI has no `--yes`. After an authorized plan apply, the command stops: it does not begin coding or execute plan items.

The production planner uses existing Pi 0.83.x model/auth/settings discovery, one in-memory no-tools call, strict JSON output, and at most one provider/model call. Retry and compaction are disabled on the effective post-reload session settings without rewriting Pi settings. See [`docs/0.2-d-start-objective.md`](docs/0.2-d-start-objective.md) for initialization behavior, observed-base/stale guarantees, authorization, provider failures, owner-gate protection, trust boundaries, and exclusions.

Inside the Runner, `/aio` defaults to the same shared human status projection used by the CLI. `/aio status`, `/aio why`, `/aio next` and `/aio plan` are deterministic and read-only; `/aio status technical` and `/aio plan technical` disclose secondary diagnostics, including bounded exact nested runtime failure identity. Verified live evidence must pass a complete coherence check before it can project a positive state, and selected projection data is detached before deep-freezing. Context-threshold consent carries one ephemeral plan/session/latch/handoff/Runner identity through the Runner to the trusted mutation boundary. Before `/aio handoff confirm` can mutate an owner gate, every optional asynchronous hook is finished and the exact current Runner/source object, session ID, ACTIVE lifecycle epoch and Runner identity are freshly re-attested synchronously. No await exists between that final source capture and the owner mutation. Exact-plan writer coordination then synchronously checks the exact latch (including no `HUMAN_TAKEOVER`), latest handoff and durable task-operation ownership using the same centralized disposition as final reservation; an unresolved or stale authority rejects with zero plan/history mutation. `HUMAN_TAKEOVER`, handoff SafePoint latch acquisition and lifecycle reservation use the same package-private PlanRevisionWriter → SQLite lock order. Takeover is current-Runner task authority rather than consent to a previously observed plan revision: one command owns a strict monotonic 10-second **canonical coordination-acquisition** deadline, budgets every process probe and backoff against that same deadline, re-observes the validated current plan only after coordination, and survives ordinary owner-first/P2 contention without a second prompt. The 10-second contract ends when the canonical takeover latch authority is acquired; the subsequent SafePoint drain may finish afterward. Takeover-first blocks P1→P1′; owner-first may complete P1→P1′, after which that same takeover command canonicalizes on the current plan. Owner-gate mutation is CAS-bound to that exact plan; Runner lifecycle epoch/ACTIVE attestation, takeover-aware SafePoint checks and exact-identity SQLite reservation reject stale or unrelated operations before durable mutation. A recovery SafePoint is only an asynchronous drain, not final authorization. After it completes, explicit continuity recovery builds one detached final attestation over the ACTIVE Runner lifecycle/epoch, fresh zero-history idle source, exact failed plan identity and position, actual model/reasoning, Git state, freshly verified checkpoint/manifest, latch, failed handoff and ACTIVE binding. Recovery also requires semantic coherence: one canonical normalized P1 projection must agree with the coordinated Ledger, failed top-level provenance and reserved snapshot, checkpoint fields, manifest fields, Git/session/parent lineage and model/reasoning wherever those representations duplicate behavior-critical meaning. A valid sealed envelope or digest is evidence integrity, not recovery authority by itself. Under package-private plan coordination, synchronous SQLite preparation and recovery-child reservation then commit as one arbitration bound to R*; SQLite revalidates the failed reserved-snapshot semantic digest before mutation, and the child cannot reread and adopt later plan, Git or model state. Mismatches fail closed without restoring external state. Checkpoint, manifest and prompt provenance derive only from immutable reserved snapshots. No consent is persisted and no lock is held across the prompt or SafePoint drain. The specialized `HANDOFF_CONFIRM` transition is not a public `TaskLedger` mutation. The installed npm artifact contains only bundled `dist` entry points: authority internals remain lexical, `src` and source-test instrumentation are absent, and neither lifecycle writers nor a raw SQLite handle can be obtained by package-relative or absolute-file imports. Production `GuardianRunner.create()` owns loading of the trusted installed Pi dependency that receives the privileged extension factory; ordinary callers cannot supply `options.pi` or inject session/settings/model runtime and internal authority objects, while source tests use support physically removed from the package. Privileged loading checks only Aiopago's deterministic physical npm dependency slots, rejects symlink/junction redirection for Pi and pi-ai, and never searches `NODE_PATH`, the target cwd or `PI_CODING_AGENT_ROOT`. This trusts those physical installed dependency bytes and does not claim protection against malicious replacement of them. On Windows, only fresh `ESRCH` from Aiopago's captured genuine Node native kill binding can authorize stale-lock cleanup: the mutable `process.kill` wrapper, PowerShell DEAD output and start-identity mismatch are not authority, so same-process wrapper forgery, PATH/PATHEXT/cwd shadows and ambiguous PID reuse preserve the lock. A public `GuardianRunner` exposes detached read-only Ledger/runtime/storage projections; real storage, ToolOperationTracker, SafePoint, handoff services and Pi callbacks remain in a lexical WeakMap capability graph, so public object reachability cannot append journal events or manufacture operation outcomes. Intended read/validation and plan-adapter APIs remain public. Final reservation remains a separate second arbitration after SafePoint. Replacement sessions remain paused until a separate explicit resume confirmation. That YES applies only to the invocation-local handoff/plan semantics/Git/target/Runner binding/artifact/prompt/model/reasoning/history/path/latch identity shown before the prompt. The trusted resume path re-attests those facts synchronously under bounded package-private plan coordination and commits exact durable binding/latch/handoff preconditions in SQLite before dispatch; the approval is neither persisted nor reusable. An unresolved or ambiguous handoff lifecycle owns its task operation across processes and restart, so another source cannot create a second manual or guided target. Explicit continuity recovery atomically transfers that ownership to one child generation; crash-stalled intents and artifact failures require bounded manual reconciliation with no automatic retry or resume. See [`docs/0.2-e-unified-human-ux.md`](docs/0.2-e-unified-human-ux.md).

Run `aio --help` for the canonical CLI. The old `eio` executable remains temporarily available as a deprecated compatibility alias and prints its warning only to stderr.

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
