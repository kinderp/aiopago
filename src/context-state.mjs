import { opaqueId, stableId, utcNow } from "./canonical.mjs";
import { CONTEXT_CURSOR_SCHEMA_VERSION, ContextCursorBook } from "./context-transfer.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { assertNoSecrets } from "./secret-scan.mjs";

export const CONTEXT_STATE_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_BINDING_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_DELIVERY_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_EPOCH_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_STATE_STORAGE_SCHEMA_VERSION = 1;

export const CONTEXT_STATE_EVENT_TYPES = Object.freeze([
  "CONTEXT_CURSOR_SET",
  "CONTEXT_CURSOR_RESET",
  "CONTEXT_BINDING_SET",
  "CONTEXT_BASELINE_SET",
  "CONTEXT_BASELINE_CLEARED",
  "CONTEXT_DELIVERY_STATE",
]);

const CONTEXT_DELIVERY_STATES = new Set([
  "PREPARED",
  "ACKNOWLEDGED",
  "RECONCILIATION_REQUIRED",
  "RETRY_APPROVED",
]);

const CONTEXT_STATE_REMEDIATION = "Open this runtime with an Aiopago version compatible with the recorded context-state schema. Do not downgrade or delete runtime state. Reconcile or export with the writer-compatible version; if continuity is intentionally abandoned, explicitly archive guardian.sqlite plus its -wal/-shm sidecars before reinitializing.";

function requiredString(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, code, label) {
  if (value === undefined || value === null) return null;
  return requiredString(value, code, label);
}

function record(value, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, code, `${label} must be a plain object`);
  invariant(Object.getOwnPropertySymbols(value).length === 0, code, `${label} must not contain symbol keys`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    invariant(Object.prototype.hasOwnProperty.call(descriptor, "value"), code, `${label} must contain data properties only`);
  }
  return value;
}

function exactKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) invariant(allowed.includes(key), code, `${label}.${key}`);
}

function cursorShape(cursor) {
  const value = record(cursor, "CONTEXT_STATE_CURSOR_INVALID", "cursor");
  exactKeys(value, ["schema_version", "session_id", "entry_id", "branch_depth"], "CONTEXT_STATE_CURSOR_FIELD_UNKNOWN", "cursor");
  invariant(value.schema_version === CONTEXT_CURSOR_SCHEMA_VERSION, "CONTEXT_STATE_CURSOR_VERSION_INVALID", String(value.schema_version));
  const sessionId = requiredString(value.session_id, "CONTEXT_STATE_CURSOR_SESSION_REQUIRED", "cursor.session_id");
  const entryId = value.entry_id === null ? null : requiredString(value.entry_id, "CONTEXT_STATE_CURSOR_ENTRY_INVALID", "cursor.entry_id");
  invariant(Number.isInteger(value.branch_depth) && value.branch_depth >= 0, "CONTEXT_STATE_CURSOR_DEPTH_INVALID");
  invariant((value.branch_depth === 0) === (entryId === null), "CONTEXT_STATE_CURSOR_DEPTH_ENTRY_MISMATCH");
  return Object.freeze({
    schema_version: CONTEXT_CURSOR_SCHEMA_VERSION,
    session_id: sessionId,
    entry_id: entryId,
    branch_depth: value.branch_depth,
  });
}

function bindingShape(input) {
  const value = record(input, "CONTEXT_BINDING_INVALID", "binding");
  exactKeys(value, [
    "schema_version", "binding_id", "task_id", "context_domain_id", "provider_id", "model_id",
    "usage_pool", "transport_adapter_id", "external_thread_id", "status", "created_at", "updated_at",
  ], "CONTEXT_BINDING_FIELD_UNKNOWN", "binding");
  invariant(value.schema_version === CONTEXT_BINDING_SCHEMA_VERSION, "CONTEXT_BINDING_SCHEMA_UNSUPPORTED", String(value.schema_version));
  const externalThreadId = optionalString(value.external_thread_id, "CONTEXT_BINDING_THREAD_INVALID", "external_thread_id");
  invariant(externalThreadId === null || externalThreadId.length <= 1024, "CONTEXT_BINDING_THREAD_TOO_LONG");
  invariant(value.status === "ACTIVE", "CONTEXT_BINDING_STATUS_UNSUPPORTED", String(value.status));
  return Object.freeze({
    schema_version: CONTEXT_BINDING_SCHEMA_VERSION,
    binding_id: requiredString(value.binding_id, "CONTEXT_BINDING_ID_REQUIRED", "binding_id"),
    task_id: requiredString(value.task_id, "CONTEXT_BINDING_TASK_REQUIRED", "task_id"),
    context_domain_id: requiredString(value.context_domain_id, "CONTEXT_BINDING_DOMAIN_REQUIRED", "context_domain_id"),
    provider_id: requiredString(value.provider_id, "CONTEXT_BINDING_PROVIDER_REQUIRED", "provider_id"),
    model_id: optionalString(value.model_id, "CONTEXT_BINDING_MODEL_INVALID", "model_id"),
    usage_pool: requiredString(value.usage_pool, "CONTEXT_BINDING_USAGE_POOL_REQUIRED", "usage_pool"),
    transport_adapter_id: requiredString(value.transport_adapter_id, "CONTEXT_BINDING_ADAPTER_REQUIRED", "transport_adapter_id"),
    external_thread_id: externalThreadId,
    status: "ACTIVE",
    created_at: requiredString(value.created_at, "CONTEXT_BINDING_CREATED_AT_REQUIRED", "created_at"),
    updated_at: requiredString(value.updated_at, "CONTEXT_BINDING_UPDATED_AT_REQUIRED", "updated_at"),
  });
}

function epochShape(input) {
  const value = record(input, "CONTEXT_EPOCH_INVALID", "context_epoch");
  exactKeys(value, [
    "schema_version", "context_domain_id", "binding_id", "handoff_id", "checkpoint_id",
    "source_session_id", "target_session_id", "source_cursor", "source_tail_cursor",
    "source_lag_entry_count", "target_cursor", "rebase_policy",
  ], "CONTEXT_EPOCH_FIELD_UNKNOWN", "context_epoch");
  invariant(value.schema_version === CONTEXT_EPOCH_SCHEMA_VERSION, "CONTEXT_EPOCH_SCHEMA_UNSUPPORTED", String(value.schema_version));
  const sourceSessionId = requiredString(value.source_session_id, "CONTEXT_EPOCH_SOURCE_SESSION_REQUIRED", "source_session_id");
  const targetSessionId = requiredString(value.target_session_id, "CONTEXT_EPOCH_TARGET_SESSION_REQUIRED", "target_session_id");
  const sourceCursor = cursorShape(value.source_cursor);
  const sourceTailCursor = cursorShape(value.source_tail_cursor);
  const targetCursor = cursorShape(value.target_cursor);
  invariant(sourceCursor.session_id === sourceSessionId && sourceTailCursor.session_id === sourceSessionId, "CONTEXT_EPOCH_SOURCE_CURSOR_SESSION_MISMATCH");
  invariant(targetCursor.session_id === targetSessionId, "CONTEXT_EPOCH_TARGET_CURSOR_SESSION_MISMATCH");
  invariant(Number.isInteger(value.source_lag_entry_count) && value.source_lag_entry_count >= 0, "CONTEXT_EPOCH_LAG_INVALID");
  invariant(value.rebase_policy === "durable_checkpoint_epoch", "CONTEXT_EPOCH_REBASE_POLICY_UNSUPPORTED", String(value.rebase_policy));
  return Object.freeze({
    schema_version: CONTEXT_EPOCH_SCHEMA_VERSION,
    context_domain_id: requiredString(value.context_domain_id, "CONTEXT_EPOCH_DOMAIN_REQUIRED", "context_domain_id"),
    binding_id: optionalString(value.binding_id, "CONTEXT_EPOCH_BINDING_INVALID", "binding_id"),
    handoff_id: requiredString(value.handoff_id, "CONTEXT_EPOCH_HANDOFF_REQUIRED", "handoff_id"),
    checkpoint_id: requiredString(value.checkpoint_id, "CONTEXT_EPOCH_CHECKPOINT_REQUIRED", "checkpoint_id"),
    source_session_id: sourceSessionId,
    target_session_id: targetSessionId,
    source_cursor: sourceCursor,
    source_tail_cursor: sourceTailCursor,
    source_lag_entry_count: value.source_lag_entry_count,
    target_cursor: targetCursor,
    rebase_policy: "durable_checkpoint_epoch",
  });
}

function deliveryShape(input) {
  const value = record(input, "CONTEXT_DELIVERY_INVALID", "delivery");
  invariant(value.schema_version === CONTEXT_DELIVERY_SCHEMA_VERSION, "CONTEXT_DELIVERY_SCHEMA_UNSUPPORTED", String(value.schema_version));
  invariant(CONTEXT_DELIVERY_STATES.has(value.state), "CONTEXT_DELIVERY_STATE_UNSUPPORTED", String(value.state));
  const allowed = [
    "schema_version", "transfer_id", "task_id", "context_domain_id", "session_id", "source_cursor",
    "target_cursor", "state", "attempt", "failure_reason", "prepared_at", "updated_at",
    ...(value.state === "ACKNOWLEDGED" ? ["acknowledged_at"] : []),
  ];
  exactKeys(value, allowed, "CONTEXT_DELIVERY_FIELD_UNKNOWN", "delivery");
  const sessionId = requiredString(value.session_id, "CONTEXT_DELIVERY_SESSION_REQUIRED", "session_id");
  const sourceCursor = cursorShape(value.source_cursor);
  const targetCursor = cursorShape(value.target_cursor);
  invariant(sourceCursor.session_id === sessionId && targetCursor.session_id === sessionId, "CONTEXT_DELIVERY_CURSOR_SESSION_MISMATCH");
  invariant(Number.isInteger(value.attempt) && value.attempt > 0, "CONTEXT_DELIVERY_ATTEMPT_INVALID");

  let failureReason = null;
  if (value.state === "RECONCILIATION_REQUIRED" || value.state === "RETRY_APPROVED") {
    failureReason = requiredString(value.failure_reason, "CONTEXT_DELIVERY_FAILURE_REASON_REQUIRED", "failure_reason");
  } else {
    invariant(value.failure_reason === null, "CONTEXT_DELIVERY_FAILURE_REASON_UNEXPECTED");
  }
  const acknowledgedAt = value.state === "ACKNOWLEDGED"
    ? requiredString(value.acknowledged_at, "CONTEXT_DELIVERY_ACKNOWLEDGED_AT_REQUIRED", "acknowledged_at")
    : undefined;

  return Object.freeze({
    schema_version: CONTEXT_DELIVERY_SCHEMA_VERSION,
    transfer_id: requiredString(value.transfer_id, "CONTEXT_DELIVERY_TRANSFER_REQUIRED", "transfer_id"),
    task_id: requiredString(value.task_id, "CONTEXT_DELIVERY_TASK_REQUIRED", "task_id"),
    context_domain_id: requiredString(value.context_domain_id, "CONTEXT_DELIVERY_DOMAIN_REQUIRED", "context_domain_id"),
    session_id: sessionId,
    source_cursor: sourceCursor,
    target_cursor: targetCursor,
    state: value.state,
    attempt: value.attempt,
    failure_reason: failureReason,
    prepared_at: requiredString(value.prepared_at, "CONTEXT_DELIVERY_PREPARED_AT_REQUIRED", "prepared_at"),
    updated_at: requiredString(value.updated_at, "CONTEXT_DELIVERY_UPDATED_AT_REQUIRED", "updated_at"),
    ...(acknowledgedAt === undefined ? {} : { acknowledged_at: acknowledgedAt }),
  });
}

function stateEnvelope(input, extraKeys = []) {
  const value = record(input, "CONTEXT_STATE_EVENT_INVALID", "context_state_event");
  exactKeys(value, ["schema_version", "task_id", "context_domain_id", "updated_at", ...extraKeys], "CONTEXT_STATE_EVENT_FIELD_UNKNOWN", "context_state_event");
  invariant(value.schema_version === CONTEXT_STATE_SCHEMA_VERSION, "CONTEXT_STATE_SCHEMA_UNSUPPORTED", String(value.schema_version));
  return {
    schema_version: CONTEXT_STATE_SCHEMA_VERSION,
    task_id: requiredString(value.task_id, "CONTEXT_STATE_TASK_REQUIRED", "task_id"),
    context_domain_id: requiredString(value.context_domain_id, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id"),
    updated_at: requiredString(value.updated_at, "CONTEXT_STATE_UPDATED_AT_REQUIRED", "updated_at"),
  };
}

export function validateContextStateJournalPayload(eventType, payload) {
  switch (eventType) {
    case "CONTEXT_CURSOR_SET": {
      const base = stateEnvelope(payload, ["cursor"]);
      return Object.freeze({ ...base, cursor: cursorShape(payload.cursor) });
    }
    case "CONTEXT_CURSOR_RESET":
      return Object.freeze(stateEnvelope(payload));
    case "CONTEXT_BINDING_SET":
      return bindingShape(payload);
    case "CONTEXT_BASELINE_SET": {
      const base = stateEnvelope(payload, ["baseline"]);
      return Object.freeze({ ...base, baseline: epochShape(payload.baseline) });
    }
    case "CONTEXT_BASELINE_CLEARED":
      return Object.freeze(stateEnvelope(payload));
    case "CONTEXT_DELIVERY_STATE":
      return deliveryShape(payload);
    default:
      invariant(false, "CONTEXT_STATE_EVENT_TYPE_UNSUPPORTED", String(eventType));
  }
}

function migrationTableExists(db) {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='context_state_migrations'").get());
}

function validatePersistedContextRows(db) {
  const rows = db.prepare("SELECT seq,event_type,event_key,data_json FROM journal WHERE event_key LIKE 'context-%' ORDER BY seq").all();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.data_json);
      validateContextStateJournalPayload(row.event_type, payload);
    } catch (error) {
      const causeCode = error instanceof GuardianError ? error.code : "CONTEXT_STATE_JOURNAL_JSON_INVALID";
      throw new GuardianError(
        "CONTEXT_STATE_MIGRATION_BLOCKED",
        `context state journal row ${row.seq} is incompatible (${causeCode})`,
        {
          seq: row.seq,
          event_type: row.event_type,
          event_key: row.event_key,
          cause_code: causeCode,
          remediation: CONTEXT_STATE_REMEDIATION,
        },
      );
    }
  }
}

function ensureContextStateStorageLifecycle(storage) {
  const { db } = storage;
  let versions = [];
  if (migrationTableExists(db)) {
    try {
      versions = db.prepare("SELECT version FROM context_state_migrations ORDER BY version").all().map((row) => row.version);
    } catch (error) {
      throw new GuardianError("CONTEXT_STATE_STORAGE_HISTORY_INVALID", "context_state_migrations cannot be read", {
        cause: String(error?.message ?? error),
        remediation: CONTEXT_STATE_REMEDIATION,
      });
    }
    invariant(versions.every((version) => Number.isInteger(version) && version >= 1), "CONTEXT_STATE_STORAGE_HISTORY_INVALID", "invalid context-state migration history", { remediation: CONTEXT_STATE_REMEDIATION });
    const newest = versions.at(-1) ?? 0;
    invariant(newest <= CONTEXT_STATE_STORAGE_SCHEMA_VERSION, "CONTEXT_STATE_STORAGE_VERSION_UNSUPPORTED", `context-state storage schema ${newest} is newer than supported ${CONTEXT_STATE_STORAGE_SCHEMA_VERSION}`, {
      observed_version: newest,
      supported_version: CONTEXT_STATE_STORAGE_SCHEMA_VERSION,
      remediation: CONTEXT_STATE_REMEDIATION,
    });
  }

  // Validate legacy/current journal bytes before recording any context-state migration.
  // This makes adoption fail closed rather than silently reinterpreting old payloads.
  validatePersistedContextRows(db);

  if (versions.includes(CONTEXT_STATE_STORAGE_SCHEMA_VERSION)) {
    const authority = db.prepare("SELECT authority,schema_version FROM authorities WHERE name='context_state_journal'").get();
    invariant(authority?.schema_version === CONTEXT_STATE_SCHEMA_VERSION, "CONTEXT_STATE_STORAGE_METADATA_INVALID", "context_state_journal authority metadata is missing or incompatible", { remediation: CONTEXT_STATE_REMEDIATION });
    return;
  }

  storage.transaction(() => {
    validatePersistedContextRows(db);
    db.exec("CREATE TABLE IF NOT EXISTS context_state_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO context_state_migrations(version,applied_at) VALUES(?,?)")
      .run(CONTEXT_STATE_STORAGE_SCHEMA_VERSION, utcNow());
    db.prepare("INSERT OR IGNORE INTO authorities(name,authority,schema_version) VALUES(?,?,?)")
      .run("context_state_journal", "Guardian SQLite journal; versioned cursor, binding, delivery and context-epoch lifecycle", CONTEXT_STATE_SCHEMA_VERSION);
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
  try {
    return JSON.parse(row.data_json);
  } catch {
    invariant(false, "CONTEXT_STATE_JOURNAL_JSON_INVALID", `${row.event_type}:${row.seq}`);
  }
}

function assertScope(payload, taskId, domainId) {
  invariant(payload.task_id === taskId && payload.context_domain_id === domainId, "CONTEXT_STATE_SCOPE_MISMATCH", `${payload.task_id}/${payload.context_domain_id}`);
}

export class ContextStateStore {
  constructor(storage, taskId) {
    invariant(storage && typeof storage.appendEvent === "function" && storage.db?.prepare, "CONTEXT_STATE_STORAGE_REQUIRED");
    this.storage = storage;
    this.taskId = requiredString(taskId, "CONTEXT_STATE_TASK_REQUIRED", "task_id");
    ensureContextStateStorageLifecycle(storage);
    // Context state is journal-backed. This index changes only access cost; it does
    // not create a second authority alongside GuardianStorage.journal.
    storage.db.exec("CREATE INDEX IF NOT EXISTS context_state_event_type_seq ON journal(event_type,seq)");
  }

  _latest(prefix, eventTypes = null) {
    const rows = this.storage.db.prepare(
      "SELECT seq,event_type,event_key,occurred_at,data_json FROM journal WHERE substr(event_key,1,?)=? ORDER BY seq DESC LIMIT 256",
    ).all(prefix.length, prefix);
    for (const row of rows) {
      if (!eventTypes || eventTypes.has(row.event_type)) {
        const normalized = validateContextStateJournalPayload(row.event_type, rowPayload(row));
        return Object.freeze({ ...normalized, _seq: row.seq, _event_type: row.event_type, _occurred_at: row.occurred_at });
      }
    }
    return null;
  }

  _append(eventType, prefix, payload, { handoffId = null } = {}) {
    const normalized = validateContextStateJournalPayload(eventType, payload);
    assertNoSecrets(normalized);
    const event = this.storage.appendEvent(eventType, normalized, { handoffId, eventKey: eventKey(prefix) });
    return Object.freeze({ ...normalized, _event_id: event.event_id, _occurred_at: event.occurred_at });
  }

  getCursor(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const latest = this._latest(eventPrefix("cursor", this.taskId, domainId), new Set(["CONTEXT_CURSOR_SET", "CONTEXT_CURSOR_RESET"]));
    if (!latest || latest._event_type === "CONTEXT_CURSOR_RESET") return null;
    assertScope(latest, this.taskId, domainId);
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
    assertScope(latest, this.taskId, domainId);
    const { _seq, _event_type, _occurred_at, ...binding } = latest;
    return bindingShape(binding);
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
    const binding = bindingShape({
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
    const binding = bindingShape({ ...prior, external_thread_id: threadId, updated_at: utcNow() });
    this._append("CONTEXT_BINDING_SET", eventPrefix("binding", this.taskId, domainId), binding);
    return binding;
  }

  getEpoch(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const latest = this._latest(eventPrefix("baseline", this.taskId, domainId), new Set(["CONTEXT_BASELINE_SET", "CONTEXT_BASELINE_CLEARED"]));
    if (!latest || latest._event_type === "CONTEXT_BASELINE_CLEARED") return null;
    assertScope(latest, this.taskId, domainId);
    const epoch = epochShape(latest.baseline);
    invariant(epoch.context_domain_id === domainId, "CONTEXT_EPOCH_DOMAIN_MISMATCH", domainId);
    return epoch;
  }

  // Compatibility aliases: the spike called a context epoch a "baseline".
  getBaseline(contextDomainId) { return this.getEpoch(contextDomainId); }

  setEpoch(contextDomainId, epoch, { handoffId = null } = {}) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const normalized = epochShape(epoch);
    invariant(normalized.context_domain_id === domainId, "CONTEXT_EPOCH_DOMAIN_MISMATCH", domainId);
    if (handoffId !== null) invariant(normalized.handoff_id === handoffId, "CONTEXT_EPOCH_HANDOFF_MISMATCH", domainId);
    assertNoSecrets(normalized);
    this._append("CONTEXT_BASELINE_SET", eventPrefix("baseline", this.taskId, domainId), {
      schema_version: CONTEXT_STATE_SCHEMA_VERSION,
      task_id: this.taskId,
      context_domain_id: domainId,
      baseline: normalized,
      updated_at: utcNow(),
    }, { handoffId });
    return normalized;
  }

  setBaseline(contextDomainId, baseline, options = {}) { return this.setEpoch(contextDomainId, baseline, options); }

  clearEpoch(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    this._append("CONTEXT_BASELINE_CLEARED", eventPrefix("baseline", this.taskId, domainId), {
      schema_version: CONTEXT_STATE_SCHEMA_VERSION,
      task_id: this.taskId,
      context_domain_id: domainId,
      updated_at: utcNow(),
    });
  }

  clearBaseline(contextDomainId) { return this.clearEpoch(contextDomainId); }

  latestDelivery(contextDomainId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const latest = this._latest(eventPrefix("delivery", this.taskId, domainId), new Set(["CONTEXT_DELIVERY_STATE"]));
    if (!latest) return null;
    assertScope(latest, this.taskId, domainId);
    const { _seq, _event_type, _occurred_at, ...delivery } = latest;
    return deliveryShape(delivery);
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
    const delivery = deliveryShape({
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
    const next = deliveryShape({
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
    const next = deliveryShape({ ...prior, state: "RETRY_APPROVED", updated_at: utcNow() });
    this._append("CONTEXT_DELIVERY_STATE", eventPrefix("delivery", this.taskId, domainId), next);
    return next;
  }

  acknowledgeDelivery(contextDomainId, transferId) {
    const domainId = requiredString(contextDomainId, "CONTEXT_STATE_DOMAIN_REQUIRED", "context_domain_id");
    const prior = this.latestDelivery(domainId);
    invariant(prior?.transfer_id === transferId && prior.state === "PREPARED", "CONTEXT_DELIVERY_STATE_MISMATCH", domainId);
    const now = utcNow();
    const next = deliveryShape({ ...prior, state: "ACKNOWLEDGED", failure_reason: null, updated_at: now, acknowledged_at: now });
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
