// Public package API: provider-neutral plan access plus read/data/validation
// helpers. Operational Runner, Pi loading, CLI launch, storage, handoff and
// mutation authorities are intentionally confined to the aio executable bundle.
export {
  canonicalJson,
  digestObject,
  jsonClone,
  opaqueId,
  sha256,
  stableId,
  strictJsonClone,
  utcNow,
} from "./canonical.mjs";
export { GuardianError, fail, invariant } from "./errors.mjs";
export {
  CONTEXT_HANDOFF_THRESHOLD_ENV,
  ContextHandoffAdvisor,
  DEFAULT_CONTEXT_HANDOFF_THRESHOLD_PERCENT,
  LEGACY_CONTEXT_HANDOFF_THRESHOLD_ENV,
  contextHandoffThreshold,
  contextHandoffThresholdEnvironment,
} from "./context-advisor.mjs";
export { observeGitState, sameGitState } from "./git-state.mjs";
export {
  formatHumanNext,
  formatHumanStatus,
  formatHumanTechnical,
  formatHumanWhy,
  formatPlan,
  formatPlanTechnical,
  guidedHandoffEligibilityIdentity,
  observeHumanWorkflow,
  observeRawTaskPlan,
  observeRunnerHumanWorkflow,
  observeTaskPlan,
  projectHumanWorkflow,
  sameGuidedHandoffEligibility,
  validateRuntimeObservation,
} from "./human-workflow.mjs";
export { createPlanAdapter, plan } from "./intent-adapter.mjs";
export {
  TaskLedger,
  canonicalRequiredLocalPaths,
  validateRequiredLocalPaths,
  validateTaskLedger,
} from "./ledger.mjs";
export {
  DEFAULT_METRICS_RETENTION,
  METRICS_SCHEMA_VERSION,
  assertTelemetrySafe,
  measureHandoffArtifacts,
} from "./metrics.mjs";
export {
  DEFAULT_REPOSITORY_CONFIG,
  INSTALLATION_ROOT,
  LEGACY_REPOSITORY_CONFIG_SCHEMA,
  REPOSITORY_CONFIG_FILE,
  REPOSITORY_CONFIG_SCHEMA,
  discoverTargetRepository,
  loadRepositoryContext,
  readRepositoryConfig,
  validateRepositoryConfig,
  validateRepositoryStateBoundaries,
} from "./repository.mjs";
export {
  LEGACY_RUNNER_BINDING_CUSTOM_TYPE,
  RUNNER_BINDING_CUSTOM_TYPE,
  readRuntimeRunnerBinding,
  verifyRunnerOwnership,
} from "./runner-ownership.mjs";
export { readRuntimeProjection } from "./runtime-reader.mjs";
