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
  }

  buildManifest(h) {
    const manifest = super.buildManifest(h);
    const bindings = this.contextCaptures.get(h.source_session_id) ?? [];
    return {
      ...manifest,
      context_domains: structuredClone(bindings),
    };
  }

  beforeResumeReady(handoff, targetSession, manifest) {
    if (!this.contextContinuity) return null;
    const bindings = manifest.context_domains ?? [];
    invariant(Array.isArray(bindings), "MANIFEST_MISMATCH", "context_domains");
    return this.contextContinuity.rebindAfterHandoff({
      bindings,
      targetSession,
      handoffId: handoff.handoff_id,
      checkpointId: handoff.checkpoint_id,
    });
  }
}
