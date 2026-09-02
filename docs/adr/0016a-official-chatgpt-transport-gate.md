# ADR-0016A — Official ChatGPT transport gate

- **Status:** DECIDED / BLOCKING CONSTRAINT
- **Date:** 2026-09-02
- **Parent:** ADR-0016
- **Issue:** #32
- **Scope:** transport eligibility for `ChatGPT Normal`

## 1. Finding

ADR-0016 deliberately keeps the concrete `ChatGPT Normal` transport outside Aiopago core. The transport must satisfy both OpenAI product rules and the user's architectural requirement that ordinary ChatGPT usage remain distinct from Codex and API usage.

OpenAI's consumer Terms prohibit automatically/programmatically extracting data or Output from the Services and prohibit circumventing service restrictions or protective measures.

Official references rechecked on 2026-09-02:

- <https://openai.com/policies/terms-of-use/>
- <https://openai.com/policies/eu-terms-of-use/>

Therefore a Playwright/CDP/DOM-scraping bridge that drives `chatgpt.com` and programmatically extracts assistant Output is **not an accepted implementation path** for Aiopago.

This is a product/architecture constraint, not merely a preference about fragility.

## 2. Decisions and current OpenAI surfaces

### D1 — `ChatGPT Normal` requires an officially supported external-client conversation transport

`DECIDED`

The `ChatGPT Normal` provider seam may be connected only to a transport that OpenAI explicitly documents/supports for external programmatic clients and whose usage semantics can be demonstrated to consume the intended ordinary ChatGPT product usage pool.

Until such a surface is identified and verified, the production `ChatGPT Normal` adapter is **BLOCKED EXTERNALLY**.

Provider-neutral context-domain, hydration, durability and handoff work may continue because it does not depend on a particular ChatGPT transport.

### D2 — Browser/DOM extraction and private endpoints are rejected

`DECIDED`

Do not implement or ship:

- Playwright/Selenium/CDP response scraping from ChatGPT;
- DOM polling/parsing of assistant responses;
- calls to undocumented/private ChatGPT web endpoints;
- extraction/reuse of ChatGPT browser cookies or session tokens;
- any mechanism intended to bypass API billing, Codex limits, ChatGPT limits or other product restrictions.

The adapter boundary remains valid, but the adapter itself must use an eligible official transport.

### D3 — `Sign in with ChatGPT` is identity, not ordinary ChatGPT conversation transport

`OBSERVED / NOT SUFFICIENT`

OpenAI currently documents `Sign in with ChatGPT` as an identity-provider sign-in mechanism for supported external applications. By itself it shares identity information and does not grant a third-party client access to ChatGPT conversations, memory, files, tokens or billing data.

Reference rechecked on 2026-09-02:

- <https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt>

It may become useful for authentication if OpenAI later exposes additional supported permissions, but authentication alone does not satisfy the transport or quota requirement.

### D4 — Apps SDK / MCP is the opposite integration direction for the requested Pi-first UX

`OBSERVED / NOT SUFFICIENT FOR CURRENT UX`

OpenAI's Apps SDK and MCP integration model lets ChatGPT call external tools, data and applications. This is useful for bringing Aiopago capabilities **into ChatGPT**, but the primary conversation surface remains ChatGPT.

It does not currently document the reverse transport required here: Pi acting as the primary client, sending ordinary ChatGPT turns and receiving ChatGPT Output while consuming the user's normal ChatGPT plan quota.

References rechecked on 2026-09-02:

- <https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk>
- <https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt>

An Aiopago MCP/App integration may be a separate future product direction, but it does not replace the requested one-Pi-UI `/model` flow.

### D5 — Public OpenAI API is supported but is not `ChatGPT Normal`

`OBSERVED / OUT OF SCOPE FOR CHATGPT NORMAL`

The public OpenAI API is a supported programmatic surface for external clients, but ChatGPT and the API platform remain separately billed and managed. API use therefore cannot truthfully be labeled `ChatGPT Normal` or represented as consuming normal ChatGPT subscription quota.

References rechecked on 2026-09-02:

- <https://help.openai.com/en/articles/9039756>
- <https://help.openai.com/en/articles/8156019>

The API may still use the provider-neutral Aiopago continuity machinery under an explicit API-provider identity and API usage pool.

### D6 — Codex ChatGPT-plan sign-in does not create a generic ordinary-ChatGPT transport

`OBSERVED / NOT SUFFICIENT`

OpenAI explicitly supports Codex clients signed in with a ChatGPT account and documents Codex as included across ChatGPT plans, with its own product usage limits.

Reference rechecked on 2026-09-02:

- <https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>

This proves that OpenAI can expose subscription-backed product clients, but it establishes **Codex** access, not a generic external-client API for ordinary ChatGPT conversations. Aiopago must not infer ordinary ChatGPT transport eligibility from Codex authentication behavior.

## 3. Effect on spike #32

The provider-neutral S1–S8 mechanics and their durability hardening are now validated independently of the real ChatGPT transport.

Production `ChatGPT Normal` remains blocked only at the external transport/product boundary:

- provider registration seam: validated;
- same-Pi-session transport isolation: validated;
- A→B→A bounded continuity: validated;
- Pi-mediated read tool loop: validated;
- durable cursor and remote binding: validated provider-neutrally;
- ambiguous delivery reconciliation across restart: validated;
- history-zero handoff/rebind: validated;
- real ordinary-ChatGPT transport: **blocked externally**;
- real ChatGPT-vs-Codex usage-pool proof: **blocked externally**.

No provider-neutral test may be presented as proof that `ChatGPT Normal` itself is available.

## 4. Adapter qualification gate

A future transport candidate may be wired as `ChatGPT Normal` only after all seven gates below are evidenced.

### Q1 — Documented transport

OpenAI explicitly documents/supports the transport for external clients. Authentication documentation alone is insufficient.

### Q2 — Conversation capability

The transport can send and receive ordinary assistant turns and can carry the bounded Aiopago context capsule without requiring consumer-web scraping.

### Q3 — Identity safety

No browser cookie/session-token extraction, private endpoint reuse, DOM automation or other circumvention mechanism is required.

### Q4 — State semantics

Remote thread/conversation identity, retry behavior and idempotency/reconciliation semantics are documented or empirically bounded enough for Aiopago to fail closed.

### Q5 — Usage-pool evidence

A controlled before/after experiment demonstrates which product pool changes: ordinary ChatGPT, Codex or API. The configured provider label or authentication method is not accepted as proof.

### Q6 — Pi tool-loop compatibility

Pi-mediated tool results can return to the same external conversational state without invoking Codex as a hidden executor.

### Q7 — Failure semantics

Timeout, ambiguous delivery or process restart cannot silently advance the durable cursor or cause an automatic ambiguous replay.

Until **Q1–Q7** all pass, `ChatGPT Normal` remains feature-gated/unavailable rather than silently falling back to the API or browser automation.

## 5. Adapter contract requirement

The provider adapter exposes transport provenance at minimum:

```text
transport_support
  status               # official-supported | experimental-nonproduction
  documentation_ref
  usage_pool_claim
  usage_pool_evidence
```

Aiopago production configuration must reject a `ChatGPT Normal` adapter whose transport is not marked and verified as officially supported.

The provider-neutral implementation already enforces this fail-closed shape:

- external adapters default to `experimental-nonproduction`;
- experimental installation requires explicit Runner opt-in;
- `official-supported` requires documentation and usage-pool evidence metadata;
- sibling models cannot remain silently unclassified;
- outbound secret-shaped values fail before transport;
- ambiguous delivery does not silently advance the cursor.

These mechanics prove the qualification boundary, **not** the existence of an eligible OpenAI transport.

## 6. Consequence

The architecture remains useful while the final ChatGPT transport is blocked:

```text
Pi /model
   |
   +-- Codex / Claude / Gemini / local / API providers   -> usable through supported paths
   |
   +-- ChatGPT Normal                                    -> continuity seam ready,
                                                           Q1-Q7 transport gate required
```

Aiopago can therefore productize provider-neutral multi-model continuity without tying its core to an undocumented consumer-web interface. The real `ChatGPT Normal` adapter should be a small transport-specific layer added only when OpenAI exposes a qualifying surface.
