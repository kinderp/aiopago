import { canonicalJson } from "./canonical.mjs";
import { ContextCursorBook, hydrateContextTransfer } from "./context-transfer.mjs";
import { invariant } from "./errors.mjs";
import { assertNoSecrets } from "./secret-scan.mjs";

export const CONTEXT_SYNC_ENVELOPE_VERSION = "0.2.0";
export const CONTEXT_SYNC_PRIVACY_BOUNDARY_VERSION = "0.1.0";
export const CONTEXT_HANDOFF_BINDING_VERSION = "0.1.0";
export const CONTEXT_SYNC_PREFIX = `AIOPAGO_CONTEXT_TRANSFER/${CONTEXT_SYNC_ENVELOPE_VERSION}`;
export const DEFAULT_PROTOCOL_BUDGET = Object.freeze({
  max_tool_results: 8,
  max_total_tool_result_chars: 8000,
  max_tool_result_chars: 4000,
  max_live_user_chars: 4000,
});

const PROTOCOL_BUDGET_KEYS = Object.freeze(Object.keys(DEFAULT_PROTOCOL_BUDGET));

function protocolBudget(input = {}) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "CONTEXT_SYNC_PROTOCOL_BUDGET_INVALID", "protocol budget must be an object");
  for (const key of Object.keys(input)) invariant(PROTOCOL_BUDGET_KEYS.includes(key), "CONTEXT_SYNC_PROTOCOL_BUDGET_FIELD_UNKNOWN", key);
  const merged = { ...DEFAULT_PROTOCOL_BUDGET, ...input };
  for (const [key, value] of Object.entries(merged)) {
    invariant(Number.isInteger(value) && value > 0, "CONTEXT_SYNC_PROTOCOL_BUDGET_INVALID", `${key} must be a positive integer`);
  }
  return Object.freeze(merged);
}

function modelMatchesDomain(message, domain) {
  if (!message || message.role !== "assistant") return false;
  if (message.provider !== domain.provider_id) return false;
  return domain.model_id === undefined || message.model === domain.model_id;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function latestUserInput(entries, maxChars) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = textContent(entry.message.content);
    if (!text) return null;
    const clipped = text.slice(0, maxChars);
    return Object.freeze({
      text: clipped,
      truncated: clipped.length < text.length,
      original_chars: text.length,
    });
  }
  return null;
}

function correlatedDomainToolResults(windowEntries, branchEntries, domain) {
  const windowToolResultIds = new Set(
    windowEntries
      .filter((entry) => entry?.type === "message" && entry.message?.role === "toolResult" && typeof entry.id === "string")
      .map((entry) => entry.id),
  );
  const outstanding = new Map();
  const results = [];

  for (const entry of branchEntries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant") {
      const domainOwned = modelMatchesDomain(message, domain);
      for (const block of message.content ?? []) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const prior = outstanding.get(block.id);
        outstanding.set(block.id, Object.freeze({
          domain_owned: domainOwned,
          tool_name: typeof block.name === "string" ? block.name : null,
          ambiguous: prior !== undefined,
        }));
      }
      continue;
    }
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const owner = outstanding.get(message.toolCallId) ?? null;
    if (
      windowToolResultIds.has(entry.id)
      && owner
      && owner.ambiguous !== true
      && owner.domain_owned === true
      && owner.tool_name !== null
      && owner.tool_name === message.toolName
    ) {
      results.push(entry);
    }
    // A tool result closes the outstanding correlation slot regardless of whether
    // it belongs to the current window/domain. Later reuse of the same provider-
    // generated id is therefore independent, while overlapping reuse fails closed.
    outstanding.delete(message.toolCallId);
  }

  return results;
}

function protocolToolResults(windowEntries, branchEntries, domain, limits) {
  const candidates = correlatedDomainToolResults(windowEntries, branchEntries, domain);
  const results = [];
  const reasons = new Set();
  let remaining = limits.max_total_tool_result_chars;

  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    if (results.length >= limits.max_tool_results) {
      reasons.add("max_tool_results");
      break;
    }
    const raw = textContent(entry.message.content);
    const allowed = Math.max(0, Math.min(limits.max_tool_result_chars, remaining));
    const text = raw.slice(0, allowed);
    const itemReasons = [];
    if (text.length < raw.length) {
      if (remaining <= limits.max_tool_result_chars) {
        reasons.add("max_total_tool_result_chars");
        itemReasons.push("max_total_tool_result_chars");
      }
      if (limits.max_tool_result_chars <= remaining) {
        reasons.add("max_tool_result_chars");
        itemReasons.push("max_tool_result_chars");
      }
    }
    remaining -= text.length;
    results.push(Object.freeze({
      tool_call_id: entry.message.toolCallId,
      tool_name: entry.message.toolName,
      is_error: entry.message.isError === true,
      source_ref: Object.freeze({ kind: "pi-tool-result", entry_id: entry.id ?? null }),
      text,
      truncation: Object.freeze({
        truncated: text.length < raw.length,
        reasons: Object.freeze(itemReasons.sort()),
        original_chars: raw.length,
        emitted_chars: text.length,
      }),
    }));
    if (remaining <= 0) {
      if (index < candidates.length - 1) reasons.add("max_total_tool_result_chars");
      break;
    }
  }

  return Object.freeze({
    purpose: "live-correlated-tool-continuation",
    historical_hydration: false,
    items: Object.freeze(results),
    truncated: reasons.size > 0,
    truncation: Object.freeze({
      truncated: reasons.size > 0,
      reasons: Object.freeze([...reasons].sort()),
      emitted_chars: limits.max_total_tool_result_chars - remaining,
      remaining_chars: remaining,
    }),
    remaining_chars: remaining,
  });
}

function assistantEntryId(sessionManager, message, domain) {
  const entries = sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || !modelMatchesDomain(entry.message, domain)) continue;
    if (entry.message.timestamp !== message.timestamp) continue;
    if (message.responseId && entry.message.responseId !== message.responseId) continue;
    return entry.id;
  }
  return null;
}

function transferMessage(envelope) {
  return Object.freeze({
    role: "user",
    content: Object.freeze([{ type: "text", text: `${CONTEXT_SYNC_PREFIX}\n${canonicalJson(envelope)}` }]),
    timestamp: Date.now(),
  });
}

function sameCursor(left, right) {
  return left?.session_id === right?.session_id && left?.entry_id === right?.entry_id;
}

function rootCursor(sessionId) {
  return Object.freeze({ schema_version: "0.1.0", session_id: sessionId, entry_id: null, branch_depth: 0 });
}

function durableFailure(delivery, fallbackReason = "durable-unresolved-delivery") {
  if (!delivery) return null;
  return Object.freeze({
    schema_version: CONTEXT_SYNC_ENVELOPE_VERSION,
    context_domain_id: delivery.context_domain_id,
    session_id: delivery.session_id,
    transfer_id: delivery.transfer_id,
    reason: delivery.failure_reason ?? fallbackReason,
    durable_state: delivery.state,
  });
}

function outboundTruncation(transfer, liveUserInput, toolResults) {
  const reasons = [
    ...transfer.truncation.reasons.map((reason) => `hydration:${reason}`),
    ...(liveUserInput?.truncated ? ["live_user_input:max_live_user_chars"] : []),
    ...toolResults.truncation.reasons.map((reason) => `tool_continuation:${reason}`),
  ].sort();
  return Object.freeze({ truncated: reasons.length > 0, reasons: Object.freeze(reasons) });
}

export class ContextSyncCoordinator {
  constructor({ contextDomains, cursorBook = new ContextCursorBook(), stateStore = null, ledger, observeGit, evidenceProvider = () => [], hydrationBudget = undefined, protocolBudget: protocolLimits = undefined } = {}) {
    invariant(contextDomains && typeof contextDomains.resolve === "function", "CONTEXT_SYNC_DOMAIN_REGISTRY_REQUIRED");
    invariant(ledger && typeof ledger.read === "function", "CONTEXT_SYNC_LEDGER_REQUIRED");
    invariant(typeof observeGit === "function", "CONTEXT_SYNC_GIT_OBSERVER_REQUIRED");
    invariant(typeof evidenceProvider === "function", "CONTEXT_SYNC_EVIDENCE_PROVIDER_INVALID");
    invariant(!stateStore || (typeof stateStore.unresolvedDelivery === "function" && typeof stateStore.prepareDelivery === "function"), "CONTEXT_SYNC_STATE_STORE_INVALID");
    this.contextDomains = contextDomains;
    this.cursorBook = cursorBook;
    this.stateStore = stateStore;
    this.ledger = ledger;
    this.observeGit = observeGit;
    this.evidenceProvider = evidenceProvider;
    this.hydrationBudget = hydrationBudget;
    this.protocolBudget = protocolBudget(protocolLimits ?? {});
    this.pending = new Map();
    this.reconciliationRequired = new Map();
    this.lastProjection = new Map();
    this.durableBaselines = new Map();
    if (this.stateStore) {
      for (const domain of this.externalDomains()) {
        const baseline = this.stateStore.getBaseline(domain.context_domain_id);
        if (baseline) this.durableBaselines.set(domain.context_domain_id, baseline);
      }
    }
  }

  externalDomains() {
    return (this.contextDomains.list?.() ?? []).filter((domain) => domain.kind === "external-stateful");
  }

  captureForHandoff(sourceSession) {
    invariant(sourceSession?.sessionManager, "CONTEXT_HANDOFF_SOURCE_SESSION_REQUIRED");
    const sessionId = sourceSession.sessionManager.getSessionId();
    const bindings = [];
    for (const domain of this.externalDomains()) {
      invariant(!this.pending.has(domain.context_domain_id), "CONTEXT_HANDOFF_PENDING_EXTERNAL_REQUEST", domain.context_domain_id);
      invariant(!this.reconciliationFor(domain.context_domain_id), "CONTEXT_SYNC_RECONCILIATION_REQUIRED", domain.context_domain_id);
      const window = this.cursorBook.plan(domain.context_domain_id, sourceSession.sessionManager);
      const durableBinding = this.stateStore?.ensureBinding(domain) ?? null;
      bindings.push(Object.freeze({
        schema_version: CONTEXT_HANDOFF_BINDING_VERSION,
        context_domain_id: domain.context_domain_id,
        binding_id: durableBinding?.binding_id ?? null,
        provider_id: domain.provider_id,
        model_id: domain.model_id ?? null,
        usage_pool: domain.usage_pool,
        source_session_id: sessionId,
        source_cursor: Object.freeze({ ...window.source_cursor }),
        source_tail_cursor: Object.freeze({ ...window.target_cursor }),
        lag_entry_count: window.entries.length,
        rebase_policy: "durable_checkpoint_epoch",
      }));
    }
    return Object.freeze(bindings);
  }

  rebindAfterHandoff({ bindings = [], targetSession, handoffId, checkpointId } = {}) {
    invariant(targetSession?.sessionManager, "CONTEXT_HANDOFF_TARGET_SESSION_REQUIRED");
    invariant(typeof handoffId === "string" && handoffId.length > 0, "CONTEXT_HANDOFF_ID_REQUIRED");
    invariant(typeof checkpointId === "string" && checkpointId.length > 0, "CONTEXT_HANDOFF_CHECKPOINT_REQUIRED");
    const targetSessionId = targetSession.sessionManager.getSessionId();
    const results = [];

    for (const binding of bindings) {
      invariant(binding?.schema_version === CONTEXT_HANDOFF_BINDING_VERSION, "CONTEXT_HANDOFF_BINDING_INVALID");
      const domain = this.externalDomains().find((candidate) => candidate.context_domain_id === binding.context_domain_id);
      invariant(domain, "CONTEXT_HANDOFF_DOMAIN_UNKNOWN", binding.context_domain_id);
      invariant(domain.provider_id === binding.provider_id && (domain.model_id ?? null) === binding.model_id && domain.usage_pool === binding.usage_pool, "CONTEXT_HANDOFF_DOMAIN_MISMATCH", binding.context_domain_id);
      const durableBinding = this.stateStore?.ensureBinding(domain) ?? null;
      if (binding.binding_id !== null && binding.binding_id !== undefined) {
        invariant(durableBinding?.binding_id === binding.binding_id, "CONTEXT_HANDOFF_BINDING_ID_MISMATCH", binding.context_domain_id);
      }

      const existingBaseline = this.durableBaselines.get(binding.context_domain_id) ?? this.stateStore?.getBaseline(binding.context_domain_id) ?? null;
      const current = this.cursorBook.get(binding.context_domain_id);
      if (existingBaseline?.handoff_id === handoffId && current?.session_id === targetSessionId) {
        results.push(existingBaseline);
        continue;
      }
      const expected = binding.source_cursor ?? rootCursor(binding.source_session_id);
      const actual = current ?? rootCursor(binding.source_session_id);
      invariant(sameCursor(actual, expected), "CONTEXT_HANDOFF_SOURCE_CURSOR_MISMATCH", binding.context_domain_id);

      this.pending.delete(binding.context_domain_id);
      this.reconciliationRequired.delete(binding.context_domain_id);
      this.cursorBook.reset(binding.context_domain_id);
      const targetWindow = this.cursorBook.plan(binding.context_domain_id, targetSession.sessionManager);
      const targetCursor = this.cursorBook.commit(targetWindow);
      const baseline = Object.freeze({
        schema_version: CONTEXT_HANDOFF_BINDING_VERSION,
        context_domain_id: binding.context_domain_id,
        binding_id: durableBinding?.binding_id ?? binding.binding_id ?? null,
        handoff_id: handoffId,
        checkpoint_id: checkpointId,
        source_session_id: binding.source_session_id,
        target_session_id: targetSessionId,
        source_cursor: Object.freeze({ ...binding.source_cursor }),
        source_tail_cursor: Object.freeze({ ...binding.source_tail_cursor }),
        source_lag_entry_count: binding.lag_entry_count,
        target_cursor: Object.freeze({ ...targetCursor }),
        rebase_policy: binding.rebase_policy,
      });
      this.durableBaselines.set(binding.context_domain_id, baseline);
      this.stateStore?.setBaseline(binding.context_domain_id, baseline, { handoffId });
      results.push(baseline);
    }
    return Object.freeze(results);
  }

  project(event, ctx) {
    const model = ctx?.model;
    if (!model) return null;
    const domain = this.contextDomains.resolve(model);
    if (domain.kind !== "external-stateful") return null;

    const memoryReconciliation = this.reconciliationRequired.get(domain.context_domain_id);
    invariant(!memoryReconciliation, "CONTEXT_SYNC_RECONCILIATION_REQUIRED", `${domain.context_domain_id}:${memoryReconciliation?.reason ?? "unknown"}`);

    const pending = this.pending.get(domain.context_domain_id);
    if (pending) {
      invariant(pending.session_id === ctx.sessionManager.getSessionId(), "CONTEXT_SYNC_PENDING_SESSION_MISMATCH");
      return Object.freeze({ messages: pending.messages, envelope: pending.envelope, domain });
    }

    const durableUnresolved = this.stateStore?.unresolvedDelivery(domain.context_domain_id) ?? null;
    if (durableUnresolved) {
      let failure = durableFailure(durableUnresolved);
      if (durableUnresolved.state === "PREPARED") {
        const reconciled = this.stateStore.markDeliveryReconciliation(
          domain.context_domain_id,
          durableUnresolved.transfer_id,
          "restart-or-lost-process-with-prepared-transfer",
        );
        failure = durableFailure(reconciled);
      }
      this.reconciliationRequired.set(domain.context_domain_id, failure);
      invariant(false, "CONTEXT_SYNC_RECONCILIATION_REQUIRED", `${domain.context_domain_id}:${failure.reason}`);
    }

    const window = this.cursorBook.plan(domain.context_domain_id, ctx.sessionManager);
    const branchEntries = ctx.sessionManager.getBranch();
    const transfer = hydrateContextTransfer({
      window,
      targetDomain: domain,
      ledger: this.ledger.read(),
      gitState: this.observeGit(),
      evidence: this.evidenceProvider({ window, domain, ctx }) ?? [],
      hydrationBudget: this.hydrationBudget,
    });
    const liveUserInput = latestUserInput(window.entries, this.protocolBudget.max_live_user_chars);
    const toolResults = protocolToolResults(window.entries, branchEntries, domain, this.protocolBudget);
    const durableBaseline = this.durableBaselines.get(domain.context_domain_id) ?? this.stateStore?.getBaseline(domain.context_domain_id) ?? null;
    if (durableBaseline && !this.durableBaselines.has(domain.context_domain_id)) this.durableBaselines.set(domain.context_domain_id, durableBaseline);
    const binding = this.stateStore?.ensureBinding(domain) ?? null;
    const envelope = Object.freeze({
      schema_version: CONTEXT_SYNC_ENVELOPE_VERSION,
      context_domain_id: domain.context_domain_id,
      context_binding_id: binding?.binding_id ?? null,
      durable_baseline: durableBaseline,
      privacy_boundary: Object.freeze({
        schema_version: CONTEXT_SYNC_PRIVACY_BOUNDARY_VERSION,
        hydration_policy_version: transfer.privacy_policy.schema_version,
        historical_raw_tool_output: "excluded",
        live_tool_result_policy: "domain-owned-post-watermark-correlated-bounded",
        live_user_input_policy: "latest-post-watermark-bounded",
        transcript_dump: false,
        summarization: "none",
        complete_envelope_scan: "fail-closed-before-transport",
      }),
      transfer,
      live_user_input: liveUserInput,
      protocol_tool_results: toolResults,
      truncation: outboundTruncation(transfer, liveUserInput, toolResults),
    });
    // P4 requires one final scan over the complete assembled envelope, including
    // live user input and correlated tool continuation, before any transport or
    // durable delivery prepare can observe it.
    assertNoSecrets(envelope);
    this.stateStore?.prepareDelivery(window, domain);
    const messages = Object.freeze([transferMessage(envelope)]);
    const record = Object.freeze({
      session_id: ctx.sessionManager.getSessionId(),
      provider_id: model.provider,
      model_id: model.id,
      window,
      envelope,
      messages,
    });
    this.pending.set(domain.context_domain_id, record);
    this.lastProjection.set(domain.context_domain_id, record);
    return Object.freeze({ messages, envelope, domain });
  }

  acknowledgeTurn(event, ctx) {
    const message = event?.message;
    if (!message || message.role !== "assistant") return null;
    const model = ctx?.model;
    if (!model) return null;
    const domain = this.contextDomains.resolve(model);
    if (domain.kind !== "external-stateful" || !modelMatchesDomain(message, domain)) return null;

    const pending = this.pending.get(domain.context_domain_id);
    if (!pending) return null;
    invariant(pending.provider_id === model.provider && pending.model_id === model.id, "CONTEXT_SYNC_PENDING_MODEL_MISMATCH");

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      this.pending.delete(domain.context_domain_id);
      const durable = this.stateStore?.markDeliveryReconciliation(domain.context_domain_id, pending.window.transfer_id, message.stopReason) ?? null;
      const failure = durable ? durableFailure(durable) : Object.freeze({
        schema_version: CONTEXT_SYNC_ENVELOPE_VERSION,
        context_domain_id: domain.context_domain_id,
        session_id: pending.session_id,
        transfer_id: pending.window.transfer_id,
        reason: message.stopReason,
      });
      this.reconciliationRequired.set(domain.context_domain_id, failure);
      return Object.freeze({ domain, reconciliation_required: failure });
    }

    const entryId = assistantEntryId(ctx.sessionManager, message, domain);
    invariant(entryId, "CONTEXT_SYNC_ASSISTANT_ENTRY_NOT_PERSISTED");
    const cursor = this.cursorBook.acknowledgeThroughEntry(pending.window, ctx.sessionManager, entryId);
    this.stateStore?.acknowledgeDelivery(domain.context_domain_id, pending.window.transfer_id);
    this.pending.delete(domain.context_domain_id);
    this.reconciliationRequired.delete(domain.context_domain_id);
    this.durableBaselines.delete(domain.context_domain_id);
    this.stateStore?.clearBaseline(domain.context_domain_id);
    return Object.freeze({ domain, cursor, transfer_id: pending.window.transfer_id });
  }

  resolveReconciliation(contextDomainId, action) {
    invariant(action === "retry-from-last-acknowledged", "CONTEXT_SYNC_RECONCILIATION_ACTION_INVALID", action);
    const failure = this.reconciliationRequired.get(contextDomainId) ?? durableFailure(this.stateStore?.unresolvedDelivery(contextDomainId) ?? null);
    invariant(failure, "CONTEXT_SYNC_RECONCILIATION_NOT_REQUIRED", contextDomainId);
    if (this.stateStore?.unresolvedDelivery(contextDomainId)?.state === "RECONCILIATION_REQUIRED") {
      this.stateStore.approveDeliveryRetry(contextDomainId);
    }
    this.reconciliationRequired.delete(contextDomainId);
    return failure;
  }

  reconciliationFor(contextDomainId) {
    return this.reconciliationRequired.get(contextDomainId) ?? durableFailure(this.stateStore?.unresolvedDelivery(contextDomainId) ?? null);
  }

  projectionFor(contextDomainId) {
    return this.lastProjection.get(contextDomainId) ?? null;
  }
}
