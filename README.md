# Aiopago

Aiopago is a local continuity runner for Pi coding sessions. It keeps the Master Task Ledger, runtime safety state and handoff artifacts in the selected Git worktree without copying conversation history.

## Install and use

Requires Node.js 22.19 or newer and `@earendil-works/pi-coding-agent` 0.83.x.

```bash
npm install --global https://github.com/kinderp/aiopago.git
aio init /path/to/repository
aio status --target /path/to/repository
aio plan --target /path/to/repository
```

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

See [`docs/0.2-c-intent-adapter.md`](docs/0.2-c-intent-adapter.md) for the structured request/response contract, authority rules, errors, and security boundaries. See [`docs/portable-alpha.md`](docs/portable-alpha.md) for setup, read-only workflow commands, Runner operation and recovery. See [`docs/rename-aiopago-migration.md`](docs/rename-aiopago-migration.md) for legacy data and command compatibility.

Repository: <https://github.com/kinderp/aiopago>
