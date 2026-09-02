import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTEXT_SYNC_PREFIX } from "../src/context-sync.mjs";
import { defineProviderAdapter } from "../src/provider-adapter.mjs";
import { loadPi } from "../src/pi-loader.mjs";
import { GuardianRunner } from "../src/runner.mjs";

const CHAT_PROVIDER = "chatgpt-stateful-spike";
const CHAT_MODEL = "chatgpt-stateful";
const CODE_PROVIDER = "code-stateful-spike";
const CODE_MODEL = "code-stateful";
const DOMAIN_ID = "chatgpt-stateful:spike";

function writeLedger(root) {
  const task = {
    schema_version: "0.1.0",
    task_id: "TASK-STATEFUL-SPIKE",
    title: "External stateful context and tool spike",
    objective: "Review a code-side implementation from an external stateful model without replaying the full Pi transcript",
    requirements_version: "REQ-GH-32-S3-S4-2026-09-02",
    plan_revision_id: "PLAN-GH-32-S3-S4-1",
    status: "IN_PROGRESS",
    completion_criteria: ["S3 delta continuity", "S4 Pi read tool roundtrip"],
    risk: "HIGH",
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    current_item: "ITEM-S3-S4",
    next_item: null,
    next_step: "Review the implementation and read the bounded local evidence",
    model_policy: `${CHAT_PROVIDER}/${CHAT_MODEL}`,
    reasoning_policy: "off",
    minimal_reads: ["romeo-state.txt"],
    relevant_decisions: ["Use WebSocket for control", "Keep move(direction) as the educational API"],
    relevant_tests: ["node --test test/external-stateful-spike.test.mjs"],
    evidence_references: ["romeo-state.txt"],
    task_items: [
      {
        task_item_id: "ITEM-S3-S4",
        task_id: "TASK-STATEFUL-SPIKE",
        title: "External stateful model continuity",
        description: "Prove watermark hydration and local read tool use",
        status: "IN_PROGRESS",
        depends_on: [],
        completion_criteria: ["one-message transport projection", "post-watermark code delta", "read tool result returned to same external provider"],
        evidence: [],
        requirements_refs: ["GitHub #32 S3", "GitHub #32 S4"],
        risk: "HIGH",
        milestone: "SPIKE-32",
        last_updated_at: "2026-09-02T00:00:00.000Z",
        last_updated_by: "test",
      },
    ],
  };
  writeFileSync(join(root, "TASK_PLAN.md"), `# External stateful spike\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
  writeFileSync(join(root, "romeo-state.txt"), "PEDAGOGICAL_API=move(direction)\nWEBSOCKET_CONTROL=enabled\n");
}

function fakeGitState(root) {
  return {
    repository_id: "stateful-spike",
    workdir: root,
    branch: "feat/websocket",
    head_sha: "abc123",
    base_sha: "def456",
    index_digest: "sha256:index",
    worktree_digest: "sha256:worktree",
    status_entries: ["M romeo-state.txt"],
  };
}

function serialized(context) {
  return JSON.stringify(context.messages);
}

async function bindRuntimeExtensions(runner) {
  await runner.runtime.session.bindExtensions({
    mode: "print",
    commandContextActions: {
      waitForIdle: () => runner.runtime.session.waitForIdle(),
      newSession: (options) => runner.runtime.newSession(options),
      fork: (entryId, options) => runner.runtime.fork(entryId, options),
      navigateTree: (targetId, options) => runner.runtime.session.navigateTree(targetId, options),
      switchSession: (path, options) => runner.runtime.switchSession(path, options),
      reload: async () => {},
    },
  });
}

test("S3/S4 spike: external stateful model gets only Aiopago deltas and can use Pi read without Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiopago-stateful-"));
  const sessions = mkdtempSync(join(tmpdir(), "aiopago-stateful-sessions-"));
  writeLedger(root);

  const pi = await loadPi();
  const previousFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("network forbidden in external-stateful spike");
  };

  let runner = null;
  try {
    const credentials = new pi.ai.InMemoryCredentialStore();
    const modelRuntime = await pi.coding.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
    const chatTransport = pi.ai.fauxProvider({
      provider: CHAT_PROVIDER,
      models: [{ id: CHAT_MODEL, name: "ChatGPT stateful sentinel", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    });
    const codeTransport = pi.ai.fauxProvider({
      provider: CODE_PROVIDER,
      models: [{ id: CODE_MODEL, name: "Code sentinel", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    });

    const remoteRequests = [];
    const codeRequests = [];
    chatTransport.setResponses([
      (context) => {
        remoteRequests.push(structuredClone(context.messages));
        const text = serialized(context);
        assert.equal(context.messages.length, 1, "external provider must receive one Aiopago capsule, not Pi transcript");
        assert.match(text, new RegExp(CONTEXT_SYNC_PREFIX.replaceAll("/", "\\/")));
        assert.match(text, /DISCUSS_ARCHITECTURE/);
        return pi.ai.fauxAssistantMessage("CHAT_DECISION_USE_WEBSOCKET");
      },
      (context) => {
        remoteRequests.push(structuredClone(context.messages));
        const text = serialized(context);
        assert.equal(context.messages.length, 1, "returning external provider must still receive only one capsule");
        assert.match(text, /CODE_IMPLEMENTATION_DONE/, "post-watermark code result must be hydrated");
        assert.match(text, /REVIEW_IMPLEMENTATION/, "current user input must survive projection");
        assert.doesNotMatch(text, /CHAT_DECISION_USE_WEBSOCKET/, "provider's already-acknowledged prior reply must not be replayed");
        return pi.ai.fauxAssistantMessage(
          pi.ai.fauxToolCall("read", { path: "romeo-state.txt" }, { id: "read:romeo-state" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        remoteRequests.push(structuredClone(context.messages));
        const text = serialized(context);
        assert.equal(context.messages.length, 1, "tool continuation must also remain a bounded capsule");
        assert.match(text, /PEDAGOGICAL_API=move\(direction\)/, "Pi read result must return to the same external provider");
        assert.doesNotMatch(text, /CODE_IMPLEMENTATION_DONE/, "already-acknowledged code delta must not be resent after tool use");
        return pi.ai.fauxAssistantMessage("CHAT_REVIEW_TOOL_CONFIRMED");
      },
    ]);
    codeTransport.setResponses([
      (context) => {
        codeRequests.push(structuredClone(context.messages));
        assert.match(serialized(context), /CHAT_DECISION_USE_WEBSOCKET/, "Pi-native code model must see Chat decision in normal Pi context");
        return pi.ai.fauxAssistantMessage("CODE_IMPLEMENTATION_DONE");
      },
    ]);

    modelRuntime.registerNativeProvider(codeTransport.provider);
    const chatAdapter = defineProviderAdapter({
      adapter_id: "chatgpt-stateful-sentinel-adapter",
      provider_id: CHAT_PROVIDER,
      context_domain: {
        context_domain_id: DOMAIN_ID,
        kind: "external-stateful",
        model_id: CHAT_MODEL,
        usage_pool: "chatgpt",
        capabilities: { local_files_direct: false, pi_tools: true, authoritative_context_usage: false },
      },
      install: async ({ modelRuntime: runtime }) => runtime.registerNativeProvider(chatTransport.provider),
    });

    const settingsManager = pi.coding.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    runner = await GuardianRunner.create({
      cwd: root,
      pi,
      modelRuntime,
      providerAdapters: [chatAdapter],
      modelPolicy: `${CHAT_PROVIDER}/${CHAT_MODEL}`,
      reasoningPolicy: "off",
      contextHandoffThresholdPercent: 90,
      settingsManager,
      sessionDir: sessions,
      tools: ["read"],
      observeGit: () => fakeGitState(root),
    });
    await bindRuntimeExtensions(runner);

    const chatModel = runner.modelRuntime.getModel(CHAT_PROVIDER, CHAT_MODEL);
    const codeModel = runner.modelRuntime.getModel(CODE_PROVIDER, CODE_MODEL);
    const session = runner.runtime.session;
    const sessionId = session.sessionId;

    await session.prompt("DISCUSS_ARCHITECTURE");
    assert.equal(chatTransport.state.callCount, 1);
    assert.equal(runner.contextCursors.get(DOMAIN_ID)?.session_id, sessionId);

    await session.setModel(codeModel, { persist: false });
    await session.prompt("IMPLEMENT_AGREED_DESIGN");
    assert.equal(codeTransport.state.callCount, 1);
    assert.equal(chatTransport.state.callCount, 1);

    await session.setModel(chatModel, { persist: false });
    assert.equal(session.sessionId, sessionId, "A→B→A must remain one Pi session");
    await session.prompt("REVIEW_IMPLEMENTATION");

    assert.equal(chatTransport.state.callCount, 3, "review plus read tool continuation should use the external transport twice");
    assert.equal(codeTransport.state.callCount, 1, "Chat-side Pi tool execution must not invoke code provider");
    assert.equal(remoteRequests.length, 3);
    assert.equal(codeRequests.length, 1);
    assert.equal(networkAttempts, 0);

    const branch = session.sessionManager.getBranch();
    const readResult = branch.find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "read:romeo-state");
    assert.ok(readResult, "Pi must persist the read tool result in the local session");
    assert.equal(readResult.message.toolName, "read");
    assert.match(JSON.stringify(readResult.message.content), /PEDAGOGICAL_API=move\(direction\)/);

    const finalProjection = runner.contextSync.projectionFor(DOMAIN_ID);
    assert.ok(finalProjection);
    assert.equal(finalProjection.envelope.protocol_tool_results.items.length, 1, "only the external provider's own tool result is carried as protocol delta");
    assert.equal(finalProjection.envelope.protocol_tool_results.items[0].tool_name, "read");
  } finally {
    if (runner) await runner.dispose();
    globalThis.fetch = previousFetch;
  }
});
