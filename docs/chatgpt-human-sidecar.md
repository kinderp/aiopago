# ChatGPT Human Sidecar

Status: **TEMPORARY / HUMAN-MEDIATED / NOT `ChatGPT Normal` TRANSPORT**

The Human Sidecar gives Aiopago a temporary way to use the user's ordinary ChatGPT product manually while keeping Pi as the primary harness. It does **not** automate chatgpt.com, reuse browser cookies, call private endpoints, or claim an OpenAI-supported external ChatGPT transport.

## UX

Inside Pi:

```text
/chatgpt ask <question>
```

Aiopago:

1. appends the sidecar request to the current Pi session without invoking the selected model;
2. builds a bounded post-watermark context capsule using the same durable-first hydrator as external-stateful providers;
3. performs the normal outbound secret scan;
4. records a durable PREPARED delivery;
5. copies the capsule to the system clipboard.

The human pastes it into ordinary ChatGPT, obtains a reply, copies that reply, returns to Pi and runs:

```text
/chatgpt import
```

Aiopago reads the clipboard, appends the imported reply to the Pi session without invoking a model, advances the sidecar cursor through that imported reply, and marks the delivery ACKNOWLEDGED. A later `/model codex` turn therefore sees the imported ChatGPT exchange through normal Pi context, while the next sidecar export does not resend material already acknowledged by ChatGPT.

Additional commands:

```text
/chatgpt status
/chatgpt retry [replacement question]
```

`status` reports only delivery/cursor metadata. `retry` explicitly reconciles the prior unresolved export before preparing a new human transfer; there is no silent replay.

## Context domain

The sidecar uses a dedicated `external-stateful` domain:

```text
context_domain_id: external:chatgpt-human-sidecar
provider_id:       chatgpt-human-sidecar
model_id:          manual-chatgpt
usage_pool:        human-mediated-chatgpt
transport_adapter: chatgpt-human-sidecar/manual-copy-paste
```

`usage_pool` is a descriptive local label, not quota evidence. The sidecar must never be exposed or documented as an automated `ChatGPT Normal` model.

## Safety and durability

- No browser automation, DOM extraction, cookies, private endpoints, or reverse-engineered web calls.
- Export is bounded and secret-scanned before clipboard write.
- The sidecar never receives local mutation tools.
- A PREPARED export survives restart. Import reconstructs the exact durable transfer window and advances the cursor only after the imported response has been persisted in the Pi session.
- Import is idempotent across the crash seam after response persistence but before cursor/delivery acknowledgement: an existing response marker is reused rather than appended again.
- A new export is rejected while another PREPARED delivery is unresolved; retry is explicit.
- Import never calls the currently selected Pi model. It only persists an explicitly human-supplied external response.
- If the sidecar has been used before, its context domain is restored at Runner extension setup so full Aiopago handoff includes its durable cursor/baseline.
- Full Aiopago handoff therefore uses the same external-stateful continuity rules and cannot silently discard unresolved sidecar state.

## Clipboard support

The default local clipboard adapter uses only standard/local OS commands:

- macOS: `pbcopy` / `pbpaste`;
- Windows: PowerShell `Set-Clipboard` / `Get-Clipboard -Raw`;
- Linux/Wayland: `wl-copy` / `wl-paste`;
- Linux/X11 fallback: `xclip` or `xsel`.

Tests inject an in-memory clipboard and make no OS clipboard or network calls.

## Replacement by a future official transport

This feature is intentionally disposable at the transport layer, not at the context layer. If ADR-0016A Q1-Q7 eventually qualify an official OpenAI transport, the Human Sidecar can be disabled and the real provider adapter can reuse the same context-domain/cursor/hydration/handoff mechanics.
