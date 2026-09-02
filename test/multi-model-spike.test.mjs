import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineProviderAdapter } from "../src/provider-adapter.mjs";
import { loadPi } from "../src/pi-loader.mjs";
import { GuardianRunner } from "../src/runner.mjs";

const CHAT_PROVIDER = "chatgpt-normal-spike";
const CHAT_MODEL = "chatgpt-normal";
const CODE_PROVIDER = "codex-spike";
const CODE_MODEL = "codex-spike";

function writeLedger(root) {
  const task = {
    schema_version: "0.1.0",
    task_id: "TASK-MULTI-MODEL-SPIKE",
    title: "Multi-model provider spike",
    objective: "Prove ChatGPT-normal provider registration and isolated model routing in one Pi session",
    requirements_version: "REQ-GH-32-S1-S2-2026-09-02",
    plan_revision_id: "PLAN-GH-32-S1-S2-1",
    status: "IN_PROGRESS",
    completion_criteria: ["offline S1/S2 seam evidence"],
    risk: "HIGH",
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    current_item: "ITEM-S1-S2",
    next_item: null,
    next_step: "Run the provider-registration and transport-isolation spike",
    model_policy: `${CHAT_PROVIDER}/${CHAT_MODEL}`,
    reasoning_policy: "off",
    minimal_reads: ["TASK_PLAN.md"],
    relevant_decisions: ["ADR-0016 proposed multi-model context-domain boundary"],
    relevant_tests: ["node --test test/multi-model-spike.test.mjs"],
    evidence_references: ["GitHub #32"],
    task_items: [
      {
        task_item_id: "ITEM-S1-S2",
        task_id: "TASK-MULTI-MODEL-SPIKE",
        title: "Provider seam",
        description: "Prove one Pi session can route ChatGPT-normal and code turns through distinct transports",
        status: "IN_PROGRESS",
        depends_on: [],
        completion_criteria: ["custom provider selectable", "transport counters isolated", "same Pi session preserved"],
        evidence: [],
        requirements_refs: ["GitHub #32 S1", "GitHub #32 S2"],
        risk: "HIGH",
        milestone: "SPIKE-32",
        last_updated_at: "2026-09-02T00:00:00.000Z",
        last_updated_by: "test",
      },
    ],
  };
  writeFileSync(join(root, "TASK_PLAN.md"), `# Multi-model spike ledger\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

function messagesText(messages) {
  return JSON.stringify(messages);
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

test("S1/S2 spike: ChatGPT Normal and code provider share one Pi session but not one transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiopago-multi-model-"));
  const sessions = mkdtempSync(join(tmpdir(), "aiopago-multi-model-sessions-"));
  writeLedger(root);

  const pi = await loadPi();
  const previousFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("network forbidden in offline multi-model spike");
  };

  let runner = null;
  try {
    const credentials = new pi.ai.InMemoryCredentialStore();
    const modelRuntime = await pi.coding.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
    const chatTransport = pi.ai.fauxProvider({
      provider: CHAT_PROVIDER,
      models: [{ id: CHAT_MODEL, name: "ChatGPT Normal (offline spike)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    });
    const codeTransport = pi.ai.fauxProvider({
      provider: CODE_PROVIDER,
      models: [{ id: CODE_MODEL, name: "Codex route sentinel (offline spike)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    });

    const chatContexts = [];
    const codeContexts = [];
    chatTransport.setResponses([
      (context) => {
        chatContexts.push(structuredClone(context.messages));
        return pi.ai.fauxAssistantMessage("CHAT_DECISION_USE_WEBSOCKET");
      },
      (context) => {
        chatContexts.push(structuredClone(context.messages));
        return pi.ai.fauxAssistantMessage("CHAT_REVIEW_SEES_CODE_CHANGE");
      },
    ]);
    codeTransport.setResponses([
      (context) => {
        codeContexts.push(structuredClone(context.messages));
        return pi.ai.fauxAssistantMessage("CODE_IMPLEMENTATION_DONE");
      },
    ]);

    modelRuntime.registerNativeProvider(codeTransport.provider);
    const chatAdapter = defineProviderAdapter({
      adapter_id: "chatgpt-normal-memory-transport",
      provider_id: CHAT_PROVIDER,
      context_domain: {
        context_domain_id: "chatgpt-normal:spike",
        kind: "external-stateful",
        model_id: CHAT_MODEL,
        usage_pool: "chatgpt",
        capabilities: {
          local_files_direct: false,
          pi_tools: true,
          authoritative_context_usage: false,
        },
      },
      install: async ({ modelRuntime: runtime }) => {
        runtime.registerNativeProvider(chatTransport.provider);
      },
    });

    const settingsManager = pi.coding.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    runner = await GuardianRunner.create({
      cwd: root,
      pi,
      modelRuntime,
      providerAdapters: [chatAdapter],
      modelPolicy: `${CHAT_PROVIDER}/${CHAT_MODEL}`,
      reasoningPolicy: "off",
      contextHandoffThresholdPercent: 50,
      settingsManager,
      sessionDir: sessions,
      noTools: "all",
    });
    await bindRuntimeExtensions(runner);

    assert.deepEqual(runner.installedProviderAdapters, [{
      adapter_id: "chatgpt-normal-memory-transport",
      provider_id: CHAT_PROVIDER,
      model_ids: [CHAT_MODEL],
      context_domain_id: "chatgpt-normal:spike",
    }]);

    const chatModel = runner.modelRuntime.getModel(CHAT_PROVIDER, CHAT_MODEL);
    const codeModel = runner.modelRuntime.getModel(CODE_PROVIDER, CODE_MODEL);
    assert.ok(chatModel, "ChatGPT Normal must be registered in Pi ModelRuntime");
    assert.ok(codeModel, "code sentinel provider must be registered in Pi ModelRuntime");
    const availableChat = await runner.modelRuntime.getAvailable(CHAT_PROVIDER);
    assert.equal(availableChat.some((model) => model.id === CHAT_MODEL), true, "ChatGPT Normal must be available to the model picker catalog");

    const chatDomain = runner.contextDomains.resolve(chatModel);
    assert.equal(chatDomain.kind, "external-stateful");
    assert.equal(chatDomain.usage_pool, "chatgpt");
    assert.equal(chatDomain.transport_adapter_id, "chatgpt-normal-memory-transport");
    const codeDomain = runner.contextDomains.resolve(codeModel);
    assert.equal(codeDomain.kind, "pi-native");
    assert.equal(codeDomain.usage_pool, CODE_PROVIDER);

    const session = runner.runtime.session;
    const sessionId = session.sessionId;
    assert.equal(session.model.provider, CHAT_PROVIDER);
    assert.equal(session.model.id, CHAT_MODEL);

    await session.prompt("DISCUSS_REMOTE_CONTROL");
    assert.equal(chatTransport.state.callCount, 1);
    assert.equal(codeTransport.state.callCount, 0);

    await session.setModel(codeModel, { persist: false });
    assert.equal(session.sessionId, sessionId, "model change must not rotate the Pi session");
    assert.equal(session.model.provider, CODE_PROVIDER);
    await session.prompt("IMPLEMENT_AGREED_DESIGN");
    assert.equal(chatTransport.state.callCount, 1, "code turn must not traverse ChatGPT transport");
    assert.equal(codeTransport.state.callCount, 1);
    assert.match(messagesText(codeContexts[0]), /CHAT_DECISION_USE_WEBSOCKET/, "Pi-native code model must receive the prior ChatGPT decision in the same Pi context");

    await session.setModel(chatModel, { persist: false });
    assert.equal(session.sessionId, sessionId, "returning to ChatGPT must keep the same Pi session");
    await session.prompt("REVIEW_CODE_CHANGE");
    assert.equal(chatTransport.state.callCount, 2);
    assert.equal(codeTransport.state.callCount, 1, "ChatGPT turn must not traverse code transport");
    assert.match(messagesText(chatContexts[1]), /CODE_IMPLEMENTATION_DONE/, "returning ChatGPT model must see the intervening code turn in Pi's logical conversation");
    assert.equal(networkAttempts, 0, "offline seam must not attempt network transport");

    const taskId = runner.ledger.read().task_id;
    runner.storage.engageLatch(taskId, "INTEGRITY", "test:s1-s2");
    await assert.rejects(
      () => runner.modelRuntime.completeSimple(chatModel, { messages: [] }),
      (error) => error?.code === "LLM_ADMISSION_BLOCKED",
      "adapter provider must remain behind Aiopago AdmissionGate",
    );
  } finally {
    if (runner) await runner.dispose();
    globalThis.fetch = previousFetch;
  }
});
