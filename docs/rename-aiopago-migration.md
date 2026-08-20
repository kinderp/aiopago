# Dedicated rename migration — Eiopago to Aiopago

## Scope and baseline

This document records the inventory taken **before any existing tracked file was changed** on branch `chore/rename-aiopago`, worktree `F:/dev/aiopago-rename`, baseline `ab5100207f7714852b121352d8f389dfe92133a4`. The migration changes naming and compatibility surfaces only; 0.2-B is out of scope.

Canonical naming after this migration is **Aiopago**, slug/package/repository **aiopago**, and CLI/TUI command **aio**. The legacy `eio` CLI/TUI command remains a deprecated compatibility alias.

## Initial inventory method

The inventory used `git ls-files`, a case-insensitive tracked-content scan for `Eiopago`, `eiopago`, `EIOPAGO`, `EioPago`, semantic token scans for `eio`/`EIO`, and a filename/directory scan excluding Git internals and generated dependencies. There were 55 tracked files, one matching filename (`PIANO_MAESTRO_FARO_DUREX_EIOPAGO.md`), and no matching directory. `npm view eiopago` returned registry `E404`, so there is no published npm package requiring a compatibility package.

Initial persistent-path scan found no `~/.eiopago`, `.eiopago`, `eiopago.json`, `eiopago.db`, `eiopago.sqlite`, `eiopago.yaml`, `eiopago.yml`, or `eiopago.toml`. Runtime state is already under brand-neutral `.guardian/`; no filesystem-state move is needed.

## Occurrence classification and decision table

The table is exhaustive by tracked path and occurrence family; repeated occurrences with the same semantics are grouped by file. Categories are those required by the migration mandate.

| Occurrence / path | Category | Rename? | Compatibility | Reason |
|---|---:|:---:|---|---|
| `.gitignore` branding comment | A/E | yes | none | Current managed-state branding becomes Aiopago; path remains `.guardian`. |
| `CHECKPOINT.md` existing sections, old worktrees/remotes/session names, old commands and schema names | G/N | no, below new checkpoint | exact historical record | Existing checkpoint sections are immutable provenance. A new Aiopago completion section is prepended. |
| `PIANO_MAESTRO_FARO_DUREX_EIOPAGO.md` filename and current architecture prose | A/J/L/H | yes | migration history lives here and in checkpoint | This is current cross-project documentation, not a sealed record. Rename file and current naming/URLs/commands. |
| `TASK_PLAN.md`, including `TASK-EIOPAGO-*`, old schema heading and completed P0 evidence | F/G/N | no | legacy Ledger reader | The closed Ledger is historical provenance. New templates use Aiopago; the reader continues to accept pre-rename Ledgers. |
| `bin/eio.mjs` | C/L | keep as wrapper | deprecated alias, warning on stderr only | Legacy executable delegates to the canonical implementation and preserves stdout/exit behavior. |
| new `bin/aio.mjs` | C/L | add | canonical | Single canonical entrypoint. |
| `package.json` name/bin/scripts/metadata | I/H/M | yes | retain `bin.eio` and legacy npm script only | Package was not published; rename directly to `aiopago`, add canonical metadata and repository URL. |
| `docs/adr/0015-*`, `docs/contracts/m0-contracts.md`, `docs/audit/*`, `docs/it/00-regole-operative.md`, `docs/roadmap.md` | A/B/F/H/J | yes except explicit legacy notes | persisted identifiers documented separately | These are current architecture/governance documents and must present Aiopago as current product. |
| `docs/m1-h0-handoff-mvp.md`, `docs/m1-h1-context-handoff-advisor.md`, `docs/portable-alpha.md` | A/C/F/J | yes | document deprecated `/eio`/`eio` and legacy schemas | Current usage must lead with `aio`; old commands and formats remain documented only as compatibility. |
| `docs/m1-h2-threshold-calibration.md`, `docs/m1-h2-run-finalization.md`, `docs/m1-h2-workload-feasibility.md` | D/F/G/J/N | mixed | legacy schema names and old run paths explicitly historical | Branding and future examples become Aiopago/aio; frozen experiment identifiers and paths remain provenance where required. |
| `docs/m1-h2-calibration-pilot.json` | F/G/K/N | no | frozen protocol accepted by readers | Byte/digest-bound historical protocol; rewriting would invalidate recorded evidence. |
| `src/cli.mjs`, `src/human-workflow.mjs`, `src/extension.mjs`, `src/runner.mjs`, `src/pi-loader.mjs`, `src/metrics.mjs` | A/B/C/J | yes | `eio` and `/eio` delegate/alias only | All current UI, help, diagnostics, actor names and extension identity become canonical Aiopago/aio. |
| `src/bootstrap.mjs` branding, generated Ledger header, managed `.gitignore` markers and error codes | A/E/F | yes | recognize legacy managed block and Ledger | New repositories get Aiopago artifacts; existing old managed blocks and Ledgers remain accepted without destructive rewrite. |
| `src/repository.mjs`: `eiopago.repository/1.0.0` | E/F | canonical writer yes | reader accepts exact legacy schema | Existing `.guardian/config.json` remains readable; new configs use `aiopago.repository/1.0.0`. No path migration. |
| `src/runner-ownership.mjs`: `eiopago.runner-session-binding.v1` | F | canonical writer yes | reader accepts exact legacy custom type | Existing session records remain attestable; new entries use `aiopago.runner-session-binding.v1`. |
| `src/handoff.mjs`: `EIOPAGO_RESUME_V1`, `eiopago-runner`, `/eio` actors/instructions | F/C | yes | old persisted records remain historical; command alias retained | New prompts/producers/actors are Aiopago; no old record is rewritten. |
| `src/calibration-preflight.mjs`, `src/calibration-finalizer.mjs`, `src/calibration-quality.mjs` schema identifiers | F | canonical writer yes | readers accept exact legacy schema set | New calibration records use `aiopago.*`; frozen pre-rename records/protocols remain readable. |
| `src/context-advisor.mjs`, `src/runner.mjs`, calibration launcher: `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT` | D | canonical variable yes | exact legacy fallback; conflicting dual values fail | New variable is `AIOPAGO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`; old short variable remains deprecated compatibility. No `EIOPAGO_*` variable existed. |
| all `test/*.test.mjs` branding/temp names/current commands | K | yes | targeted legacy-format, env and CLI equivalence tests remain | Tests move to canonical naming except fixtures/assertions proving backward compatibility. |
| temp prefixes such as `eiopago-core-` and `EIO_BASH_OK` | K/M | yes | none | Generated test artifacts are not persistent contracts. |
| historical repository/worktree paths in closed checkpoint, closed Ledger and frozen calibration protocol | G/H/N | no | historical allowlist | They identify actual prior runs and must not be falsified. |
| `TASK-EIOPAGO-*` and `PLAN-EIOPAGO-*` where already present | G/N | no | historical ID allowlist | Existing IDs remain immutable; new generated records use `AIOPAGO` where the format includes a product token. |
| repository URL `https://github.com/kinderp/eiopago` outside immutable history | H | yes | no redirect reliance | Current metadata/docs point directly to `https://github.com/kinderp/aiopago`. |
| package/module directory or import namespace named `eiopago` | B/L | none exists | none | No such module tree exists; do not invent one or duplicate implementation. |
| `EIOPAGO_*` environment variables | D | none exists | none | Do not invent a migration layer. `EIOPAGO_RESUME_V1` is a protocol marker, not an environment variable. |
| `.guardian/` runtime/config/artifact paths and `guardian.sqlite` | E | no | naturally continuous | Paths are brand-neutral and stay in place; no byte move or merge is required. |

## Persisted identifier policy

| Identifier family | New writer | Legacy reader / historical treatment |
|---|---|---|
| Repository config | `aiopago.repository/1.0.0` | Accept `eiopago.repository/1.0.0` in place; never silently rewrite during read-only commands. |
| Ledger heading | `aiopago.task-ledger/0.1.0` | Parser remains compatible with pre-rename heading and JSON schema `0.1.0`. |
| Runner session binding | `aiopago.runner-session-binding.v1` | Accept exactly `eiopago.runner-session-binding.v1`. |
| Calibration attestation/run/quality/finalizer | corresponding `aiopago.*` values | Accept the exact pre-rename `eiopago.*` values required by frozen records. |
| Frozen calibration protocol | no rewrite | Accept `eiopago.threshold-calibration-protocol/1.0.0`; tracked protocol remains byte-identical. |
| Resume marker | `AIOPAGO_RESUME_V1` | Existing `EIOPAGO_RESUME_V1` entries are immutable history; no retroactive rewrite. |
| Existing task/plan IDs | new records use `AIOPAGO` when branded | Existing `TASK-EIOPAGO-*` / `PLAN-EIOPAGO-*` remain unchanged. |

## Compatibility and state decisions

- CLI: `aio` is canonical. `eio` is a thin deprecated wrapper; warning is stderr-only and exit codes/stdout are delegated unchanged.
- TUI: `/aio` is canonical; `/eio` and `/eiopago` remain deprecated aliases to the same handler. No duplicate command implementation.
- Environment: no `EIOPAGO_*` variables existed. Existing `EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT` gets the canonical replacement `AIOPAGO_CONTEXT_HANDOFF_THRESHOLD_PERCENT`; equal dual values are accepted, incompatible dual values fail explicitly, and legacy-only use warns.
- Persistent paths: none carry the old brand. `.guardian/` and its bytes stay in place. Existing config/schema and managed-ignore compatibility is handled in readers/initialization rather than by a destructive filesystem migration.
- npm: the registry returned `E404` for `eiopago`; no compatibility package or publication is part of this migration.
- Historical records: closed checkpoint sections, the closed `TASK_PLAN.md`, the frozen calibration protocol, old run worktree paths and existing branded IDs are not rewritten.

## Automatic guard

`scripts/check-brand-migration.mjs` scans tracked and not-yet-committed working-tree files only, excluding Git internals, dependencies and generated artifacts. It rejects legacy full-brand occurrences unless they match a precise path/count/rationale allowlist. Short `eio` is checked separately and semantically: only compatibility entrypoints/aliases/tests, immutable history and migration documentation are allowed. Any count change requires an explicit allowlist review. The guard runs inside `npm run check`.

## Pre-remote-rename validation and review

- `npm test`: PASS, 156/156 tests.
- `npm run check`: PASS, brand guard plus syntax check for 39 modules.
- `npm pack --dry-run`: PASS, package `aiopago@0.1.0`, 30 intended files.
- `git diff --check`: PASS after removing changed-line trailing whitespace.
- Canonical/deprecated CLI equivalence: help, version, status and raw plan stdout/exit status match; the deprecation notice is stderr-only.
- Frozen `TASK_PLAN.md` and `docs/m1-h2-calibration-pilot.json`: byte diff from `origin/main` is zero.
- Review of `origin/main...chore/rename-aiopago`: no known HIGH or MEDIUM finding, no stale current repository URL, no package/module duplication and no 0.2-B implementation.
