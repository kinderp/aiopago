# ChatGPT TUI Sidecar

Status: **SPIKE / INTEGRATED UX LAYER / NO OFFICIAL CHATGPT NORMAL TRANSPORT YET**

This slice evolves the temporary human sidecar into an integrated Pi/Aiopago chat mode without weakening ADR-0016A.

## Product goal

The user stays inside one Pi/Aiopago terminal and switches the primary conversational surface between Code and Chat:

```text
CODE <-> CHAT
```

The project/session context and local tool plane remain owned by Aiopago. Switching mode must not create a second project authority and must not silently invoke the Code model while the user believes they are in Chat mode.

## Keyboard

Pi currently binds `Ctrl+G` to the external editor, so this spike reserves:

```text
Ctrl+Alt+G
```

for the future CODE/CHAT toggle. The binding should remain configurable when productized.

## Input ownership

The critical design rule is that the input editor belongs to Aiopago, not directly to the ChatGPT web surface.

In Chat mode every submitted line is routed before any model call:

```text
user input
   |
   v
Aiopago input router
   |
   +-- pure chat --------------------> Chat transport
   +-- local read/query ---> Pi/local tool plane ---> Chat transport
   +-- local mutation -----> guarded Pi worker -----> Chat transport
   +-- ambiguous action ----------------------------> FAIL CLOSED
```

This makes it possible to keep filesystem, Git, tests and other local capabilities available while ChatGPT remains the conversational model.

## Current first slice

`src/chatgpt-tui-mode.mjs` introduces:

- explicit `code` / `chat` mode state;
- deterministic intent classes: `pure-chat`, `local-read`, `local-action`, `mixed`, `ambiguous-action`;
- fail-closed handling for deictic mutation requests such as `ok fallo` / `implement that` when their meaning depends on ChatGPT output that Aiopago cannot safely observe;
- a transport-availability boundary;
- a hard invariant that Chat-mode input is `handled` by the extension and therefore must not leak into the currently selected Pi Code model.

The production interactive transport is intentionally **not** implemented by this slice. Until a supported panel transport is attached, Chat mode must report `CHATGPT_TUI_TRANSPORT_UNAVAILABLE` instead of falling back to Codex/API or browser-private mechanisms.

## Relationship to the existing human sidecar

The existing `feat/chatgpt-human-sidecar` branch remains the durability/protocol baseline:

- bounded post-watermark hydration;
- secret scanning;
- durable PREPARED delivery;
- explicit reconciliation;
- cursor acknowledgement;
- restart-safe handoff/rebind.

The TUI slice is stacked on that branch so the UX transport can be replaced without replacing context continuity.

## Tool-plane policy

The intended policy is:

```text
AUTO READ/QUERY
- read
- grep/find
- ls
- git status/log
- tests/lint where configured as non-mutating

GUARDED MUTATION
- edit/write
- package installation
- commit/push
- destructive shell actions
```

Mutation authority remains Aiopago/Pi-side. ChatGPT must not gain direct local filesystem authority merely because Chat mode is active.

## Fail-closed reference problem

Until ADR-0016A provides an official output-capable ChatGPT transport, this conversation is safe:

```text
User: applica la soluzione B a authority_epoch
```

because the action is explicit.

This conversation is not safe to execute automatically:

```text
ChatGPT: sceglierei la soluzione B
User: ok fallo
```

If Aiopago cannot officially observe the preceding ChatGPT output, `fallo` cannot be resolved reliably. The router therefore blocks the local mutation and asks for an explicit restatement rather than guessing.

## Next slices

1. Wire the mode controller into `src/extension.mjs` with a configurable shortcut and visible TUI status.
2. Add a local read/query executor behind the router.
3. Add a guarded coding-worker path for explicit mutations.
4. Prototype an interactive terminal panel transport that keeps the user inside Pi without treating consumer-web output as a provider API.
5. Keep ADR-0016A Q1-Q7 as the only gate that may promote a future OpenAI transport to automated `ChatGPT Normal` provider status.
