import { HandoffService } from "./handoff.mjs";
import { invariant } from "./errors.mjs";

export class ContextAwareHandoffService extends HandoffService {
  constructor({ contextContinuity = null, ...options }) {
    invariant(!contextContinuity || (typeof contextContinuity.captureForHandoff === "function" && typeof contextContinuity.rebindAfterHandoff === "function"), "CONTEXT_HANDOFF_CONTINUITY_INVALID");
    const captures = new Map();
    const sourceSafePoint = options.safePoint;
    const safePoint = contextContinuity ? {
      request: async (session, ...args) => {
        const safe = await sourceSafePoint.request(session, ...args);
        captures.set(session.sessionId, contextContinuity.captureForHandoff(session));
        return safe;
      },
    } : sourceSafePoint;
    super({ ...options, safePoint });
    this.contextContinuity = contextContinuity;
    this.contextCaptures = captures;
    this.deferResumeReadyMetric = false;
    this.deferredResumeReadyMetric = null;
  }

  metric(lifecycleState, details) {
    if (lifecycleState === "RESUME_READY" && this.deferResumeReadyMetric) {
      this.deferredResumeReadyMetric = details;
      return null;
    }
    return super.metric(lifecycleState, details);
  }

  buildManifest(h) {
    const manifest = super.buildManifest(h);
    const bindings = this.contextCaptures.get(h.source_session_id) ?? [];
    return {
      ...manifest,
      context_domains: structuredClone(bindings),
    };
  }

  continuity(handoffId, targetSession) {
    if (!this.contextContinuity) return super.continuity(handoffId, targetSession);

    invariant(!this.deferResumeReadyMetric, "CONTEXT_HANDOFF_CONTINUITY_REENTRANT");
    this.deferResumeReadyMetric = true;
    this.deferredResumeReadyMetric = null;
    try {
      const ready = super.continuity(handoffId, targetSession);
      const manifest = this.artifacts.verify("manifest", ready.resume_manifest_id, ready.resume_manifest_digest).payload;
      const bindings = manifest.context_domains ?? [];
      invariant(Array.isArray(bindings), "MANIFEST_MISMATCH", "context_domains");
      this.contextContinuity.rebindAfterHandoff({
        bindings,
        targetSession,
        handoffId: ready.handoff_id,
        checkpointId: ready.checkpoint_id,
      });

      const deferred = this.deferredResumeReadyMetric;
      this.deferResumeReadyMetric = false;
      this.deferredResumeReadyMetric = null;
      if (deferred) super.metric("RESUME_READY", deferred);
      return ready;
    } catch (error) {
      // A failed context-domain rebind must never leave a misleading RESUME_READY
      // telemetry event behind. finishPausedHandoff will persist CONTINUITY_FAILED.
      this.deferResumeReadyMetric = false;
      this.deferredResumeReadyMetric = null;
      throw error;
    }
  }
}
