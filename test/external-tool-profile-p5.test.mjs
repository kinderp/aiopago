import assert from "node:assert/strict";
import test from "node:test";
import { createGuardianExtension } from "../src/extension.mjs";
import { EXTERNAL_STATEFUL_TOOL_PROFILE, evaluateExternalStatefulToolAdmission } from "../src/external-tool-profile.mjs";
import { TOOL_PROFILES } from "../src/safety.mjs";

const external = { context_domain_id: "external:p5", kind: "external-stateful", capabilities: { pi_tools: true } };
const disabled = { context_domain_id: "external:p5-disabled", kind: "external-stateful", capabilities: { pi_tools: false } };
const native = { context_domain_id: "pi:p5", kind: "pi-native", capabilities: { pi_tools: true } };

test("P5 external-stateful tool profile is a closed read/query allowlist", () => {
  assert.deepEqual(EXTERNAL_STATEFUL_TOOL_PROFILE.admitted_tools, ["read", "grep", "find", "ls"]);
  for (const name of EXTERNAL_STATEFUL_TOOL_PROFILE.admitted_tools) {
    assert.equal(TOOL_PROFILES[name], "READ_ONLY", `${name} must also remain read-only in the generic safety core`);
    assert.equal(evaluateExternalStatefulToolAdmission(external, name, TOOL_PROFILES).admitted, true);
  }
  for (const name of ["edit", "write", "bash", "future-read-only-tool", "unknown"]) {
    assert.equal(evaluateExternalStatefulToolAdmission(external, name, { ...TOOL_PROFILES, "future-read-only-tool": "READ_ONLY" }).admitted, false, `${name} must not enter the external surface implicitly`);
  }
});

test("P5 pi_tools=false blocks even an otherwise admitted read tool", () => {
  const decision = evaluateExternalStatefulToolAdmission(disabled, "read", TOOL_PROFILES);
  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, "EXTERNAL_PI_TOOLS_DISABLED");
});

test("P5 generic profile drift can only narrow, never widen, the external allowlist", () => {
  const narrowed = evaluateExternalStatefulToolAdmission(external, "read", { ...TOOL_PROFILES, read: "LOCAL_ATOMIC_MUTATION" });
  assert.equal(narrowed.admitted, false);
  assert.equal(narrowed.reason, "EXTERNAL_TOOL_NOT_READ_ONLY");
  assert.equal(evaluateExternalStatefulToolAdmission(native, "bash", TOOL_PROFILES).admitted, true, "Pi-native provider semantics remain outside the P5 external gate");
});

test("P5 Pi extension enforces closed external profile while preserving Pi-native tool semantics", () => {
  const handlers = new Map();
  const admitted = [];
  let mode = "external";
  const runner = {
    runtime: { session: { model: { provider: "provider", id: "model" } } },
    contextDomains: { resolve: () => mode === "external" ? external : native },
    toolTracker: { admit: (...args) => admitted.push(args), finish() {} },
  };
  const pi = { registerCommand() {}, on(name, handler) { handlers.set(name, handler); } };
  createGuardianExtension(runner)(pi);
  const toolCall = handlers.get("tool_call");
  const ctx = { model: { provider: "provider", id: "model" } };

  for (const name of ["read", "grep", "find", "ls"]) {
    assert.equal(toolCall({ toolCallId: `ok-${name}`, toolName: name, input: {} }, ctx), undefined);
  }
  const admittedBeforeBlocks = admitted.length;
  for (const name of ["edit", "write", "bash", "unknown"]) {
    const result = toolCall({ toolCallId: `blocked-${name}`, toolName: name, input: {} }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /EXTERNAL_CONTEXT_TOOL_NOT_ADMITTED/);
  }
  assert.equal(admitted.length, admittedBeforeBlocks, "blocked external calls must never reach ToolOperationTracker");

  mode = "native";
  assert.equal(toolCall({ toolCallId: "native-edit", toolName: "edit", input: { path: "a" } }, ctx), undefined);
  assert.equal(toolCall({ toolCallId: "native-bash", toolName: "bash", input: {} }, ctx), undefined);
});
