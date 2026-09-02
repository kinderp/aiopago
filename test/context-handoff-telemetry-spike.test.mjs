import assert from "node:assert/strict";
import test from "node:test";
import { HandoffService } from "../src/handoff.mjs";
import { ContextAwareHandoffService } from "../src/multi-model-handoff.mjs";

function service({ rebind, events }) {
  return new ContextAwareHandoffService({
    storage: {},
    artifacts: {
      verify() {
        return { payload: { context_domains: [{ schema_version: "0.1.0", context_domain_id: "chat:test" }] } };
      },
    },
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

test("S8 telemetry: RESUME_READY is discarded when context-domain rebind fails", () => {
  const events = [];
  const original = HandoffService.prototype.continuity;
  HandoffService.prototype.continuity = function fakeCoreContinuity() {
    const ready = {
      handoff_id: "HO-FAIL",
      checkpoint_id: "CP-FAIL",
      resume_manifest_id: "RM-FAIL",
      resume_manifest_digest: "digest",
    };
    this.metric("RESUME_READY", { handoff: ready, reason: "CORE_CONTINUITY_VALIDATED" });
    return ready;
  };

  try {
    const subject = service({
      events,
      rebind: () => { throw Object.assign(new Error("rebind failed"), { code: "CONTEXT_REBIND_FAILED" }); },
    });
    assert.throws(
      () => subject.continuity("HO-FAIL", { sessionId: "SES-TARGET" }),
      (error) => error?.code === "CONTEXT_REBIND_FAILED",
    );
    assert.deepEqual(events, [], "failed rebind must not publish RESUME_READY telemetry");
    assert.equal(subject.deferResumeReadyMetric, false);
    assert.equal(subject.deferredResumeReadyMetric, null);
  } finally {
    HandoffService.prototype.continuity = original;
  }
});

test("S8 telemetry: RESUME_READY is emitted once after successful context-domain rebind", () => {
  const events = [];
  const calls = [];
  const original = HandoffService.prototype.continuity;
  HandoffService.prototype.continuity = function fakeCoreContinuity() {
    const ready = {
      handoff_id: "HO-PASS",
      checkpoint_id: "CP-PASS",
      resume_manifest_id: "RM-PASS",
      resume_manifest_digest: "digest",
    };
    this.metric("RESUME_READY", { handoff: ready, reason: "CORE_CONTINUITY_VALIDATED" });
    return ready;
  };

  try {
    const subject = service({
      events,
      rebind: (input) => calls.push(input),
    });
    const ready = subject.continuity("HO-PASS", { sessionId: "SES-TARGET" });
    assert.equal(ready.handoff_id, "HO-PASS");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].handoffId, "HO-PASS");
    assert.equal(calls[0].checkpointId, "CP-PASS");
    assert.equal(events.length, 1);
    assert.equal(events[0].state, "RESUME_READY");
    assert.equal(events[0].details.reason, "CORE_CONTINUITY_VALIDATED");
    assert.equal(subject.deferResumeReadyMetric, false);
    assert.equal(subject.deferredResumeReadyMetric, null);
  } finally {
    HandoffService.prototype.continuity = original;
  }
});
