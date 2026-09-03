import assert from "node:assert/strict";
import test from "node:test";
import { HandoffService } from "../src/handoff.mjs";

const GIT = Object.freeze({
  repository_id: "repo-p7-hook",
  workdir: "/tmp/repo-p7-hook",
  branch: "main",
  base_sha: "base",
  head_sha: "head",
  commit_shas: [],
  index_digest: `sha256:${"1".repeat(64)}`,
  worktree_digest: `sha256:${"2".repeat(64)}`,
  status_entries: [],
});

function fixture({ failHook = false } = {}) {
  const handoff = {
    handoff_id: "HO-P7-HOOK",
    source_session_id: "SES-SOURCE",
    source_session_file: "/tmp/source.jsonl",
    target_session_id: "SES-TARGET",
    target_session_file: "/tmp/target.jsonl",
    parent_session_id: "SES-SOURCE",
    parent_session_file: "/tmp/source.jsonl",
    runner_instance_id: "RUNNER-P7",
    session_binding_id: "BIND-P7",
    task_id: "TASK-P7",
    current_item: "ITEM-P7",
    next_item: null,
    next_step: "resume",
    task_plan_revision: "PLAN-P7",
    task_plan_digest: "digest-plan",
    requirements_version: "REQ-P7",
    latch_generation: 1,
    checkpoint_id: "CP-P7",
    checkpoint_digest: "digest-checkpoint",
    resume_manifest_id: "RM-P7",
    resume_manifest_digest: "digest-manifest",
    resume_prompt_id: "RP-P7",
    resume_prompt_digest: null,
    resume_prompt: null,
    authorization_state: "NOT_AUTHORIZED",
    admission_state: "NOT_COMMITTED",
    dispatch_state: "NOT_STARTED",
    expected_git_state: GIT,
    model_policy: null,
    reasoning_policy: null,
    state: "MANIFEST_PERSISTED",
  };
  const saved = [];
  const metrics = [];
  let stored = structuredClone(handoff);
  const storage = {
    getHandoff: () => structuredClone(stored),
    saveHandoff(next, eventType, eventData) {
      stored = structuredClone(next);
      saved.push({ state: stored.state, eventType, eventData: structuredClone(eventData) });
      return structuredClone(stored);
    },
    getLatch: () => ({ state: "ENGAGED", generation: 1 }),
  };
  const manifest = {
    manifest_version: "1.1.0",
    resume_manifest_id: "RM-P7",
    handoff_id: "HO-P7-HOOK",
    resume_prompt_id: "RP-P7",
    checkpoint_id: "CP-P7",
    checkpoint_digest: "digest-checkpoint",
    task_id: "TASK-P7",
    source_session_id: "SES-SOURCE",
    replacement_session_id: "SES-TARGET",
    parent_session_id: "SES-SOURCE",
    runner_instance_id: "RUNNER-P7",
    session_binding_id: "BIND-P7",
    task_plan_revision: "PLAN-P7",
    task_plan_digest: "digest-plan",
    requirements_version: "REQ-P7",
    repository: GIT.repository_id,
    worktree: GIT.workdir,
    branch: GIT.branch,
    base_sha: GIT.base_sha,
    head_sha: GIT.head_sha,
    index_digest: GIT.index_digest,
    worktree_digest: GIT.worktree_digest,
    git_status_summary: [],
    current_item: "ITEM-P7",
    next_item: null,
    next_step: "resume",
    model_policy: null,
    reasoning_policy: null,
    minimal_reads: [],
    required_local_paths: [],
  };
  const checkpoint = { checkpoint_id: "CP-P7", git_state: GIT };
  const hookStates = [];

  class Subject extends HandoffService {
    attestRunnerOwnership() { return true; }
    assertModelPolicy() { return true; }
    beforeResumeReady(current) {
      hookStates.push(storage.getHandoff(current.handoff_id).state);
      if (failHook) throw Object.assign(new Error("P7_HOOK_FAILED"), { code: "P7_HOOK_FAILED" });
    }
  }

  const service = new Subject({
    storage,
    artifacts: {
      verify(kind) {
        if (kind === "checkpoint") return { payload: checkpoint, bytes: Buffer.from("checkpoint") };
        return { payload: manifest, bytes: Buffer.from("manifest") };
      },
    },
    ledger: {
      path: "/tmp/TASK_PLAN.md",
      read: () => ({
        task_id: "TASK-P7",
        plan_revision_id: "PLAN-P7",
        content_digest: "digest-plan",
        requirements_version: "REQ-P7",
        current_item: "ITEM-P7",
        next_item: null,
        next_step: "resume",
        minimal_reads: [],
        required_local_paths: [],
      }),
    },
    observeGit: () => GIT,
    safePoint: {},
    runnerInstanceId: "RUNNER-P7",
    telemetry: { recordHandoffEvent: (state) => metrics.push(state) },
  });
  const target = {
    sessionId: "SES-TARGET",
    sessionManager: {
      getHeader: () => ({ parentSession: "/tmp/source.jsonl" }),
      getEntries: () => [],
    },
    isIdle: true,
  };
  return { service, storage, target, saved, metrics, hookStates, getStored: () => structuredClone(stored) };
}

test("P7 durable RESUME_READY is persisted only after the pre-ready continuity hook succeeds", () => {
  const f = fixture();
  const ready = f.service.continuity("HO-P7-HOOK", f.target);
  assert.deepEqual(f.hookStates, ["MANIFEST_PERSISTED"]);
  assert.equal(ready.state, "RESUME_READY");
  assert.equal(f.getStored().state, "RESUME_READY");
  assert.equal(f.saved.some((entry) => entry.state === "RESUME_READY" && entry.eventType === "CONTINUITY_VALIDATED"), true);
  assert.deepEqual(f.metrics, ["RESUME_READY"]);
});

test("P7 hook failure never persists RESUME_READY and becomes durable CONTINUITY_FAILED", () => {
  const f = fixture({ failHook: true });
  assert.throws(() => f.service.continuity("HO-P7-HOOK", f.target), (error) => error?.code === "P7_HOOK_FAILED");
  assert.deepEqual(f.hookStates, ["MANIFEST_PERSISTED"]);
  assert.equal(f.getStored().state, "CONTINUITY_FAILED");
  assert.equal(f.saved.some((entry) => entry.state === "RESUME_READY"), false);
  assert.equal(f.saved.at(-1).eventType, "CONTINUITY_FAILED");
  assert.deepEqual(f.metrics, []);
});
