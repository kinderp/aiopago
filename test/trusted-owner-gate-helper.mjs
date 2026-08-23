import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { satisfyTrustedHandoffOwnerGate } from "../src/handoff-plan-internal.mjs";
import { handoffConsentIdentity } from "../src/handoff-consent.mjs";
import { GuardianStorage } from "../src/storage.mjs";

// Historical transition tests exercise the production package-private path.
// The helper itself is test-only and is never included in the npm package.
export function satisfyOwnerGateForTest(ledger, request, storage = null) {
  const plan = ledger.read();
  const ownedStorage = storage ?? new GuardianStorage(join(mkdtempSync(join(tmpdir(), "aiopago-owner-gate-test-")), "guardian.sqlite"));
  try {
    const latch = ownedStorage.getLatch(plan.task_id) ?? ownedStorage.ensureLatch(plan.task_id);
    return satisfyTrustedHandoffOwnerGate(ledger, {
      storage: ownedStorage,
      expected: { taskId: plan.task_id, planRevisionId: plan.plan_revision_id, contentDigest: plan.content_digest },
      taskId: plan.task_id,
      expectedHandoff: handoffConsentIdentity(ownedStorage.latestHandoffForTask(plan.task_id)),
      expectedLatch: { task_id: plan.task_id, state: latch.state, generation: latch.generation, reason: latch.reason ?? null },
      ...request,
    });
  } finally {
    if (!storage) ownedStorage.close();
  }
}
