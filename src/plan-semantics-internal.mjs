import { canonicalJson, digestObject, strictJsonClone } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { canonicalRequiredLocalPaths } from "./ledger.mjs";

const PLAN_SEMANTIC_FIELDS = Object.freeze([
  "task_id",
  "objective",
  "current_item",
  "next_item",
  "next_step",
  "plan_revision_id",
  "content_digest",
  "requirements_version",
  "completion_criteria",
  "relevant_decisions",
  "relevant_tests",
  "evidence_references",
  "minimal_reads",
  "required_local_paths",
  "model_policy",
  "reasoning_policy",
]);

function semanticList(plan, field, { required, code }) {
  if (!Object.hasOwn(plan, field)) {
    invariant(!required, code, `Canonical plan semantics are missing ${field}`);
    return [];
  }
  invariant(Array.isArray(plan[field]), code, `Canonical plan semantic field ${field} must be an array`);
  return strictJsonClone(plan[field], { code, field: `plan.${field}` });
}

function semanticScalar(plan, field, { nullable = false, required = true, code }) {
  if (!Object.hasOwn(plan, field)) {
    invariant(!required, code, `Canonical plan semantics are missing ${field}`);
    return null;
  }
  const value = plan[field];
  invariant((nullable && value === null) || typeof value === "string", code, `Canonical plan semantic field ${field} is invalid`);
  return value;
}

export function canonicalPlanSemantics(plan, {
  requireAll = false,
  modelPolicy = undefined,
  reasoningPolicy = undefined,
  code = "HANDOFF_PLAN_PROVENANCE_MISMATCH",
} = {}) {
  invariant(plan && typeof plan === "object" && !Array.isArray(plan), code, "Canonical plan semantics require a plan object");
  if (requireAll) {
    for (const field of PLAN_SEMANTIC_FIELDS) invariant(Object.hasOwn(plan, field), code, `Canonical plan semantics are missing ${field}`);
  }
  const required = requireAll;
  const projection = {
    task_id: semanticScalar(plan, "task_id", { code }),
    objective: semanticScalar(plan, "objective", { code }),
    current_item: semanticScalar(plan, "current_item", { nullable: true, code }),
    next_item: semanticScalar(plan, "next_item", { nullable: true, code }),
    next_step: semanticScalar(plan, "next_step", { code }),
    plan_revision_id: semanticScalar(plan, "plan_revision_id", { code }),
    content_digest: semanticScalar(plan, "content_digest", { code }),
    requirements_version: semanticScalar(plan, "requirements_version", { code }),
    completion_criteria: semanticList(plan, "completion_criteria", { required, code }),
    relevant_decisions: semanticList(plan, "relevant_decisions", { required, code }),
    relevant_tests: semanticList(plan, "relevant_tests", { required, code }),
    evidence_references: semanticList(plan, "evidence_references", { required, code }),
    minimal_reads: semanticList(plan, "minimal_reads", { required, code }),
    required_local_paths: canonicalRequiredLocalPaths(
      Object.hasOwn(plan, "required_local_paths") ? plan.required_local_paths : [],
      code,
    ),
    model_policy: modelPolicy === undefined
      ? semanticScalar(plan, "model_policy", { nullable: true, required, code })
      : modelPolicy,
    reasoning_policy: reasoningPolicy === undefined
      ? semanticScalar(plan, "reasoning_policy", { nullable: true, required, code })
      : reasoningPolicy,
  };
  invariant(projection.model_policy === null || typeof projection.model_policy === "string", code, "Canonical model policy is invalid");
  invariant(projection.reasoning_policy === null || typeof projection.reasoning_policy === "string", code, "Canonical reasoning policy is invalid");
  return strictJsonClone(projection, { code, field: "canonical plan semantics" });
}

export function planSemanticDigest(plan, options = {}) {
  return digestObject(canonicalPlanSemantics(plan, options));
}

export function sameCanonicalJson(left, right) {
  try {
    return canonicalJson(strictJsonClone(left, { clone: true })) === canonicalJson(strictJsonClone(right, { clone: true }));
  } catch {
    return false;
  }
}

export function samePlanSemantics(left, right, { leftRequireAll = false, rightRequireAll = false } = {}) {
  try {
    return canonicalJson(canonicalPlanSemantics(left, { requireAll: leftRequireAll }))
      === canonicalJson(canonicalPlanSemantics(right, { requireAll: rightRequireAll }));
  } catch {
    return false;
  }
}

export function assertPlanSemanticSubset(expectedPlan, representation, fieldMap, {
  code = "HANDOFF_PLAN_PROVENANCE_MISMATCH",
  label = "plan evidence",
  optionalFields = [],
} = {}) {
  const expected = canonicalPlanSemantics(expectedPlan, { requireAll: true, code });
  const optional = new Set(optionalFields);
  invariant(representation && typeof representation === "object" && !Array.isArray(representation), code, `${label} is not an object`);
  for (const [evidenceField, planField] of Object.entries(fieldMap)) {
    if (!Object.hasOwn(representation, evidenceField)) {
      invariant(optional.has(evidenceField), code, `${label} is missing ${evidenceField}`);
      continue;
    }
    let actual = representation[evidenceField];
    if (planField === "required_local_paths") actual = canonicalRequiredLocalPaths(actual, code);
    else actual = strictJsonClone(actual, { code, field: `${label}.${evidenceField}` });
    invariant(sameCanonicalJson(actual, expected[planField]), code, `${label}.${evidenceField} conflicts with canonical plan semantics`);
  }
  return expected;
}

export { PLAN_SEMANTIC_FIELDS };
