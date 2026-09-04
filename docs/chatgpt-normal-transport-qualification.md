# ChatGPT Normal transport qualification harness

Status: **development gate for ADR-0016A; not a transport implementation**.

This harness turns ADR-0016A Q1–Q7 into a versioned evidence check. It exists so Aiopago can attach a real `ChatGPT Normal` adapter quickly if OpenAI later exposes a qualifying external-client transport, without weakening the provider-neutral architecture in the meantime.

## What it does

`scripts/chatgpt-transport-qualification.mjs` validates one evidence manifest and returns exactly one of:

- `QUALIFIED` — all Q1–Q7 are PASS and no prohibited mechanism is present;
- `BLOCKED` — no gate has failed, but at least one gate still lacks a qualifying transport/evidence;
- `FAILED` — a gate explicitly fails or the evidence is internally inconsistent.

The current baseline is:

`docs/evidence/chatgpt-normal-transport-baseline-2026-09-04.json`

It is expected to evaluate to **BLOCKED**. CI treating that baseline as `QUALIFIED` would be a bug.

## Q1–Q7

1. **Q1 Documented transport** — requires at least one official OpenAI HTTPS documentation reference when marked PASS.
2. **Q2 Conversation capability** — ordinary assistant turns and bounded Aiopago capsule delivery must work without consumer-web scraping.
3. **Q3 Identity safety** — browser automation, DOM extraction, cookie/session-token reuse, private endpoint reuse and restriction circumvention must all remain false.
4. **Q4 State semantics** — remote conversation identity and retry/idempotency/reconciliation behavior must be bounded enough for fail-closed delivery.
5. **Q5 Usage-pool evidence** — PASS requires `usage_pool.claim=chatgpt` plus controlled before/after evidence. API or Codex usage cannot be relabeled as ordinary ChatGPT.
6. **Q6 Pi tool loop** — a Pi-mediated tool result must return to the same external conversation without hidden Codex execution.
7. **Q7 Failure semantics** — timeout, ambiguous delivery and restart must not silently advance a cursor or replay an uncertain request.

The harness does **not** prove that a documentation URL is truthful, that an account counter actually moved, or that OpenAI has approved a transport merely because someone wrote `PASS` in JSON. Q1 and Q5 still require reviewable external evidence. The executable gate prevents incomplete or contradictory evidence from being promoted accidentally.

## Current OpenAI baseline — 2026-09-04

The baseline remains BLOCKED because the currently documented surfaces still do not provide the Pi-first transport required by the project:

- `Sign in with ChatGPT` shares identity information; it is not an ordinary ChatGPT conversation API.
- Apps SDK / MCP lets ChatGPT invoke external tools/apps; it does not document Pi submitting ordinary ChatGPT turns against normal ChatGPT plan usage.
- OpenAI API usage is billed separately from ChatGPT and therefore cannot be labeled `ChatGPT Normal`.
- Codex supports ChatGPT-plan sign-in, but that establishes Codex product access rather than a generic ordinary-ChatGPT external-client transport.

Official references are recorded in the baseline evidence manifest and ADR-0016A.

## How a future real adapter would be qualified

When an eligible OpenAI surface appears:

1. copy the baseline manifest to a candidate-specific evidence file;
2. link the exact OpenAI transport documentation under Q1;
3. implement the transport-specific adapter outside Aiopago core;
4. run ordinary-turn and remote-thread tests for Q2/Q4;
5. perform controlled usage-counter measurements for Q5;
6. run the real ChatGPT → Pi read/query tool → same ChatGPT context loop for Q6;
7. kill/restart/timeout the adapter around delivery boundaries for Q7;
8. run the qualifier with `--expect QUALIFIED`;
9. only then configure the adapter as `official-supported` with `usage_pool=chatgpt`.

Example:

```bash
node scripts/chatgpt-transport-qualification.mjs \
  docs/evidence/chatgpt-normal-transport-candidate.json \
  --expect QUALIFIED
```

Until then, the correct baseline command is:

```bash
node scripts/chatgpt-transport-qualification.mjs \
  docs/evidence/chatgpt-normal-transport-baseline-2026-09-04.json \
  --expect BLOCKED
```

## Boundary

This work belongs to the multi-model / 0.3-A line. It does not modify, depend on, or widen `feat/unified-human-ux-0.2-e`.
