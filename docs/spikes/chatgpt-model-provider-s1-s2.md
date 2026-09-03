# Spike #32 — S1/S2 provider seam and transport isolation

**Date:** 2026-09-02  
**Status:** EXECUTED / PROVIDER-NEUTRAL SEAM PASS; PRODUCTION CHATGPT TRANSPORT BLOCKED  
**ADR:** `docs/adr/0016-multi-model-context-domain-continuity.md` + ADR-0016A

## Purpose

This slice does **not** automate `chatgpt.com` and does not claim normal-ChatGPT quota semantics. It proves the local architectural seam needed before an eligible real ChatGPT transport can be attached.

The questions are deliberately smaller:

1. can an external-stateful provider be installed into the same Pi `ModelRuntime` used by Aiopago;
2. can it remain selectable as a normal Pi model while model changes keep one Pi session;
3. can external-route and code-route calls be kept transport-isolated;
4. can the custom provider remain behind Aiopago's existing admission/latch gate.

## Verified upstream surface

Aiopago supports `@earendil-works/pi-coding-agent` 0.83.x. Pi 0.83.0 already implements the surfaces used by this spike:

- custom provider registration;
- complete provider implementations with custom `streamSimple` behavior;
- provider models in the normal model catalog used by `/model`;
- model changes inside the same `AgentSession`;
- `model_select` events for `/model`, model cycling and restore;
- streaming tool-call blocks for non-standard providers.

The spike therefore does not require a Pi fork merely to expose an externally backed model.

## New Aiopago seams

### `ContextDomainRegistry`

`src/context-domain.mjs` distinguishes inference model identity from context location/semantics.

The first kinds are:

- `pi-native`: ordinary Pi conversation context;
- `external-stateful`: an external conversational state exists and requires explicit continuity semantics.

Unregistered models resolve to a provider-scoped `pi-native` descriptor. External adapters must register their external-stateful domain explicitly.

### `ProviderAdapter`

`src/provider-adapter.mjs` defines a small provider-neutral installation boundary. An adapter:

- has its own adapter ID;
- owns one provider ID in the current contract;
- registers that provider into Pi `ModelRuntime`;
- publishes its context-domain descriptor;
- contains transport installation logic but no Aiopago durable project authority.

The post-review safety gate also makes transport provenance explicit for external-stateful adapters:

```text
transport_support.status
  official-supported
  experimental-nonproduction
```

An experimental external transport is rejected by default. Spike/tests must opt in explicitly at `GuardianRunner.create()` with `allowExperimentalExternal: true`; environment variables never enable the transport implicitly. An `official-supported` adapter must provide documentation and usage-pool claim/evidence metadata.

An exact-model descriptor is also rejected if the installed provider exposes unclassified sibling models; provider-default descriptors may classify the complete provider.

### Runner ordering

`GuardianRunner.create()` installs provider adapters **before** `AdmissionGate.install(modelRuntime)`.

This ordering is safety-relevant. The current gate wraps providers present at installation time. Installing an external provider afterward would risk placing it outside the same latch/safe-point transport boundary.

## Offline integration test

`test/multi-model-spike.test.mjs` uses two in-memory Pi faux providers:

- `chatgpt-normal-spike/chatgpt-normal` — stands in for a future eligible ChatGPT transport;
- `codex-spike/codex-spike` — a code-route sentinel, **not** the real Codex service.

Expected flow:

```text
same Pi session

external sentinel
  -> discussion response
/model-equivalent session.setModel()
code sentinel
  -> implementation response
/model-equivalent session.setModel()
external sentinel
  -> review response
```

The executed test requires:

- the external provider/model is present and available in the Pi model catalog;
- the same Pi `sessionId` survives both model changes;
- the first external response is visible to the code provider through Pi context;
- the code response reaches the returning external domain through Aiopago's bounded projection path;
- external calls increment only the external sentinel counter;
- code calls increment only the code sentinel counter;
- zero network requests occur;
- after the Aiopago latch is engaged, a direct external-provider request fails with `LLM_ADMISSION_BLOCKED`.

The test uses `session.setModel()` because that is the SDK operation used by the interactive `/model` path; it does not create a second Aiopago model-routing mechanism.

## Gate status

### S1 — Provider registration

**Provider-neutral Pi/Aiopago seam:** PASS on Node 22.19.0 + Pi 0.83.0.  
**Real ChatGPT product transport:** BLOCKED by ADR-0016A pending an eligible OpenAI-documented external-client transport.

The provider seam must not be described as proof that `ChatGPT Normal` itself is available.

### S2 — Usage-pool isolation

**Provider-neutral routing isolation:** PASS with independent in-memory transports and zero-network assertions.  
**Real ChatGPT-vs-Codex quota isolation:** BLOCKED until the real eligible transport exists and its usage semantics can be measured.

The fake transport counters prove only that Aiopago/Pi can keep two transport paths separate. They do not prove how the ChatGPT product will account a future request.

## Post-review safety findings

The independent review added fail-closed requirements before this seam can become production surface:

- external adapters are experimental unless explicit official transport evidence is supplied;
- experimental transport enablement is an explicit Runner construction option, never ambient environment state;
- exact-model adapters cannot leave sibling models silently classified as Pi-native;
- external-stateful tools are read-only in this spike (`read`/query tools); mutation expansion remains deferred;
- context capsules pass the shared secret scanner before transport;
- remote error/abort enters explicit reconciliation-required state rather than silently replaying a stale pending capsule.

## Next step

Do **not** implement a consumer-web/browser bridge. ADR-0016A rejects Playwright/CDP/DOM response extraction, private ChatGPT endpoints and cookie/session-token reuse.

The next ChatGPT-specific step is only:

1. identify an OpenAI-documented/supported external-client conversation transport;
2. verify that its usage semantics actually correspond to the intended normal ChatGPT usage pool;
3. mark the adapter `official-supported` with evidence;
4. replace only the in-memory transport behind the already-tested provider seam.

Until then this code remains a provider-neutral foundation and an experimental transport harness, not a production `ChatGPT Normal` implementation.
