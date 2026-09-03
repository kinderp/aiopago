import { invariant } from "./errors.mjs";

export const EXTERNAL_TOOL_PROFILE_SCHEMA_VERSION = "0.1.0";
export const EXTERNAL_STATEFUL_TOOL_PROFILE = Object.freeze({
  schema_version: EXTERNAL_TOOL_PROFILE_SCHEMA_VERSION,
  profile_id: "external-stateful-read-query-only",
  admitted_tools: Object.freeze(["read", "grep", "find", "ls"]),
  mutation_tools: "deferred",
});

const ADMITTED = new Set(EXTERNAL_STATEFUL_TOOL_PROFILE.admitted_tools);

export function evaluateExternalStatefulToolAdmission(domain, toolName, genericToolProfiles = {}) {
  if (!domain || domain.kind !== "external-stateful") {
    return Object.freeze({ applies: false, admitted: true, reason: "PI_NATIVE_TOOL_SEMANTICS" });
  }
  if (domain.capabilities?.pi_tools !== true) {
    return Object.freeze({ applies: true, admitted: false, reason: "EXTERNAL_PI_TOOLS_DISABLED" });
  }
  if (typeof toolName !== "string" || !ADMITTED.has(toolName)) {
    return Object.freeze({ applies: true, admitted: false, reason: "EXTERNAL_TOOL_NOT_IN_PROFILE" });
  }
  invariant(genericToolProfiles && typeof genericToolProfiles === "object", "EXTERNAL_TOOL_GENERIC_PROFILE_REQUIRED");
  if (genericToolProfiles[toolName] !== "READ_ONLY") {
    return Object.freeze({ applies: true, admitted: false, reason: "EXTERNAL_TOOL_NOT_READ_ONLY" });
  }
  return Object.freeze({ applies: true, admitted: true, reason: "EXTERNAL_READ_QUERY_ADMITTED" });
}
