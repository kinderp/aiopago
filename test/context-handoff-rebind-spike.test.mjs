import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTEXT_SYNC_PREFIX } from "../src/context-sync.mjs";
import { defineProviderAdapter } from "../src/provider-adapter.mjs";
import { loadPi } from "../src/pi-loader.mjs";
import { GuardianRunner } from "../src/runner.mjs";

const CHAT_PROVIDER = "chatgpt-handoff-spike";
const CHAT_MODEL = "chatgpt-handoff";
const CODE_PROVIDER = "code-handoff-spike";
const CODE_MODEL = "code-handoff";
const DOMAIN_ID = "chatgpt-handoff:spike";
const HISTORY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);
const INDEX_DIGEST = `sha256:${"1".repeat(64)}`;
const WORKTREE_DIGEST = `sha256:${"2".repeat(64)}`;

function writeLedger(root) {
  const task = {
    schema_version: "0.1.0",
    task_id: "TASK-HANDOFF-S8",
    title: "Durable external context handoff spike",
    objective: "Preserve one logical external context domain across a history-zero Aiopago Pi-session handoff",
    requirements_version: "REQ-GH-32-S8-2026-09-02",
    plan_revision_id: "PLAN-GH-32-S8-1",
    status: "IN_PROGRESS",
    completion_criteria: ["history-zero replacement", "sealed context-domain lineage", "checkpoint-based external rebase"],
    risk: "HIGH",
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    current_item: "ITEM-S8",
    next_item: null,
    next_step: "Resume in the fresh Pi session from the durable checkpoint and review the code-side change",
    model_policy: `${CHAT_PROVIDER}/${CHAT_MODEL}`,
    reasoning_policy: "off",
    minimal_reads: ["romeo-state.txt"],
    relevant_decisions: ["Use WebSocket for controls", "Keep move(direction) as the educational API"],
    relevant_tests: ["node --test test/context-handoff-rebind-spike.test.mjs"],
    evidence_references: ["GitHub #32 S8"],
    task_items: [
      {
        task_item_id: "ITEM-S8",
        task_id: "TASK-HANDOFF-S8",
        title: "History-zero context-domain rebind",
        description: "Seal external cursor lineage and start a fresh Pi context epoch from the Aiopago checkpoint",
        status: "IN_PROGRESS",
        depends_on: [],
        completion_criteria: ["source lag is preserved as metadata", "no transcript in manifest", "target cursor uses replacement session"],
        evidence: [],
        requirements_refs: ["GitHub #32 S8"],
        risk: "HIGH",
        milestone: "SPIKE-32",
        last_updated_at: "2026-09-02T00:00:00.000Z",
        last_updated_by: "test",
      },
    ],
  };
  writeFileSync(join(root, "TASK_PLAN.md"), `# S8 durable handoff ledger\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
  writeFileSync(join(root, "romeo-state.txt"), "PEDAGOGICAL_API=move(direction)\nWEBSOCKET_CONTROL=enabled\n");
}

function fakeGitState(root) {
  return {
    repository_id: "s8-handoff-spike",
    workdir: root,
    branch: "feat/websocket",
    head_sha: "abc123",
    base_sha: "def456",
    commit_shas: [],
    index_digest: INDEX_DIGEST,
    worktree_digest: WORKTREE_DIGEST,
    status_entries: ["M romeo-state.txt"],
    observed_at: "2026-09-02T00:00:00.000Z",
  };
}

function serialized(context) { return JSON.stringify(context.messages); }

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

test("S8: Aiopago handoff rebinds external context to a fresh history-zero Pi epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiopago-s8-"));
  const sessions = mkdtempSync(join(tmpdir(), "aiopago-s8-sessions-"));
  writeLedger(root);

  const pi = await loadPi();
  const previousFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("network forbidden in S8 handoff spike");
  };

  let runner = null;
  try {
    const credentials = new pi.ai.InMemoryCredentialStore();
    const modelRuntime = await pi.coding.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
    const chatTransport = pi.ai.fauxProvider({
      provider: CHAT_PROVIDER,
      models: [{ id: CHAT_MODEL, name: "ChatGPT handoff sentinel", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    });
    const codeTransport = pi.ai.fauxProvider({
      provider: CODE_PROVIDER,
      models: [{ id: CODE_MODEL, name: "Code handoff sentinel", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    });

    const remoteRequests = [];
    const codeRequests = [];
    chatTransport.setResponses([
      (context) => {
        remoteRequests.push(structuredClone(context.messages));
        assert.equal(context.messages.length, 1);
        assert.match(serialized(context), /DISCUSS_ARCHITECTURE/);
        return pi.ai.fauxAssistantMessage("CHAT_DECISION_USE_WEBSOCKET");
      },
      (context) => {
        remoteRequests.push(structuredClone(context.messages));
        const text = serialized(context);
        assert.equal(context.messages.length, 1, "fresh Pi session must still send one bounded capsule");
        assert.match(text, new RegExp(CONTEXT_SYNC_PREFIX.replaceAll("/", "\\/")));
        assert.match(text, /durable_baseline/);
        assert.match(text, /checkpoint_id/);
        assert.match(text, /source_lag_entry_count/);
        assert.match(text, /AIOPAGO_RESUME_V1/, "fresh-session resume prompt must be present as current user input");
        assert.doesNotMatch(text, /CHAT_DECISION_USE_WEBSOCKET/, "old external reply must not be copied into the new Pi transcript");
        assert.doesNotMatch(text, /CODE_IMPLEMENTATION_DONE/, "old code transcript must not be copied into the new Pi transcript");
        return pi.ai.fauxAssistantMessage("CHAT_AFTER_DURABLE_REBASE");
      },
    ]);
    codeTransport.setResponses([
      (context) => {
        codeRequests.push(structuredClone(context.messages));
        assert.match(serialized(context), /CHAT_DECISION_USE_WEBSOCKET/);
        return pi.ai.fauxAssistantMessage("CODE_IMPLEMENTATION_DONE");
      },
    ]);

    modelRuntime.registerNativeProvider(codeTransport.provider);
    const chatAdapter = defineProviderAdapter({
      adapter_id: "chatgpt-handoff-sentinel-adapter",
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
      providerAdapterCatalog: [chatAdapter],
      providerInstallationConfig: {
        adapters: [{ adapter_id: "chatgpt-handoff-sentinel-adapter", mode: "experimental-nonproduction" }],
      },
      modelPolicy: `${CHAT_PROVIDER}/${CHAT_MODEL}`,
      reasoningPolicy: "off",
      contextHandoffThresholdPercent: 90,
      settingsManager,
      sessionDir: sessions,
      noTools: "all",
      observeGit: () => fakeGitState(root),
    });
    await bindRuntimeExtensions(runner);

    const chatModel = runner.modelRuntime.getModel(CHAT_PROVIDER, CHAT_MODEL);
    const codeModel = runner.modelRuntime.getModel(CODE_PROVIDER, CODE_MODEL);
    const sourceSessionId = runner.runtime.session.sessionId;

    await runner.runtime.session.prompt("DISCUSS_ARCHITECTURE");
    const acknowledgedBeforeCode = runner.contextCursors.get(DOMAIN_ID);
    assert.equal(acknowledgedBeforeCode.session_id, sourceSessionId);

    await runner.runtime.session.setModel(codeModel, { persist: false });
    await runner.runtime.session.prompt("IMPLEMENT_AGREED_DESIGN");
    await runner.runtime.session.setModel(chatModel, { persist: false });
    assert.equal(chatTransport.state.callCount, 1, "external provider must remain behind while code work accumulates");
    assert.equal(codeTransport.state.callCount, 1);

    const sourceTailBeforeHandoff = runner.runtime.session.sessionManager.getBranch().at(-1)?.id;
    assert.notEqual(sourceTailBeforeHandoff, acknowledgedBeforeCode.entry_id, "source must contain unacknowledged post-Chat work");

    const handoff = await runner.handoffDirect({ mode: "manual", confirm: false });
    assert.equal(handoff.state, "RESUME_READY");
    const replacementSessionId = runner.runtime.session.sessionId;
    assert.notEqual(replacementSessionId, sourceSessionId);

    const historyBeforeResume = runner.runtime.session.sessionManager.getEntries().filter((entry) => HISTORY_TYPES.has(entry.type));
    assert.equal(historyBeforeResume.length, 0, "replacement Pi must remain conversation-history zero before resume");

    const manifest = runner.artifacts.verify("manifest", handoff.resume_manifest_id, handoff.resume_manifest_digest).payload;
    assert.equal(Array.isArray(manifest.context_domains), true);
    assert.equal(manifest.context_domains.length, 1);
    const binding = manifest.context_domains[0];
    assert.equal(binding.context_domain_id, DOMAIN_ID);
    assert.match(binding.binding_id, /^CTXBIND-/);
    assert.equal(binding.source_session_id, sourceSessionId);
    assert.equal(binding.source_cursor.entry_id, acknowledgedBeforeCode.entry_id);
    assert.equal(binding.source_tail_cursor.entry_id, sourceTailBeforeHandoff);
    assert.ok(binding.lag_entry_count > 0, "manifest must record that external context lagged behind source Pi tail");
    assert.equal(binding.rebase_policy, "durable_checkpoint_epoch");

    const manifestText = JSON.stringify(manifest);
    assert.doesNotMatch(manifestText, /CHAT_DECISION_USE_WEBSOCKET/, "manifest must not copy external transcript");
    assert.doesNotMatch(manifestText, /CODE_IMPLEMENTATION_DONE/, "manifest must not copy code transcript");

    const reboundCursor = runner.contextCursors.get(DOMAIN_ID);
    assert.equal(reboundCursor.session_id, replacementSessionId, "context cursor must be rebound to the replacement Pi session after continuity");
    const baseline = runner.contextSync.durableBaselines.get(DOMAIN_ID);
    assert.ok(baseline, "durable context baseline must exist until first external acknowledgement in the new Pi session");
    assert.equal(baseline.binding_id, binding.binding_id);
    assert.equal(baseline.handoff_id, handoff.handoff_id);
    assert.equal(baseline.checkpoint_id, handoff.checkpoint_id);
    assert.equal(baseline.source_lag_entry_count, binding.lag_entry_count);
    assert.equal(baseline.target_session_id, replacementSessionId);

    const resumed = await runner.handoffService.resume(handoff.handoff_id, {
      actor: "human:test-s8",
      sendResume: (prompt) => runner.runtime.session.sendUserMessage(prompt),
    });
    assert.equal(resumed.state, "RESUMED");
    assert.equal(chatTransport.state.callCount, 2, "resume should call only the external provider once");
    assert.equal(codeTransport.state.callCount, 1, "durable external resume must not invoke the code provider");
    assert.equal(runner.contextSync.durableBaselines.has(DOMAIN_ID), false, "successful external reply must acknowledge and clear the durable baseline");
    assert.equal(runner.contextState.getBaseline(DOMAIN_ID), null, "durable baseline journal projection must clear after acknowledgement");
    assert.equal(runner.contextCursors.get(DOMAIN_ID).session_id, replacementSessionId);
    assert.equal(networkAttempts, 0);

    const replacementHistory = runner.runtime.session.sessionManager.getEntries().filter((entry) => HISTORY_TYPES.has(entry.type));
    assert.ok(replacementHistory.length > 0, "resume may start the new Pi conversation only after continuity and explicit admission");
    assert.equal(remoteRequests.length, 2);
    assert.equal(codeRequests.length, 1);
  } finally {
    if (runner) await runner.dispose();
    globalThis.fetch = previousFetch;
  }
});
