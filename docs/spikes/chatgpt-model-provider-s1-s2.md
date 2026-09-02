# Spike #32 — S1/S2 provider seam and transport isolation

**Date:** 2026-09-02  
**Status:** IMPLEMENTED / EXECUTION EVIDENCE PENDING  
**ADR:** `docs/adr/0016-multi-model-context-domain-continuity.md`

## Purpose

This first slice does **not** automate `chatgpt.com` and does not claim normal-ChatGPT quota semantics yet. It proves the local architectural seam needed before a real ChatGPT transport is attached.

The questions are deliberately smaller:

1. can an external-stateful `ChatGPT Normal` provider be installed into the same Pi `ModelRuntime` used by Aiopago;
2. can it remain selectable as a normal Pi model while model changes keep one Pi session;
3. can ChatGPT-route and code-route calls be kept transport-isolated;
4. can the custom provider remain behind Aiopago's existing admission/latch gate.

## Verified upstream surface

Aiopago supports `@earendil-works/pi-coding-agent` 0.83.x. Pi 0.83.0 already documents and implements:

- custom provider registration;
- complete provider implementations with custom `streamSimple` behavior;
- provider models in the normal model catalog used by `/model`;
- model changes inside the same `AgentSession`;
- `model_select` events for `/model`, model cycling and restore;
- streaming tool-call blocks for non-standard providers.

The spike therefore does not require a Pi fork merely to expose a ChatGPT-backed model.

## New Aiopago seams

### `ContextDomainRegistry`

`src/context-domain.mjs` distinguishes inference model identity from context location/semantics.

The first kinds are:

- `pi-native`: ordinary Pi conversation context;
- `external-stateful`: an external conversational state exists and can require later watermark/delta synchronization.

Unregistered models resolve to a provider-scoped `pi-native` descriptor. `ChatGPT Normal` is explicitly registered as `external-stateful` with usage pool `chatgpt`.

### `ProviderAdapter`

`src/provider-adapter.mjs` defines a small provider-neutral installation boundary. An adapter:

- has its own adapter ID;
- owns one provider ID for the spike;
- registers that provider into Pi `ModelRuntime`;
- publishes its context-domain descriptor;
- contains transport installation logic but no Aiopago durable authority.

ChatGPT-specific browser/session code is intentionally absent.

### Runner ordering

`GuardianRunner.create()` installs provider adapters **before** `AdmissionGate.install(modelRuntime)`.

This ordering is safety-relevant. The current gate wraps providers present at installation time. Installing an external provider afterward would risk placing it outside the same latch/safe-point transport boundary. The spike makes the ordering explicit rather than relying on late extension registration.

## Offline integration test

`test/multi-model-spike.test.mjs` uses two in-memory Pi faux providers:

- `chatgpt-normal-spike/chatgpt-normal` — stands in for the future ChatGPT transport;
- `codex-spike/codex-spike` — a code-route sentinel, **not** the real Codex service.

Expected flow:

```text
same Pi session

ChatGPT sentinel
  -> discussion response
/model-equivalent session.setModel()
Code sentinel
  -> implementation response
/model-equivalent session.setModel()
ChatGPT sentinel
  -> review response
```

The test requires:

- the ChatGPT provider/model is present and available in the Pi model catalog;
- the same Pi `sessionId` survives both model changes;
- the first ChatGPT response is visible to the code provider through Pi context;
- the code response is visible when switching back to ChatGPT;
- ChatGPT calls increment only the ChatGPT sentinel counter;
- code calls increment only the code sentinel counter;
- zero network requests occur;
- after the Aiopago latch is engaged, a direct ChatGPT-provider request fails with `LLM_ADMISSION_BLOCKED`.

The test uses `session.setModel()` because that is the SDK operation used by the interactive `/model` path; it does not create a second Aiopago model-routing mechanism.

## Gate status

### S1 — Provider registration

**Offline seam:** implemented.  
**Execution evidence:** pending a real test run.  
**Real ChatGPT transport:** not yet implemented.

Do not call S1 fully closed until the test executes successfully on the supported Pi 0.83.x profile and a later transport adapter streams an actual ChatGPT-product response.

### S2 — Usage-pool isolation

**Offline transport-routing seam:** implemented.  
**Execution evidence:** pending a real test run.  
**Real ChatGPT-vs-Codex quota isolation:** unproven.

The fake transport counters prove only that Aiopago/Pi can keep two transport paths separate. They do not prove how the ChatGPT product will account a browser-backed request. That requires the real adapter and empirical evidence.

## Next spike step

After this test is green:

1. freeze the minimal transport adapter contract required by a real ChatGPT bridge;
2. connect a normal authenticated ChatGPT browser/product session without storing browser credentials in Aiopago state;
3. replace only the in-memory ChatGPT transport in the test flow;
4. collect real S1/S2 evidence before beginning watermark/hydration work (S3/S5/S6).

No browser selectors, cookies, access tokens or ChatGPT page code belong in the Aiopago core.
