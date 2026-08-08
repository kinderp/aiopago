import { invariant } from "./errors.mjs";

export const DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT = 50;
export const CONTEXT_HANDOFF_THRESHOLD_ENV = "EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT";

export function contextHandoffThreshold(value = undefined) {
  if (value === undefined || value === null || value === "") return DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT;
  const threshold = typeof value === "number" ? value : Number(value);
  invariant(Number.isFinite(threshold) && threshold > 0 && threshold <= 100, "CONTEXT_HANDOFF_THRESHOLD_INVALID", `${CONTEXT_HANDOFF_THRESHOLD_ENV} must be greater than 0 and at most 100`);
  return threshold;
}

export class ContextHandoffAdvisor {
  constructor({ thresholdPercent = undefined } = {}) {
    this.thresholdPercent = contextHandoffThreshold(thresholdPercent);
    this.notifiedAboveThreshold = false;
  }

  reset() {
    this.notifiedAboveThreshold = false;
  }

  observe(usage) {
    const percent = usage?.percent;
    if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
    if (percent < this.thresholdPercent) {
      this.notifiedAboveThreshold = false;
      return null;
    }
    if (this.notifiedAboveThreshold) return null;
    this.notifiedAboveThreshold = true;
    return Object.freeze({
      percent,
      tokens: usage.tokens ?? null,
      contextWindow: usage.contextWindow ?? null,
      thresholdPercent: this.thresholdPercent,
    });
  }
}
