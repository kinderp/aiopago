export const CONTEXT_HANDOFF_COMPATIBILITY_SCHEMA_VERSION = "0.1.0";
export const CONTEXT_HANDOFF_COMPATIBILITY_POLICY = Object.freeze({
  schema_version: CONTEXT_HANDOFF_COMPATIBILITY_SCHEMA_VERSION,
  full_session_handoff: "history-zero-replacement-pi-session",
  external_context_rebind: "before-resume-ready",
  resume_ready_telemetry: "after-successful-rebind",
  rebind_failure: "fail-closed-continuity-failed",
  model_switch: "same-pi-session-no-full-handoff",
});
