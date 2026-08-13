import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { formatGuardianStatus } from "../src/extension.mjs";
import { loadPi } from "../src/pi-loader.mjs";
import { GuardianRunner } from "../src/runner.mjs";
import { RUNNER_BINDING_CUSTOM_TYPE } from "../src/runner-ownership.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function normalized(path) { return path.replaceAll("\\", "/"); }

function taskLedger(advanced = false) {
  const timestamp = advanced ? "2026-08-09T08:31:00.000Z" : "2026-08-09T08:30:00.000Z";
  return {
    schema_version: "0.1.0",
    task_id: "TASK-PORTABLE-FIXTURE",
    title: "Portable greeting acceptance",
    objective: "Normalize the fixture greeting and record independent acceptance evidence.",
    requirements_version: "REQ-PORTABLE-FIXTURE-1",
    plan_revision_id: advanced ? "PLAN-PORTABLE-FIXTURE-2" : "PLAN-PORTABLE-FIXTURE-1",
    status: "IN_PROGRESS",
    completion_criteria: ["Greeting is normalized", "Acceptance evidence is recorded"],
    risk: "MEDIUM",
    created_at: "2026-08-09T08:30:00.000Z",
    updated_at: timestamp,
    current_item: advanced ? "ITEM-2" : "ITEM-1",
    next_item: advanced ? null : "ITEM-2",
    next_step: advanced ? "Create acceptance.txt for ITEM-2; do not repeat ITEM-1." : "Normalize app.mjs for ITEM-1, then advance the Ledger to ITEM-2.",
    evidence: [],
    model_policy: null,
    reasoning_policy: "off",
    minimal_reads: ["TASK_PLAN.md", "docs/decision.md"],
    relevant_decisions: ["docs/decision.md"],
    relevant_tests: ["node --test test/app.test.mjs"],
    evidence_references: ["README.md"],
    task_items: [
      {
        task_item_id: "ITEM-1", task_id: "TASK-PORTABLE-FIXTURE", title: "Normalize greeting",
        description: "Change app.mjs to export the normalized portable greeting.", status: advanced ? "DONE" : "IN_PROGRESS",
        depends_on: [], completion_criteria: ["app.mjs exports PORTABLE"], evidence: advanced ? ["app.mjs exports PORTABLE; test/app.test.mjs passes"] : [],
        requirements_refs: ["REQ-PORTABLE-FIXTURE-1"], risk: "LOW", milestone: "FIXTURE", last_updated_at: timestamp, last_updated_by: "offline Pi fixture",
      },
      {
        task_item_id: "ITEM-2", task_id: "TASK-PORTABLE-FIXTURE", title: "Record acceptance",
        description: "Create acceptance.txt after continuity without touching app.mjs again.", status: advanced ? "IN_PROGRESS" : "PLANNED",
        depends_on: ["ITEM-1"], completion_criteria: ["acceptance.txt identifies ITEM-2"], evidence: [],
        requirements_refs: ["REQ-PORTABLE-FIXTURE-1"], risk: "LOW", milestone: "FIXTURE", last_updated_at: timestamp, last_updated_by: advanced ? "offline Pi fixture" : "human:test",
      },
    ],
  };
}

function writeLedger(root, advanced = false) {
  const task = taskLedger(advanced);
  writeFileSync(join(root, "TASK_PLAN.md"), `# Portable fixture Ledger\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
}

function createExternalFixture() {
  const root = mkdtempSync(join(tmpdir(), "eiopago-p0-b-external-"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "app.mjs"), "export const greeting = 'portable';\n");
  writeFileSync(join(root, "README.md"), "# Independent portable fixture\n");
  writeFileSync(join(root, "docs", "decision.md"), "# Decision\n\nUse an uppercase greeting and separate acceptance evidence.\n");
  writeFileSync(join(root, "test", "app.test.mjs"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { greeting } from '../app.mjs';\ntest('normalized greeting', () => assert.equal(greeting, 'PORTABLE'));\n");
  git(root, ["init"]);
  git(root, ["config", "user.email", "portable@example.invalid"]);
  git(root, ["config", "user.name", "Portable Fixture"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial independent application"]);
  return root;
}

function makeMessage(model, usage, content, stopReason) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage, stopReason, timestamp: Date.now(),
  };
}

function streamMessage(pi, message) {
  const stream = pi.ai.createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
    stream.push({ type: "done", reason: message.stopReason, message });
  });
  return stream;
}

function hasResumeContext(context) {
  return JSON.stringify(context.messages).includes("EIOPAGO_RESUME_V1");
}

async function offlineRuntime(pi) {
  const credentials = new pi.ai.InMemoryCredentialStore();
  const modelRuntime = await pi.coding.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = {
    id: "portable-offline", name: "Portable offline", api: "openai-completions", provider: "portable-offline",
    baseUrl: "offline://portable", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
  };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const calls = [];
  const toolCalls = [];
  modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl, apiKey: "offline-placeholder", api: model.api, models: [model],
    streamSimple(_model, context) {
      const resume = hasResumeContext(context);
      const phaseCalls = calls.filter((call) => call.resume === resume).length;
      calls.push({ resume, serialized: JSON.stringify(context.messages) });
      const phaseTools = resume
        ? [{ id: "TOOL-ITEM-2", name: "write", arguments: { path: "acceptance.txt", content: "ITEM-2 accepted after continuity\n" } }]
        : [
            { id: "TOOL-BASH-GIT-STATUS", name: "bash", arguments: { command: "git status --short" } },
            { id: "TOOL-BASH-LOCAL", name: "bash", arguments: { command: "node -e \"console.log('EIO_BASH_OK')\"" } },
            { id: "TOOL-ITEM-1", name: "write", arguments: { path: "app.mjs", content: "export const greeting = 'PORTABLE';\n" } },
          ];
      if (phaseCalls < phaseTools.length) {
        const tool = phaseTools[phaseCalls];
        toolCalls.push(tool);
        return streamMessage(pi, makeMessage(model, usage, [{ type: "toolCall", ...tool }], "toolUse"));
      }
      return streamMessage(pi, makeMessage(model, usage, [{ type: "text", text: resume ? "ITEM-2 complete" : "ITEM-1 complete" }], "stop"));
    },
  });
  await modelRuntime.setRuntimeApiKey(model.provider, "offline-placeholder");
  return { modelRuntime, model, calls, toolCalls };
}

const HISTORY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);

test("P0-B external repo: eio launch owns Pi and completes portable A-to-B handoff with zero history", async (t) => {
  const root = createExternalFixture();
  const initResult = await runCli(["init", "--target", root], { stdout: () => {} });
  assert.equal(normalized(initResult.result.targetRoot), normalized(root));
  writeLedger(root, false);
  git(root, ["add", ".gitignore", ".guardian/config.json", "TASK_PLAN.md"]);
  git(root, ["commit", "-m", "initialize bounded portable task"]);
  const initialHead = git(root, ["rev-parse", "HEAD"]);
  const packageJsonBefore = existsSync(join(root, "package.json"));
  const pi = await loadPi();
  const offline = await offlineRuntime(pi);
  const settings = pi.coding.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const sessions = mkdtempSync(join(tmpdir(), "eiopago-p0-b-sessions-"));
  const priorFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts += 1; throw new Error("network forbidden"); };

  let evidence;
  try {
    const launched = await runCli(["--target", join(root, "docs")], {
      stdout: () => {},
      createRunner: async ({ repository }) => {
        assert.notEqual(repository.installationRoot.toLowerCase(), repository.targetRoot.toLowerCase());
        assert.equal(normalized(repository.targetRoot), normalized(root));
        const runner = await GuardianRunner.create({
          repository, pi, modelRuntime: offline.modelRuntime, model: offline.model,
          reasoningPolicy: "off", settingsManager: settings, sessionDir: sessions,
        });
        runner.runInteractive = async () => {
          const source = runner.runtime.session;
          const sourceId = source.sessionId;
          const sourceFile = source.sessionFile.replaceAll("\\", "/");
          assert.equal(runner.cwd, repository.targetRoot);
          assert.equal(runner.roots.targetRoot, repository.targetRoot);
          assert.equal(runner.handoffService.modelPolicy, "portable-offline/portable-offline");
          assert.deepEqual(runner.tools, ["read", "edit", "write", "grep", "find", "ls", "bash"]);
          assert.deepEqual(source.getActiveToolNames(), ["read", "edit", "write", "grep", "find", "ls", "bash"]);

          await source.prompt("Execute ITEM-1 only. SOURCE_PRIVATE_MARKER must never reach the replacement.");
          assert.equal(readFileSync(join(root, "app.mjs"), "utf8"), "export const greeting = 'PORTABLE';\n");
          const sourceToolResults = source.sessionManager.getEntries()
            .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
          const bashResults = sourceToolResults.filter((entry) => entry.message.toolName === "bash");
          assert.equal(bashResults.length, 2, "the Runner-owned Pi session must execute both real built-in bash calls");
          assert.equal(bashResults.every((entry) => entry.message.isError === false), true);
          assert.match(JSON.stringify(bashResults), /EIO_BASH_OK/);
          const shellOperations = runner.storage.operationsForTask("TASK-PORTABLE-FIXTURE")
            .filter((operation) => operation.profile === "SHELL_ATOMIC_OPERATION");
          assert.equal(shellOperations.length, 2);
          assert.equal(shellOperations.every((operation) => operation.outcome === "KNOWN_SUCCESS"), true);
          assert.equal(shellOperations.every((operation) => /^shell:sha256:[a-f0-9]{64}$/.test(operation.effect_reference)), true);
          assert.equal(JSON.stringify(shellOperations).includes("git status --short"), false, "journal must not retain raw shell commands");
          execFileSync(process.execPath, ["--test", "test/app.test.mjs"], { cwd: root, stdio: "pipe" });
          writeLedger(root, true);
          const advanced = runner.ledger.read();
          assert.equal(advanced.current_item, "ITEM-2");
          assert.equal(advanced.plan_revision_id, "PLAN-PORTABLE-FIXTURE-2");

          const status = formatGuardianStatus(runner, { getContextUsage: () => ({ percent: 37 }) });
          assert.equal(normalized(status).includes(`Target repository: ${normalized(root)}`), true);
          assert.match(status, /Task: TASK-PORTABLE-FIXTURE revision=PLAN-PORTABLE-FIXTURE-2/);
          assert.match(status, /Runner ownership: Runner-owned source/);
          assert.match(status, /Current item: ITEM-2/);
          assert.match(status, /Latch: RELEASED/);
          assert.match(status, /Advisor\/context: 37%; threshold=\d+(?:\.\d+)?%/);

          let pausedEvidence = null;
          let confirmations = 0;
          const uiContext = {
            async confirm(title) {
              assert.equal(title, "Eiopago resume");
              confirmations += 1;
              const session = runner.runtime.session;
              const handoff = runner.storage.findHandoffByTarget(session.sessionId);
              const entries = session.sessionManager.getEntries();
              const history = entries.filter((entry) => HISTORY_TYPES.has(entry.type));
              pausedEvidence = {
                state: handoff.state,
                history_count: history.length,
                serialized_entries: JSON.stringify(entries),
                model: `${session.model.provider}/${session.model.id}`,
                reasoning: session.thinkingLevel,
                binding_count: entries.filter((entry) => entry.type === "custom" && entry.customType === RUNNER_BINDING_CUSTOM_TYPE).length,
              };
              assert.equal(runner.storage.getLatch(handoff.task_id).state, "ENGAGED");
              return true;
            },
            notify() {},
            setEditorText() {},
          };
          const commandContextActions = {
            waitForIdle: () => runner.runtime.session.waitForIdle(),
            newSession: (options) => runner.runtime.newSession({
              ...options,
              withSession: async (replacementCtx) => {
                await runner.runtime.session.bindExtensions({ mode: "print", uiContext, commandContextActions });
                return options.withSession?.(replacementCtx);
              },
            }),
            fork: (entryId, options) => runner.runtime.fork(entryId, options),
            navigateTree: (targetId, options) => runner.runtime.session.navigateTree(targetId, options),
            switchSession: (path, options) => runner.runtime.switchSession(path, options),
            reload: async () => {},
          };
          await source.bindExtensions({ mode: "print", uiContext, commandContextActions });
          await Promise.all([
            source.prompt("/eio handoff confirm"),
            source.prompt("/eio handoff confirm"),
          ]);
          const result = runner.storage.latestHandoffForTask("TASK-PORTABLE-FIXTURE");
          assert.equal(confirmations, 1);
          assert.equal(result.state, "RESUMED");
          assert.equal(pausedEvidence.state, "RESUME_READY");
          assert.equal(pausedEvidence.history_count, 0);
          assert.equal(pausedEvidence.serialized_entries.includes("SOURCE_PRIVATE_MARKER"), false);
          assert.equal(pausedEvidence.serialized_entries.includes("EIOPAGO_RESUME_V1"), false);
          assert.equal(pausedEvidence.binding_count, 1);
          assert.equal(pausedEvidence.model, "portable-offline/portable-offline");
          assert.equal(pausedEvidence.reasoning, "off");

          const target = runner.runtime.session;
          assert.notEqual(target.sessionId, sourceId);
          assert.equal(target.sessionManager.getHeader().parentSession.replaceAll("\\", "/"), sourceFile);
          assert.equal(readFileSync(join(root, "acceptance.txt"), "utf8"), "ITEM-2 accepted after continuity\n");
          const targetEntries = JSON.stringify(target.sessionManager.getEntries());
          assert.equal(targetEntries.includes("SOURCE_PRIVATE_MARKER"), false);
          assert.equal(targetEntries.includes("EIOPAGO_RESUME_V1"), true);
          assert.equal(targetEntries.includes("current_item=ITEM-2"), true);
          assert.equal(targetEntries.includes("do not repeat ITEM-1"), true);

          const checkpoint = runner.artifacts.verify("checkpoint", result.checkpoint_id, result.checkpoint_digest);
          const manifest = runner.artifacts.verify("manifest", result.resume_manifest_id, result.resume_manifest_digest);
          assert.equal(checkpoint.payload.git_state.repository_id, normalized(repository.targetRoot));
          assert.equal(checkpoint.payload.git_state.head_sha, initialHead);
          assert.deepEqual(checkpoint.payload.tests, ["node --test test/app.test.mjs"]);
          assert.deepEqual(checkpoint.payload.decisions, ["docs/decision.md"]);
          assert.equal(checkpoint.payload.changes.includes("file:app.mjs"), true);
          assert.equal(checkpoint.payload.changes.filter((reference) => /^shell:sha256:[a-f0-9]{64}$/.test(reference)).length, 2);
          assert.equal(JSON.stringify(checkpoint.payload).includes("git status --short"), false);
          assert.deepEqual(manifest.payload.relevant_decisions, ["docs/decision.md"]);
          assert.deepEqual(manifest.payload.relevant_tests, ["node --test test/app.test.mjs"]);
          assert.deepEqual(manifest.payload.evidence_references, ["README.md"]);
          assert.equal(manifest.payload.worktree, normalized(repository.targetRoot));
          assert.equal(manifest.payload.branch, git(root, ["branch", "--show-current"]));
          assert.equal(manifest.payload.head_sha, initialHead);
          assert.equal(manifest.payload.task_plan_revision, "PLAN-PORTABLE-FIXTURE-2");
          assert.equal(manifest.payload.current_item, "ITEM-2");
          assert.equal(manifest.payload.model_policy, "portable-offline/portable-offline");
          assert.equal(manifest.payload.reasoning_policy, "off");
          assert.equal(Object.hasOwn(manifest.payload, "transcript"), false);

          const callsBeforeDuplicates = offline.calls.length;
          const duplicateResume = await runner.handoffService.resume(result.handoff_id, {
            actor: "human:duplicate-resume", sendResume: (prompt) => target.sendUserMessage(prompt),
          });
          const duplicateAuthorization = await runner.handoffService.resume(result.handoff_id, {
            actor: "human:duplicate-authorization", sendResume: (prompt) => target.sendUserMessage(prompt),
          });
          assert.equal(duplicateResume.state, "RESUMED");
          assert.equal(duplicateAuthorization.state, "RESUMED");
          assert.equal(offline.calls.length, callsBeforeDuplicates);
          const events = runner.storage.events(result.handoff_id);
          assert.equal(events.filter((event) => event.event_type === "HANDOFF_STARTED").length, 1);
          assert.equal(events.filter((event) => event.event_type === "RESUME_AUTHORIZED").length, 1);
          assert.equal(events.filter((event) => event.event_type === "RESUME_ADMISSION_COMMITTED").length, 1);
          assert.equal(events.filter((event) => event.event_type === "RESUME_DISPATCH_INTENT").length, 1);
          assert.equal(events.filter((event) => event.event_type === "RESUME_ACKNOWLEDGED").length, 1);

          evidence = {
            result, pausedEvidence, status, sourceId, targetId: target.sessionId,
            checkpointPath: checkpoint.path, manifestPath: manifest.path,
            eventTypes: events.map((event) => event.event_type),
            targetEntries,
          };
        };
        return runner;
      },
    });
    assert.equal(launched.action, "launch");
  } finally {
    globalThis.fetch = priorFetch;
  }

  assert.ok(evidence);
  assert.equal(offline.toolCalls.filter((call) => call.name === "bash" && call.arguments.command === "git status --short").length, 1);
  assert.equal(offline.toolCalls.filter((call) => call.name === "bash" && call.arguments.command === "node -e \"console.log('EIO_BASH_OK')\"").length, 1);
  assert.equal(offline.toolCalls.filter((call) => call.name === "write" && call.arguments.path === "app.mjs").length, 1);
  assert.equal(offline.toolCalls.filter((call) => call.name === "write" && call.arguments.path === "acceptance.txt").length, 1);
  assert.equal(offline.calls.filter((call) => call.resume).every((call) => !call.serialized.includes("SOURCE_PRIVATE_MARKER")), true);
  assert.equal(networkAttempts, 0);
  assert.equal(existsSync(join(root, "package.json")), packageJsonBefore);
  assert.equal(existsSync(evidence.checkpointPath), true);
  assert.equal(existsSync(evidence.manifestPath), true);
  t.diagnostic(`P0-B evidence ${JSON.stringify({
    target_root: normalized(root),
    handoff_id: evidence.result.handoff_id,
    source_session_id: evidence.sourceId,
    replacement_session_id: evidence.targetId,
    checkpoint_id: evidence.result.checkpoint_id,
    checkpoint_digest: evidence.result.checkpoint_digest,
    checkpoint_path: normalized(evidence.checkpointPath),
    manifest_id: evidence.result.resume_manifest_id,
    manifest_digest: evidence.result.resume_manifest_digest,
    manifest_path: normalized(evidence.manifestPath),
    paused_history_entries: evidence.pausedEvidence.history_count,
    continuity_state: evidence.pausedEvidence.state,
    final_state: evidence.result.state,
    model_policy: evidence.result.model_policy,
    reasoning_policy: evidence.result.reasoning_policy,
  })}`);
});
