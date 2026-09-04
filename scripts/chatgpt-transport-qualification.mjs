import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CHATGPT_NORMAL_TRANSPORT_QUALIFICATION_SCHEMA = "aiopago.chatgpt-normal-transport-qualification/0.1.0";
export const CHATGPT_NORMAL_QUALIFICATION_GATES = Object.freeze([
  "Q1_DOCUMENTED_TRANSPORT",
  "Q2_CONVERSATION_CAPABILITY",
  "Q3_IDENTITY_SAFETY",
  "Q4_STATE_SEMANTICS",
  "Q5_USAGE_POOL_EVIDENCE",
  "Q6_PI_TOOL_LOOP",
  "Q7_FAILURE_SEMANTICS",
]);

const GATE_STATUSES = new Set(["PASS", "BLOCKED", "FAIL"]);
const PROHIBITED_MECHANISMS = Object.freeze([
  "browser_automation",
  "dom_extraction",
  "cookie_or_session_token_reuse",
  "private_endpoint_reuse",
  "restriction_circumvention",
]);
const OFFICIAL_OPENAI_HOSTS = new Set(["openai.com", "www.openai.com", "help.openai.com", "developers.openai.com", "platform.openai.com"]);

function invariant(condition, code, message = code) {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function strings(value, code) {
  invariant(Array.isArray(value), code);
  const normalized = value.map((item) => String(item ?? "").trim());
  invariant(normalized.every(Boolean), code);
  return normalized;
}

function officialOpenAIReference(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && OFFICIAL_OPENAI_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function evaluateChatGPTNormalTransportQualification(input) {
  invariant(plainRecord(input), "CHATGPT_TRANSPORT_QUALIFICATION_INVALID");
  invariant(input.schema === CHATGPT_NORMAL_TRANSPORT_QUALIFICATION_SCHEMA, "CHATGPT_TRANSPORT_QUALIFICATION_SCHEMA_UNSUPPORTED");
  invariant(typeof input.candidate_id === "string" && input.candidate_id.trim(), "CHATGPT_TRANSPORT_CANDIDATE_ID_REQUIRED");
  invariant(typeof input.observed_at === "string" && input.observed_at.trim(), "CHATGPT_TRANSPORT_OBSERVED_AT_REQUIRED");
  invariant(plainRecord(input.gates), "CHATGPT_TRANSPORT_GATES_REQUIRED");
  invariant(plainRecord(input.prohibited_mechanisms), "CHATGPT_TRANSPORT_PROHIBITED_MECHANISMS_REQUIRED");

  const gateResults = [];
  const consistencyErrors = [];

  for (const gateId of CHATGPT_NORMAL_QUALIFICATION_GATES) {
    const gate = input.gates[gateId];
    invariant(plainRecord(gate), "CHATGPT_TRANSPORT_GATE_REQUIRED", gateId);
    invariant(GATE_STATUSES.has(gate.status), "CHATGPT_TRANSPORT_GATE_STATUS_INVALID", `${gateId}:${gate.status}`);
    const evidence = strings(gate.evidence ?? [], "CHATGPT_TRANSPORT_GATE_EVIDENCE_INVALID");
    invariant(gate.status !== "PASS" || evidence.length > 0, "CHATGPT_TRANSPORT_PASS_EVIDENCE_REQUIRED", gateId);
    gateResults.push(Object.freeze({ gate_id: gateId, status: gate.status, evidence: Object.freeze(evidence) }));
  }

  const prohibited = [];
  for (const key of PROHIBITED_MECHANISMS) {
    invariant(typeof input.prohibited_mechanisms[key] === "boolean", "CHATGPT_TRANSPORT_PROHIBITED_MECHANISM_INVALID", key);
    if (input.prohibited_mechanisms[key]) prohibited.push(key);
  }

  const q1 = input.gates.Q1_DOCUMENTED_TRANSPORT;
  if (q1.status === "PASS" && !strings(q1.evidence, "CHATGPT_TRANSPORT_GATE_EVIDENCE_INVALID").some(officialOpenAIReference)) {
    consistencyErrors.push("Q1 PASS requires at least one HTTPS OpenAI documentation reference");
  }

  const q3 = input.gates.Q3_IDENTITY_SAFETY;
  if (q3.status === "PASS" && prohibited.length > 0) {
    consistencyErrors.push(`Q3 PASS conflicts with prohibited mechanisms: ${prohibited.join(", ")}`);
  }

  const usage = plainRecord(input.usage_pool) ? input.usage_pool : {};
  const q5 = input.gates.Q5_USAGE_POOL_EVIDENCE;
  if (q5.status === "PASS") {
    if (usage.claim !== "chatgpt") consistencyErrors.push(`Q5 PASS requires usage_pool.claim=chatgpt, got ${usage.claim ?? "missing"}`);
    const beforeAfter = Array.isArray(usage.before_after_evidence) ? usage.before_after_evidence.filter((item) => String(item ?? "").trim()) : [];
    if (beforeAfter.length === 0) consistencyErrors.push("Q5 PASS requires controlled before/after usage-pool evidence");
  }

  let status = "QUALIFIED";
  if (consistencyErrors.length > 0 || prohibited.length > 0 || gateResults.some((gate) => gate.status === "FAIL")) status = "FAILED";
  else if (gateResults.some((gate) => gate.status === "BLOCKED")) status = "BLOCKED";

  return Object.freeze({
    schema: CHATGPT_NORMAL_TRANSPORT_QUALIFICATION_SCHEMA,
    candidate_id: input.candidate_id.trim(),
    observed_at: input.observed_at.trim(),
    status,
    qualified: status === "QUALIFIED",
    gate_results: Object.freeze(gateResults),
    prohibited_mechanisms: Object.freeze(prohibited),
    consistency_errors: Object.freeze(consistencyErrors),
  });
}

export function assertChatGPTNormalTransportQualified(input) {
  const result = evaluateChatGPTNormalTransportQualification(input);
  invariant(result.qualified, "CHATGPT_NORMAL_TRANSPORT_NOT_QUALIFIED", `${result.status}: ${result.consistency_errors.join("; ") || "Q1-Q7 incomplete"}`);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const [path, flag, expected] = argv;
  invariant(path, "CHATGPT_TRANSPORT_EVIDENCE_PATH_REQUIRED");
  invariant(flag === "--expect" && ["QUALIFIED", "BLOCKED", "FAILED"].includes(expected), "CHATGPT_TRANSPORT_EXPECTATION_REQUIRED", "Usage: node scripts/chatgpt-transport-qualification.mjs <evidence.json> --expect <QUALIFIED|BLOCKED|FAILED>");
  const input = JSON.parse(await readFile(path, "utf8"));
  const result = evaluateChatGPTNormalTransportQualification(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== expected) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`${error.code ?? "CHATGPT_TRANSPORT_QUALIFICATION_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  });
}
