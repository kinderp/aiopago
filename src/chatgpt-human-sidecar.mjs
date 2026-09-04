import { spawnSync } from "node:child_process";
import { canonicalJson } from "./canonical.mjs";
import { createContextDomainDescriptor } from "./context-domain.mjs";
import { CONTEXT_TRANSFER_SCHEMA_VERSION, hydrateContextTransfer } from "./context-transfer.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { assertNoSecrets } from "./secret-scan.mjs";

export const CHATGPT_HUMAN_SIDECAR_SCHEMA_VERSION = "0.1.0";
export const CHATGPT_HUMAN_SIDECAR_PREFIX = `AIOPAGO_CHATGPT_HUMAN_SIDECAR/${CHATGPT_HUMAN_SIDECAR_SCHEMA_VERSION}`;
export const CHATGPT_HUMAN_SIDECAR_DOMAIN_ID = "external:chatgpt-human-sidecar";
export const CHATGPT_HUMAN_SIDECAR_PROVIDER_ID = "chatgpt-human-sidecar";
export const CHATGPT_HUMAN_SIDECAR_MODEL_ID = "manual-chatgpt";
export const DEFAULT_CHATGPT_HUMAN_SIDECAR_IMPORT_LIMIT = 120_000;

export const CHATGPT_HUMAN_SIDECAR_DOMAIN = createContextDomainDescriptor({
  context_domain_id: CHATGPT_HUMAN_SIDECAR_DOMAIN_ID,
  kind: "external-stateful",
  provider_id: CHATGPT_HUMAN_SIDECAR_PROVIDER_ID,
  model_id: CHATGPT_HUMAN_SIDECAR_MODEL_ID,
  usage_pool: "human-mediated-chatgpt",
  transport_adapter_id: "chatgpt-human-sidecar/manual-copy-paste",
  capabilities: {
    local_files_direct: false,
    pi_tools: false,
    authoritative_context_usage: false,
  },
});

function requiredText(value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} must be non-empty text`);
  return value.trim();
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

function runClipboard(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
  if (!result.error && result.status === 0) return result.stdout ?? "";
  return null;
}

export function createSystemClipboard({ platform = process.platform } = {}) {
  return Object.freeze({
    write(text) {
      const value = requiredText(text, "CHATGPT_SIDECAR_CLIPBOARD_TEXT_REQUIRED", "clipboard text");
      if (platform === "darwin") {
        if (runClipboard("pbcopy", [], { input: value }) !== null) return;
      } else if (platform === "win32") {
        if (runClipboard("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"], { input: value }) !== null) return;
      } else {
        const writers = [
          ["wl-copy", []],
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
        ];
        for (const [command, args] of writers) {
          if (runClipboard(command, args, { input: value }) !== null) return;
        }
      }
      throw new GuardianError("CHATGPT_SIDECAR_CLIPBOARD_UNAVAILABLE", "No supported local clipboard writer is available");
    },
    read() {
      if (platform === "darwin") {
        const value = runClipboard("pbpaste", []);
        if (value !== null) return value;
      } else if (platform === "win32") {
        const value = runClipboard("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]);
        if (value !== null) return value;
      } else {
        const readers = [
          ["wl-paste", ["-n"]],
          ["xclip", ["-selection", "clipboard", "-o"]],
          ["xsel", ["--clipboard", "--output"]],
        ];
        for (const [command, args] of readers) {
          const value = runClipboard(command, args);
          if (value !== null) return value;
        }
      }
      throw new GuardianError("CHATGPT_SIDECAR_CLIPBOARD_UNAVAILABLE", "No supported local clipboard reader is available");
    },
  });
}

function sameCursor(left, right) {
  return left?.schema_version === right?.schema_version
    && left?.session_id === right?.session_id
    && left?.entry_id === right?.entry_id
    && left?.branch_depth === right?.branch_depth;
}

function reconstructWindow(delivery) {
  return Object.freeze({
    schema_version: CONTEXT_TRANSFER_SCHEMA_VERSION,
    transfer_id: delivery.transfer_id,
    context_domain_id: delivery.context_domain_id,
    source_cursor: delivery.source_cursor,
    target_cursor: delivery.target_cursor,
    entries: Object.freeze([]),
  });
}

function appendMessage(sessionManager, text) {
  invariant(sessionManager && typeof sessionManager.appendMessage === "function", "CHATGPT_SIDECAR_SESSION_APPEND_REQUIRED");
  const returned = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
  if (typeof returned === "string" && returned.length > 0) return returned;
  const leaf = typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() : null;
  if (typeof leaf === "string" && leaf.length > 0) return leaf;
  const last = sessionManager.getBranch?.().at(-1);
  invariant(typeof last?.id === "string" && last.id.length > 0, "CHATGPT_SIDECAR_SESSION_APPEND_ID_MISSING");
  return last.id;
}

function responseMarker(transferId) {
  return `${CHATGPT_HUMAN_SIDECAR_PREFIX}:RESPONSE:${transferId}`;
}

function existingResponseEntry(sessionManager, transferId) {
  const marker = responseMarker(transferId);
  const entries = sessionManager.getBranch?.() ?? [];
  return entries.find((entry) => entry?.type === "message" && entry.message?.role === "user" && messageText(entry.message).startsWith(marker)) ?? null;
}

function branchIndex(sessionManager, entryId) {
  if (entryId === null || entryId === undefined) return -1;
  return (sessionManager.getBranch?.() ?? []).findIndex((entry) => entry.id === entryId);
}

function requestMessage(question) {
  return `${CHATGPT_HUMAN_SIDECAR_PREFIX}:REQUEST\n${question}`;
}

function responseMessage(transferId, response) {
  return `${responseMarker(transferId)}\n${response}`;
}

function capsuleText(capsule) {
  return `${CHATGPT_HUMAN_SIDECAR_PREFIX}\n${canonicalJson(capsule)}`;
}

export class ChatgptHumanSidecar {
  constructor({
    contextDomains,
    cursorBook,
    stateStore,
    ledger,
    observeGit,
    evidenceProvider = () => [],
    hydrationBudget = undefined,
    clipboard = createSystemClipboard(),
    maxImportChars = DEFAULT_CHATGPT_HUMAN_SIDECAR_IMPORT_LIMIT,
  } = {}) {
    invariant(contextDomains && typeof contextDomains.register === "function" && typeof contextDomains.get === "function", "CHATGPT_SIDECAR_DOMAIN_REGISTRY_REQUIRED");
    invariant(cursorBook && typeof cursorBook.plan === "function" && typeof cursorBook.acknowledgeThroughEntry === "function", "CHATGPT_SIDECAR_CURSOR_BOOK_REQUIRED");
    invariant(stateStore && typeof stateStore.ensureBinding === "function" && typeof stateStore.prepareDelivery === "function", "CHATGPT_SIDECAR_STATE_STORE_REQUIRED");
    invariant(ledger && typeof ledger.read === "function", "CHATGPT_SIDECAR_LEDGER_REQUIRED");
    invariant(typeof observeGit === "function", "CHATGPT_SIDECAR_GIT_OBSERVER_REQUIRED");
    invariant(typeof evidenceProvider === "function", "CHATGPT_SIDECAR_EVIDENCE_PROVIDER_INVALID");
    invariant(clipboard && typeof clipboard.write === "function" && typeof clipboard.read === "function", "CHATGPT_SIDECAR_CLIPBOARD_INVALID");
    invariant(Number.isInteger(maxImportChars) && maxImportChars > 0, "CHATGPT_SIDECAR_IMPORT_LIMIT_INVALID");
    this.contextDomains = contextDomains;
    this.cursorBook = cursorBook;
    this.stateStore = stateStore;
    this.ledger = ledger;
    this.observeGit = observeGit;
    this.evidenceProvider = evidenceProvider;
    this.hydrationBudget = hydrationBudget;
    this.clipboard = clipboard;
    this.maxImportChars = maxImportChars;

    // If the sidecar has been used before, restore its domain immediately so a
    // later full Aiopago handoff includes it even before the first sidecar command.
    if (this.stateStore.getBinding?.(CHATGPT_HUMAN_SIDECAR_DOMAIN_ID)) this.ensureDomain();
  }

  ensureDomain() {
    const existing = this.contextDomains.get(CHATGPT_HUMAN_SIDECAR_PROVIDER_ID, CHATGPT_HUMAN_SIDECAR_MODEL_ID);
    const domain = existing ?? this.contextDomains.register(CHATGPT_HUMAN_SIDECAR_DOMAIN);
    invariant(domain.context_domain_id === CHATGPT_HUMAN_SIDECAR_DOMAIN_ID, "CHATGPT_SIDECAR_DOMAIN_CONFLICT");
    invariant(domain.transport_adapter_id === CHATGPT_HUMAN_SIDECAR_DOMAIN.transport_adapter_id, "CHATGPT_SIDECAR_DOMAIN_CONFLICT");
    this.stateStore.ensureBinding(domain);
    return domain;
  }

  status() {
    const delivery = this.stateStore.latestDelivery?.(CHATGPT_HUMAN_SIDECAR_DOMAIN_ID) ?? null;
    const cursor = this.cursorBook.get?.(CHATGPT_HUMAN_SIDECAR_DOMAIN_ID) ?? this.stateStore.getCursor?.(CHATGPT_HUMAN_SIDECAR_DOMAIN_ID) ?? null;
    return Object.freeze({
      schema_version: CHATGPT_HUMAN_SIDECAR_SCHEMA_VERSION,
      context_domain_id: CHATGPT_HUMAN_SIDECAR_DOMAIN_ID,
      transport: "human-copy-paste",
      automated_chatgpt_transport: false,
      delivery_state: delivery?.state ?? "IDLE",
      transfer_id: delivery?.transfer_id ?? null,
      attempt: delivery?.attempt ?? 0,
      cursor: cursor ? Object.freeze({ ...cursor }) : null,
    });
  }

  ask({ sessionManager, question } = {}) {
    const domain = this.ensureDomain();
    const request = requiredText(question, "CHATGPT_SIDECAR_QUESTION_REQUIRED", "question");
    assertNoSecrets({ request });
    const unresolved = this.stateStore.unresolvedDelivery(domain.context_domain_id);
    invariant(!unresolved, "CHATGPT_SIDECAR_IMPORT_REQUIRED", unresolved ? `${unresolved.state}:${unresolved.transfer_id}` : undefined);

    appendMessage(sessionManager, requestMessage(request));
    const window = this.cursorBook.plan(domain.context_domain_id, sessionManager);
    const transfer = hydrateContextTransfer({
      window,
      targetDomain: domain,
      ledger: this.ledger.read(),
      gitState: this.observeGit(),
      evidence: this.evidenceProvider({ window, domain, ctx: null, source: "chatgpt-human-sidecar" }) ?? [],
      hydrationBudget: this.hydrationBudget,
    });
    const baseline = this.stateStore.getBaseline?.(domain.context_domain_id) ?? null;
    const capsule = Object.freeze({
      schema_version: CHATGPT_HUMAN_SIDECAR_SCHEMA_VERSION,
      context_domain_id: domain.context_domain_id,
      transport: "human-copy-paste",
      product_label: "ChatGPT human sidecar",
      automated_chatgpt_transport: false,
      usage_pool_label: domain.usage_pool,
      transfer_id: window.transfer_id,
      durable_baseline: baseline,
      request,
      instructions: Object.freeze([
        "Use only the supplied project/context evidence plus your general knowledge.",
        "Do not assume direct repository or tool access unless the capsule explicitly contains that evidence.",
        "Answer the request directly; your response will be manually copied back into Pi/Aiopago.",
      ]),
      transfer,
    });
    assertNoSecrets(capsule);
    this.stateStore.prepareDelivery(window, domain);
    const text = capsuleText(capsule);
    try {
      this.clipboard.write(text);
    } catch (error) {
      this.stateStore.markDeliveryReconciliation(domain.context_domain_id, window.transfer_id, "clipboard-export-failed-after-prepare");
      throw error;
    }
    return Object.freeze({
      schema_version: CHATGPT_HUMAN_SIDECAR_SCHEMA_VERSION,
      context_domain_id: domain.context_domain_id,
      transfer_id: window.transfer_id,
      clipboard_chars: text.length,
      truncation: transfer.truncation,
      delivery_state: "PREPARED",
    });
  }

  retry({ sessionManager, question = undefined } = {}) {
    const domain = this.ensureDomain();
    let prior = this.stateStore.unresolvedDelivery(domain.context_domain_id);
    invariant(prior, "CHATGPT_SIDECAR_RETRY_NOT_REQUIRED");
    if (prior.state === "PREPARED") {
      prior = this.stateStore.markDeliveryReconciliation(domain.context_domain_id, prior.transfer_id, "human-requested-sidecar-retry");
    }
    invariant(prior.state === "RECONCILIATION_REQUIRED", "CHATGPT_SIDECAR_RETRY_NOT_REQUIRED", prior.state);
    this.stateStore.approveDeliveryRetry(domain.context_domain_id);

    let request = typeof question === "string" && question.trim().length > 0 ? question.trim() : null;
    if (!request) {
      const branch = sessionManager.getBranch?.() ?? [];
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        const text = branch[index]?.type === "message" ? messageText(branch[index].message) : "";
        if (!text.startsWith(`${CHATGPT_HUMAN_SIDECAR_PREFIX}:REQUEST\n`)) continue;
        request = text.slice(`${CHATGPT_HUMAN_SIDECAR_PREFIX}:REQUEST\n`.length).trim();
        break;
      }
    }
    return this.ask({ sessionManager, question: requiredText(request, "CHATGPT_SIDECAR_QUESTION_REQUIRED", "retry question") });
  }

  importReply({ sessionManager } = {}) {
    const domain = this.ensureDomain();
    const delivery = this.stateStore.unresolvedDelivery(domain.context_domain_id);
    invariant(delivery?.state === "PREPARED", "CHATGPT_SIDECAR_PREPARED_EXPORT_REQUIRED", delivery?.state ?? "IDLE");
    invariant(sessionManager?.getSessionId?.() === delivery.session_id, "CHATGPT_SIDECAR_SESSION_MISMATCH", `${sessionManager?.getSessionId?.()} != ${delivery.session_id}`);

    let responseEntry = existingResponseEntry(sessionManager, delivery.transfer_id);
    let responseChars = null;
    if (!responseEntry) {
      const response = requiredText(this.clipboard.read(), "CHATGPT_SIDECAR_REPLY_REQUIRED", "ChatGPT clipboard reply");
      invariant(!response.startsWith(CHATGPT_HUMAN_SIDECAR_PREFIX), "CHATGPT_SIDECAR_REPLY_EXPECTED", "Clipboard still contains an Aiopago sidecar capsule rather than a ChatGPT reply");
      invariant(response.length <= this.maxImportChars, "CHATGPT_SIDECAR_REPLY_TOO_LARGE", `${response.length} > ${this.maxImportChars}`);
      const entryId = appendMessage(sessionManager, responseMessage(delivery.transfer_id, response));
      responseEntry = { id: entryId };
      responseChars = response.length;
    }

    const window = reconstructWindow(delivery);
    const current = this.cursorBook.get(domain.context_domain_id);
    let cursor;
    if (!current || sameCursor(current, delivery.source_cursor)) {
      cursor = this.cursorBook.acknowledgeThroughEntry(window, sessionManager, responseEntry.id);
    } else {
      const currentIndex = branchIndex(sessionManager, current.entry_id);
      const responseIndex = branchIndex(sessionManager, responseEntry.id);
      invariant(current.session_id === delivery.session_id && currentIndex >= responseIndex && responseIndex >= 0, "CHATGPT_SIDECAR_CURSOR_RECONCILIATION_REQUIRED");
      cursor = current;
    }

    this.stateStore.acknowledgeDelivery(domain.context_domain_id, delivery.transfer_id);
    this.stateStore.clearBaseline?.(domain.context_domain_id);
    return Object.freeze({
      schema_version: CHATGPT_HUMAN_SIDECAR_SCHEMA_VERSION,
      context_domain_id: domain.context_domain_id,
      transfer_id: delivery.transfer_id,
      delivery_state: "ACKNOWLEDGED",
      response_chars: responseChars,
      reused_persisted_response: responseChars === null,
      cursor,
    });
  }
}
