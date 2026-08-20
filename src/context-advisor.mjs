import { invariant } from "./errors.mjs";

export const DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT = 50;
export const CONTEXT_HANDOFF_THRESHOLD_ENV = "AIOPAGO_CONTEXT_HANDOFF_THRESHOLD_PERCENT";
export const LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV = "EIO_CONTEXT_HANDOFF_THRESHOLD_PERCENT";

export function contextHandoffThresholdEnvironment(env = process.env, { warn = (message) => console.error(message) } = {}) {
  const canonical = env[CONTEXT_HANDOFF_THRESHOLD_ENV];
  const legacy = env[LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV];
  if (canonical !== undefined && legacy !== undefined) {
    invariant(String(canonical) === String(legacy), "CONTEXT_HANDOFF_THRESHOLD_ENV_CONFLICT", `${CONTEXT_HANDOFF_THRESHOLD_ENV} conflicts with deprecated ${LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV}`);
  }
  if (legacy !== undefined) warn(`${LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV} is deprecated; use ${CONTEXT_HANDOFF_THRESHOLD_ENV}`);
  return canonical ?? legacy;
}

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
