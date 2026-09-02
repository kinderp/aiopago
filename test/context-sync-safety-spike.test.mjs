import assert from "node:assert/strict";
import test from "node:test";
import { ContextDomainRegistry } from "../src/context-domain.mjs";
import { ContextSyncCoordinator } from "../src/context-sync.mjs";
import { createGuardianExtension } from "../src/extension.mjs";

const PROVIDER = "external-safety-spike";
const MODEL = "external-safety";
const DOMAIN = "external-safety:spike";

function user(id, text) {
  return { type: "message", id, parentId: null, timestamp: "2026-09-02T00:00:00.000Z", message: { role: "user", content: text, timestamp: 1 } };
}

class FakeSessionManager {
  constructor(entries = []) {
    this.entries = entries;
  }
  getSessionId() { return "SES-SAFETY"; }
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
    transport_adapter_id: "external-safety-adapter",
    capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
  });
  return domains;
}

function coordinator(entries, protocolBudget = undefined) {
  const sessionManager = new FakeSessionManager(entries);
  const contextDomains = registry();
  const sync = new ContextSyncCoordinator({
    contextDomains,
    ledger: { read: () => ({ task_id: "TASK-SAFETY", plan_revision_id: "PLAN-1", objective: "safe objective", next_step: "safe next step" }) },
    observeGit: () => ({ repository_id: "repo", branch: "main", head_sha: "abc", base_sha: "abc", index_digest: "idx", worktree_digest: "wt", status_entries: [] }),
    protocolBudget,
  });
  const ctx = { model: { provider: PROVIDER, id: MODEL }, sessionManager };
  return { sync, ctx, sessionManager };
}

test("external context transfer fails closed before transport when a secret-shaped value is present", () => {
  const { sync, ctx } = coordinator([user("u1", "do not send sk-abcdefghijklmnop outside")]);
  assert.throws(() => sync.project({}, ctx), (error) => error?.code === "SECRET_SCAN_FAILED");
  assert.equal(sync.pending.size, 0, "secret rejection must not create a pending external request");
});

test("external provider error becomes explicit reconciliation-required state without silent retry", () => {
  const { sync, ctx, sessionManager } = coordinator([user("u1", "first request")]);
  const first = sync.project({}, ctx);
  assert.ok(first);
  const failure = sync.acknowledgeTurn({
    message: { role: "assistant", provider: PROVIDER, model: MODEL, stopReason: "error", timestamp: 2 },
  }, ctx);
  assert.equal(failure.reconciliation_required.reason, "error");
  assert.equal(sync.pending.size, 0);
  assert.ok(sync.reconciliationFor(DOMAIN));

  sessionManager.entries = [...sessionManager.entries, user("u2", "new user request")];
  assert.throws(() => sync.project({}, ctx), (error) => error?.code === "CONTEXT_SYNC_RECONCILIATION_REQUIRED");

  sync.resolveReconciliation(DOMAIN, "retry-from-last-acknowledged");
  const retried = sync.project({}, ctx);
  assert.equal(retried.envelope.live_user_input.text, "new user request");
});

test("live user input truncation is explicit in the external protocol", () => {
  const { sync, ctx } = coordinator([user("u1", "123456789")], { max_live_user_chars: 4 });
  const projected = sync.project({}, ctx);
  assert.deepEqual(projected.envelope.live_user_input, { text: "1234", truncated: true, original_chars: 9 });
});

test("external-stateful domains are read-only at the Pi tool admission boundary", () => {
  const handlers = new Map();
  const admitted = [];
  const runner = {
    runtime: { session: { model: { provider: PROVIDER, id: MODEL } } },
    contextDomains: registry(),
    toolTracker: { admit: (...args) => admitted.push(args) },
  };
  const pi = {
    registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
  };
  createGuardianExtension(runner)(pi);
  const toolCall = handlers.get("tool_call");
  const ctx = { model: { provider: PROVIDER, id: MODEL } };

  const edit = toolCall({ toolCallId: "edit-1", toolName: "edit", input: { path: "a.txt", oldText: "a", newText: "b" } }, ctx);
  assert.equal(edit.block, true);
  assert.match(edit.reason, /EXTERNAL_CONTEXT_TOOL_NOT_ADMITTED/);
  assert.equal(admitted.length, 0);

  const read = toolCall({ toolCallId: "read-1", toolName: "read", input: { path: "a.txt" } }, ctx);
  assert.equal(read, undefined);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0][1], "read");
});
