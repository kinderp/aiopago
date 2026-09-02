import { opaqueId, stableId, utcNow } from "./canonical.mjs";
import { ContextCursorBook } from "./context-transfer.mjs";
import { invariant } from "./errors.mjs";
import { assertNoSecrets } from "./secret-scan.mjs";

export const CONTEXT_STATE_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_BINDING_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_DELIVERY_SCHEMA_VERSION = "0.1.0";

function requiredString(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, code, label) {
  if (value === undefined || value === null) return null;
  return requiredString(value, code, label);
}

function cloneFrozen(value) {
  return value === null || value === undefined ? value : Object.freeze(structuredClone(value));
}

function cursorShape(cursor) {
  invariant(cursor && typeof cursor === "object" && !Array.isArray(cursor), "CONTEXT_STATE_CURSOR_INVALID");
  invariant(cursor.schema_version === "0.1.0", "CONTEXT_STATE_CURSOR_VERSION_INVALID");
  const sessionId = requiredString(cursor.session_id, "CONTEXT_STATE_CURSOR_SESSION_REQUIRED", "cursor.session_id");
  const entryId = cursor.entry_id === null ? null : requiredString(cursor.entry_id, "CONTEXT_STATE_CURSOR_ENTRY_INVALID", "cursor.entry_id");
  invariant(Number.isInteger(cursor.branch_depth) && cursor.branch_depth >= 0, "CONTEXT_STATE_CURSOR_DEPTH_INVALID");
  return Object.freeze({
    schema_version: cursor.schema_version,
    session_id: sessionId,
    entry_id: entryId,
    branch_depth: cursor.branch_depth,
  });
}

function domainKey(taskId, contextDomainId) {
  return stableId("CTXSTATE", taskId, contextDomainId);
}

function eventPrefix(kind, taskId, contextDomainId) {
  return `context-${kind}:${domainKey(taskId, contextDomainId)}:`;
}

function eventKey(prefix) {
  return `${prefix}${opaqueId("EVK")}`;
}

function rowPayload(row) {
  if (!row) return null;
  return JSON.parse(row.data_json);
}

export class ContextStateStore {
  constructor(storage, taskId) {
    invariant(storage && typeof storage.appendEvent === "function" && storage.db?.prepare, "CONTEXT_STATE_STORAGE_REQUIRED");
    this.storage = storage;
    this.taskId = requiredString(taskId, "CONTEXT_STATE_TASK_REQUIRED", "task_id");
    // Context state is journal-backed. This index changes only access cost; it does
    // not create a second authority alongside GuardianStorage.journal.
    try { storage.db.exec("CREATE INDEX IF NOT EXISTS context_state_event_type_seq ON journal(event_type,seq)"); } catch {}
  }

  _latest(prefix, eventTypes = null) {
    const rows = this.storage.db.prepare(
      "SELECT seq,event_type,event_key,occurred_at,data_json FROM journal WHERE substr(event_key,1,?)=? ORDER BY seq DESC LIMIT 256",
    ).all(prefix.length, prefix);
    for (const row of rows) {
      if (!eventTypes || eventTypes.has(row.event_type)) return Object.freeze({ ...rowPayload(row), _seq: row.seq, _event_type: row.event_type, _occurred_at: row.occurred_at });
    }
    return null;
  }

  _append(eventType, prefix, payload, { handoffId = null } = {}) {
    assertNoSecrets(payload);
    const event = this.storage.appendEvent(eventType, payload, { handoffId, eventKey: eventKey(prefix) });
    return Object.freeze({ ...payload, _event_id: event.event_id, _occurred_at: event.occurred_at });
  }

  getCursor(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const latest = this._latest(eventPrefix("cursor", this.taskId, domainId), new Set(["CONTEXT_CURSOR_SET", "CONTEXT_CURSOR_RESET"]));
    if (!latest || latest._event_type === "CONTEXT_CURSOR_RESET") return null;
    return cursorShape(latest.cursor);
  }

  setCursor(contextDomainId, cursor) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const normalized = cursorShape(cursor);
    this._append("CONTEXT_CURSOR_SET", eventPrefix("cursor", this.taskId, domainId), {
      schema_version: CONTEXT_STATE_SCHEMA_VERSION,
      task_id: this.taskId,
      context_domain_id: domainId,
      cursor: normalized,
      updated_at: utcNow(),
    });
    return normalized;
  }

  resetCursor(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    this._append("CONTEXT_CURSOR_RESET", eventPrefix("cursor", this.taskId, domainId), {
      schema_version: CONTEXT_STATE_SCHEMA_VERSION,
      task_id: this.taskId,
      context_domain_id: domainId,
      updated_at: utcNow(),
    });
  }

  getBinding(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const latest = this._latest(eventPrefix("binding", this.taskId, domainId), new Set(["CONTEXT_BINDING_SET"]));
    if (!latest) return null;
    const { _seq, _event_type, _occurred_at, ...binding } = latest;
    return Object.freeze(binding);
  }

  ensureBinding(domain) {
    invariant(domain?.kind === "external-stateful", "CONTEXT_BINDING_EXTERNAL_DOMAIN_REQUIRED");
    const domainId = requiredString(domain.context_domain_id, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const prior = this.getBinding(domainId);
    if (prior) {
      invariant(prior.provider_id === domain.provider_id, "CONTEXT_BINDING_PROVIDER_MISMATCH", domainId);
      invariant((prior.model_id ?? null) === (domain.model_id ?? null), "CONTEXT_BINDING_MODEL_MISMATCH", domainId);
      invariant(prior.usage_pool === domain.usage_pool, "CONTEXT_BINDING_USAGE_POOL_MISMATCH", domainId);
      invariant(prior.transport_adapter_id === domain.transport_adapter_id, "CONTEXT_BINDING_ADAPTER_MISMATCH", domainId);
      return prior;
    }
    const now = utcNow();
    const binding = Object.freeze({
      schema_version: CONTEXT_BINDING_SCHEMA_VERSION,
      binding_id: stableId("CTXBIND", this.taskId, domainId),
      task_id: this.taskId,
      context_domain_id: domainId,
      provider_id: domain.provider_id,
      model_id: domain.model_id ?? null,
      usage_pool: domain.usage_pool,
      transport_adapter_id: domain.transport_adapter_id,
      external_thread_id: null,
      status: "ACTIVE",
      created_at: now,
      updated_at: now,
    });
    this._append("CONTEXT_BINDING_SET", eventPrefix("binding", this.taskId, domainId), binding);
    return binding;
  }

  bindExternalThread(contextDomainId, externalThreadId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const threadId = requiredString(externalThreadId, "CONTEXT_BINDING_THREAD_REQUIRED", "external_thread_id");
    invariant(threadId.length <= 1024, "CONTEXT_BINDING_THREAD_TOO_LONG");
    assertNoSecrets({ external_thread_id: threadId });
    const prior = this.getBinding(domainId);
    invariant(prior, "CONTEXT_BINDING_NOT_FOUND", domainId);
    if (prior.external_thread_id !== null) {
      invariant(prior.external_thread_id === threadId, "CONTEXT_BINDING_THREAD_CONFLICT", domainId);
      return prior;
    }
    const binding = Object.freeze({ ...prior, external_thread_id: threadId, updated_at: utcNow() });
    this._append("CONTEXT_BINDING_SET", eventPrefix("binding", this.taskId, domainId), binding);
    return binding;
  }

  getBaseline(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const latest = this._latest(eventPrefix("baseline", this.taskId, domainId), new Set(["CONTEXT_BASELINE_SET", "CONTEXT_BASELINE_CLEARED"]));
    if (!latest || latest._event_type === "CONTEXT_BASELINE_CLEARED") return null;
    return cloneFrozen(latest.baseline);
  }

  setBaseline(contextDomainId, baseline, { handoffId = null } = {}) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    invariant(baseline && typeof baseline === "object", "CONTEXT_BASELINE_INVALID");
    assertNoSecrets(baseline);
    this._append("CONTEXT_BASELINE_SET", eventPrefix("baseline", this.taskId, domainId), {
      schema_version: CONTEXT_STATE_SCHEMA_VERSION,
      task_id: this.taskId,
      context_domain_id: domainId,
      baseline: structuredClone(baseline),
      updated_at: utcNow(),
    }, { handoffId });
    return cloneFrozen(baseline);
  }

  clearBaseline(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    this._append("CONTEXT_BASELINE_CLEARED", eventPrefix("baseline", this.taskId, domainId), {
      schema_version: CONTEXT_STATE_SCHEMA_VERSION,
      task_id: this.taskId,
      context_domain_id: domainId,
      updated_at: utcNow(),
    });
  }

  latestDelivery(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const latest = this._latest(eventPrefix("delivery", this.taskId, domainId), new Set(["CONTEXT_DELIVERY_STATE"]));
    if (!latest) return null;
    const { _seq, _event_type, _occurred_at, ...delivery } = latest;
    return Object.freeze(delivery);
  }

  unresolvedDelivery(contextDomainId) {
    const latest = this.latestDelivery(contextDomainId);
    return latest && ["PREPARED", "RECONCILIATION_REQUIRED"].includes(latest.state) ? latest : null;
  }

  prepareDelivery(window, domain) {
    invariant(window?.context_domain_id === domain?.context_domain_id, "CONTEXT_DELIVERY_DOMAIN_MISMATCH");
    const domainId = requiredString(window.context_domain_id, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const prior = this.latestDelivery(domainId);
    invariant(!prior || !["PREPARED", "RECONCILIATION_REQUIRED"].includes(prior.state), "CONTEXT_DELIVERY_UNRESOLVED", domainId);
    const attempt = prior?.state === "RETRY_APPROVED" ? prior.attempt + 1 : 1;
    const delivery = Object.freeze({
      schema_version: CONTEXT_DELIVERY_SCHEMA_VERSION,
      transfer_id: requiredString(window.transfer_id, "CONTEXT_DELIVERY_TRANSFER_REQUIRED", "transfer_id"),
      task_id: this.taskId,
      context_domain_id: domainId,
      session_id: requiredString(window.source_cursor.session_id, "CONTEXT_DELIVERY_SESSION_REQUIRED", "session_id"),
      source_cursor: cursorShape(window.source_cursor),
      target_cursor: cursorShape(window.target_cursor),
      state: "PREPARED",
      attempt,
      failure_reason: null,
      prepared_at: utcNow(),
      updated_at: utcNow(),
    });
    this._append("CONTEXT_DELIVERY_STATE", eventPrefix("delivery", this.taskId, domainId), delivery);
    return delivery;
  }

  markDeliveryReconciliation(contextDomainId, transferId, reason) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const prior = this.latestDelivery(domainId);
    invariant(prior?.transfer_id === transferId && prior.state === "PREPARED", "CONTEXT_DELIVERY_STATE_MISMATCH", domainId);
    const next = Object.freeze({
      ...prior,
      state: "RECONCILIATION_REQUIRED",
      failure_reason: requiredString(reason, "CONTEXT_DELIVERY_FAILURE_REASON_REQUIRED", "reason"),
      updated_at: utcNow(),
    });
    this._append("CONTEXT_DELIVERY_STATE", eventPrefix("delivery", this.taskId, domainId), next);
    return next;
  }

  approveDeliveryRetry(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const prior = this.latestDelivery(domainId);
    invariant(prior?.state === "RECONCILIATION_REQUIRED", "CONTEXT_DELIVERY_RECONCILIATION_NOT_REQUIRED", domainId);
    const next = Object.freeze({ ...prior, state: "RETRY_APPROVED", updated_at: utcNow() });
    this._append("CONTEXT_DELIVERY_STATE", eventPrefix("delivery", this.taskId, domainId), next);
    return next;
  }

  acknowledgeDelivery(contextDomainId, transferId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const prior = this.latestDelivery(domainId);
    invariant(prior?.transfer_id === transferId && prior.state === "PREPARED", "CONTEXT_DELIVERY_STATE_MISMATCH", domainId);
    const next = Object.freeze({ ...prior, state: "ACKNOWLEDGED", failure_reason: null, updated_at: utcNow(), acknowledged_at: utcNow() });
    this._append("CONTEXT_DELIVERY_STATE", eventPrefix("delivery", this.taskId, domainId), next);
    return next;
  }
}

export class DurableContextCursorBook extends ContextCursorBook {
  constructor(stateStore) {
    invariant(stateStore && typeof stateStore.getCursor === "function" && typeof stateStore.setCursor === "function", "CONTEXT_CURSOR_STATE_STORE_REQUIRED");
    super();
    this.stateStore = stateStore;
    this.loaded = new Set();
  }

  ensureLoaded(contextDomainId) {
    if (this.loaded.has(contextDomainId)) return;
    const cursor = this.stateStore.getCursor(contextDomainId);
    if (cursor) this.cursors.set(contextDomainId, cursor);
    this.loaded.add(contextDomainId);
  }

  get(contextDomainId) {
    this.ensureLoaded(contextDomainId);
    return super.get(contextDomainId);
  }

  plan(contextDomainId, sessionManager) {
    this.ensureLoaded(contextDomainId);
    return super.plan(contextDomainId, sessionManager);
  }

  commit(window) {
    this.ensureLoaded(window?.context_domain_id);
    const cursor = super.commit(window);
    this.stateStore.setCursor(window.context_domain_id, cursor);
    return cursor;
  }

  acknowledgeThroughEntry(window, sessionManager, entryId) {
    this.ensureLoaded(window?.context_domain_id);
    const cursor = super.acknowledgeThroughEntry(window, sessionManager, entryId);
    // Persist the cursor before marking delivery acknowledged. If the process dies
    // between those writes, restart fails closed on the still-PREPARED delivery.
    this.stateStore.setCursor(window.context_domain_id, cursor);
    return cursor;
  }

  reset(contextDomainId) {
    this.ensureLoaded(contextDomainId);
    super.reset(contextDomainId);
    this.stateStore.resetCursor(contextDomainId);
  }
}
