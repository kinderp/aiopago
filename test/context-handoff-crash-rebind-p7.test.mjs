import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContextDomainDescriptor, ContextDomainRegistry } from "../src/context-domain.mjs";
import { ContextStateStore, DurableContextCursorBook } from "../src/context-state.mjs";
import { CONTEXT_HANDOFF_BINDING_VERSION, ContextSyncCoordinator } from "../src/context-sync.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const TASK = "TASK-P7-CRASH";
const DOMAIN_ID = "external:p7-crash";
const PROVIDER = "external-p7-crash";
const MODEL = "external-p7-crash-model";
const SOURCE_SESSION = "SES-P7-SOURCE";
const TARGET_SESSION = "SES-P7-TARGET";
const HANDOFF_ID = "HO-P7-CRASH";
const CHECKPOINT_ID = "CP-P7-CRASH";

const domain = createContextDomainDescriptor({
  context_domain_id: DOMAIN_ID,
  kind: "external-stateful",
  provider_id: PROVIDER,
  model_id: MODEL,
  usage_pool: "external-test",
  transport_adapter_id: "adapter-p7-crash",
  capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
});

function storagePath() {
  return join(mkdtempSync(join(tmpdir(), "aiopago-p7-crash-")), "guardian.sqlite");
}

function cursor(sessionId, entryId = null, branchDepth = 0) {
  return Object.freeze({ schema_version: "0.1.0", session_id: sessionId, entry_id: entryId, branch_depth: branchDepth });
}

class FakeSessionManager {
  constructor(sessionId) { this.sessionId = sessionId; }
  getSessionId() { return this.sessionId; }
  getBranch() { return []; }
}

function registry() {
  const domains = new ContextDomainRegistry();
  domains.register(domain);
  return domains;
}

function coordinator(state, book) {
  return new ContextSyncCoordinator({
    contextDomains: registry(),
    cursorBook: book,
    stateStore: state,
    ledger: { read: () => ({ task_id: TASK, plan_revision_id: "PLAN-P7", objective: "crash-safe rebind", next_step: "resume" }) },
    observeGit: () => ({ repository_id: "repo", branch: "main", head_sha: "abc", base_sha: "abc", index_digest: "idx", worktree_digest: "wt", status_entries: [] }),
  });
}

function setupSource(state) {
  const durableBinding = state.ensureBinding(domain);
  const sourceCursor = cursor(SOURCE_SESSION, "a1", 1);
  const sourceTail = cursor(SOURCE_SESSION, "a3", 3);
  state.setCursor(DOMAIN_ID, sourceCursor);
  return Object.freeze({
    schema_version: CONTEXT_HANDOFF_BINDING_VERSION,
    context_domain_id: DOMAIN_ID,
    binding_id: durableBinding.binding_id,
    provider_id: PROVIDER,
    model_id: MODEL,
    usage_pool: "external-test",
    source_session_id: SOURCE_SESSION,
    source_cursor: sourceCursor,
    source_tail_cursor: sourceTail,
    lag_entry_count: 2,
    rebase_policy: "durable_checkpoint_epoch",
  });
}

function targetSession() {
  return { sessionManager: new FakeSessionManager(TARGET_SESSION) };
}

function rebind(sync, binding) {
  return sync.rebindAfterHandoff({
    bindings: [binding],
    targetSession: targetSession(),
    handoffId: HANDOFF_ID,
    checkpointId: CHECKPOINT_ID,
  });
}

function baselineCount(storage) {
  return storage.db.prepare("SELECT count(*) AS n FROM journal WHERE event_type='CONTEXT_BASELINE_SET'").get().n;
}

function cursorSetCount(storage) {
  return storage.db.prepare("SELECT count(*) AS n FROM journal WHERE event_type='CONTEXT_CURSOR_SET'").get().n;
}

test("P7 restart completes rebind after crash between durable epoch and cursor write", () => {
  const path = storagePath();
  const firstStorage = new GuardianStorage(path);
  const firstState = new ContextStateStore(firstStorage, TASK);
  const binding = setupSource(firstState);
  const firstBook = new DurableContextCursorBook(firstState);
  const firstSync = coordinator(firstState, firstBook);
  const realSetCursor = firstState.setCursor.bind(firstState);
  firstState.setCursor = () => { throw new Error("SIMULATED_CRASH_BEFORE_CURSOR_WRITE"); };

  assert.throws(() => rebind(firstSync, binding), /SIMULATED_CRASH_BEFORE_CURSOR_WRITE/);
  const epochAfterCrash = firstState.getEpoch(DOMAIN_ID);
  assert.equal(epochAfterCrash.handoff_id, HANDOFF_ID, "epoch intent must be durable before cursor rebase");
  assert.equal(epochAfterCrash.target_session_id, TARGET_SESSION);
  firstState.setCursor = realSetCursor;
  assert.equal(firstState.getCursor(DOMAIN_ID).session_id, SOURCE_SESSION, "cursor must still identify source epoch before its durable write");
  assert.equal(baselineCount(firstStorage), 1);
  assert.equal(cursorSetCount(firstStorage), 1, "only initial source cursor should exist before retry");
  firstStorage.close();

  const secondStorage = new GuardianStorage(path);
  try {
    const secondState = new ContextStateStore(secondStorage, TASK);
    const secondBook = new DurableContextCursorBook(secondState);
    const secondSync = coordinator(secondState, secondBook);
    const result = rebind(secondSync, binding);
    assert.equal(result.length, 1);
    assert.equal(result[0].handoff_id, HANDOFF_ID);
    assert.deepEqual(secondState.getCursor(DOMAIN_ID), cursor(TARGET_SESSION));
    assert.equal(secondState.getEpoch(DOMAIN_ID).handoff_id, HANDOFF_ID);
    assert.equal(baselineCount(secondStorage), 1, "retry must reuse the same durable epoch instead of appending another one");
    assert.equal(cursorSetCount(secondStorage), 2, "retry adds exactly one target cursor write");
  } finally {
    secondStorage.close();
  }
});

test("P7 restart recognizes completed durable cursor after crash before in-memory rebase", () => {
  const path = storagePath();
  const firstStorage = new GuardianStorage(path);
  const firstState = new ContextStateStore(firstStorage, TASK);
  const binding = setupSource(firstState);
  const firstBook = new DurableContextCursorBook(firstState);
  const firstSync = coordinator(firstState, firstBook);
  const realSetCursor = firstState.setCursor.bind(firstState);
  firstState.setCursor = (...args) => {
    const persisted = realSetCursor(...args);
    if (persisted.session_id === TARGET_SESSION) throw new Error("SIMULATED_CRASH_AFTER_CURSOR_WRITE");
    return persisted;
  };

  assert.throws(() => rebind(firstSync, binding), /SIMULATED_CRASH_AFTER_CURSOR_WRITE/);
  assert.equal(firstState.getEpoch(DOMAIN_ID).handoff_id, HANDOFF_ID);
  assert.deepEqual(firstState.getCursor(DOMAIN_ID), cursor(TARGET_SESSION), "target cursor write must survive the simulated process loss");
  assert.equal(firstBook.get(DOMAIN_ID).session_id, SOURCE_SESSION, "in-memory cursor intentionally remains stale in the crashed process");
  firstStorage.close();

  const secondStorage = new GuardianStorage(path);
  try {
    const secondState = new ContextStateStore(secondStorage, TASK);
    const secondBook = new DurableContextCursorBook(secondState);
    const secondSync = coordinator(secondState, secondBook);
    const beforeBaselines = baselineCount(secondStorage);
    const beforeCursors = cursorSetCount(secondStorage);
    const result = rebind(secondSync, binding);
    assert.equal(result[0].handoff_id, HANDOFF_ID);
    assert.deepEqual(secondBook.get(DOMAIN_ID), cursor(TARGET_SESSION));
    assert.equal(baselineCount(secondStorage), beforeBaselines, "idempotent retry must not rewrite epoch");
    assert.equal(cursorSetCount(secondStorage), beforeCursors, "already durable target cursor must not be rewritten");
  } finally {
    secondStorage.close();
  }
});
