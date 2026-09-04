import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHATGPT_HUMAN_SIDECAR_PREFIX,
  ChatgptHumanSidecar,
} from "../src/chatgpt-human-sidecar.mjs";
import { ContextDomainRegistry } from "../src/context-domain.mjs";
import { ContextStateStore, DurableContextCursorBook } from "../src/context-state.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { GuardianStorage } from "../src/storage.mjs";

function writeLedger(root) {
  const task = {
    schema_version: "0.1.0",
    task_id: "TASK-HUMAN-SIDECAR",
    title: "ChatGPT human sidecar",
    objective: "Carry bounded project context to ordinary ChatGPT through an explicit human copy/paste boundary",
    requirements_version: "REQ-HUMAN-SIDECAR-1",
    plan_revision_id: "PLAN-HUMAN-SIDECAR-1",
    status: "IN_PROGRESS",
    completion_criteria: ["bounded export", "durable import"],
    risk: "MEDIUM",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    current_item: "ITEM-HUMAN-SIDECAR",
    next_item: null,
    next_step: "Review the imported ChatGPT response in Pi",
    model_policy: "code/codex",
    reasoning_policy: "high",
    minimal_reads: ["src/runner.mjs"],
    relevant_decisions: ["Pi remains the primary harness"],
    relevant_tests: ["node --test test/chatgpt-human-sidecar.test.mjs"],
    evidence_references: [],
    task_items: [{
      task_item_id: "ITEM-HUMAN-SIDECAR",
      task_id: "TASK-HUMAN-SIDECAR",
      title: "Human-mediated ChatGPT bridge",
      description: "Export bounded context and import a manual reply",
      status: "IN_PROGRESS",
      depends_on: [],
      completion_criteria: ["export", "import"],
      evidence: [],
      requirements_refs: ["ADR-0016A temporary fallback"],
      risk: "MEDIUM",
      milestone: "0.3-A-SIDECAR",
      last_updated_at: "2026-09-04T00:00:00.000Z",
      last_updated_by: "test",
    }],
  };
  writeFileSync(join(root, "TASK_PLAN.md"), `# Human sidecar\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

class FakeSessionManager {
  constructor(id = "SESSION-HUMAN-SIDECAR") {
    this.id = id;
    this.entries = [];
    this.counter = 0;
  }
  getSessionId() { return this.id; }
  getBranch() { return this.entries; }
  getLeafId() { return this.entries.at(-1)?.id ?? null; }
  appendMessage(message) {
    const id = `ENTRY-${++this.counter}`;
    this.entries.push({
      type: "message",
      id,
      parentId: this.entries.at(-1)?.id ?? null,
      message: structuredClone(message),
    });
    return id;
  }
  appendAssistant(text, provider = "code", model = "codex") {
    return this.appendMessage({
      role: "assistant",
      provider,
      model,
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
  appendUser(text) {
    return this.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  }
}

function fakeGit(root) {
  return {
    repository_id: "human-sidecar-test",
    workdir: root,
    branch: "feat/chatgpt-human-sidecar",
    head_sha: "abc123",
    base_sha: "def456",
    index_digest: "sha256:index",
    worktree_digest: "sha256:worktree",
    status_entries: ["M src/chatgpt-human-sidecar.mjs"],
  };
}

function memoryClipboard(initial = "") {
  return {
    value: initial,
    writes: 0,
    reads: 0,
    write(text) { this.writes += 1; this.value = text; },
    read() { this.reads += 1; return this.value; },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-human-sidecar-"));
  writeLedger(root);
  const storagePath = join(root, "guardian.sqlite");
  const storage = new GuardianStorage(storagePath);
  const ledger = new TaskLedger(join(root, "TASK_PLAN.md"));
  const state = new ContextStateStore(storage, ledger.read().task_id);
  const cursors = new DurableContextCursorBook(state);
  const domains = new ContextDomainRegistry();
  const clipboard = memoryClipboard();
  const session = new FakeSessionManager();
  const sidecar = new ChatgptHumanSidecar({
    contextDomains: domains,
    cursorBook: cursors,
    stateStore: state,
    ledger,
    observeGit: () => fakeGit(root),
    clipboard,
  });
  return { root, storagePath, storage, ledger, state, cursors, domains, clipboard, session, sidecar };
}

test("human sidecar exports bounded post-watermark context and imports reply without replay", () => {
  const x = fixture();
  try {
    x.session.appendAssistant("CODE_DELTA_BEFORE_CHATGPT");
    const exported = x.sidecar.ask({ sessionManager: x.session, question: "REVIEW_CURRENT_DESIGN" });
    assert.equal(exported.delivery_state, "PREPARED");
    assert.equal(x.clipboard.writes, 1);
    assert.match(x.clipboard.value, new RegExp(CHATGPT_HUMAN_SIDECAR_PREFIX.replaceAll("/", "\\/")));
    assert.match(x.clipboard.value, /CODE_DELTA_BEFORE_CHATGPT/);
    assert.match(x.clipboard.value, /REVIEW_CURRENT_DESIGN/);
    assert.equal(x.state.latestDelivery(exported.context_domain_id).state, "PREPARED");
    assert.equal(x.cursors.get(exported.context_domain_id), null, "export must not advance the sidecar cursor");

    x.clipboard.value = "CHATGPT_DECISION_KEEP_WEBSOCKET";
    const imported = x.sidecar.importReply({ sessionManager: x.session });
    assert.equal(imported.delivery_state, "ACKNOWLEDGED");
    assert.equal(x.state.latestDelivery(exported.context_domain_id).state, "ACKNOWLEDGED");
    assert.equal(x.cursors.get(exported.context_domain_id).entry_id, x.session.getLeafId());
    assert.match(JSON.stringify(x.session.getBranch().at(-1).message.content), /CHATGPT_DECISION_KEEP_WEBSOCKET/);

    x.session.appendAssistant("CODE_DELTA_AFTER_CHATGPT");
    const second = x.sidecar.ask({ sessionManager: x.session, question: "REVIEW_NEW_DELTA" });
    assert.equal(second.delivery_state, "PREPARED");
    assert.match(x.clipboard.value, /CODE_DELTA_AFTER_CHATGPT/);
    assert.match(x.clipboard.value, /REVIEW_NEW_DELTA/);
    assert.doesNotMatch(x.clipboard.value, /CHATGPT_DECISION_KEEP_WEBSOCKET/, "already imported ChatGPT reply must not be replayed to ChatGPT");
    assert.doesNotMatch(x.clipboard.value, /CODE_DELTA_BEFORE_CHATGPT/, "already acknowledged pre-watermark context must not be replayed");
  } finally {
    x.storage.close();
  }
});

test("human sidecar import is restart-safe after response persistence and before cursor acknowledgement", () => {
  const x = fixture();
  const exported = x.sidecar.ask({ sessionManager: x.session, question: "CHECK_RESTART_SAFETY" });
  const responseEntryId = x.session.appendUser(`${CHATGPT_HUMAN_SIDECAR_PREFIX}:RESPONSE:${exported.transfer_id}\nCHATGPT_RESPONSE_ALREADY_PERSISTED`);
  const beforeCount = x.session.getBranch().length;
  x.storage.close();

  const storage2 = new GuardianStorage(x.storagePath);
  try {
    const state2 = new ContextStateStore(storage2, x.ledger.read().task_id);
    const cursors2 = new DurableContextCursorBook(state2);
    const domains2 = new ContextDomainRegistry();
    const clipboard2 = {
      write() { throw new Error("not used"); },
      read() { throw new Error("clipboard must not be reread when response is already persisted"); },
    };
    const sidecar2 = new ChatgptHumanSidecar({
      contextDomains: domains2,
      cursorBook: cursors2,
      stateStore: state2,
      ledger: x.ledger,
      observeGit: () => fakeGit(x.root),
      clipboard: clipboard2,
    });
    const imported = sidecar2.importReply({ sessionManager: x.session });
    assert.equal(imported.reused_persisted_response, true);
    assert.equal(x.session.getBranch().length, beforeCount, "restart import must not duplicate the already persisted response");
    assert.equal(cursors2.get(exported.context_domain_id).entry_id, responseEntryId);
    assert.equal(state2.latestDelivery(exported.context_domain_id).state, "ACKNOWLEDGED");
  } finally {
    storage2.close();
  }
});

test("human sidecar blocks secret-shaped outbound context before clipboard write", () => {
  const x = fixture();
  try {
    x.session.appendUser("accidental token sk-abcdefghijklmnop");
    assert.throws(
      () => x.sidecar.ask({ sessionManager: x.session, question: "CHECK_FOR_SECRETS" }),
      (error) => error.code === "SECRET_SCAN_FAILED",
    );
    assert.equal(x.clipboard.writes, 0);
    assert.equal(x.state.latestDelivery("external:chatgpt-human-sidecar"), null);
  } finally {
    x.storage.close();
  }
});

test("human sidecar rejects importing its own exported capsule as a reply", () => {
  const x = fixture();
  try {
    x.sidecar.ask({ sessionManager: x.session, question: "ASK_CHATGPT" });
    assert.throws(
      () => x.sidecar.importReply({ sessionManager: x.session }),
      (error) => error.code === "CHATGPT_SIDECAR_REPLY_EXPECTED",
    );
    assert.equal(x.state.latestDelivery("external:chatgpt-human-sidecar").state, "PREPARED");
  } finally {
    x.storage.close();
  }
});

test("human sidecar retry explicitly reconciles an unresolved prepared export", () => {
  const x = fixture();
  try {
    const first = x.sidecar.ask({ sessionManager: x.session, question: "FIRST_QUESTION" });
    const second = x.sidecar.retry({ sessionManager: x.session, question: "SECOND_QUESTION" });
    assert.notEqual(second.transfer_id, first.transfer_id);
    assert.equal(x.state.latestDelivery(second.context_domain_id).state, "PREPARED");
    assert.equal(x.state.latestDelivery(second.context_domain_id).attempt, 2);
    assert.match(x.clipboard.value, /SECOND_QUESTION/);
  } finally {
    x.storage.close();
  }
});
