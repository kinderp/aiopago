import assert from "node:assert/strict";
import test from "node:test";
import { buildAttributionSnapshot } from "../src/attribution.mjs";
import { ContextDomainRegistry } from "../src/context-domain.mjs";
import { MeasurementInstrumentation } from "../src/metrics.mjs";

class MemoryMetricStorage {
  constructor() {
    this.sessions = new Map();
    this.samples = [];
    this.diagnostics = [];
    this.operations = [];
  }
  getMetricSession(sessionId) { return this.sessions.get(sessionId) ?? null; }
  upsertMetricSession(record) { this.sessions.set(record.session_id, structuredClone(record)); return this.getMetricSession(record.session_id); }
  appendMetricSample(record, sessionSummary) {
    this.samples.push(structuredClone(record));
    this.sessions.set(sessionSummary.session_id, structuredClone(sessionSummary));
    return record;
  }
  appendMetricDiagnostic(record) { this.diagnostics.push(structuredClone(record)); return record; }
  metricSamples(sessionId = null) { return this.samples.filter((sample) => sessionId === null || sample.session_id === sessionId).map((sample) => structuredClone(sample)); }
  operationsForTask(taskId) { return this.operations.filter((operation) => operation.task_id === taskId).map((operation) => structuredClone(operation)); }
  findHandoffByTarget() { return null; }
  findHandoffBySource() { return null; }
}

function usage(input, output, reasoning = 0, cacheRead = 0, cacheWrite = 0) {
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant({ provider, model, timestamp, usageValue, content }) {
  return { role: "assistant", provider, model, timestamp, usage: usageValue, content };
}

const task = {
  task_id: "TASK-S7",
  current_item: "ITEM-S7",
};

const ctx = {
  cwd: "/repo",
  sessionManager: { getSessionId: () => "SES-S7" },
  getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
};

test("S7: metric samples preserve safe model/pool/tool attribution without code or shell text", () => {
  const storage = new MemoryMetricStorage();
  const domains = new ContextDomainRegistry();
  domains.register({
    context_domain_id: "chatgpt-normal:test",
    kind: "external-stateful",
    provider_id: "chat-provider",
    model_id: "chat-model",
    usage_pool: "chatgpt",
    transport_adapter_id: "official-sentinel",
    capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
  });
  const metrics = new MeasurementInstrumentation({
    storage,
    ledger: { read: () => task },
    runnerInstanceId: "RUNNER-S7",
    thresholdPercent: 50,
    contextDomains: domains,
  });

  const secretOld = "SUPER_SECRET_OLD_LINE\nSUPER_SECRET_OLD_TWO";
  const secretNew = "SUPER_SECRET_NEW_LINE\nSUPER_SECRET_NEW_TWO\nSUPER_SECRET_NEW_THREE";
  const secretCommand = "pytest && echo SUPER_SECRET_SHELL_VALUE";

  metrics.captureModelCall({
    message: assistant({
      provider: "chat-provider",
      model: "chat-model",
      timestamp: 1,
      usageValue: usage(100, 50, 5, 10, 0),
      content: [
        { type: "toolCall", id: "chat-read-1", name: "read", arguments: { path: "/repo/src/romeo.py" } },
      ],
    }),
  }, ctx);

  metrics.captureModelCall({
    message: assistant({
      provider: "code-provider",
      model: "code-model",
      timestamp: 2,
      usageValue: usage(300, 100, 20, 40, 5),
      content: [
        { type: "toolCall", id: "code-edit-1", name: "edit", arguments: { path: "/repo/src/romeo.py", oldText: secretOld, newText: secretNew } },
        { type: "toolCall", id: "code-bash-1", name: "bash", arguments: { command: secretCommand } },
      ],
    }),
  }, ctx);

  storage.operations.push(
    { operation_id: "chat-read-1", task_id: task.task_id, state: "TERMINAL", outcome: "KNOWN_SUCCESS", profile: "READ_ONLY", effect_reference: null },
    { operation_id: "code-edit-1", task_id: task.task_id, state: "TERMINAL", outcome: "KNOWN_SUCCESS", profile: "LOCAL_ATOMIC_MUTATION", effect_reference: "file:src/romeo.py" },
    { operation_id: "code-bash-1", task_id: task.task_id, state: "TERMINAL", outcome: "KNOWN_FAILURE", profile: "SHELL_ATOMIC_OPERATION", effect_reference: null },
  );

  assert.equal(storage.diagnostics.length, 0);
  assert.equal(storage.samples.length, 2);

  const chat = storage.samples[0];
  assert.equal(chat.attribution.context_domain_id, "chatgpt-normal:test");
  assert.equal(chat.attribution.context_domain_kind, "external-stateful");
  assert.equal(chat.attribution.usage_pool, "chatgpt");
  assert.equal(chat.attribution.context_usage_semantic, "pi_session_runtime_not_remote_provider_context");
  assert.equal(chat.activity.calls[0].target_path, "src/romeo.py");

  const code = storage.samples[1];
  assert.equal(code.attribution.context_domain_kind, "pi-native");
  assert.equal(code.attribution.usage_pool, "code-provider");
  assert.equal(code.activity.requested_tool_calls, 2);
  assert.equal(code.activity.calls[0].tool_class, "mutation");
  assert.equal(code.activity.calls[0].target_path, "src/romeo.py");
  assert.equal(code.activity.calls[0].requested_removed_lines, 2);
  assert.equal(code.activity.calls[0].requested_added_lines, 3);
  assert.equal(code.activity.calls[1].tool_class, "shell");
  assert.equal(code.activity.calls[1].target_path, null);

  const serialized = JSON.stringify(storage.samples);
  assert.doesNotMatch(serialized, /SUPER_SECRET_OLD/);
  assert.doesNotMatch(serialized, /SUPER_SECRET_NEW/);
  assert.doesNotMatch(serialized, /SUPER_SECRET_SHELL_VALUE/);
  assert.doesNotMatch(serialized, /pytest/);
});

test("S7: attribution snapshot exposes exact pool/model/tool primitives and refuses to invent work mix", () => {
  const storage = new MemoryMetricStorage();
  storage.samples = [
    {
      session_id: "SES-S7",
      task_id: task.task_id,
      model: { provider: "chat-provider", id: "chat-model" },
      attribution: { usage_pool: "chatgpt", context_domain_kind: "external-stateful" },
      usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 5, cache_read_tokens: 10, cache_write_tokens: 0 },
      activity: { calls: [{ tool_call_id: "chat-read-1", tool_class: "read", target_path: "src/romeo.py", requested_added_lines: null, requested_removed_lines: null, requested_written_lines: null }] },
    },
    {
      session_id: "SES-S7",
      task_id: task.task_id,
      model: { provider: "code-provider", id: "code-model" },
      attribution: { usage_pool: "codex", context_domain_kind: "pi-native" },
      usage: { input_tokens: 300, output_tokens: 150, reasoning_tokens: 50, cache_read_tokens: 20, cache_write_tokens: 10 },
      activity: { calls: [
        { tool_call_id: "code-edit-1", tool_class: "mutation", target_path: "src/romeo.py", requested_added_lines: 3, requested_removed_lines: 2, requested_written_lines: null },
        { tool_call_id: "code-bash-1", tool_class: "shell", target_path: null, requested_added_lines: null, requested_removed_lines: null, requested_written_lines: null },
      ] },
    },
  ];
  storage.operations = [
    { operation_id: "chat-read-1", task_id: task.task_id, state: "TERMINAL", outcome: "KNOWN_SUCCESS" },
    { operation_id: "code-edit-1", task_id: task.task_id, state: "TERMINAL", outcome: "KNOWN_SUCCESS" },
    { operation_id: "code-bash-1", task_id: task.task_id, state: "TERMINAL", outcome: "KNOWN_FAILURE" },
  ];

  const snapshot = buildAttributionSnapshot({ storage, sessionId: "SES-S7" });
  assert.equal(snapshot.model_calls, 2);
  assert.equal(snapshot.primary_tokens_observed, 600);
  assert.equal(snapshot.usage_pools.length, 2);

  const chat = snapshot.usage_pools.find((entry) => entry.key === "chatgpt");
  const codex = snapshot.usage_pools.find((entry) => entry.key === "codex");
  assert.equal(chat.call_share_percent, 50);
  assert.equal(codex.call_share_percent, 50);
  assert.equal(chat.primary_token_share_percent, 25);
  assert.equal(codex.primary_token_share_percent, 75);
  assert.equal(chat.reasoning_tokens, 5, "reasoning remains separate from primary token share");
  assert.equal(codex.cache_read_tokens, 20, "cache remains separate from primary token share");

  const chatTools = snapshot.tools_by_usage_pool.find((entry) => entry.usage_pool === "chatgpt");
  const codeTools = snapshot.tools_by_usage_pool.find((entry) => entry.usage_pool === "codex");
  assert.equal(chatTools.requested_tool_calls, 1);
  assert.equal(chatTools.known_success, 1);
  assert.deepEqual(chatTools.successful_file_targets, ["src/romeo.py"]);
  assert.equal(codeTools.requested_tool_calls, 2);
  assert.equal(codeTools.known_success, 1);
  assert.equal(codeTools.known_failure, 1);
  assert.equal(codeTools.mutation_calls, 1);
  assert.equal(codeTools.shell_calls, 1);
  assert.equal(codeTools.requested_added_lines, 3);
  assert.equal(codeTools.requested_removed_lines, 2);
  assert.equal(snapshot.work_mix.status, "not_computed");
});
