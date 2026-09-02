import assert from "node:assert/strict";
import test from "node:test";
import { ContextCursorBook, hydrateContextTransfer } from "../src/context-transfer.mjs";
import { createContextDomainDescriptor } from "../src/context-domain.mjs";

function user(id, parentId, text) {
  return { type: "message", id, parentId, timestamp: "2026-09-02T00:00:00.000Z", message: { role: "user", content: text, timestamp: 1 } };
}

function assistant(id, parentId, provider, model, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-02T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "spike",
      provider,
      model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    },
  };
}

class FakeSessionManager {
  constructor(sessionId, entries = []) {
    this.sessionId = sessionId;
    this.entries = entries;
  }
  getSessionId() { return this.sessionId; }
  getBranch() { return this.entries; }
}

const targetDomain = createContextDomainDescriptor({
  context_domain_id: "chatgpt-normal:spike",
  kind: "external-stateful",
  provider_id: "chatgpt-normal-spike",
  model_id: "chatgpt-normal",
  usage_pool: "chatgpt",
  transport_adapter_id: "official-transport-sentinel",
  capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
});

test("S5: cursor plans only post-watermark entries and advances only on commit", () => {
  const manager = new FakeSessionManager("SES-1", [
    user("u1", null, "Discuss remote control"),
    assistant("a1", "u1", "chatgpt-normal-spike", "chatgpt-normal", "Use WebSocket for control"),
  ]);
  const cursors = new ContextCursorBook();

  const initial = cursors.plan(targetDomain.context_domain_id, manager);
  assert.equal(initial.entries.length, 2);
  assert.equal(initial.source_cursor.entry_id, null);
  assert.equal(initial.target_cursor.entry_id, "a1");
  assert.equal(cursors.get(targetDomain.context_domain_id), null, "planning must not acknowledge delivery");
  cursors.commit(initial);
  assert.equal(cursors.get(targetDomain.context_domain_id).entry_id, "a1");

  manager.entries = [
    ...manager.entries,
    { type: "model_change", id: "m1", parentId: "a1", timestamp: "2026-09-02T00:01:00.000Z", provider: "codex-spike", modelId: "codex-spike" },
    user("u2", "m1", "Implement the agreed design"),
    assistant("a2", "u2", "codex-spike", "codex-spike", "Implemented WebSocket and all tests pass"),
    {
      type: "message",
      id: "t1",
      parentId: "a2",
      timestamp: "2026-09-02T00:02:00.000Z",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "very large raw stdout that must not be copied by default" }], isError: false, timestamp: 3 },
    },
  ];

  const delta = cursors.plan(targetDomain.context_domain_id, manager);
  assert.equal(delta.source_cursor.entry_id, "a1");
  assert.equal(delta.target_cursor.entry_id, "t1");
  assert.deepEqual(delta.entries.map((entry) => entry.id), ["m1", "u2", "a2", "t1"]);
  assert.equal(cursors.get(targetDomain.context_domain_id).entry_id, "a1", "cursor must stay on acknowledged watermark before commit");

  cursors.commit(delta);
  assert.equal(cursors.get(targetDomain.context_domain_id).entry_id, "t1");
  assert.equal(cursors.plan(targetDomain.context_domain_id, manager).entries.length, 0, "same acknowledged branch tail must be idempotent");
});

test("S5: stale commits and branch divergence fail closed", () => {
  const manager = new FakeSessionManager("SES-2", [user("u1", null, "one")]);
  const cursors = new ContextCursorBook();
  const first = cursors.plan(targetDomain.context_domain_id, manager);

  manager.entries = [...manager.entries, assistant("a1", "u1", "codex-spike", "codex-spike", "two")];
  const stillRoot = cursors.plan(targetDomain.context_domain_id, manager);
  cursors.commit(stillRoot);
  assert.throws(() => cursors.commit(first), (error) => error?.code === "CONTEXT_CURSOR_STALE_COMMIT");

  manager.entries = [user("other", null, "different branch")];
  assert.throws(() => cursors.plan(targetDomain.context_domain_id, manager), (error) => error?.code === "CONTEXT_CURSOR_DIVERGED");
});

test("S6: hydrator is bounded, provenance-oriented and excludes raw tool results by default", () => {
  const manager = new FakeSessionManager("SES-3", [
    user("u1", null, "Please implement the agreed architecture"),
    assistant("a1", "u1", "codex-spike", "codex-spike", "Changed server.py and tests now pass"),
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-09-02T00:02:00.000Z",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "RAW_TOOL_OUTPUT_SHOULD_NOT_APPEAR" }], isError: false, timestamp: 3 },
    },
  ]);
  const cursors = new ContextCursorBook();
  const window = cursors.plan(targetDomain.context_domain_id, manager);
  const ledger = {
    task_id: "TASK-ROMEO",
    plan_revision_id: "PLAN-7",
    requirements_version: "REQ-3",
    current_item: "ITEM-WS",
    next_item: "ITEM-RECONNECT",
    objective: "Add browser remote control while keeping the student-facing API simple",
    next_step: "Review the implementation before reconnect work",
    relevant_decisions: ["Use WebSocket for controls", "Keep move(direction) as the educational API"],
    relevant_tests: ["pytest: 190 passed"],
  };
  const gitState = {
    repository_id: "romeo",
    branch: "feat/websocket",
    head_sha: "abc123",
    base_sha: "def456",
    index_digest: "index-digest",
    worktree_digest: "worktree-digest",
    status_entries: ["M src/romeo/server.py", "A tests/test_websocket.py"],
  };
  const bundle = hydrateContextTransfer({
    window,
    targetDomain,
    ledger,
    gitState,
    evidence: [{ kind: "diff", source: "src/romeo/server.py", text: "+ websocket handler\n+ move(command)" }],
  });

  assert.equal(bundle.target_context_domain_id, targetDomain.context_domain_id);
  assert.equal(bundle.project.task_id, "TASK-ROMEO");
  assert.equal(bundle.git.branch, "feat/websocket");
  assert.equal(bundle.recent_context.some((item) => item.text.includes("Changed server.py")), true);
  assert.equal(JSON.stringify(bundle).includes("RAW_TOOL_OUTPUT_SHOULD_NOT_APPEAR"), false);
  assert.equal(bundle.hydrated_evidence[0].source, "src/romeo/server.py");
  assert.equal(bundle.truncated, false);

  const tiny = hydrateContextTransfer({
    window,
    targetDomain,
    ledger,
    evidence: [{ kind: "diff", source: "huge.diff", text: "x".repeat(200) }],
    hydrationBudget: { max_entries: 1, max_total_chars: 30, max_entry_chars: 20, max_evidence_items: 1 },
  });
  assert.equal(tiny.truncated, true);
  const textualSize = [
    tiny.project.objective,
    tiny.project.next_step,
    ...tiny.project.decisions,
    ...tiny.project.tests,
    ...tiny.recent_context.map((item) => item.text),
    ...tiny.hydrated_evidence.map((item) => item.text),
  ].join("").length;
  assert.ok(textualSize <= 30, `hydrated text must respect total budget, got ${textualSize}`);
});
