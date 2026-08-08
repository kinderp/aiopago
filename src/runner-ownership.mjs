import { invariant } from "./errors.mjs";

export const RUNNER_BINDING_CUSTOM_TYPE = "eiopago.runner-session-binding.v1";
const BINDING_FIELDS = ["handoff_id", "replacement_session_id", "runner_instance_id", "session_binding_id"];

function assertBindingShape(binding) {
  invariant(binding && typeof binding === "object", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "binding missing");
  invariant(binding.schema_version === "1.0.0", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "binding schema");
  for (const field of BINDING_FIELDS) invariant(typeof binding[field] === "string" && binding[field].length > 0, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", field);
  return binding;
}

export function installRunnerSessionBinding(sessionManager, expected) {
  const initializationEntries = sessionManager.getEntries();
  invariant(initializationEntries.every((entry) => ["model_change", "thinking_level_change"].includes(entry.type)), "RUNNER_BINDING_SESSION_NOT_EMPTY");
  const binding = assertBindingShape({
    schema_version: "1.0.0",
    handoff_id: expected.handoff_id,
    replacement_session_id: sessionManager.getSessionId(),
    runner_instance_id: expected.runner_instance_id,
    session_binding_id: expected.session_binding_id,
  });
  sessionManager.appendCustomEntry(RUNNER_BINDING_CUSTOM_TYPE, binding);
  return binding;
}

export function readRuntimeRunnerBinding(session) {
  invariant(session?.sessionManager && typeof session.sessionId === "string", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "runtime session missing");
  const entries = session.sessionManager.getEntries();
  const matches = entries.filter((entry) => entry.type === "custom" && entry.customType === RUNNER_BINDING_CUSTOM_TYPE);
  invariant(matches.length === 1, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "Runner binding entry missing or duplicated");
  const entry = matches[0];
  const bindingIndex = entries.indexOf(entry);
  invariant(entries.slice(0, bindingIndex).every((candidate) => ["model_change", "thinking_level_change"].includes(candidate.type)), "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "Runner binding was not installed during session setup");
  const binding = assertBindingShape(entry.data);
  invariant(session.sessionManager.getSessionId() === session.sessionId && binding.replacement_session_id === session.sessionId, "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "current runtime session mismatch");
  return binding;
}

export function verifyRunnerOwnership({ runtimeBinding, journalBinding, manifestBinding, expected }) {
  assertBindingShape(runtimeBinding);
  assertBindingShape(journalBinding);
  assertBindingShape(manifestBinding);
  assertBindingShape(expected);
  invariant(journalBinding.status === "ACTIVE", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "handoff binding stale or superseded");
  for (const field of BINDING_FIELDS) {
    invariant(runtimeBinding[field] === expected[field] && journalBinding[field] === expected[field] && manifestBinding[field] === expected[field], "RUNNER_OWNERSHIP_ATTESTATION_FAILED", field);
  }
  invariant(journalBinding.event_data && typeof journalBinding.event_data === "object", "RUNNER_OWNERSHIP_ATTESTATION_FAILED", "journal binding event missing");
  for (const field of BINDING_FIELDS) invariant(journalBinding.event_data[field] === expected[field], "RUNNER_OWNERSHIP_ATTESTATION_FAILED", `journal ${field}`);
  return Object.freeze({ ...expected, status: "ATTESTED" });
}
