# Aiopago Efficiency Benchmark Requirement

Status: PLANNED / NON-BLOCKING FOR 0.2-B REMEDIATION

Aiopago must measure, rather than estimate, its effect on token usage, monetary cost and human coordination overhead.

Primary outcome metric: Cost per Accepted Work Unit (CAWU).

Required measured dimensions:
- input tokens;
- output tokens;
- reasoning tokens when exposed;
- cache read/write tokens;
- total context tokens;
- provider/model cost with provenance;
- session count;
- handoff count;
- retries/rework;
- context re-read / repeated-context overhead where measurable;
- human coordination time when explicitly recorded;
- accepted work units and acceptance evidence.

Derived metrics:
- Tokens per Accepted Work Unit;
- Cost per Accepted Work Unit;
- Context Tax percentage;
- Useful Work Ratio;
- Retry/Rework Rate;
- Human Coordination Time per Accepted Work Unit;
- Token Saving percentage against a declared baseline;
- Cost Saving percentage against a declared baseline.

Scientific rules:
1. MEASURED, ESTIMATED and UNKNOWN values must remain distinct.
2. No missing value is converted to zero.
3. Savings claims require a declared baseline and methodology version.
4. Comparisons should prefer matched or difficulty-classified tasks and report sample size and dispersion, not only an average.
5. Provider billing, local estimates and model/runtime telemetry remain separate provenance sources until reconciled.
6. An Accepted Work Unit requires explicit acceptance/evidence; session completion alone is insufficient.
7. Baseline collection must begin before TokenSave/TraceDecay, adaptive routing or other cost-optimization features are enabled, so Aiopago can measure causal improvement against a pre-optimization baseline.

Roadmap integration:
- M1 telemetry supplies the raw measurements.
- M8 benchmark owns the versioned methodology and cost-to-acceptance analysis.
- M3 TokenSave/TraceDecay and M7 adaptive routing must be evaluated against the frozen baseline rather than by self-reported savings.

Acceptance target for the benchmark capability:
Aiopago can produce a reproducible report for a task/work unit showing total token use, cost, context overhead, retries, acceptance evidence, CAWU, and — when a valid baseline exists — measured token/cost savings with methodology and provenance.
