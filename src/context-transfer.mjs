import { stableId } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

export const CONTEXT_CURSOR_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_TRANSFER_SCHEMA_VERSION = "0.2.0";
export const CONTEXT_HYDRATION_POLICY_SCHEMA_VERSION = "0.1.0";
export const DEFAULT_CONTEXT_HYDRATION_BUDGET = Object.freeze({
  max_entries: 16,
  max_total_chars: 12000,
  max_entry_chars: 2000,
  max_evidence_items: 8,
  max_git_status_entries: 64,
  max_metadata_chars: 512,
});
export const DEFAULT_CONTEXT_HYDRATION_POLICY = Object.freeze({
  schema_version: CONTEXT_HYDRATION_POLICY_SCHEMA_VERSION,
  strategy: "durable-state-first-bounded",
  projection_order: Object.freeze(["project", "git", "hydrated_evidence", "recent_context"]),
  recent_context: "post-watermark-projection-only",
  raw_tool_output: "excluded-from-hydration",
  transcript_dump: false,
  summarization: "none",
});

const HYDRATION_BUDGET_KEYS = Object.freeze(Object.keys(DEFAULT_CONTEXT_HYDRATION_BUDGET));

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
  let depth = 0;
  if (entry) {
    const index = entries.findIndex((candidate) => candidate.id === entry.id);
    invariant(index >= 0, "CONTEXT_CURSOR_DIVERGED", `entry ${entry.id} is not on the current Pi branch`);
    depth = index + 1;
  }
  return Object.freeze({
    schema_version: CONTEXT_CURSOR_SCHEMA_VERSION,
    session_id: sessionId(sessionManager),
    entry_id: entry?.id ?? null,
    branch_depth: depth,
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

  currentForWindow(window) {
    const domainId = requiredString(window.context_domain_id, "CONTEXT_CURSOR_DOMAIN_REQUIRED", "context_domain_id");
    return this.cursors.get(domainId) ?? Object.freeze({
      schema_version: CONTEXT_CURSOR_SCHEMA_VERSION,
      session_id: window.source_cursor.session_id,
      entry_id: null,
      branch_depth: 0,
    });
  }

  commit(window) {
    invariant(window?.schema_version === CONTEXT_TRANSFER_SCHEMA_VERSION, "CONTEXT_TRANSFER_WINDOW_INVALID");
    const domainId = requiredString(window.context_domain_id, "CONTEXT_CURSOR_DOMAIN_REQUIRED", "context_domain_id");
    const current = this.currentForWindow(window);
    invariant(sameCursor(current, window.source_cursor), "CONTEXT_CURSOR_STALE_COMMIT", domainId);
    const committed = Object.freeze({ ...window.target_cursor });
    this.cursors.set(domainId, committed);
    return committed;
  }

  acknowledgeThroughEntry(window, sessionManager, entryId) {
    invariant(window?.schema_version === CONTEXT_TRANSFER_SCHEMA_VERSION, "CONTEXT_TRANSFER_WINDOW_INVALID");
    const domainId = requiredString(window.context_domain_id, "CONTEXT_CURSOR_DOMAIN_REQUIRED", "context_domain_id");
    const acknowledgedEntryId = requiredString(entryId, "CONTEXT_CURSOR_ACK_ENTRY_REQUIRED", "entry_id");
    const current = this.currentForWindow(window);
    invariant(sameCursor(current, window.source_cursor), "CONTEXT_CURSOR_STALE_COMMIT", domainId);

    const entries = branch(sessionManager);
    const currentSessionId = sessionId(sessionManager);
    invariant(currentSessionId === window.source_cursor.session_id, "CONTEXT_CURSOR_SESSION_MISMATCH", `${window.source_cursor.session_id} != ${currentSessionId}`);
    const transferTargetIndex = window.target_cursor.entry_id === null
      ? -1
      : entries.findIndex((entry) => entry.id === window.target_cursor.entry_id);
    invariant(window.target_cursor.entry_id === null || transferTargetIndex >= 0, "CONTEXT_CURSOR_DIVERGED", `transfer target ${window.target_cursor.entry_id} is not on the current Pi branch`);
    const acknowledgeIndex = entries.findIndex((entry) => entry.id === acknowledgedEntryId);
    invariant(acknowledgeIndex >= transferTargetIndex && acknowledgeIndex >= 0, "CONTEXT_CURSOR_ACK_BEFORE_TRANSFER", acknowledgedEntryId);

    const acknowledged = cursorFor(sessionManager, entries, entries[acknowledgeIndex]);
    this.cursors.set(domainId, acknowledged);
    return acknowledged;
  }

  reset(contextDomainId) {
    this.cursors.delete(contextDomainId);
  }
}

function budget(input = {}) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "CONTEXT_HYDRATION_BUDGET_INVALID", "budget must be an object");
  for (const key of Object.keys(input)) {
    invariant(HYDRATION_BUDGET_KEYS.includes(key), "CONTEXT_HYDRATION_BUDGET_FIELD_UNKNOWN", key);
  }
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

function isToolResultEntry(entry) {
  return entry?.type === "message" && entry.message?.role === "toolResult";
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

function boundedCollector(limits) {
  let remaining = limits.max_total_chars;
  const reasons = new Set();
  const take = (value, perItem = limits.max_entry_chars, perItemReason = "max_entry_chars") => {
    const text = String(value ?? "");
    const allowed = Math.max(0, Math.min(perItem, remaining));
    if (allowed === 0) {
      if (text.length > 0) reasons.add("max_total_chars");
      return "";
    }
    const clipped = text.slice(0, allowed);
    if (clipped.length < text.length) {
      if (remaining <= perItem) reasons.add("max_total_chars");
      if (perItem <= remaining) reasons.add(perItemReason);
    }
    remaining -= clipped.length;
    return clipped;
  };
  return {
    take,
    markTruncated(reason) { reasons.add(reason); },
    get truncated() { return reasons.size > 0; },
    get remaining() { return remaining; },
    snapshot() {
      return Object.freeze({
        truncated: reasons.size > 0,
        reasons: Object.freeze([...reasons].sort()),
        emitted_chars: limits.max_total_chars - remaining,
        remaining_chars: remaining,
      });
    },
  };
}

function projectList(values, collector, perItem) {
  const result = [];
  for (const value of values ?? []) {
    const original = String(value ?? "");
    const text = collector.take(original, perItem);
    if (!text && original.length > 0) break;
    result.push(text);
  }
  return Object.freeze(result);
}

function gitProjection(gitState, collector, limits) {
  if (!gitState) return null;
  const metadata = (value) => value === null || value === undefined ? null : collector.take(value, limits.max_metadata_chars, "max_metadata_chars");
  const repositoryId = metadata(gitState.repository_id);
  const branchName = metadata(gitState.branch);
  const headSha = metadata(gitState.head_sha);
  const baseSha = metadata(gitState.base_sha);
  const indexDigest = metadata(gitState.index_digest);
  const worktreeDigest = metadata(gitState.worktree_digest);
  const statuses = [];
  const rawStatuses = gitState.status_entries ?? [];
  for (const status of rawStatuses) {
    if (statuses.length >= limits.max_git_status_entries) {
      collector.markTruncated("max_git_status_entries");
      break;
    }
    const original = String(status ?? "");
    const text = collector.take(original, limits.max_metadata_chars, "max_metadata_chars");
    if (!text && original.length > 0) break;
    statuses.push(text);
  }
  return Object.freeze({
    source_ref: repositoryId || headSha ? Object.freeze({ kind: "git-state", repository_id: repositoryId, head_sha: headSha }) : null,
    repository_id: repositoryId,
    branch: branchName,
    head_sha: headSha,
    base_sha: baseSha,
    index_digest: indexDigest,
    worktree_digest: worktreeDigest,
    status_entries: Object.freeze(statuses),
  });
}

export function hydrateContextTransfer({ window, targetDomain, ledger = null, gitState = null, evidence = [], hydrationBudget = undefined } = {}) {
  invariant(window?.schema_version === CONTEXT_TRANSFER_SCHEMA_VERSION, "CONTEXT_TRANSFER_WINDOW_INVALID");
  invariant(targetDomain?.context_domain_id === window.context_domain_id, "CONTEXT_TRANSFER_DOMAIN_MISMATCH");
  invariant(Array.isArray(evidence), "CONTEXT_HYDRATION_EVIDENCE_INVALID", "evidence must be an array");
  const limits = budget(hydrationBudget ?? {});
  const collector = boundedCollector(limits);
  const metadata = (value) => value === null || value === undefined ? null : collector.take(value, limits.max_metadata_chars, "max_metadata_chars");

  // P4 priority: authoritative/durable project state, Git and evidence consume the
  // budget before any post-watermark conversation projection.
  const taskId = metadata(ledger?.task_id);
  const planRevisionId = metadata(ledger?.plan_revision_id);
  const project = Object.freeze({
    source_ref: taskId || planRevisionId ? Object.freeze({ kind: "task-ledger", task_id: taskId, plan_revision_id: planRevisionId }) : null,
    task_id: taskId,
    plan_revision_id: planRevisionId,
    requirements_version: metadata(ledger?.requirements_version),
    current_item: metadata(ledger?.current_item),
    next_item: metadata(ledger?.next_item),
    objective: collector.take(ledger?.objective ?? ""),
    next_step: collector.take(ledger?.next_step ?? ""),
    decisions: projectList(ledger?.relevant_decisions, collector, limits.max_entry_chars),
    tests: projectList(ledger?.relevant_tests, collector, limits.max_entry_chars),
  });

  const git = gitProjection(gitState, collector, limits);

  const hydratedEvidence = [];
  for (const item of evidence) {
    if (hydratedEvidence.length >= limits.max_evidence_items) {
      collector.markTruncated("max_evidence_items");
      break;
    }
    const kind = metadata(item?.kind ?? "text");
    const source = metadata(item?.source);
    const original = String(item?.text ?? "");
    const text = collector.take(original);
    if (!text && original.length > 0) break;
    hydratedEvidence.push(Object.freeze({
      source_ref: source ? Object.freeze({ kind: "evidence", ref: source }) : null,
      kind,
      source,
      text,
      text_truncated: text.length < original.length,
      original_chars: original.length,
    }));
  }

  const recent = [];
  for (const entry of window.entries) {
    const candidate = entryCandidate(entry);
    if (!candidate) continue;
    if (recent.length >= limits.max_entries) {
      collector.markTruncated("max_entries");
      break;
    }
    const entryId = metadata(candidate.entry_id);
    const kind = metadata(candidate.kind);
    const provider = candidate.provider !== undefined ? metadata(candidate.provider) : undefined;
    const model = candidate.provider !== undefined ? metadata(candidate.model) : undefined;
    const original = candidate.text;
    const text = collector.take(original);
    if (!text && original.length > 0) break;
    recent.push(Object.freeze({
      source_ref: entryId ? Object.freeze({ kind: "pi-entry", entry_id: entryId }) : null,
      entry_id: entryId,
      kind,
      ...(provider !== undefined ? { provider, model } : {}),
      text,
      text_truncated: text.length < original.length,
      original_chars: original.length,
    }));
  }

  const truncation = collector.snapshot();
  return Object.freeze({
    schema_version: CONTEXT_TRANSFER_SCHEMA_VERSION,
    transfer_id: window.transfer_id,
    target_context_domain_id: targetDomain.context_domain_id,
    source_cursor: Object.freeze({ ...window.source_cursor }),
    target_cursor: Object.freeze({ ...window.target_cursor }),
    privacy_policy: DEFAULT_CONTEXT_HYDRATION_POLICY,
    project,
    git,
    hydrated_evidence: Object.freeze(hydratedEvidence),
    recent_context: Object.freeze(recent),
    projection_stats: Object.freeze({
      window_entries: window.entries.length,
      hydrated_evidence_items: hydratedEvidence.length,
      recent_context_entries: recent.length,
      raw_tool_result_entries_excluded: window.entries.filter(isToolResultEntry).length,
    }),
    budget: limits,
    truncation,
    truncated: truncation.truncated,
    remaining_chars: truncation.remaining_chars,
  });
}
