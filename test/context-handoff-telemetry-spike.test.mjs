import assert from "node:assert/strict";
import test from "node:test";
import { HandoffService } from "../src/handoff.mjs";
import { ContextAwareHandoffService } from "../src/multi-model-handoff.mjs";

function service({ rebind, events }) {
  return new ContextAwareHandoffService({
    storage: {},
    artifacts: {},
    ledger: {},
    observeGit: () => ({}),
    safePoint: { request: async () => ({}) },
    runnerInstanceId: "RUNNER-TELEMETRY-SPIKE",
    telemetry: { recordHandoffEvent: (state, details) => events.push({ state, details }) },
    contextContinuity: {
      captureForHandoff: () => [],
      rebindAfterHandoff: rebind,
    },
  });
}

function installFakeCoreContinuity() {
  const original = HandoffService.prototype.continuity;
  HandoffService.prototype.continuity = function fakeCoreContinuity(handoffId, targetSession) {
    const ready = {
      handoff_id: handoffId,
      checkpoint_id: `CP-${handoffId}`,
      resume_manifest_id: `RM-${handoffId}`,
      resume_manifest_digest: "digest",
    };
    const manifest = { context_domains: [{ schema_version: "0.1.0", context_domain_id: "chat:test" }] };
    this.beforeResumeReady(ready, targetSession, manifest);
    this.metric("RESUME_READY", { handoff: ready, reason: "CORE_CONTINUITY_VALIDATED" });
    return ready;
  };
  return () => { HandoffService.prototype.continuity = original; };
}

test("S8 telemetry: failed context-domain rebind prevents RESUME_READY telemetry", () => {
  const events = [];
  const restore = installFakeCoreContinuity();
  try {
    const subject = service({
      events,
      rebind: () => { throw Object.assign(new Error("rebind failed"), { code: "CONTEXT_REBIND_FAILED" }); },
    });
    assert.throws(
      () => subject.continuity("HO-FAIL", { sessionId: "SES-TARGET" }),
      (error) => error?.code === "CONTEXT_REBIND_FAILED",
    );
    assert.deepEqual(events, [], "failed rebind must prevent RESUME_READY telemetry rather than discarding it after publication");
  } finally {
    restore();
  }
});

test("S8 telemetry: RESUME_READY is emitted once and only after successful context-domain rebind", () => {
  const events = [];
  const order = [];
  const restore = installFakeCoreContinuity();
  try {
    const subject = service({
      events,
      rebind: (input) => { order.push("rebind"); return input; },
    });
    subject.telemetry.recordHandoffEvent = (state, details) => { order.push("metric"); events.push({ state, details }); };
    const ready = subject.continuity("HO-PASS", { sessionId: "SES-TARGET" });
    assert.equal(ready.handoff_id, "HO-PASS");
    assert.deepEqual(order, ["rebind", "metric"]);
    assert.equal(events.length, 1);
    assert.equal(events[0].state, "RESUME_READY");
    assert.equal(events[0].details.reason, "CORE_CONTINUITY_VALIDATED");
  } finally {
    restore();
  }
});
