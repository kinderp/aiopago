import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CHATGPT_NORMAL_QUALIFICATION_GATES,
  CHATGPT_NORMAL_TRANSPORT_QUALIFICATION_SCHEMA,
  assertChatGPTNormalTransportQualified,
  evaluateChatGPTNormalTransportQualification,
} from "../scripts/chatgpt-transport-qualification.mjs";

const baseline = JSON.parse(await readFile(new URL("../docs/evidence/chatgpt-normal-transport-baseline-2026-09-04.json", import.meta.url), "utf8"));

function qualifiedFixture() {
  return {
    schema: CHATGPT_NORMAL_TRANSPORT_QUALIFICATION_SCHEMA,
    candidate_id: "synthetic-qualified-transport",
    observed_at: "2026-09-04",
    usage_pool: { claim: "chatgpt", before_after_evidence: ["controlled-run-1"] },
    prohibited_mechanisms: {
      browser_automation: false,
      dom_extraction: false,
      cookie_or_session_token_reuse: false,
      private_endpoint_reuse: false,
      restriction_circumvention: false,
    },
    gates: Object.fromEntries(CHATGPT_NORMAL_QUALIFICATION_GATES.map((gateId) => [gateId, {
      status: "PASS",
      evidence: gateId === "Q1_DOCUMENTED_TRANSPORT"
        ? ["https://help.openai.com/en/articles/synthetic-supported-transport"]
        : [`synthetic evidence for ${gateId}`],
    }])),
  };
}

test("2026-09-04 ordinary ChatGPT external-client baseline remains BLOCKED rather than being mislabeled available", () => {
  const result = evaluateChatGPTNormalTransportQualification(baseline);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.qualified, false);
  assert.equal(result.gate_results.find((gate) => gate.gate_id === "Q1_DOCUMENTED_TRANSPORT").status, "BLOCKED");
  assert.equal(result.gate_results.find((gate) => gate.gate_id === "Q5_USAGE_POOL_EVIDENCE").status, "BLOCKED");
});

test("a complete synthetic Q1-Q7 candidate can qualify", () => {
  const fixture = qualifiedFixture();
  const result = assertChatGPTNormalTransportQualified(fixture);
  assert.equal(result.status, "QUALIFIED");
  assert.equal(result.qualified, true);
});

test("Q5 cannot pass when evidence claims API or another pool instead of ordinary ChatGPT", () => {
  const fixture = qualifiedFixture();
  fixture.usage_pool.claim = "api";
  const result = evaluateChatGPTNormalTransportQualification(fixture);
  assert.equal(result.status, "FAILED");
  assert.match(result.consistency_errors.join("\n"), /usage_pool\.claim=chatgpt/);
});

test("Q3 cannot pass while browser/private transport mechanisms are enabled", () => {
  const fixture = qualifiedFixture();
  fixture.prohibited_mechanisms.cookie_or_session_token_reuse = true;
  const result = evaluateChatGPTNormalTransportQualification(fixture);
  assert.equal(result.status, "FAILED");
  assert.deepEqual(result.prohibited_mechanisms, ["cookie_or_session_token_reuse"]);
});

test("Q1 PASS requires an official OpenAI HTTPS documentation reference", () => {
  const fixture = qualifiedFixture();
  fixture.gates.Q1_DOCUMENTED_TRANSPORT.evidence = ["https://example.com/not-openai"];
  const result = evaluateChatGPTNormalTransportQualification(fixture);
  assert.equal(result.status, "FAILED");
  assert.match(result.consistency_errors.join("\n"), /OpenAI documentation reference/);
});

test("malformed or incomplete evidence fails closed", () => {
  const fixture = qualifiedFixture();
  delete fixture.gates.Q7_FAILURE_SEMANTICS;
  assert.throws(() => evaluateChatGPTNormalTransportQualification(fixture), (error) => error.code === "CHATGPT_TRANSPORT_GATE_REQUIRED");
});
