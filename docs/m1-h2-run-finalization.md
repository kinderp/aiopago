> **Historical pre-rename record.** Names, identifiers, commands, repository/worktree paths and measured protocol references below are retained as immutable provenance. The current product is Aiopago; use `docs/portable-alpha.md` for canonical `aio` usage and `docs/rename-aiopago-migration.md` for compatibility.

# M1-H2 run finalization

This infrastructure does not start a pilot, change the threshold/workload, or read Pi conversation history.

## Authoritative inputs

`npm run calibration:finalize -- --run <run-id>` reads only:

- `<run>/preflight-attestation.json` and the byte-frozen `<run>/pilot-protocol.json`;
- the run-specific SQLite identity, metric sessions/samples, handoff events, and bounded diagnostics, opened read-only;
- the workload `TASK_PLAN.md` Ledger;
- `<run>/quality-evidence.json`, validated as `eiopago.calibration-quality-evidence/1.0.0`;
- declared bounded review artifacts only to verify their SHA-256 (their human text is not parsed).

It writes only `<run>/run-record.json`. The output is canonical JSON without a finalizer timestamp; repeated finalization over identical logical inputs is byte-idempotent. `finalizer_inputs` records canonical source digests.

## Quality evidence

Preflight creates an empty bounded quality-evidence skeleton. A structured completed document can be validated and recorded with:

```text
npm run calibration:quality -- --run <run-id> --input <machine-readable-json>
```

The schema allowlists the four frozen commands by exact string and records suite attempt/ordinal, start/end, exit code, and bounded output digest. It also records accepted WCP IDs, completion marker, no-history/control attestations, structured review findings, regressions, rework cycles, and the explicit final acceptance decision. The finalizer derives gate PASS only from the chronologically ordered, complete latest suite whose four exit codes are zero and whose final decision follows that suite; it never parses command output or invents PASS.

## Classification

- `VALID`: a `MetricSample.context.occupancy_percent` actually crosses the attested threshold, the session/time-correlated SUGGESTED/PREPARED/STARTED/COMPLETED lifecycle is complete for the handoff, every call has essential usage and context telemetry, and quality is PASS.
- `CENSORED_EARLY_COMPLETION`: the authoritative Ledger task is complete, quality is PASS, and complete context samples prove no crossing.
- `INVALID_TELEMETRY`: essential samples are absent/incoherent or a blocking measurement diagnostic exists.
- Other invalid details cover controlled-variable, lifecycle, and unresolved quality failures.

The nominal threshold or a lifecycle event's threshold metadata is never substituted for a measured crossing. Charged provider cost remains explicit `unknown` when unavailable and is never replaced by Pi equivalent cost.

## Ledger correlation degradation

A model call with authoritative session ID and essential assistant input/output usage is persisted even while `TASK_PLAN.md` is temporarily absent or invalid. Its task/item/checkpoint/handoff correlation is `null`, its collection status is `measurement_complete_correlation_partial`, and a bounded `correlation_degraded` diagnostic has the same status. This differs from `measurement_missing`: an absent session ID or essential usage produces no sample. Context may remain `unknown` without discarding valid usage. No speculative backfill is performed, and subsequent samples recover normal correlation after the Ledger becomes valid.
