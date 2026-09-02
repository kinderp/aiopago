import { stableId } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

export const CONTEXT_CURSOR_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_TRANSFER_SCHEMA_VERSION = "0.1.0";
export const DEFAULT_CONTEXT_HYDRATION_BUDGET = Object.freeze({
  max_entries: 16,
  max_total_chars: 12000,
  max_entry_chars: 2000,
  max_evidence_items: 8,
});

function requiredString(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be a non-empty string`);
  return value.trim();
}

function sessionId(sessionManager) {
  invariant(sessionManager && typeof sessionManager.getSessionId === "function", "CONTEXT_CURSOR_SESSION_MANAGER_REQUIRED");
  return requiredString(sessionManager.getSessionId(), "CONTEXT_CURSOR_SESSION_ID_REQUIRED", "session_id");
}

function branch(sessionManager) {
  invariant(typeof sessionManager.getBranch === "function", "CONTEXT_CURSOR_BRANCH_REQUIRED");
  const entries = sessionManager.getBranch();
  invariant(Array.isArray(entries), "CONTEXT_CURSOR_BRANCH_INVALID");
  return entries;
}

function cursorFor(sessionManager, entries, entry = entries.at(-1) ?? null) {
  return Object.freeze({
    schema_version: CONTEXT_CURSOR_SCHEMA_VERSION,
    session_id: sessionId(sessionManager),
    entry_id: entry?.id ?? null,
    branch_depth: entries.length,
  });
}

function sameCursor(left, right) {
  return left?.session_id === right?.session_id && left?.entry_id === right?.entry_id;
}

function freezeWindow(window) {
  return Object.freeze({
    ...window,
    source_cursor: Object.freeze({ ...window.source_cursor }),
    target_cursor: Object.freeze({ ...window.target_cursor }),
    entries: Object.freeze(structuredClone(window.entries)),
  });
}

export class ContextCursorBook {
  constructor() {
    this.cursors = new Map();
  }

  get(contextDomainId) {
    return this.cursors.get(contextDomainId) ?? null;
  }

  plan(contextDomainId, sessionManager) {
    const domainId = requiredString(contextDomainId, "CONTEXT_CURSOR_DOMAIN_REQUIRED", "context_domain_id");
    const entries = branch(sessionManager);
    const currentSessionId = sessionId(sessionManager);
    const stored = this.cursors.get(domainId) ?? Object.freeze({
      schema_version: CONTEXT_CURSOR_SCHEMA_VERSION,
      session_id: currentSessionId,
      entry_id: null,
      branch_depth: 0,
    });
    invariant(stored.session_id === currentSessionId, "CONTEXT_CURSOR_SESSION_MISMATCH", `${stored.session_id} != ${currentSessionId}`);

    let startIndex = -1;
    if (stored.entry_id !== null) {
      startIndex = entries.findIndex((entry) => entry.id === stored.entry_id);
      invariant(startIndex >= 0, "CONTEXT_CURSOR_DIVERGED", `entry ${stored.entry_id} is not on the current Pi branch`);
    }
    const delta = entries.slice(startIndex + 1);
    const target = cursorFor(sessionManager, entries);
    return freezeWindow({
      schema_version: CONTEXT_TRANSFER_SCHEMA_VERSION,
      transfer_id: stableId("CTX", domainId, currentSessionId, stored.entry_id ?? "ROOT", target.entry_id ?? "EMPTY"),
      context_domain_id: domainId,
      source_cursor: stored,
      target_cursor: target,
      entries: delta,
    });
  }

  commit(window) {
    invariant(window?.schema_version === CONTEXT_TRANSFER_SCHEMA_VERSION, "CONTEXT_TRANSFER_WINDOW_INVALID");
    const domainId = requiredString(window.context_domain_id, "CONTEXT_CURSOR_DOMAIN_REQUIRED", "context_domain_id");
    const current = this.cursors.get(domainId) ?? Object.freeze({
      schema_version: CONTEXT_CURSOR_SCHEMA_VERSION,
      session_id: window.source_cursor.session_id,
      entry_id: null,
      branch_depth: 0,
    });
    invariant(sameCursor(current, window.source_cursor), "CONTEXT_CURSOR_STALE_COMMIT", domainId);
    const committed = Object.freeze({ ...window.target_cursor });
    this.cursors.set(domainId, committed);
    return committed;
  }

  reset(contextDomainId) {
    this.cursors.delete(contextDomainId);
  }
}

function budget(input = {}) {
  const merged = { ...DEFAULT_CONTEXT_HYDRATION_BUDGET, ...input };
  for (const [key, value] of Object.entries(merged)) {
    invariant(Number.isInteger(value) && value > 0, "CONTEXT_HYDRATION_BUDGET_INVALID", `${key} must be a positive integer`);
  }
  return Object.freeze(merged);
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function entryCandidate(entry) {
  if (entry.type === "message") {
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") return null;
    const text = messageText(entry.message);
    if (!text) return null;
    return {
      entry_id: entry.id,
      kind: role,
      ...(role === "assistant" ? { provider: entry.message.provider ?? null, model: entry.message.model ?? null } : {}),
      text,
    };
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return { entry_id: entry.id, kind: "compaction", text: entry.summary };
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return { entry_id: entry.id, kind: "branch_summary", text: entry.summary };
  }
  if (entry.type === "model_change") {
    return { entry_id: entry.id, kind: "model_change", text: `${entry.provider}/${entry.modelId}` };
  }
  return null;
}

function gitProjection(gitState) {
  if (!gitState) return null;
  return Object.freeze({
    repository_id: gitState.repository_id ?? null,
    branch: gitState.branch ?? null,
    head_sha: gitState.head_sha ?? null,
    base_sha: gitState.base_sha ?? null,
    index_digest: gitState.index_digest ?? null,
    worktree_digest: gitState.worktree_digest ?? null,
    status_entries: Object.freeze([...(gitState.status_entries ?? [])]),
  });
}

function boundedCollector(limits) {
  let remaining = limits.max_total_chars;
  let truncated = false;
  const take = (value, perItem = limits.max_entry_chars) => {
    const text = String(value ?? "");
    const allowed = Math.max(0, Math.min(perItem, remaining));
    if (allowed === 0) {
      if (text.length > 0) truncated = true;
      return "";
    }
    const clipped = text.slice(0, allowed);
    if (clipped.length < text.length) truncated = true;
    remaining -= clipped.length;
    return clipped;
  };
  return {
    take,
    markTruncated() { truncated = true; },
    get truncated() { return truncated; },
    get remaining() { return remaining; },
  };
}

export function hydrateContextTransfer({ window, targetDomain, ledger = null, gitState = null, evidence = [], hydrationBudget = undefined } = {}) {
  invariant(window?.schema_version === CONTEXT_TRANSFER_SCHEMA_VERSION, "CONTEXT_TRANSFER_WINDOW_INVALID");
  invariant(targetDomain?.context_domain_id === window.context_domain_id, "CONTEXT_TRANSFER_DOMAIN_MISMATCH");
  const limits = budget(hydrationBudget);
  const collector = boundedCollector(limits);

  const recent = [];
  for (const entry of window.entries) {
    const candidate = entryCandidate(entry);
    if (!candidate) continue;
    if (recent.length >= limits.max_entries) {
      collector.markTruncated();
      break;
    }
    const text = collector.take(candidate.text);
    if (!text && candidate.text.length > 0) break;
    recent.push(Object.freeze({ ...candidate, text }));
  }

  const hydratedEvidence = [];
  for (const item of evidence) {
    if (hydratedEvidence.length >= limits.max_evidence_items) {
      collector.markTruncated();
      break;
    }
    const text = collector.take(item?.text ?? "");
    if (!text && String(item?.text ?? "").length > 0) break;
    hydratedEvidence.push(Object.freeze({
      kind: item?.kind ?? "text",
      source: item?.source ?? null,
      text,
    }));
  }

  const objective = collector.take(ledger?.objective ?? "");
  const nextStep = collector.take(ledger?.next_step ?? "");
  const decisions = [];
  for (const decision of ledger?.relevant_decisions ?? []) {
    const text = collector.take(decision);
    if (!text && String(decision).length > 0) break;
    decisions.push(text);
  }
  const tests = [];
  for (const test of ledger?.relevant_tests ?? []) {
    const text = collector.take(test);
    if (!text && String(test).length > 0) break;
    tests.push(text);
  }

  return Object.freeze({
    schema_version: CONTEXT_TRANSFER_SCHEMA_VERSION,
    transfer_id: window.transfer_id,
    target_context_domain_id: targetDomain.context_domain_id,
    source_cursor: Object.freeze({ ...window.source_cursor }),
    target_cursor: Object.freeze({ ...window.target_cursor }),
    project: Object.freeze({
      task_id: ledger?.task_id ?? null,
      plan_revision_id: ledger?.plan_revision_id ?? null,
      requirements_version: ledger?.requirements_version ?? null,
      current_item: ledger?.current_item ?? null,
      next_item: ledger?.next_item ?? null,
      objective,
      next_step: nextStep,
      decisions: Object.freeze(decisions),
      tests: Object.freeze(tests),
    }),
    git: gitProjection(gitState),
    recent_context: Object.freeze(recent),
    hydrated_evidence: Object.freeze(hydratedEvidence),
    budget: limits,
    truncated: collector.truncated,
    remaining_chars: collector.remaining,
  });
}
