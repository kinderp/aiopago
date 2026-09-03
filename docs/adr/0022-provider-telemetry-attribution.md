# ADR-0022 — Provider-neutral telemetry and attribution projection

- **Status:** PROPOSED / P6 IMPLEMENTED FOR REVIEW
- **Date:** 2026-09-03
- **Issue:** #36

P6 exposes a pure public projection over already-sanitized metric samples and operation outcomes; it does not expose GuardianStorage. The projection reports provider/model, context-domain, configured usage-pool label, captured token fields, bounded tool outcomes and successful file-target provenance.

`usage_pool` is explicitly labeled `configured_label_not_billing_or_quota_proof`. Primary-token share uses input+output only; reasoning/cache remain separate because overlap semantics are provider-specific. Missing usage is marked partial, never filled by an estimate presented as fact.

Tests and decisions are reported as unavailable when metric samples do not contain defensible provenance. `work_mix` remains `not_computed` until a transparent weighting policy is separately ratified. The legacy storage-backed S7 snapshot remains internal compatibility evidence, not the P6 public API.

No dashboard polish, billing reconciliation, quota inference, transcript content or shell/code text enters this surface.
