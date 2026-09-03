import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GuardianRunner } from "../src/runner.mjs";

function root() {
  const cwd = mkdtempSync(join(tmpdir(), "aiopago-p2-runner-"));
  const task = {
    schema_version: "0.1.0",
    task_id: "TASK-P2-RUNNER",
    title: "P2 runner installation boundary",
    objective: "Reject legacy global provider installation bypasses",
    requirements_version: "REQ-P2-RUNNER",
    plan_revision_id: "PLAN-P2-RUNNER",
    status: "IN_PROGRESS",
    completion_criteria: ["legacy provider install options rejected"],
    risk: "LOW",
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: "2026-09-03T00:00:00.000Z",
    current_item: "ITEM-P2-RUNNER",
    next_item: null,
    next_step: "verify explicit installation boundary",
    model_policy: null,
    reasoning_policy: "off",
    minimal_reads: [],
    relevant_decisions: [],
    relevant_tests: [],
    evidence_references: [],
    task_items: [{
      task_item_id: "ITEM-P2-RUNNER",
      task_id: "TASK-P2-RUNNER",
      title: "Runner boundary",
      description: "Legacy provider options are rejected before provider installation",
      status: "IN_PROGRESS",
      depends_on: [],
      completion_criteria: ["legacy options rejected"],
      evidence: [],
      requirements_refs: ["P2"],
      risk: "LOW",
      milestone: "0.3-A",
      last_updated_at: "2026-09-03T00:00:00.000Z",
      last_updated_by: "test",
    }],
  };
  writeFileSync(join(cwd, "TASK_PLAN.md"), `# P2 runner\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`);
  return cwd;
}

test("P2 GuardianRunner rejects legacy providerAdapters bypass", async () => {
  await assert.rejects(
    GuardianRunner.create({ cwd: root(), providerAdapters: [] }),
    (error) => error?.code === "PROVIDER_INSTALLATION_LEGACY_RUNNER_OPTION_UNSUPPORTED",
  );
});

test("P2 GuardianRunner rejects legacy global experimental opt-in", async () => {
  await assert.rejects(
    GuardianRunner.create({ cwd: root(), allowExperimentalExternal: true }),
    (error) => error?.code === "PROVIDER_INSTALLATION_LEGACY_RUNNER_OPTION_UNSUPPORTED",
  );
});
