import { canonicalJson, strictJsonClone } from "./canonical.mjs";
import { GuardianError, invariant } from "./errors.mjs";
import { PlanPort, PLAN_PROPOSAL_SCHEMA } from "./plan-proposal.mjs";
import { MAX_PLAN_BYTES } from "./plan-store.mjs";

export const PLAN_INTENT_SCHEMA = "aiopago.plan-intent/0.1.0";
export const PLAN_OBSERVATION_SCHEMA = "aiopago.plan-observation/0.1.0";
export const PLAN_VALIDATION_SCHEMA = "aiopago.plan-validation/0.1.0";

const INTENT_FIELDS = ["candidate_plan", "change_reason", "producer", "proposal_id", "schema"].sort();
const PROPOSAL_PAYLOAD_FIELDS = [
  "base_content_digest",
  "base_plan_revision_id",
  "candidate_plan",
  "change_reason",
  "created_at",
  "producer",
  "proposal_id",
  "proposed_plan_revision_id",
  "requirements_version",
  "schema",
  "task_id",
].sort();
const ADAPTER_PROPOSAL_FIELDS = [...PROPOSAL_PAYLOAD_FIELDS, "proposal_digest"].sort();

function exactFields(value, expected, code, label) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value)
      && canonicalJson(Object.keys(value).sort()) === canonicalJson(expected),
    code,
    `${label} fields are invalid`,
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundaryClone(value, { code, field }) {
  try {
    return strictJsonClone(value, { code, field });
  } catch (error) {
    if (error instanceof GuardianError) throw error;
    throw new GuardianError(error?.code ?? code, error?.message ?? `${field} is invalid`);
  }
}

function immutableJson(value, options) {
  return deepFreeze(boundaryClone(value, options));
}

function proposalPayload(proposal) {
  const payload = {};
  for (const field of PROPOSAL_PAYLOAD_FIELDS) payload[field] = proposal[field];
  return payload;
}

function proposalView(proposal) {
  return immutableJson(
    { ...proposalPayload(proposal), proposal_digest: proposal.proposal_digest },
    { code: "PLAN_PROPOSAL_JSON_DOMAIN_INVALID", field: "Plan proposal response" },
  );
}

/**
 * Internal implementation. The supported package-root surface is createPlanAdapter()/plan;
 * PlanPort injection exists only for repository tests and is not re-exported at package root.
 */
export class IntentAdapter {
  #port;

  constructor(path = "TASK_PLAN.md", options = {}) {
    this.#port = options.port ?? new PlanPort(path, options.planPortOptions);
    Object.freeze(this);
  }

  #observeRaw() {
    return this.#port.observe();
  }

  #reconstruct(input) {
    const external = boundaryClone(input, { code: "PLAN_ADAPTER_PROPOSAL_JSON_DOMAIN_INVALID", field: "plan proposal" });
    exactFields(external, ADAPTER_PROPOSAL_FIELDS, "PLAN_ADAPTER_PROPOSAL_FIELDS_INVALID", "Adapter plan proposal");
    const suppliedDigest = external.proposal_digest;
    const payload = {};
    for (const field of PROPOSAL_PAYLOAD_FIELDS) payload[field] = external[field];
    const proposal = this.#port.proposal(payload);
    invariant(
      suppliedDigest === proposal.proposal_digest,
      "PLAN_PROPOSAL_DIGEST_INVALID",
      "proposal_digest does not match the reconstructed canonical PlanProposal",
    );
    return proposal;
  }

  #materializeCurrent(proposal) {
    const observed = this.#observeRaw();
    invariant(
      observed.task_id === proposal.task_id,
      "PLAN_TASK_ID_MISMATCH",
      "Proposal task_id does not match the current authoritative task",
    );
    const revisionMatches = observed.plan_revision_id === proposal.base_plan_revision_id;
    const digestMatches = observed.content_digest === proposal.base_content_digest;
    if (!revisionMatches || !digestMatches) {
      throw new GuardianError(
        "PLAN_PROPOSAL_STALE",
        "The proposal base is stale relative to the current TASK_PLAN.md authority",
        {
          expected_plan_revision_id: proposal.base_plan_revision_id,
          observed_plan_revision_id: observed.plan_revision_id,
          revision_matches: revisionMatches,
          expected_content_digest: proposal.base_content_digest,
          observed_content_digest: observed.content_digest,
          digest_matches: digestMatches,
        },
      );
    }
    const materialized = this.#port.materialize(proposal, observed.bytes);
    invariant(
      materialized.bytes.length <= MAX_PLAN_BYTES,
      "PLAN_AUTHORITY_TOO_LARGE",
      `Candidate TASK_PLAN.md exceeds the ${MAX_PLAN_BYTES}-byte authority limit`,
    );
    return { observed, materialized };
  }

  observe() {
    const observed = this.#observeRaw();
    return immutableJson({
      schema: PLAN_OBSERVATION_SCHEMA,
      task_id: observed.task_id,
      plan_revision_id: observed.plan_revision_id,
      content_digest: observed.content_digest,
      plan: observed.plan,
    }, { code: "PLAN_OBSERVATION_INVALID", field: "plan.observe response" });
  }

  propose(input) {
    const intent = boundaryClone(input, { code: "PLAN_INTENT_JSON_DOMAIN_INVALID", field: "plan.propose intent" });
    exactFields(intent, INTENT_FIELDS, "PLAN_INTENT_FIELDS_INVALID", "Plan intent");
    invariant(intent.schema === PLAN_INTENT_SCHEMA, "PLAN_INTENT_SCHEMA_UNSUPPORTED", `Expected ${PLAN_INTENT_SCHEMA}`);

    const observed = this.#observeRaw();
    const candidate = intent.candidate_plan;
    const proposal = this.#port.proposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      proposal_id: intent.proposal_id,
      task_id: observed.task_id,
      base_plan_revision_id: observed.plan_revision_id,
      base_content_digest: observed.content_digest,
      proposed_plan_revision_id: candidate?.plan_revision_id,
      requirements_version: candidate?.requirements_version,
      created_at: candidate?.updated_at,
      producer: intent.producer,
      change_reason: intent.change_reason,
      candidate_plan: candidate,
    });

    const materialized = this.#port.materialize(proposal, observed.bytes);
    invariant(
      materialized.bytes.length <= MAX_PLAN_BYTES,
      "PLAN_AUTHORITY_TOO_LARGE",
      `Candidate TASK_PLAN.md exceeds the ${MAX_PLAN_BYTES}-byte authority limit`,
    );
    return proposalView(proposal);
  }

  validate(input) {
    const proposal = this.#reconstruct(input);
    const { materialized } = this.#materializeCurrent(proposal);
    return immutableJson({
      schema: PLAN_VALIDATION_SCHEMA,
      valid: true,
      stale: false,
      task_id: proposal.task_id,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      base_plan_revision_id: proposal.base_plan_revision_id,
      base_content_digest: proposal.base_content_digest,
      candidate_plan_revision_id: proposal.proposed_plan_revision_id,
      candidate_content_digest: materialized.content_digest,
    }, { code: "PLAN_VALIDATION_RESULT_INVALID", field: "plan.validate response" });
  }

  diff(input) {
    const proposal = this.#reconstruct(input);
    const { materialized } = this.#materializeCurrent(proposal);
    return immutableJson(materialized.diff, { code: "PLAN_DIFF_INVALID", field: "plan.diff response" });
  }

  apply(input) {
    const proposal = this.#reconstruct(input);
    const result = this.#port.apply(proposal);
    return immutableJson(result, { code: "PLAN_APPLY_RESULT_INVALID", field: "plan.apply response" });
  }
}

Object.freeze(IntentAdapter.prototype);

function publicSurface(adapter) {
  const surface = Object.create(null);
  for (const operation of ["observe", "propose", "validate", "diff", "apply"]) {
    Object.defineProperty(surface, operation, {
      value: (...args) => {
        const expected = operation === "observe" ? 0 : 1;
        invariant(args.length === expected, "PLAN_ADAPTER_ARGUMENTS_INVALID", `plan.${operation} expects exactly ${expected} argument${expected === 1 ? "" : "s"}`);
        return adapter[operation](...args);
      },
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(surface);
}

export function createPlanAdapter(path = "TASK_PLAN.md") {
  invariant(arguments.length <= 1, "PLAN_ADAPTER_ARGUMENTS_INVALID", "createPlanAdapter expects at most one path argument");
  invariant(typeof path === "string" && path.length > 0, "PLAN_ADAPTER_PATH_INVALID", "Plan adapter path must be a non-empty string");
  return publicSurface(new IntentAdapter(path));
}

export const plan = createPlanAdapter();
