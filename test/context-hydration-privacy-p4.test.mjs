import assert from "node:assert/strict";
import test from "node:test";
import { ContextDomainRegistry } from "../src/context-domain.mjs";
import {
  CONTEXT_TRANSFER_SCHEMA_VERSION,
  ContextCursorBook,
  DEFAULT_CONTEXT_HYDRATION_POLICY,
  hydrateContextTransfer,
} from "../src/context-transfer.mjs";
import { ContextSyncCoordinator } from "../src/context-sync.mjs";

const PROVIDER = "external-p4";
const MODEL = "external-p4-model";
const DOMAIN = "external:p4";

function user(id, text) {
  return { type: "message", id, parentId: null, timestamp: "2026-09-03T00:00:00.000Z", message: { role: "user", content: text, timestamp: 1 } };
}

function toolCallingAssistant(id, toolCallId = "read-1") {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-03T00:00:01.000Z",
    message: {
      role: "assistant",
      provider: PROVIDER,
      model: MODEL,
      content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "state.txt" } }],
      stopReason: "toolUse",
      timestamp: 2,
    },
  };
}

function toolResult(id, toolCallId, text) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-03T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 3,
    },
  };
}

class FakeSessionManager {
  constructor(entries = []) { this.entries = entries; }
  getSessionId() { return "SES-P4"; }
  getBranch() { return this.entries; }
}

function registry() {
  const domains = new ContextDomainRegistry();
  domains.register({
    context_domain_id: DOMAIN,
    kind: "external-stateful",
    provider_id: PROVIDER,
    model_id: MODEL,
    usage_pool: "external-test",
    transport_adapter_id: "adapter-p4",
    capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
  });
  return domains;
}

function coordinator(entries, { evidenceProvider = () => [], hydrationBudget = undefined, protocolBudget = undefined } = {}) {
  const sessionManager = new FakeSessionManager(entries);
  const contextDomains = registry();
  const sync = new ContextSyncCoordinator({
    contextDomains,
    ledger: { read: () => ({ task_id: "TASK-P4", plan_revision_id: "PLAN-P4", objective: "bounded privacy", next_step: "continue" }) },
    observeGit: () => ({ repository_id: "repo-p4", branch: "main", head_sha: "abc", base_sha: "abc", index_digest: "idx", worktree_digest: "wt", status_entries: [] }),
    evidenceProvider,
    hydrationBudget,
    protocolBudget,
  });
  return { sync, sessionManager, ctx: { model: { provider: PROVIDER, id: MODEL }, sessionManager } };
}

function targetDomain() {
  return registry().resolve({ provider: PROVIDER, id: MODEL });
}

test("P4 hydration is deterministic, durable-first, provenance-oriented and excludes raw tool output", () => {
  const manager = new FakeSessionManager([
    user("u1", "RECENT_CONTEXT_MUST_LOSE_BUDGET_PRIORITY"),
    toolResult("t1", "other-call", "RAW_TOOL_OUTPUT_MUST_NOT_ENTER_HYDRATION"),
  ]);
  const cursors = new ContextCursorBook();
  const window = cursors.plan(DOMAIN, manager);
  assert.equal(window.schema_version, CONTEXT_TRANSFER_SCHEMA_VERSION);

  const input = {
    window,
    targetDomain: targetDomain(),
    ledger: { task_id: "TASK", objective: "DURABLE_OBJECTIVE" },
    evidence: [{ kind: "checkpoint", source: "CP-1", text: "EVIDENCE" }],
    hydrationBudget: {
      max_entries: 8,
      max_total_chars: 43,
      max_entry_chars: 100,
      max_evidence_items: 8,
      max_git_status_entries: 8,
      max_metadata_chars: 100,
    },
  };
  const first = hydrateContextTransfer(input);
  const second = hydrateContextTransfer(input);
  assert.deepEqual(first, second, "hydration must not depend on clocks, models or hidden summarizers");
  assert.deepEqual(first.privacy_policy, DEFAULT_CONTEXT_HYDRATION_POLICY);
  assert.equal(first.project.objective, "DURABLE_OBJECTIVE");
  assert.equal(first.hydrated_evidence[0].text, "EVIDENCE", "evidence must consume budget before recent transcript projection");
  assert.equal(first.recent_context.length, 0, "recent conversation must lose budget priority to durable evidence");
  assert.equal(first.projection_stats.raw_tool_result_entries_excluded, 1);
  assert.equal(JSON.stringify(first).includes("RAW_TOOL_OUTPUT_MUST_NOT_ENTER_HYDRATION"), false);
  assert.equal("entries" in first, false, "hydrated output must not expose the raw Pi window/transcript");
  assert.equal(first.privacy_policy.transcript_dump, false);
  assert.equal(first.privacy_policy.summarization, "none");
  assert.equal(first.truncation.truncated, true);
  assert.ok(first.truncation.reasons.includes("max_total_chars"));
  assert.equal(first.truncation.emitted_chars + first.truncation.remaining_chars, first.budget.max_total_chars);

  const roomy = hydrateContextTransfer({ ...input, hydrationBudget: undefined });
  assert.deepEqual(roomy.project.source_ref, { kind: "task-ledger", task_id: "TASK", plan_revision_id: null });
  assert.deepEqual(roomy.hydrated_evidence[0].source_ref, { kind: "evidence", ref: "CP-1" });
  assert.deepEqual(roomy.recent_context[0].source_ref, { kind: "pi-entry", entry_id: "u1" });
});

test("P4 hydration budget rejects unknown fields instead of silently changing semantics", () => {
  const manager = new FakeSessionManager([user("u1", "safe")]);
  const window = new ContextCursorBook().plan(DOMAIN, manager);
  assert.throws(
    () => hydrateContextTransfer({ window, targetDomain: targetDomain(), hydrationBudget: { max_entries: 1, include_tool_results: 1 } }),
    (error) => error?.code === "CONTEXT_HYDRATION_BUDGET_FIELD_UNKNOWN",
  );
});

test("P4 live tool continuation is separate from hydration, correlated, bounded and explicitly truncated", () => {
  const initialEntries = [user("u1", "read the state"), toolCallingAssistant("a1")];
  const { sync, sessionManager, ctx } = coordinator(initialEntries, {
    protocolBudget: { max_tool_results: 2, max_total_tool_result_chars: 4, max_tool_result_chars: 4, max_live_user_chars: 100 },
  });
  const acknowledged = sync.cursorBook.plan(DOMAIN, sessionManager);
  sync.cursorBook.commit(acknowledged);
  sessionManager.entries = [...sessionManager.entries, toolResult("t1", "read-1", "ABCDEFGHI")];

  const projected = sync.project({}, ctx);
  assert.equal(projected.envelope.privacy_boundary.historical_raw_tool_output, "excluded");
  assert.equal(projected.envelope.privacy_boundary.live_tool_result_policy, "domain-owned-post-watermark-correlated-bounded");
  assert.equal(projected.envelope.protocol_tool_results.purpose, "live-correlated-tool-continuation");
  assert.equal(projected.envelope.protocol_tool_results.historical_hydration, false);
  assert.equal(projected.envelope.protocol_tool_results.items.length, 1);
  const result = projected.envelope.protocol_tool_results.items[0];
  assert.equal(result.text, "ABCD");
  assert.equal(result.truncation.truncated, true);
  assert.equal(result.truncation.original_chars, 9);
  assert.deepEqual(result.source_ref, { kind: "pi-tool-result", entry_id: "t1" });
  assert.equal(projected.envelope.transfer.projection_stats.raw_tool_result_entries_excluded, 1);
  assert.equal(JSON.stringify(projected.envelope.transfer).includes("ABCD"), false, "live tool output must not be smuggled into historical hydration");
  assert.equal(projected.envelope.truncation.truncated, true);
  assert.ok(projected.envelope.truncation.reasons.includes("tool_continuation:max_total_tool_result_chars") || projected.envelope.truncation.reasons.includes("tool_continuation:max_tool_result_chars"));
});

test("P4 final complete-envelope secret scan covers correlated tool continuation before pending transport state", () => {
  const initialEntries = [user("u1", "read the state"), toolCallingAssistant("a1")];
  const { sync, sessionManager, ctx } = coordinator(initialEntries);
  const acknowledged = sync.cursorBook.plan(DOMAIN, sessionManager);
  sync.cursorBook.commit(acknowledged);
  sessionManager.entries = [...sessionManager.entries, toolResult("t1", "read-1", "sk-abcdefghijklmnop")];

  assert.throws(() => sync.project({}, ctx), (error) => error?.code === "SECRET_SCAN_FAILED");
  assert.equal(sync.pending.size, 0, "secret failure must happen before transport pending state is recorded");
  assert.equal(sync.projectionFor(DOMAIN), null);
});
