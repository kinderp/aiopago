import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContextDomainDescriptor, ContextDomainRegistry } from "../src/context-domain.mjs";
import { ContextStateStore, DurableContextCursorBook } from "../src/context-state.mjs";
import { ContextSyncCoordinator } from "../src/context-sync.mjs";
import { defineProviderAdapter, installProviderAdapters } from "../src/provider-adapter.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const TASK = "TASK-CONTEXT-DURABILITY";
const DOMAIN_ID = "external-durable:spike";
const PROVIDER = "external-durable";
const MODEL = "external-durable-model";
const ADAPTER = "external-durable-adapter";

const domain = createContextDomainDescriptor({
  context_domain_id: DOMAIN_ID,
  kind: "external-stateful",
  provider_id: PROVIDER,
  model_id: MODEL,
  usage_pool: "external-test",
  transport_adapter_id: ADAPTER,
  capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
});

function user(id, text) {
  return { type: "message", id, parentId: null, timestamp: "2026-09-02T00:00:00.000Z", message: { role: "user", content: text, timestamp: 1 } };
}

class FakeSessionManager {
  constructor(sessionId, entries = []) {
    this.sessionId = sessionId;
    this.entries = entries;
  }
  getSessionId() { return this.sessionId; }
  getBranch() { return this.entries; }
}

function storagePath() {
  return join(mkdtempSync(join(tmpdir(), "aiopago-context-state-")), "guardian.sqlite");
}

function registry() {
  const domains = new ContextDomainRegistry();
  domains.register(domain);
  return domains;
}

function coordinator(stateStore, cursorBook, manager) {
  return new ContextSyncCoordinator({
    contextDomains: registry(),
    cursorBook,
    stateStore,
    ledger: { read: () => ({ task_id: TASK, plan_revision_id: "PLAN-1", objective: "durable context", next_step: "continue" }) },
    observeGit: () => ({ repository_id: "repo", branch: "main", head_sha: "abc", base_sha: "abc", index_digest: "idx", worktree_digest: "wt", status_entries: [] }),
  });
}

test("durable cursor survives GuardianStorage restart without replaying acknowledged entries", () => {
  const path = storagePath();
  const manager = new FakeSessionManager("SES-DURABLE", [user("u1", "one")]);

  const firstStorage = new GuardianStorage(path);
  const firstState = new ContextStateStore(firstStorage, TASK);
  const firstBook = new DurableContextCursorBook(firstState);
  const window = firstBook.plan(DOMAIN_ID, manager);
  firstBook.commit(window);
  assert.equal(firstBook.get(DOMAIN_ID).entry_id, "u1");
  firstStorage.close();

  const secondStorage = new GuardianStorage(path);
  try {
    const secondState = new ContextStateStore(secondStorage, TASK);
    const secondBook = new DurableContextCursorBook(secondState);
    assert.equal(secondBook.get(DOMAIN_ID).entry_id, "u1");
    assert.equal(secondBook.plan(DOMAIN_ID, manager).entries.length, 0, "restart must resume from durable acknowledged cursor");

    const wrongSession = new FakeSessionManager("SES-OTHER", manager.entries);
    assert.throws(() => secondBook.plan(DOMAIN_ID, wrongSession), (error) => error?.code === "CONTEXT_CURSOR_SESSION_MISMATCH");
  } finally {
    secondStorage.close();
  }
});

test("remote conversation binding is durable, opaque, conflict-safe and secret-scanned", () => {
  const path = storagePath();
  const firstStorage = new GuardianStorage(path);
  const firstState = new ContextStateStore(firstStorage, TASK);
  const created = firstState.ensureBinding(domain);
  const bound = firstState.bindExternalThread(DOMAIN_ID, "conversation-opaque-123");
  assert.equal(bound.binding_id, created.binding_id);
  assert.equal(bound.external_thread_id, "conversation-opaque-123");
  assert.throws(() => firstState.bindExternalThread(DOMAIN_ID, "different-thread"), (error) => error?.code === "CONTEXT_BINDING_THREAD_CONFLICT");
  assert.throws(() => {
    const freshTaskState = new ContextStateStore(firstStorage, `${TASK}-SECRET`);
    const freshDomain = { ...domain, context_domain_id: `${DOMAIN_ID}:secret` };
    freshTaskState.ensureBinding(freshDomain);
    freshTaskState.bindExternalThread(freshDomain.context_domain_id, "sk-abcdefghijklmnop");
  }, (error) => error?.code === "SECRET_SCAN_FAILED");
  firstStorage.close();

  const secondStorage = new GuardianStorage(path);
  try {
    const secondState = new ContextStateStore(secondStorage, TASK);
    const restored = secondState.getBinding(DOMAIN_ID);
    assert.equal(restored.binding_id, created.binding_id);
    assert.equal(restored.external_thread_id, "conversation-opaque-123");
  } finally {
    secondStorage.close();
  }
});

test("prepared external delivery becomes reconciliation-required after restart and never silently replays", () => {
  const path = storagePath();
  const manager = new FakeSessionManager("SES-DELIVERY", [user("u1", "send once")]);

  const firstStorage = new GuardianStorage(path);
  const firstState = new ContextStateStore(firstStorage, TASK);
  const firstBook = new DurableContextCursorBook(firstState);
  const firstSync = coordinator(firstState, firstBook, manager);
  const projected = firstSync.project({}, { model: { provider: PROVIDER, id: MODEL }, sessionManager: manager });
  assert.ok(projected);
  assert.equal(firstState.latestDelivery(DOMAIN_ID).state, "PREPARED");
  firstStorage.close();

  const secondStorage = new GuardianStorage(path);
  try {
    const secondState = new ContextStateStore(secondStorage, TASK);
    const secondBook = new DurableContextCursorBook(secondState);
    const secondSync = coordinator(secondState, secondBook, manager);
    const ctx = { model: { provider: PROVIDER, id: MODEL }, sessionManager: manager };

    assert.throws(() => secondSync.project({}, ctx), (error) => error?.code === "CONTEXT_SYNC_RECONCILIATION_REQUIRED");
    assert.equal(secondState.latestDelivery(DOMAIN_ID).state, "RECONCILIATION_REQUIRED");

    secondSync.resolveReconciliation(DOMAIN_ID, "retry-from-last-acknowledged");
    assert.equal(secondState.latestDelivery(DOMAIN_ID).state, "RETRY_APPROVED");
    const retry = secondSync.project({}, ctx);
    assert.ok(retry);
    assert.equal(secondState.latestDelivery(DOMAIN_ID).state, "PREPARED");
    assert.equal(secondState.latestDelivery(DOMAIN_ID).attempt, 2);
  } finally {
    secondStorage.close();
  }
});

test("provider adapter receives restored thread binding without receiving durable state authority", async () => {
  const path = storagePath();
  const storage = new GuardianStorage(path);
  try {
    const state = new ContextStateStore(storage, TASK);
    const original = state.ensureBinding(domain);
    state.bindExternalThread(DOMAIN_ID, "conversation-existing-789");

    const seen = [];
    const runtime = {
      providers: new Map(),
      getProvider(id) { return this.providers.get(id) ?? null; },
      getModels(id) { return this.providers.get(id)?.getModels?.() ?? []; },
      registerNativeProvider(provider) { this.providers.set(provider.id, provider); },
    };
    const adapter = defineProviderAdapter({
      adapter_id: ADAPTER,
      provider_id: PROVIDER,
      context_domain: {
        context_domain_id: DOMAIN_ID,
        kind: "external-stateful",
        model_id: MODEL,
        usage_pool: "external-test",
        capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
      },
      install: async (installContext) => {
        seen.push(installContext);
        installContext.modelRuntime.registerNativeProvider({ id: PROVIDER, getModels: () => [{ id: MODEL }] });
      },
    });

    const installed = await installProviderAdapters([adapter], {
      modelRuntime: runtime,
      pi: {},
      contextDomains: new ContextDomainRegistry(),
      contextState: state,
      allowExperimentalExternal: true,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].binding.external_thread_id, "conversation-existing-789");
    assert.equal("contextState" in seen[0], false, "adapter install must not receive ContextStateStore");
    assert.equal(typeof seen[0].bindExternalThread, "function", "adapter may retain only the narrow remote-thread binding capability");
    assert.equal(installed.installed[0].binding_id, original.binding_id);
    assert.equal(installed.installed[0].transport_support_status, "experimental-nonproduction");
  } finally {
    storage.close();
  }
});

test("durable handoff baseline survives process-style state reconstruction", () => {
  const path = storagePath();
  const baseline = {
    schema_version: "0.1.0",
    context_domain_id: DOMAIN_ID,
    binding_id: "CTXBIND-test",
    handoff_id: "HO-test",
    checkpoint_id: "CP-test",
    source_session_id: "SES-A",
    target_session_id: "SES-B",
    source_cursor: { schema_version: "0.1.0", session_id: "SES-A", entry_id: "a1", branch_depth: 2 },
    source_tail_cursor: { schema_version: "0.1.0", session_id: "SES-A", entry_id: "a2", branch_depth: 4 },
    source_lag_entry_count: 2,
    target_cursor: { schema_version: "0.1.0", session_id: "SES-B", entry_id: null, branch_depth: 0 },
    rebase_policy: "durable_checkpoint_epoch",
  };

  const firstStorage = new GuardianStorage(path);
  const firstState = new ContextStateStore(firstStorage, TASK);
  firstState.setBaseline(DOMAIN_ID, baseline, { handoffId: baseline.handoff_id });
  firstStorage.close();

  const secondStorage = new GuardianStorage(path);
  try {
    const restored = new ContextStateStore(secondStorage, TASK).getBaseline(DOMAIN_ID);
    assert.equal(restored.handoff_id, baseline.handoff_id);
    assert.equal(restored.checkpoint_id, baseline.checkpoint_id);
  } finally {
    secondStorage.close();
  }
});
