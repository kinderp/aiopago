import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableId } from "../src/canonical.mjs";
import {
  CONTEXT_EPOCH_SCHEMA_VERSION,
  CONTEXT_STATE_STORAGE_SCHEMA_VERSION,
  ContextStateStore,
} from "../src/context-state.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const TASK = "TASK-P3";
const DOMAIN_ID = "external:p3";
const NOW = "2026-09-03T00:00:00.000Z";
const domain = Object.freeze({
  context_domain_id: DOMAIN_ID,
  kind: "external-stateful",
  provider_id: "provider-p3",
  model_id: "model-p3",
  usage_pool: "external-test",
  transport_adapter_id: "adapter-p3",
});

function storagePath() {
  return join(mkdtempSync(join(tmpdir(), "aiopago-p3-state-")), "guardian.sqlite");
}

function cursor(sessionId, entryId = null, branchDepth = 0) {
  return { schema_version: "0.1.0", session_id: sessionId, entry_id: entryId, branch_depth: branchDepth };
}

function prefix(kind) {
  return `context-${kind}:${stableId("CTXSTATE", TASK, DOMAIN_ID)}:`;
}

function legacyEvent(storage, eventType, kind, suffix, payload) {
  return storage.appendEvent(eventType, payload, { eventKey: `${prefix(kind)}${suffix}` });
}

function bindingPayload(threadId = "thread-existing-p3") {
  return {
    schema_version: "0.1.0",
    binding_id: "CTXBIND-p3",
    task_id: TASK,
    context_domain_id: DOMAIN_ID,
    provider_id: domain.provider_id,
    model_id: domain.model_id,
    usage_pool: domain.usage_pool,
    transport_adapter_id: domain.transport_adapter_id,
    external_thread_id: threadId,
    status: "ACTIVE",
    created_at: NOW,
    updated_at: NOW,
  };
}

function epochPayload() {
  return {
    schema_version: CONTEXT_EPOCH_SCHEMA_VERSION,
    context_domain_id: DOMAIN_ID,
    binding_id: "CTXBIND-p3",
    handoff_id: "HO-p3",
    checkpoint_id: "CP-p3",
    source_session_id: "SES-A",
    target_session_id: "SES-B",
    source_cursor: cursor("SES-A", "a1", 1),
    source_tail_cursor: cursor("SES-A", "a3", 3),
    source_lag_entry_count: 2,
    target_cursor: cursor("SES-B"),
    rebase_policy: "durable_checkpoint_epoch",
  };
}

function deliveryPayload(state = "PREPARED") {
  const base = {
    schema_version: "0.1.0",
    transfer_id: "CTX-p3-transfer",
    task_id: TASK,
    context_domain_id: DOMAIN_ID,
    session_id: "SES-A",
    source_cursor: cursor("SES-A"),
    target_cursor: cursor("SES-A", "a1", 1),
    state,
    attempt: 1,
    failure_reason: state === "RECONCILIATION_REQUIRED" || state === "RETRY_APPROVED" ? "test-reconciliation" : null,
    prepared_at: NOW,
    updated_at: NOW,
  };
  return state === "ACKNOWLEDGED" ? { ...base, acknowledged_at: NOW } : base;
}

function contextRows(storage) {
  return storage.db.prepare("SELECT seq,event_type,event_key,data_json FROM journal WHERE event_key LIKE 'context-%' ORDER BY seq").all();
}

test("P3 adopts compatible pre-productization context state without rewriting journal bytes", () => {
  const storage = new GuardianStorage(storagePath());
  try {
    legacyEvent(storage, "CONTEXT_CURSOR_SET", "cursor", "legacy-cursor", {
      schema_version: "0.1.0", task_id: TASK, context_domain_id: DOMAIN_ID,
      cursor: cursor("SES-A", "a1", 1), updated_at: NOW,
    });
    legacyEvent(storage, "CONTEXT_BINDING_SET", "binding", "legacy-binding", bindingPayload());
    legacyEvent(storage, "CONTEXT_BASELINE_SET", "baseline", "legacy-epoch", {
      schema_version: "0.1.0", task_id: TASK, context_domain_id: DOMAIN_ID,
      baseline: epochPayload(), updated_at: NOW,
    });
    legacyEvent(storage, "CONTEXT_DELIVERY_STATE", "delivery", "legacy-delivery", deliveryPayload());
    const before = contextRows(storage);

    const state = new ContextStateStore(storage, TASK);
    const after = contextRows(storage);
    assert.deepEqual(after, before, "P3 migration must not rewrite legacy context journal payloads");
    assert.deepEqual(storage.db.prepare("SELECT version FROM context_state_migrations ORDER BY version").all(), [{ version: CONTEXT_STATE_STORAGE_SCHEMA_VERSION }]);
    assert.equal(storage.db.prepare("SELECT schema_version FROM authorities WHERE name='context_state_journal'").get().schema_version, "0.1.0");
    assert.equal(state.getCursor(DOMAIN_ID).entry_id, "a1");
    assert.equal(state.getBinding(DOMAIN_ID).external_thread_id, "thread-existing-p3");
    assert.equal(state.getEpoch(DOMAIN_ID).checkpoint_id, "CP-p3");
    assert.equal(state.getBaseline(DOMAIN_ID).handoff_id, "HO-p3", "legacy baseline API remains a compatibility alias");
    assert.equal(state.latestDelivery(DOMAIN_ID).state, "PREPARED");
  } finally {
    storage.close();
  }
});

test("P3 incompatible legacy payload fails before migration metadata or index is written", () => {
  const storage = new GuardianStorage(storagePath());
  try {
    legacyEvent(storage, "CONTEXT_CURSOR_SET", "cursor", "future-cursor", {
      schema_version: "9.9.9", task_id: TASK, context_domain_id: DOMAIN_ID,
      cursor: cursor("SES-A"), updated_at: NOW,
    });
    const before = contextRows(storage);
    assert.throws(
      () => new ContextStateStore(storage, TASK),
      (error) => error?.code === "CONTEXT_STATE_MIGRATION_BLOCKED"
        && error?.details?.cause_code === "CONTEXT_STATE_SCHEMA_UNSUPPORTED"
        && /Do not downgrade/.test(error?.details?.remediation ?? ""),
    );
    assert.deepEqual(contextRows(storage), before);
    assert.equal(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_state_migrations'").get(), undefined);
    assert.equal(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='context_state_event_type_seq'").get(), undefined);
  } finally {
    storage.close();
  }
});

test("P3 future context-state storage schema fails closed with deterministic downgrade remediation", () => {
  const storage = new GuardianStorage(storagePath());
  try {
    storage.db.exec("CREATE TABLE context_state_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    storage.db.prepare("INSERT INTO context_state_migrations(version,applied_at) VALUES(?,?)").run(CONTEXT_STATE_STORAGE_SCHEMA_VERSION + 1, NOW);
    assert.throws(
      () => new ContextStateStore(storage, TASK),
      (error) => error?.code === "CONTEXT_STATE_STORAGE_VERSION_UNSUPPORTED"
        && error?.details?.observed_version === CONTEXT_STATE_STORAGE_SCHEMA_VERSION + 1
        && /Do not downgrade/.test(error?.details?.remediation ?? ""),
    );
    assert.equal(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='context_state_event_type_seq'").get(), undefined);
  } finally {
    storage.close();
  }
});

test("P3 malformed legacy context epoch is not silently reinterpreted", () => {
  const storage = new GuardianStorage(storagePath());
  try {
    const malformed = epochPayload();
    delete malformed.target_session_id;
    legacyEvent(storage, "CONTEXT_BASELINE_SET", "baseline", "malformed-epoch", {
      schema_version: "0.1.0", task_id: TASK, context_domain_id: DOMAIN_ID,
      baseline: malformed, updated_at: NOW,
    });
    const before = contextRows(storage);
    assert.throws(
      () => new ContextStateStore(storage, TASK),
      (error) => error?.code === "CONTEXT_STATE_MIGRATION_BLOCKED"
        && error?.details?.cause_code === "CONTEXT_EPOCH_TARGET_SESSION_REQUIRED",
    );
    assert.deepEqual(contextRows(storage), before);
    assert.equal(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_state_migrations'").get(), undefined);
  } finally {
    storage.close();
  }
});

test("P3 cursor, binding, delivery and epoch round-trip through process-style restart under versioned validation", () => {
  const path = storagePath();
  const firstStorage = new GuardianStorage(path);
  const firstState = new ContextStateStore(firstStorage, TASK);
  const persistedCursor = cursor("SES-A", "a1", 1);
  firstState.setCursor(DOMAIN_ID, persistedCursor);
  const binding = firstState.ensureBinding(domain);
  firstState.bindExternalThread(DOMAIN_ID, "thread-restart-p3");
  const epoch = { ...epochPayload(), binding_id: binding.binding_id };
  firstState.setEpoch(DOMAIN_ID, epoch, { handoffId: epoch.handoff_id });
  const window = {
    transfer_id: "CTX-p3-live",
    context_domain_id: DOMAIN_ID,
    source_cursor: cursor("SES-A"),
    target_cursor: cursor("SES-A", "a1", 1),
  };
  firstState.prepareDelivery(window, domain);
  firstState.markDeliveryReconciliation(DOMAIN_ID, window.transfer_id, "provider-error");
  firstStorage.close();

  const secondStorage = new GuardianStorage(path);
  try {
    const restored = new ContextStateStore(secondStorage, TASK);
    assert.equal(restored.getCursor(DOMAIN_ID).entry_id, persistedCursor.entry_id);
    assert.equal(restored.getBinding(DOMAIN_ID).external_thread_id, "thread-restart-p3");
    assert.equal(restored.latestDelivery(DOMAIN_ID).state, "RECONCILIATION_REQUIRED");
    assert.equal(restored.latestDelivery(DOMAIN_ID).failure_reason, "provider-error");
    const restoredEpoch = restored.getEpoch(DOMAIN_ID);
    assert.equal(restoredEpoch.schema_version, CONTEXT_EPOCH_SCHEMA_VERSION);
    assert.equal(restoredEpoch.target_session_id, "SES-B");
    assert.equal(Object.isFrozen(restoredEpoch), true);
    assert.equal(Object.isFrozen(restoredEpoch.source_cursor), true);
    assert.deepEqual(secondStorage.db.prepare("SELECT version FROM context_state_migrations ORDER BY version").all(), [{ version: CONTEXT_STATE_STORAGE_SCHEMA_VERSION }]);
  } finally {
    secondStorage.close();
  }
});
