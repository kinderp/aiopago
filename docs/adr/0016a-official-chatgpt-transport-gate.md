# ADR-0016A — Official ChatGPT transport gate

- **Status:** DECIDED / BLOCKING CONSTRAINT
- **Date:** 2026-09-02
- **Parent:** ADR-0016
- **Issue:** #32
- **Scope:** transport eligibility for `ChatGPT Normal`

## 1. Finding

ADR-0016 deliberately left the concrete ChatGPT transport behind a spike. Review of OpenAI's current consumer Terms of Use constrains which transport candidates are admissible.

OpenAI's current Terms prohibit automatically or programmatically extracting data or Output from the Services and prohibit interfering with the Services, including circumventing rate limits/restrictions or protective measures.

Official references rechecked on 2026-09-02:

- <https://openai.com/policies/terms-of-use/>
- <https://openai.com/policies/eu-terms-of-use/>

Therefore a Playwright/CDP/DOM-scraping bridge that sends prompts through `chatgpt.com` and programmatically extracts assistant Output is **not an accepted implementation path** for Aiopago.

This is a product/architecture constraint, not merely a preference about fragility.

## 2. Decision

### D1 — ChatGPT Normal requires an officially supported programmatic transport

`DECIDED`

The `ChatGPT Normal` provider seam may be connected only to a transport that OpenAI officially documents/supports for programmatic access and whose usage semantics satisfy the intended ChatGPT-plan usage pool.

Until such a surface is identified and verified, the production `ChatGPT Normal` adapter is **BLOCKED**.

The offline provider seam, context-domain model and continuity work may continue because they are transport-neutral.

### D2 — Browser/DOM extraction is rejected

`DECIDED`

Do not implement or ship:

- Playwright/Selenium/CDP response scraping from ChatGPT;
- DOM polling/parsing of assistant responses;
- calls to undocumented/private ChatGPT web endpoints;
- extraction/reuse of ChatGPT browser cookies or session tokens;
- any mechanism intended to bypass API billing, Codex limits, ChatGPT limits or other product restrictions.

This supersedes any reading of ADR-0016 that browser-specific logic could simply live in an external adapter. The adapter boundary remains valid, but the adapter itself must use an eligible official transport.

### D3 — `Sign in with ChatGPT` is not conversation transport

`OBSERVED / NOT SUFFICIENT`

OpenAI currently documents `Sign in with ChatGPT` as an identity-provider flow for supported external applications. It shares identity information, not ChatGPT conversations, memory, files, tokens or billing data by itself.

Reference:

- <https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt>

It may become useful for authentication if OpenAI later exposes the required permissions, but it does not currently satisfy S1/S2 transport requirements.

### D4 — ChatGPT Apps are the opposite integration direction

`OBSERVED / NOT SUFFICIENT FOR CURRENT UX`

OpenAI's Apps/connector model lets ChatGPT call an external API/MCP service. This can participate in normal ChatGPT product usage, but the primary user interface remains ChatGPT. It does not currently provide the required external Pi client transport for sending prompts to ChatGPT and receiving ChatGPT Output inside Pi.

References:

- <https://openai.com/policies/developer-apps-terms/>
- <https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt>

An Aiopago MCP/App integration could be a separate future product direction, but it does not replace the requested one-Pi-UI `/model` flow.

### D5 — OpenAI API is technically usable but does not satisfy the quota requirement

`OBSERVED / OUT OF SCOPE FOR CHATGPT NORMAL`

The public OpenAI API is a supported programmatic surface for external clients, but ChatGPT and the API platform use separate billing systems. OpenAI explicitly documents that paid API usage is billed separately from a ChatGPT subscription.

The API can be used as an optional ordinary Pi provider, but it must not be labeled `ChatGPT Normal` or represented as consuming the normal ChatGPT quota.

References:

- <https://help.openai.com/en/articles/9039756>
- <https://help.openai.com/en/articles/8156019>

## 3. Effect on spike #32

### S1

The **local provider-registration seam** remains useful and testable.

Production S1 becomes:

> Register `ChatGPT Normal` in Pi `/model` using an officially supported OpenAI transport that demonstrably targets the normal ChatGPT product usage pool.

Until that transport exists/is identified, production S1 remains blocked after the offline seam.

### S2

Offline transport isolation can still prove that Aiopago/Pi does not accidentally cross-call two configured providers.

Real ChatGPT-vs-Codex usage-pool isolation cannot be closed using browser automation. It remains blocked until an eligible transport exposes enough evidence to verify the two pools empirically.

### S3–S8

Provider-neutral work may proceed behind fake/adversarial transports where useful, especially:

- context-domain cursors/watermarks;
- bounded Context Hydrator;
- attribution primitives;
- durable handoff rebinding;
- adapter failure semantics.

None of those tests may be presented as proof that ChatGPT Normal itself is available.

## 4. Adapter contract requirement

The future external adapter contract must make transport eligibility explicit. At minimum its metadata includes:

```text
transport_support
  status               # official-supported | experimental-nonproduction
  documentation_ref
  usage_pool_claim
  usage_pool_evidence
```

Aiopago production configuration must reject a `ChatGPT Normal` adapter whose transport is not marked and verified as officially supported.

The provider-neutral spike now implements this fail-closed shape: external adapters default to `experimental-nonproduction`; experimental installation requires explicit opt-in; `official-supported` requires documentation and usage-pool evidence metadata. That proves the gate mechanics, **not** the existence of an eligible ChatGPT transport.

## 5. Consequence

The architecture remains valuable even while the final ChatGPT transport is blocked:

```text
Pi /model
   |
   +-- Codex / Claude / Gemini / local / API providers   -> usable through their supported paths
   |
   +-- ChatGPT Normal                                    -> provider seam ready,
                                                           official transport required
```

Aiopago continues to evolve toward model-independent continuity without tying its core to an undocumented consumer-web interface.
