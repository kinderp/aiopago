import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as packageRoot from "../src/index.mjs";
import {
  IntentAdapter,
  PLAN_INTENT_SCHEMA,
  PLAN_OBSERVATION_SCHEMA,
  PLAN_VALIDATION_SCHEMA,
  createPlanAdapter,
} from "../src/intent-adapter.mjs";
import { PLAN_DIFF_SCHEMA, PLAN_PROPOSAL_SCHEMA, PlanProposal } from "../src/plan-proposal.mjs";
import { sha256 } from "../src/canonical.mjs";

const BASE_TIME = "2026-08-21T10:00:00.000Z";
const NEXT_TIME = "2026-08-21T10:05:00.000Z";

function item(id, status, overrides = {}) {
  return {
    task_item_id: id,
    task_id: "TASK-INTENT-ADAPTER",
    title: `Item ${id}`,
    description: `Complete ${id}`,
    status,
    depends_on: [],
    completion_criteria: [`${id} accepted`],
    evidence: status === "DONE" ? [`${id} evidence`] : [],
    requirements_refs: ["REQ-INTENT-1"],
    risk: "MEDIUM",
    milestone: "0.2-C",
    last_updated_at: BASE_TIME,
    last_updated_by: "human:test",
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    schema_version: "0.1.0",
    task_id: "TASK-INTENT-ADAPTER",
    title: "Intent Adapter fixture",
    objective: "Exercise provider-neutral structured plan mechanics.",
    requirements_version: "REQ-INTENT-1",
    plan_revision_id: "PLAN-BASE-1",
    status: "IN_PROGRESS",
    completion_criteria: ["The adapter remains deterministic"],
    risk: "MEDIUM",
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    current_item: "ITEM-1",
    next_item: "ITEM-2",
    next_step: "Complete ITEM-1.",
    evidence: [],
    task_items: [
      item("ITEM-1", "IN_PROGRESS"),
      item("ITEM-2", "PLANNED", { depends_on: ["ITEM-1"] }),
    ],
    ...overrides,
  };
}

function blockedTask() {
  const value = task({
    status: "BLOCKED",
    current_item: null,
    next_item: "ITEM-1",
    next_step: "Await owner authorization.",
    owner_gate: {
      kind: "HANDOFF_CONFIRM",
      status: "BLOCKED",
      command: "/aio handoff confirm",
      item_id: "ITEM-1",
      satisfied_plan_revision_id: "PLAN-GATE-SATISFIED",
      satisfied_task_status: "IN_PROGRESS",
      satisfied_next_item: "ITEM-2",
      satisfied_next_step: "Continue ITEM-1, then ITEM-2.",
    },
  });
  value.task_items[0].status = "BLOCKED";
  return value;
}

function markdown(value, schema = "aiopago.task-ledger/0.1.0") {
  return [
    "# Intent Adapter Task Ledger",
    "",
    "**Authority:** Markdown canonico standalone",
    `**Schema:** \`${schema}\``,
    `**Current revision:** \`${value.plan_revision_id}\``,
    `**Requirements version:** \`${value.requirements_version}\``,
    `**Updated:** ${value.updated_at}`,
    "",
    "Human-authored context remains byte-preserved.",
    "",
    "```json task-ledger",
    JSON.stringify(value, null, 2),
    "```",
    "",
  ].join("\n");
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiopago-intent-adapter-"));
  const path = join(root, "TASK_PLAN.md");
  const base = options.task ?? task();
  writeFileSync(path, markdown(base, options.schema));
  return { root, path, base, bytes: readFileSync(path), adapter: createPlanAdapter(path) };
}

function candidate(base, overrides = {}) {
  const value = structuredClone(base);
  value.plan_revision_id = "PLAN-CANDIDATE-2";
  value.updated_at = NEXT_TIME;
  value.next_step = "Continue the structured candidate plan.";
  return Object.assign(value, overrides);
}

function observationIdentity(observation) {
  return {
    task_id: observation.task_id,
    plan_revision_id: observation.plan_revision_id,
    content_digest: observation.content_digest,
  };
}

function fixtureIdentity(x) {
  return {
    task_id: x.base.task_id,
    plan_revision_id: x.base.plan_revision_id,
    content_digest: sha256(x.bytes),
  };
}

function intent(candidatePlan, base, overrides = {}) {
  return {
    schema: PLAN_INTENT_SCHEMA,
    proposal_id: "PPR-INTENT-ADAPTER-1",
    producer: "aiopago:test-structured-producer",
    change_reason: "Apply an externally produced structured candidate.",
    base,
    candidate_plan: candidatePlan,
    ...overrides,
  };
}

function serializedProposal(baseBytes, base, candidatePlan, overrides = {}) {
  const proposal = new PlanProposal({
    schema: PLAN_PROPOSAL_SCHEMA,
    proposal_id: "PPR-FORGED-CALLER-1",
    task_id: base.task_id,
    base_plan_revision_id: base.plan_revision_id,
    base_content_digest: sha256(baseBytes),
    proposed_plan_revision_id: candidatePlan.plan_revision_id,
    requirements_version: candidatePlan.requirements_version,
    created_at: candidatePlan.updated_at,
    producer: "aiopago:test-structured-producer",
    change_reason: "Reconstruct this proposal at the adapter boundary.",
    candidate_plan: candidatePlan,
    ...overrides,
  });
  return JSON.parse(JSON.stringify(proposal));
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function assertNoState(x) {
  assert.equal(existsSync(join(x.root, ".guardian")), false);
  assert.deepEqual(readFileSync(x.path), x.bytes);
}

test("package root exposes only the supported plan adapter, not raw plan writers", () => {
  assert.equal(typeof packageRoot.plan.observe, "function");
  assert.equal(typeof packageRoot.plan.propose, "function");
  assert.equal(typeof packageRoot.plan.validate, "function");
  assert.equal(typeof packageRoot.plan.diff, "function");
  assert.equal(typeof packageRoot.plan.apply, "function");
  assert.deepEqual(Object.keys(packageRoot.plan).sort(), ["apply", "diff", "observe", "propose", "validate"]);
  assert.equal(Object.getPrototypeOf(packageRoot.plan), null);
  assert.equal(Object.isFrozen(packageRoot.plan), true);
  assert.equal(packageRoot.plan.constructor, undefined);
  assert.throws(() => packageRoot.plan.observe({ ignored: "input" }), (error) => error.code === "PLAN_ADAPTER_ARGUMENTS_INVALID");
  assert.throws(() => packageRoot.createPlanAdapter("TASK_PLAN.md", {}), (error) => error.code === "PLAN_ADAPTER_ARGUMENTS_INVALID");
  assert.equal(packageRoot.createPlanAdapter, createPlanAdapter);
  assert.equal(Object.hasOwn(packageRoot, "PlanPort"), false);
  assert.equal(Object.hasOwn(packageRoot, "PlanRevisionWriter"), false);
  assert.equal(Object.hasOwn(packageRoot, "PlanProposal"), false);
});

test("plan.observe returns the exact deterministic authority identity defensively", () => {
  const x = fixture();
  const first = x.adapter.observe();
  const second = x.adapter.observe();
  assert.deepEqual(first, second);
  assert.equal(first.schema, PLAN_OBSERVATION_SCHEMA);
  assert.equal(first.task_id, x.base.task_id);
  assert.equal(first.plan_revision_id, x.base.plan_revision_id);
  assert.equal(first.content_digest, sha256(x.bytes));
  assert.deepEqual(first.plan, x.base);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.plan), true);
  assert.equal(Object.isFrozen(first.plan.task_items), true);
  assert.throws(() => { first.plan.next_step = "caller mutation"; }, TypeError);
  assert.equal(x.adapter.observe().plan.next_step, x.base.next_step);
  assertNoState(x);
});

test("plan.observe fails closed on malformed authority without creating state", () => {
  const x = fixture();
  writeFileSync(x.path, "# malformed\n");
  assert.throws(() => x.adapter.observe(), (error) => error.code === "LEDGER_FORMAT_INVALID");
  assert.equal(existsSync(join(x.root, ".guardian")), false);
});

test("observe/propose/validate/diff are read-only in a clean Git worktree", () => {
  const x = fixture();
  git(x.root, ["init"]);
  git(x.root, ["config", "user.email", "intent@example.invalid"]);
  git(x.root, ["config", "user.name", "Intent Adapter Fixture"]);
  git(x.root, ["add", "TASK_PLAN.md"]);
  git(x.root, ["commit", "-m", "base"]);
  const before = git(x.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const observation = x.adapter.observe();
  const proposal = x.adapter.propose(intent(candidate(observation.plan), observationIdentity(observation)));
  assert.equal(x.adapter.validate(proposal).valid, true);
  assert.equal(x.adapter.diff(proposal).schema, PLAN_DIFF_SCHEMA);
  assert.equal(git(x.root, ["status", "--porcelain=v1", "--untracked-files=all"]), before);
  assertNoState(x);
});

test("plan.propose verifies the declared base and uses the matching authority identity", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  assert.equal(proposal.schema, PLAN_PROPOSAL_SCHEMA);
  assert.equal(proposal.task_id, x.base.task_id);
  assert.equal(proposal.base_plan_revision_id, x.base.plan_revision_id);
  assert.equal(proposal.base_content_digest, sha256(x.bytes));
  assert.equal(proposal.proposed_plan_revision_id, "PLAN-CANDIDATE-2");
  assert.match(proposal.proposal_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.candidate_plan), true);

  assert.throws(
    () => x.adapter.propose({ ...intent(candidate(x.base), fixtureIdentity(x)), base_plan_revision_id: "PLAN-SPOOF", base_content_digest: `sha256:${"0".repeat(64)}` }),
    (error) => error.code === "PLAN_INTENT_FIELDS_INVALID",
  );
  assertNoState(x);
});

test("observe A -> build B -> external C -> propose B fails stale and preserves C exact bytes", () => {
  const x = fixture();
  const observationA = x.adapter.observe();
  const candidateB = candidate(structuredClone(observationA.plan), {
    title: "Candidate B derived from A",
    next_step: "Apply B only if A is still current.",
  });
  const intentB = intent(candidateB, observationIdentity(observationA));
  const authorityC = candidate(x.base, {
    plan_revision_id: "PLAN-EXTERNAL-C",
    updated_at: "2026-08-21T10:06:00.000Z",
    title: "Concurrent authority C",
    next_step: "Preserve C and its legitimate concurrent change.",
  });
  writeFileSync(x.path, markdown(authorityC));
  const exactC = readFileSync(x.path);

  assert.throws(() => x.adapter.propose(intentB), (error) => {
    assert.equal(error.code, "PLAN_PROPOSAL_STALE");
    assert.deepEqual(error.details, {
      expected_task_id: observationA.task_id,
      observed_task_id: authorityC.task_id,
      task_matches: true,
      expected_plan_revision_id: observationA.plan_revision_id,
      observed_plan_revision_id: authorityC.plan_revision_id,
      revision_matches: false,
      expected_content_digest: observationA.content_digest,
      observed_content_digest: sha256(exactC),
      digest_matches: false,
    });
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(error.details)));
    return true;
  });
  assert.deepEqual(readFileSync(x.path), exactC);
  assert.equal(existsSync(join(x.root, ".guardian")), false);
});

test("plan.propose rejects a same-revision base whose exact content digest changed", () => {
  const x = fixture();
  const observationA = x.adapter.observe();
  const sameRevisionC = structuredClone(x.base);
  sameRevisionC.updated_at = "2026-08-21T10:06:00.000Z";
  sameRevisionC.next_step = "Changed exact bytes without changing the revision ID.";
  writeFileSync(x.path, markdown(sameRevisionC));
  const exactC = readFileSync(x.path);
  assert.throws(() => x.adapter.propose(intent(candidate(observationA.plan), observationIdentity(observationA))), (error) => {
    assert.equal(error.code, "PLAN_PROPOSAL_STALE");
    assert.equal(error.details.task_matches, true);
    assert.equal(error.details.revision_matches, true);
    assert.equal(error.details.digest_matches, false);
    return true;
  });
  assert.deepEqual(readFileSync(x.path), exactC);
  assert.equal(existsSync(join(x.root, ".guardian")), false);
});

test("plan.propose rejects an expected revision mismatch even when task and digest match", () => {
  const x = fixture();
  const forgedBase = { ...fixtureIdentity(x), plan_revision_id: "PLAN-FORGED-REVISION" };
  assert.throws(() => x.adapter.propose(intent(candidate(x.base), forgedBase)), (error) => {
    assert.equal(error.code, "PLAN_PROPOSAL_STALE");
    assert.equal(error.details.task_matches, true);
    assert.equal(error.details.revision_matches, false);
    assert.equal(error.details.digest_matches, true);
    return true;
  });
  assertNoState(x);
});

test("plan.propose rejects an expected task mismatch as stale", () => {
  const x = fixture();
  const forgedBase = { ...fixtureIdentity(x), task_id: "TASK-FORGED-BASE" };
  assert.throws(() => x.adapter.propose(intent(candidate(x.base), forgedBase)), (error) => {
    assert.equal(error.code, "PLAN_PROPOSAL_STALE");
    assert.equal(error.details.task_matches, false);
    assert.equal(error.details.revision_matches, true);
    assert.equal(error.details.digest_matches, true);
    return true;
  });
  assertNoState(x);
});

test("stale intent fails before PlanProposal construction", () => {
  const x = fixture();
  let proposalCalls = 0;
  const port = {
    observe() {
      return {
        task_id: x.base.task_id,
        plan_revision_id: x.base.plan_revision_id,
        content_digest: sha256(x.bytes),
        bytes: Buffer.from(x.bytes),
        plan: structuredClone(x.base),
      };
    },
    proposal() { proposalCalls += 1; throw new Error("must not construct"); },
  };
  const adapter = new IntentAdapter(x.path, { port });
  const staleBase = { ...fixtureIdentity(x), plan_revision_id: "PLAN-STALE" };
  assert.throws(() => adapter.propose(intent(candidate(x.base), staleBase)), (error) => error.code === "PLAN_PROPOSAL_STALE");
  assert.equal(proposalCalls, 0);
  assertNoState(x);
});

test("plan.propose snapshots caller data and output mutation cannot affect later operations", () => {
  const x = fixture();
  const candidatePlan = candidate(x.base);
  const request = intent(candidatePlan, fixtureIdentity(x));
  const proposal = x.adapter.propose(request);
  candidatePlan.next_step = "mutated after propose";
  request.change_reason = "mutated after propose";
  request.base.task_id = "TASK-MUTATED-AFTER-PROPOSE";
  request.base.plan_revision_id = "PLAN-MUTATED-AFTER-PROPOSE";
  request.base.content_digest = `sha256:${"0".repeat(64)}`;
  assert.equal(proposal.task_id, x.base.task_id);
  assert.equal(proposal.base_plan_revision_id, x.base.plan_revision_id);
  assert.equal(proposal.base_content_digest, sha256(x.bytes));
  assert.equal(proposal.candidate_plan.next_step, "Continue the structured candidate plan.");
  assert.equal(x.adapter.validate(proposal).valid, true);
  assert.throws(() => { proposal.proposal_digest = `sha256:${"0".repeat(64)}`; }, TypeError);
  assertNoState(x);
});

test("plan.propose rejects invalid Ledger and strict JSON attacks deterministically", () => {
  const x = fixture();
  const invalid = candidate(x.base);
  invalid.task_items[0].status = "NOT_A_STATUS";
  assert.throws(() => x.adapter.propose(intent(invalid, fixtureIdentity(x))), (error) => error.code === "LEDGER_ITEM_STATUS_INVALID");

  const attacks = [];
  attacks.push(Object.assign(Object.create({ inherited: true }), intent(candidate(x.base), fixtureIdentity(x))));
  const accessor = intent(candidate(x.base), fixtureIdentity(x));
  Object.defineProperty(accessor, "producer", { enumerable: true, get() { return "attacker"; } });
  attacks.push(accessor);
  const symbol = intent(candidate(x.base), fixtureIdentity(x)); symbol[Symbol("hidden")] = true; attacks.push(symbol);
  attacks.push({ ...intent(candidate(x.base), fixtureIdentity(x)), producer: () => "bad" });
  attacks.push({ ...intent(candidate(x.base), fixtureIdentity(x)), producer: undefined });
  attacks.push({ ...intent(candidate(x.base), fixtureIdentity(x)), extra: Number.NaN });
  attacks.push({ ...intent(candidate(x.base), fixtureIdentity(x)), extra: 1n });
  const cycle = intent(candidate(x.base), fixtureIdentity(x)); cycle.candidate_plan.cycle = cycle; attacks.push(cycle);
  attacks.push(new (class ForgedIntent { constructor() { Object.assign(this, intent(candidate(x.base), fixtureIdentity(x))); } })());

  for (const attack of attacks) {
    assert.throws(() => x.adapter.propose(attack), (error) => error.code === "PLAN_INTENT_JSON_DOMAIN_INVALID");
  }
  assertNoState(x);
});

test("plan.propose enforces exact strict base identity fields and digest syntax", () => {
  const x = fixture();
  const desired = candidate(x.base);

  const missingBase = intent(desired, fixtureIdentity(x));
  delete missingBase.base;
  assert.throws(() => x.adapter.propose(missingBase), (error) => error.code === "PLAN_INTENT_FIELDS_INVALID");

  const missingField = fixtureIdentity(x);
  delete missingField.plan_revision_id;
  assert.throws(() => x.adapter.propose(intent(desired, missingField)), (error) => error.code === "PLAN_INTENT_BASE_FIELDS_INVALID");
  assert.throws(
    () => x.adapter.propose(intent(desired, { ...fixtureIdentity(x), extra: true })),
    (error) => error.code === "PLAN_INTENT_BASE_FIELDS_INVALID",
  );
  assert.throws(
    () => x.adapter.propose(intent(desired, { ...fixtureIdentity(x), content_digest: `sha256:${"A".repeat(64)}` })),
    (error) => error.code === "PLAN_INTENT_BASE_INVALID",
  );
  assert.throws(
    () => x.adapter.propose(intent(desired, { ...fixtureIdentity(x), task_id: "x".repeat(4097) })),
    (error) => error.code === "PLAN_INTENT_BASE_INVALID",
  );
  assertNoState(x);
});

test("plan.propose rejects custom prototypes, accessors, symbols, and cycles inside base", () => {
  const x = fixture();
  const desired = candidate(x.base);
  const attacks = [];
  attacks.push(Object.assign(Object.create({ inherited: true }), fixtureIdentity(x)));
  const accessor = fixtureIdentity(x);
  Object.defineProperty(accessor, "task_id", { enumerable: true, get() { return x.base.task_id; } });
  attacks.push(accessor);
  const symbol = fixtureIdentity(x); symbol[Symbol("hidden")] = true; attacks.push(symbol);
  const cycle = fixtureIdentity(x); cycle.cycle = cycle; attacks.push(cycle);
  attacks.push({ ...fixtureIdentity(x), task_id: undefined });
  attacks.push({ ...fixtureIdentity(x), plan_revision_id: Number.NaN });
  attacks.push({ ...fixtureIdentity(x), content_digest: 1n });
  attacks.push({ ...fixtureIdentity(x), task_id: () => "TASK-FORGED" });

  for (const base of attacks) {
    assert.throws(
      () => x.adapter.propose(intent(desired, base)),
      (error) => error.code === "PLAN_INTENT_JSON_DOMAIN_INVALID",
    );
  }
  assertNoState(x);
});

test("plan.propose fails closed for generic owner-gate mutation and lifecycle bypass", () => {
  const x = fixture({ task: blockedTask() });
  const removedGate = candidate(x.base); delete removedGate.owner_gate;
  assert.throws(() => x.adapter.propose(intent(removedGate, fixtureIdentity(x))), (error) => error.code === "PLAN_OWNER_GATE_MUTATION_FORBIDDEN");

  const lifecycle = candidate(x.base, { next_step: "Bypass the latch." });
  assert.throws(() => x.adapter.propose(intent(lifecycle, fixtureIdentity(x))), (error) => error.code === "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN");

  const command = candidate(x.base); command.owner_gate.command = "/aio arbitrary release";
  assert.throws(() => x.adapter.propose(intent(command, fixtureIdentity(x))), (error) => error.code === "OWNER_GATE_INVALID");
  assertNoState(x);
});

test("plan.validate returns immutable materialization identity for a valid proposal", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  const validation = x.adapter.validate(proposal);
  assert.equal(validation.schema, PLAN_VALIDATION_SCHEMA);
  assert.equal(validation.valid, true);
  assert.equal(validation.stale, false);
  assert.equal(validation.proposal_digest, proposal.proposal_digest);
  assert.equal(validation.base_content_digest, proposal.base_content_digest);
  assert.match(validation.candidate_content_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(validation), true);
  assertNoState(x);
});

test("plan.validate reconstructs proposals and rejects malformed fields and forged digests", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  assert.throws(() => x.adapter.validate({ ...proposal, extra: true }), (error) => error.code === "PLAN_ADAPTER_PROPOSAL_FIELDS_INVALID");
  assert.throws(
    () => x.adapter.validate({ ...proposal, proposal_digest: `sha256:${"0".repeat(64)}` }),
    (error) => error.code === "PLAN_PROPOSAL_DIGEST_INVALID",
  );
  const custom = Object.assign(Object.create({ forged: true }), proposal);
  assert.throws(() => x.adapter.validate(custom), (error) => error.code === "PLAN_ADAPTER_PROPOSAL_JSON_DOMAIN_INVALID");
  assertNoState(x);
});

test("plan.validate distinguishes a valid stale proposal and plan.apply preserves CAS", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  const external = candidate(x.base, {
    plan_revision_id: "PLAN-EXTERNAL-3",
    updated_at: "2026-08-21T10:06:00.000Z",
    next_step: "External valid revision wins.",
  });
  writeFileSync(x.path, markdown(external));
  const externalBytes = readFileSync(x.path);
  for (const preview of ["validate", "diff"]) {
    assert.throws(() => x.adapter[preview](proposal), (error) => {
      assert.equal(error.code, "PLAN_PROPOSAL_STALE");
      assert.equal(error.details.task_matches, true);
      assert.equal(error.details.revision_matches, false);
      assert.equal(error.details.digest_matches, false);
      return true;
    });
  }
  assert.throws(() => x.adapter.apply(proposal), (error) => error.code === "PLAN_CAS_CONFLICT");
  assert.deepEqual(readFileSync(x.path), externalBytes);
});

test("plan.validate enforces generic owner latch and legacy mutation boundary", () => {
  const blocked = fixture({ task: blockedTask() });
  const bypass = candidate(blocked.base, { next_step: "Unauthorized lifecycle change." });
  const forged = serializedProposal(blocked.bytes, blocked.base, bypass);
  assert.throws(() => blocked.adapter.validate(forged), (error) => error.code === "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN");
  assertNoState(blocked);

  const legacy = fixture({ schema: ["e", "io", "pago.task-ledger/0.1.0"].join("") });
  const legacyProposal = serializedProposal(legacy.bytes, legacy.base, candidate(legacy.base));
  assert.throws(() => legacy.adapter.validate(legacyProposal), (error) => error.code === "PLAN_LEGACY_MIGRATION_REQUIRED");
  assertNoState(legacy);
});

test("plan.validate enforces the authority size limit without creating state", () => {
  const x = fixture();
  const large = candidate(x.base);
  large.compatible_extension_payload = "x".repeat((32 * 1024 * 1024) + 1024);
  const proposal = serializedProposal(x.bytes, x.base, large);
  assert.throws(() => x.adapter.validate(proposal), (error) => error.code === "PLAN_AUTHORITY_TOO_LARGE");
  assertNoState(x);
});

test("plan.diff is deterministic and reports task and item added/removed/changed semantics", () => {
  const x = fixture();
  const changed = candidate(x.base, { risk: "HIGH", next_item: "ITEM-3" });
  changed.task_items[0].title = "Changed ITEM-1 title";
  changed.task_items.splice(1, 1);
  changed.task_items.push(item("ITEM-3", "PLANNED", { depends_on: ["ITEM-1"], last_updated_at: NEXT_TIME }));
  const proposal = x.adapter.propose(intent(changed, fixtureIdentity(x)));
  const first = x.adapter.diff(proposal);
  const second = x.adapter.diff(JSON.parse(JSON.stringify(proposal)));
  assert.deepEqual(first, second);
  assert.equal(first.schema, PLAN_DIFF_SCHEMA);
  assert.deepEqual(first.task_items.added.map((entry) => entry.task_item_id), ["ITEM-3"]);
  assert.deepEqual(first.task_items.removed.map((entry) => entry.task_item_id), ["ITEM-2"]);
  assert.deepEqual(first.task_items.changed.map((entry) => entry.task_item_id), ["ITEM-1"]);
  assert.equal(first.plan.changed.some((entry) => entry.field === "risk"), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.task_items), true);
  assertNoState(x);
});

test("observe -> propose -> validate -> diff -> apply produces exact candidate authority", () => {
  const x = fixture();
  const observation = x.adapter.observe();
  const desired = candidate(observation.plan, { title: "Applied structured candidate" });
  const proposal = x.adapter.propose(intent(desired, observationIdentity(observation)));
  assert.equal(proposal.task_id, observation.task_id);
  assert.equal(proposal.base_plan_revision_id, observation.plan_revision_id);
  assert.equal(proposal.base_content_digest, observation.content_digest);
  assert.equal(x.adapter.validate(proposal).valid, true);
  const diff = x.adapter.diff(proposal);
  assert.equal(diff.plan.changed.some((entry) => entry.field === "title"), true);
  const result = x.adapter.apply(proposal);
  assert.equal(result.plan_revision_id, desired.plan_revision_id);
  assert.deepEqual(x.adapter.observe().plan, desired);
  assert.equal(existsSync(join(x.root, ".guardian", "plan-history")), true);
  assert.equal(existsSync(join(x.root, ".guardian", "plan-proposals")), true);
});

test("two adapters keep observation bases and authority state isolated", () => {
  const left = fixture({ task: task({ task_id: "TASK-LEFT", title: "Left authority", task_items: [
    item("ITEM-1", "IN_PROGRESS", { task_id: "TASK-LEFT" }),
    item("ITEM-2", "PLANNED", { task_id: "TASK-LEFT", depends_on: ["ITEM-1"] }),
  ] }) });
  const right = fixture({ task: task({ task_id: "TASK-RIGHT", title: "Right authority", task_items: [
    item("ITEM-1", "IN_PROGRESS", { task_id: "TASK-RIGHT" }),
    item("ITEM-2", "PLANNED", { task_id: "TASK-RIGHT", depends_on: ["ITEM-1"] }),
  ] }) });
  const leftObservation = left.adapter.observe();
  const rightObservation = right.adapter.observe();
  const leftCandidate = candidate(leftObservation.plan, { title: "Applied only on left" });
  const leftProposal = left.adapter.propose(intent(leftCandidate, observationIdentity(leftObservation)));
  assert.throws(() => right.adapter.validate(leftProposal), (error) => {
    assert.equal(error.code, "PLAN_PROPOSAL_STALE");
    assert.equal(error.details.task_matches, false);
    return true;
  });
  left.adapter.apply(leftProposal);
  assert.equal(left.adapter.observe().plan.title, "Applied only on left");
  assert.deepEqual(right.adapter.observe(), rightObservation);
  assert.equal(existsSync(join(right.root, ".guardian")), false);
});

test("plan.apply supports same-runtime idempotence and restart remains ambiguous", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  const first = x.adapter.apply(proposal);
  const second = x.adapter.apply(JSON.parse(JSON.stringify(proposal)));
  assert.deepEqual(second, first);
  assert.throws(() => createPlanAdapter(x.path).apply(proposal), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
});

test("plan.apply preserves lock contention without mutating authority", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  mkdirSync(join(x.root, ".guardian"));
  writeFileSync(join(x.root, ".guardian", "plan-write.lock"), "owned externally\n");
  assert.throws(() => x.adapter.apply(proposal), (error) => error.code === "PLAN_LOCK_RECONCILIATION_REQUIRED");
  assert.deepEqual(readFileSync(x.path), x.bytes);
});

test("plan.apply cannot release or restructure a BLOCKED owner gate", () => {
  const x = fixture({ task: blockedTask() });
  const attempts = [];

  const advanceTask = candidate(x.base, { status: "IN_PROGRESS", current_item: "ITEM-1", next_item: "ITEM-2" });
  advanceTask.task_items[0].status = "IN_PROGRESS";
  attempts.push(advanceTask);

  const changeCurrent = candidate(x.base, { current_item: "ITEM-2", next_item: "ITEM-1" });
  changeCurrent.task_items[1].status = "IN_PROGRESS";
  attempts.push(changeCurrent);

  const removeGate = candidate(x.base); delete removeGate.owner_gate; attempts.push(removeGate);
  const changeStatus = candidate(x.base); changeStatus.owner_gate.status = "SATISFIED"; changeStatus.owner_gate.satisfied_at = NEXT_TIME; changeStatus.owner_gate.satisfied_by = "human:forged"; attempts.push(changeStatus);
  const changeAudit = candidate(x.base); changeAudit.owner_gate.satisfied_by = "human:forged"; attempts.push(changeAudit);
  const restructure = candidate(x.base); restructure.task_items.push(item("ITEM-3", "PLANNED")); attempts.push(restructure);

  for (let index = 0; index < attempts.length; index += 1) {
    let proposal;
    try { proposal = serializedProposal(x.bytes, x.base, attempts[index], { proposal_id: `PPR-OWNER-BYPASS-${index}` }); }
    catch (error) {
      assert.ok(["OWNER_GATE_INVALID", "LEDGER_CURRENT_ITEM_MISMATCH"].includes(error.code));
      continue;
    }
    assert.throws(
      () => x.adapter.apply(proposal),
      (error) => ["PLAN_OWNER_GATE_MUTATION_FORBIDDEN", "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN"].includes(error.code),
    );
  }
  assert.deepEqual(readFileSync(x.path), x.bytes);
});

test("plan.apply rejects legacy mutation", () => {
  const x = fixture({ schema: ["e", "io", "pago.task-ledger/0.1.0"].join("") });
  const proposal = serializedProposal(x.bytes, x.base, candidate(x.base));
  assert.throws(() => x.adapter.apply(proposal), (error) => error.code === "PLAN_LEGACY_MIGRATION_REQUIRED");
  assert.deepEqual(readFileSync(x.path), x.bytes);
});

test("proposal ID conflicts remain fail-closed through plan.apply", () => {
  const x = fixture();
  const firstProposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x), { proposal_id: "PPR-SHARED-ID" }));
  x.adapter.apply(firstProposal);
  const current = x.adapter.observe();
  const next = candidate(current.plan, {
    plan_revision_id: "PLAN-CANDIDATE-3",
    updated_at: "2026-08-21T10:10:00.000Z",
    next_step: "A different payload reuses the proposal ID.",
  });
  const conflict = x.adapter.propose(intent(next, observationIdentity(current), { proposal_id: "PPR-SHARED-ID" }));
  const before = readFileSync(x.path);
  assert.throws(() => x.adapter.apply(conflict), (error) => error.code === "PLAN_PROPOSAL_ID_CONFLICT");
  assert.deepEqual(readFileSync(x.path), before);
});

test("tampered provenance remains invalid through plan.apply", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  const result = x.adapter.apply(proposal);
  writeFileSync(join(x.root, result.provenance_reference), "{}\n");
  assert.throws(() => createPlanAdapter(x.path).apply(proposal), (error) => error.code === "PLAN_PROVENANCE_INVALID");
});

test("plan.apply does not catch or relabel security-critical GuardianError codes", () => {
  const x = fixture();
  const proposal = x.adapter.propose(intent(candidate(x.base), fixtureIdentity(x)));
  const codes = [
    "PLAN_CAS_CONFLICT",
    "PLAN_RECOVERY_AMBIGUOUS",
    "PLAN_WRITE_LOCKED",
    "PLAN_PROVENANCE_INVALID",
    "PLAN_ATTEMPT_LIMIT_REACHED",
    "OWNER_GATE_AUTHORIZATION_REQUIRED",
    "PLAN_LEGACY_MIGRATION_REQUIRED",
  ];
  for (const code of codes) {
    const sentinel = Object.assign(new Error(code), { code });
    const port = {
      proposal(payload) { return new PlanProposal(payload); },
      apply() { throw sentinel; },
    };
    const adapter = new IntentAdapter(x.path, { port });
    assert.throws(() => adapter.apply(proposal), (error) => error === sentinel);
  }
});
