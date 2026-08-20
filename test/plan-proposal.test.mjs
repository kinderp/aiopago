import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalJson, sha256, stableId } from "../src/canonical.mjs";
import { TaskLedger, validateTaskLedger } from "../src/ledger.mjs";
import { PlanRevisionWriter } from "../src/plan-store.mjs";
import {
  PLAN_APPLY_RESULT_SCHEMA,
  PLAN_DIFF_SCHEMA,
  PLAN_PROPOSAL_SCHEMA,
  PLAN_REVISION_SCHEMA,
  PlanPort,
  PlanProposal,
  diffTaskPlans,
} from "../src/plan-proposal.mjs";

const BASE_TIME = "2026-08-20T10:00:00.000Z";
const NEXT_TIME = "2026-08-20T10:05:00.000Z";
function git(cwd, args) { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }

function item(id, status, overrides = {}) {
  return {
    task_item_id: id,
    task_id: "TASK-PLAN-FOUNDATION",
    title: `Item ${id}`,
    description: `Complete ${id}`,
    status,
    depends_on: [],
    completion_criteria: [`${id} accepted`],
    evidence: status === "DONE" ? [`${id} evidence`] : [],
    requirements_refs: ["REQ-PLAN-1"],
    risk: "MEDIUM",
    milestone: "0.2-B",
    last_updated_at: BASE_TIME,
    last_updated_by: "human:test",
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    schema_version: "0.1.0",
    task_id: "TASK-PLAN-FOUNDATION",
    title: "Plan proposal fixture",
    objective: "Exercise deterministic structured plan proposals.",
    requirements_version: "REQ-PLAN-1",
    plan_revision_id: "PLAN-BASE-1",
    status: "IN_PROGRESS",
    completion_criteria: ["Foundation is deterministic"],
    risk: "MEDIUM",
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    current_item: "ITEM-1",
    next_item: "ITEM-2",
    next_step: "Complete ITEM-1.",
    evidence: [],
    model_policy: null,
    reasoning_policy: "high",
    minimal_reads: ["TASK_PLAN.md"],
    required_local_paths: [],
    task_items: [
      item("ITEM-1", "IN_PROGRESS"),
      item("ITEM-2", "PLANNED", { depends_on: ["ITEM-1"] }),
    ],
    ...overrides,
  };
}

function ledgerText(value, eol = "\n", { before = "Human prose before the normative Ledger.", after = "Human prose after the normative Ledger." } = {}) {
  return [
    "# Canonical Aiopago Task Ledger",
    "",
    "**Authority:** Markdown canonico standalone",
    "**Schema:** `aiopago.task-ledger/0.1.0`",
    `**Current revision:** \`${value.plan_revision_id}\``,
    `**Requirements version:** \`${value.requirements_version}\``,
    `**Updated:** ${value.updated_at}`,
    "",
    before,
    "",
    "```json task-ledger",
    JSON.stringify(value, null, 2),
    "```",
    "",
    after,
    "",
  ].join("\n").replaceAll("\n", eol);
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiopago-plan-proposal-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "plan@example.invalid"]);
  git(root, ["config", "user.name", "Plan Proposal Fixture"]);
  const base = options.task ?? task();
  const path = join(root, "TASK_PLAN.md");
  writeFileSync(path, ledgerText(base, options.eol, options.prose));
  return { root, path, base, bytes: readFileSync(path) };
}

function candidate(base, overrides = {}) {
  const value = structuredClone(base);
  value.plan_revision_id = "PLAN-CANDIDATE-2";
  value.updated_at = NEXT_TIME;
  value.next_step = "Continue the validated candidate plan.";
  return Object.assign(value, overrides);
}

function proposal(baseBytes, base, candidatePlan = candidate(base), overrides = {}) {
  return {
    schema: PLAN_PROPOSAL_SCHEMA,
    proposal_id: "opaque-value-with-no-required-prefix",
    task_id: base.task_id,
    base_plan_revision_id: base.plan_revision_id,
    base_content_digest: sha256(baseBytes),
    proposed_plan_revision_id: candidatePlan.plan_revision_id,
    requirements_version: candidatePlan.requirements_version,
    created_at: candidatePlan.updated_at,
    producer: "aiopago:test-structured-producer",
    change_reason: "Apply an already structured and reviewed candidate.",
    candidate_plan: candidatePlan,
    ...overrides,
  };
}

function allFiles(root) {
  const result = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child); else result.push(child);
    }
  };
  walk(root);
  return result;
}

function failureIo(stage) {
  const fdPaths = new Map();
  return {
    openSync(path, flags, mode) {
      if (stage === "temp-create" && String(path).includes(".replace.tmp")) {
        const error = new Error("injected temp create failure"); error.code = "EACCES"; throw error;
      }
      const fd = openSync(path, flags, mode);
      fdPaths.set(fd, String(path));
      return fd;
    },
    writeFileSync(fd, value, options) {
      if (stage === "write" && fdPaths.get(fd)?.includes(".replace.tmp")) throw new Error("injected write failure");
      return writeFileSync(fd, value, options);
    },
    fsyncSync(fd) {
      if (stage === "fsync" && fdPaths.get(fd)?.includes(".replace.tmp")) throw new Error("injected fsync failure");
      return fsyncSync(fd);
    },
    renameSync(from, to) {
      if (stage === "replace" && String(from).includes(".replace.tmp")) throw new Error("injected replace failure");
      return renameSync(from, to);
    },
  };
}

test("Plan Proposal apply materializes LF deterministically, preserves prose, and persists derived provenance", () => {
  const x = fixture();
  const input = proposal(x.bytes, x.base);
  const immutable = new PlanProposal(input);
  assert.equal(Object.isFrozen(immutable), true);
  assert.equal(Object.isFrozen(immutable.candidate_plan), true);
  assert.equal(Object.isFrozen(immutable.candidate_plan.task_items), true);
  assert.throws(() => { immutable.candidate_plan.next_step = "mutated"; }, TypeError);

  const port = new PlanPort(x.path, { now: () => "2026-08-20T10:06:00.000Z" });
  const preview = port.materialize(immutable, x.bytes);
  const reorderedCandidate = Object.fromEntries(Object.entries(candidate(x.base)).reverse());
  reorderedCandidate.task_items = reorderedCandidate.task_items.map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
  const reorderedPreview = port.materialize(proposal(x.bytes, x.base, reorderedCandidate), x.bytes);
  assert.deepEqual(reorderedPreview.bytes, preview.bytes, "candidate JSON must not depend on object insertion order");
  const result = port.apply(immutable);
  const bytes = readFileSync(x.path);
  const text = bytes.toString("utf8");

  assert.equal(result.schema, PLAN_APPLY_RESULT_SCHEMA);
  assert.equal(result.previous_revision_id, "PLAN-BASE-1");
  assert.equal(result.plan_revision_id, "PLAN-CANDIDATE-2");
  assert.equal(result.previous_content_digest, sha256(x.bytes));
  assert.equal(result.content_digest, sha256(bytes));
  assert.equal(result.content_digest, preview.content_digest);
  assert.equal(result.applied_at, "2026-08-20T10:06:00.000Z");
  assert.equal(result.provenance.schema, PLAN_REVISION_SCHEMA);
  assert.equal(result.provenance.authority, "DERIVED_EVIDENCE");
  assert.equal(result.provenance.previous_revision_id, "PLAN-BASE-1");
  assert.equal(result.provenance.previous_content_digest, sha256(x.bytes));
  assert.match(result.provenance.previous_snapshot_reference, /^\.guardian\/plan-history\/sha256-[a-f0-9]{64}\.md$/);
  assert.deepEqual(readFileSync(join(x.root, result.provenance.previous_snapshot_reference)), x.bytes);
  assert.equal(Object.hasOwn(result.provenance, "approved_by"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.match(text, /Human prose before the normative Ledger\./);
  assert.match(text, /Human prose after the normative Ledger\./);
  assert.match(text, /\*\*Current revision:\*\* `PLAN-CANDIDATE-2`/);
  assert.match(text, /\*\*Requirements version:\*\* `REQ-PLAN-1`/);
  assert.match(text, /\*\*Updated:\*\* 2026-08-20T10:05:00\.000Z/);
  assert.equal(text.includes("\r\n"), false);
  assert.deepEqual(new TaskLedger(x.path).read().plan_revision_id, "PLAN-CANDIDATE-2");
  assert.equal(existsSync(join(x.root, result.provenance_reference)), true);
  assert.equal(allFiles(x.root).some((path) => path.endsWith(".tmp") || path.endsWith("plan-write.lock")), false);
});

test("CRLF materialization preserves line endings and unrelated whitespace byte-for-byte", () => {
  const prose = { before: "Before  with  deliberate   spacing.", after: "After\twith\ta tab." };
  const x = fixture({ eol: "\r\n", prose });
  const changedRequirements = candidate(x.base, { requirements_version: "REQ-PLAN-2" });
  const result = new PlanPort(x.path).apply(proposal(x.bytes, x.base, changedRequirements));
  const bytes = readFileSync(x.path);
  const text = bytes.toString("utf8");
  assert.equal(result.content_digest, sha256(bytes));
  assert.equal(text.replaceAll("\r\n", "").includes("\n"), false);
  assert.match(text, /Before  with  deliberate   spacing\./);
  assert.match(text, /After\twith\ta tab\./);
  assert.match(text, /\*\*Requirements version:\*\* `REQ-PLAN-2`/);
  assert.equal(new TaskLedger(x.path).read().requirements_version, "REQ-PLAN-2");
  const prefixBefore = x.bytes.toString("utf8").split("```json task-ledger")[0].replace("PLAN-BASE-1", "PLAN-CANDIDATE-2").replace("REQ-PLAN-1", "REQ-PLAN-2").replace(BASE_TIME, NEXT_TIME);
  assert.equal(text.startsWith(prefixBefore), true);
});

test("proposal validation reuses canonical Ledger validation and rejects malformed foundations before writing", async (t) => {
  const cases = [
    ["invalid task_id", (x) => proposal(x.bytes, x.base, candidate(x.base), { task_id: "TASK-OTHER" }), "PLAN_TASK_ID_MISMATCH"],
    ["same revision candidate", (x) => { const c = candidate(x.base, { plan_revision_id: x.base.plan_revision_id }); return proposal(x.bytes, x.base, c, { proposed_plan_revision_id: x.base.plan_revision_id }); }, "PLAN_REVISION_REUSE"],
    ["missing required field", (x) => { const c = candidate(x.base); delete c.next_step; return proposal(x.bytes, x.base, c); }, "LEDGER_FIELD_MISSING"],
    ["DAG cycle", (x) => { const c = candidate(x.base); c.task_items[0].depends_on = ["ITEM-2"]; return proposal(x.bytes, x.base, c); }, "LEDGER_DAG_CYCLE"],
    ["DONE without evidence", (x) => { const c = candidate(x.base); c.task_items[0].status = "DONE"; return proposal(x.bytes, x.base, c); }, "DONE_WITHOUT_EVIDENCE"],
    ["current item mismatch", (x) => { const c = candidate(x.base); c.current_item = "ITEM-2"; c.next_item = null; return proposal(x.bytes, x.base, c); }, "LEDGER_CURRENT_ITEM_MISMATCH"],
  ];
  for (const [name, make, code] of cases) await t.test(name, () => {
    const x = fixture();
    const before = readFileSync(x.path);
    assert.throws(() => new PlanProposal(make(x)), (error) => error.code === code);
    assert.deepEqual(readFileSync(x.path), before);
    assert.equal(existsSync(join(x.root, ".guardian")), false);
  });
});

test("CAS rejects revision-only, digest-only, and current byte changes without a plan write", async (t) => {
  const mutations = [
    ["revision mismatch", (input) => { input.base_plan_revision_id = "PLAN-WRONG"; }],
    ["digest mismatch", (input) => { input.base_content_digest = `sha256:${"0".repeat(64)}`; }],
    ["both mismatch", (input) => { input.base_plan_revision_id = "PLAN-WRONG"; input.base_content_digest = `sha256:${"1".repeat(64)}`; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); mutate(input);
    const before = readFileSync(x.path);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_CAS_CONFLICT");
    assert.deepEqual(readFileSync(x.path), before);
  });

  await t.test("current bytes changed while revision is unchanged", () => {
    const x = fixture();
    const input = proposal(x.bytes, x.base);
    const human = Buffer.from(x.bytes.toString("utf8").replace("Human prose after", "Human edited after"));
    writeFileSync(x.path, human);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_CAS_CONFLICT" && error.details.revision_matches === true && error.details.digest_matches === false);
    assert.deepEqual(readFileSync(x.path), human);
  });

  await t.test("current revision and bytes changed but plan remains otherwise equivalent", () => {
    const x = fixture();
    const input = proposal(x.bytes, x.base);
    const humanTask = structuredClone(x.base);
    humanTask.plan_revision_id = "PLAN-HUMAN-2";
    humanTask.updated_at = "2026-08-20T10:02:00.000Z";
    const human = Buffer.from(ledgerText(humanTask));
    writeFileSync(x.path, human);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_CAS_CONFLICT" && error.details.revision_matches === false && error.details.digest_matches === false);
    assert.deepEqual(readFileSync(x.path), human);
  });

  await t.test("external mutation between preparation and final attestation", () => {
    const x = fixture();
    const human = Buffer.from(x.bytes.toString("utf8").replace("Human prose after", "Human independently edited after"));
    const port = new PlanPort(x.path, { writerOptions: { testHooks: { afterPreparation: () => writeFileSync(x.path, human) } } });
    assert.throws(() => port.apply(proposal(x.bytes, x.base)), (error) => error.code === "PLAN_CAS_CONFLICT");
    assert.deepEqual(readFileSync(x.path), human, "Aiopago must not overwrite the concurrent human mutation");
  });
});

test("proposal identity is durable, idempotent for the same payload, and conflicts for different payload", () => {
  const x = fixture();
  const input = proposal(x.bytes, x.base);
  const first = new PlanPort(x.path, { now: () => "2026-08-20T10:06:00.000Z" }).apply(input);
  const bytes = readFileSync(x.path);
  const second = new PlanPort(x.path, { now: () => "2099-01-01T00:00:00.000Z" }).apply(structuredClone(input));
  assert.deepEqual(second, first);
  assert.deepEqual(readFileSync(x.path), bytes);
  const conflicting = structuredClone(input);
  conflicting.change_reason = "Different content under the same opaque identity.";
  assert.throws(() => new PlanPort(x.path).apply(conflicting), (error) => error.code === "PLAN_PROPOSAL_ID_CONFLICT");
  assert.deepEqual(readFileSync(x.path), bytes);
});

test("two cooperative Aiopago writers from one base serialize and only one commits", () => {
  const x = fixture();
  const firstInput = proposal(x.bytes, x.base);
  const secondCandidate = candidate(x.base, { plan_revision_id: "PLAN-OTHER-2", next_step: "Other candidate." });
  const secondInput = proposal(x.bytes, x.base, secondCandidate, { proposal_id: "another-opaque-id", proposed_plan_revision_id: "PLAN-OTHER-2" });
  let concurrentError;
  const second = new PlanPort(x.path);
  const first = new PlanPort(x.path, {
    writerOptions: { testHooks: { afterPreparation: () => {
      try { second.apply(secondInput); } catch (error) { concurrentError = error; }
    } } },
  });
  const result = first.apply(firstInput);
  assert.equal(result.plan_revision_id, "PLAN-CANDIDATE-2");
  assert.equal(concurrentError.code, "PLAN_WRITE_LOCKED");
  assert.throws(() => second.apply(secondInput), (error) => error.code === "PLAN_CAS_CONFLICT");
  assert.equal(new TaskLedger(x.path).read().plan_revision_id, "PLAN-CANDIDATE-2");
});

test("diff is machine-readable, stable, and separates plan and task-item changes", () => {
  const base = task({
    status: "PLANNED", current_item: null, next_item: "ITEM-2", obsolete_plan_field: "remove me",
    task_items: [item("ITEM-1", "DONE"), item("ITEM-2", "PLANNED", { depends_on: ["ITEM-1"] })],
  });
  const after = candidate(base, {
    status: "IN_PROGRESS", current_item: "ITEM-2", next_item: "ITEM-3",
    task_items: [
      item("ITEM-3", "PLANNED", { depends_on: ["ITEM-2"] }),
      item("ITEM-2", "IN_PROGRESS", { depends_on: [], last_updated_at: NEXT_TIME, last_updated_by: "aiopago:test" }),
    ],
  });
  delete after.obsolete_plan_field;
  after.added_plan_field = "new value";
  const diff = diffTaskPlans(base, after);
  const reordered = Object.fromEntries(Object.entries(structuredClone(after)).reverse());
  reordered.task_items = [...reordered.task_items].reverse().map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
  assert.equal(diff.schema, PLAN_DIFF_SCHEMA);
  assert.deepEqual(diff.task_items.added.map((entry) => entry.task_item_id), ["ITEM-3"]);
  assert.deepEqual(diff.task_items.removed.map((entry) => entry.task_item_id), ["ITEM-1"]);
  assert.deepEqual(diff.task_items.changed.map((entry) => entry.task_item_id), ["ITEM-2"]);
  const changedFields = diff.task_items.changed[0].fields.changed.map((entry) => entry.field);
  assert.equal(changedFields.includes("depends_on"), true);
  assert.equal(changedFields.includes("status"), true);
  assert.deepEqual(diff.plan.added.map((entry) => entry.field), ["added_plan_field"]);
  assert.deepEqual(diff.plan.removed.map((entry) => entry.field), ["obsolete_plan_field"]);
  assert.equal(diff.plan.changed.some((entry) => entry.field === "current_item"), true);
  assert.equal(diff.plan.changed.some((entry) => entry.field === "next_item"), true);
  assert.deepEqual(diffTaskPlans(base, reordered), diff);
  assert.equal(JSON.stringify(diffTaskPlans(base, reordered)), JSON.stringify(diff));
  assert.deepEqual(diff.plan.changed.map((entry) => entry.field), [...diff.plan.changed.map((entry) => entry.field)].sort());
});

test("owner-gate mutation keeps authorization/lifecycle semantics and shares atomic replacement", () => {
  const blocked = task({
    status: "BLOCKED",
    current_item: null,
    next_item: "ITEM-1",
    next_step: "Owner gate: execute /aio handoff confirm",
    owner_gate: {
      kind: "HANDOFF_CONFIRM",
      status: "BLOCKED",
      command: "/aio handoff confirm",
      item_id: "ITEM-1",
      satisfied_plan_revision_id: "PLAN-GATE-2",
      satisfied_task_status: "IN_PROGRESS",
      satisfied_next_item: "ITEM-2",
      satisfied_next_step: "Continue ITEM-1, then ITEM-2.",
    },
  });
  blocked.task_items[0].status = "BLOCKED";
  const x = fixture({ task: blocked });
  assert.throws(() => new TaskLedger(x.path).satisfyOwnerGate({ command: "/aio handoff confirm", actor: "agent:test" }), (error) => error.code === "OWNER_GATE_AUTHORIZATION_REQUIRED");
  assert.deepEqual(readFileSync(x.path), x.bytes);
  assert.throws(
    () => new TaskLedger(x.path, { writerOptions: { io: failureIo("replace") } }).satisfyOwnerGate({ command: "/aio handoff confirm", actor: "human:test" }),
    /injected replace failure/,
  );
  assert.deepEqual(readFileSync(x.path), x.bytes);
  const ledger = new TaskLedger(x.path);
  const applied = ledger.satisfyOwnerGate({ command: "/aio handoff confirm", actor: "human:test" });
  assert.equal(applied.owner_gate.status, "SATISFIED");
  assert.equal(applied.owner_gate.satisfied_by, "human:test");
  assert.equal(applied.plan_revision_id, "PLAN-GATE-2");
  assert.equal(applied.status, "IN_PROGRESS");
  assert.equal(applied.current_item, "ITEM-1");
  assert.equal(applied.next_item, "ITEM-2");
  assert.equal(applied.task_items[0].status, "IN_PROGRESS");
  assert.equal(applied.next_step, "Continue ITEM-1, then ITEM-2.");
  const committed = readFileSync(x.path);
  assert.deepEqual(ledger.satisfyOwnerGate({ command: "/aio handoff confirm", actor: "human:test" }).content_digest, sha256(committed));
  assert.deepEqual(readFileSync(x.path), committed);
});

test("legacy Ledger remains readable but proposal mutation requires explicit migration", () => {
  const x = fixture();
  const legacy = Buffer.from(x.bytes.toString("utf8").replace("aiopago.task-ledger/0.1.0", "eiopago.task-ledger/0.1.0"));
  writeFileSync(x.path, legacy);
  assert.equal(new TaskLedger(x.path).read().plan_revision_id, x.base.plan_revision_id);
  const input = proposal(legacy, x.base);
  assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_LEGACY_MIGRATION_REQUIRED");
  assert.deepEqual(readFileSync(x.path), legacy);
});

test("a stale or corrupt cooperative lock fails clearly without waiting or writing", () => {
  const x = fixture();
  mkdirSync(join(x.root, ".guardian"));
  writeFileSync(join(x.root, ".guardian", "plan-write.lock"), "corrupt stale lock\n");
  assert.throws(() => new PlanPort(x.path).apply(proposal(x.bytes, x.base)), (error) => error.code === "PLAN_WRITE_LOCKED" && error.message.includes("explicit human inspection"));
  assert.deepEqual(readFileSync(x.path), x.bytes);
});

test("pre-commit filesystem failures preserve authoritative bytes and clean temporary files", async (t) => {
  for (const stage of ["temp-create", "write", "fsync", "replace"]) await t.test(stage, () => {
    const x = fixture();
    const before = readFileSync(x.path);
    const port = new PlanPort(x.path, { writerOptions: { io: failureIo(stage) } });
    assert.throws(() => port.apply(proposal(x.bytes, x.base)));
    assert.deepEqual(readFileSync(x.path), before);
    assert.equal(allFiles(x.root).some((path) => path.endsWith(".tmp") || path.endsWith("plan-write.lock")), false);
  });
});

test("interruption after plan replacement recovers the immutable apply result without a second revision", () => {
  const x = fixture();
  const input = proposal(x.bytes, x.base);
  const io = {
    linkSync(from, to) {
      if (String(to).endsWith("applied.json")) throw new Error("injected post-commit provenance interruption");
      return linkSync(from, to);
    },
  };
  assert.throws(
    () => new PlanPort(x.path, { writerOptions: { io }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input),
    (error) => error.code === "PLAN_APPLY_COMMITTED_PROVENANCE_PENDING",
  );
  const committed = readFileSync(x.path);
  assert.equal(new TaskLedger(x.path).read().plan_revision_id, "PLAN-CANDIDATE-2");
  const recovered = new PlanPort(x.path, { now: () => "2099-01-01T00:00:00.000Z" }).apply(input);
  assert.equal(recovered.applied_at, null);
  assert.equal(recovered.recovered_at, "2099-01-01T00:00:00.000Z");
  assert.equal(recovered.plan_revision_id, "PLAN-CANDIDATE-2");
  assert.deepEqual(readFileSync(x.path), committed);
});

function proposalRecordRoot(x, input) {
  return join(x.root, ".guardian", "plan-proposals", stableId("proposal", input.proposal_id));
}

function exactJsonWrite(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

test("strict JSON domain rejects non-JSON and mutable host values at any depth", async (t) => {
  const cases = [
    ["Uint8Array", () => new Uint8Array([1])],
    ["NaN", () => Number.NaN], ["positive Infinity", () => Number.POSITIVE_INFINITY], ["negative Infinity", () => Number.NEGATIVE_INFINITY],
    ["undefined", () => undefined], ["BigInt", () => 1n], ["Symbol", () => Symbol("x")], ["Function", () => () => null],
    ["Date", () => new Date(BASE_TIME)], ["Map", () => new Map([["x", 1]])], ["Set", () => new Set([1])], ["RegExp", () => /x/],
    ["ArrayBuffer", () => new ArrayBuffer(2)], ["DataView", () => new DataView(new ArrayBuffer(2))], ["custom prototype", () => Object.create({ inherited: true })],
  ];
  for (const [name, make] of cases) await t.test(name, () => {
    const x = fixture(); const c = candidate(x.base); c.extension = make();
    assert.throws(() => new PlanProposal(proposal(x.bytes, x.base, c)), (error) => error.code === "PLAN_PROPOSAL_JSON_DOMAIN_INVALID");
  });
  await t.test("getter and setter properties", () => {
    const x = fixture(); const c = candidate(x.base); let called = false;
    Object.defineProperty(c, "extension", { enumerable: true, get() { called = true; return "hidden"; } });
    assert.throws(() => new PlanProposal(proposal(x.bytes, x.base, c)), (error) => error.code === "PLAN_PROPOSAL_JSON_DOMAIN_INVALID");
    assert.equal(called, false);
  });
  await t.test("symbol-keyed and nested variants", () => {
    const x = fixture(); const c = candidate(x.base);
    c.extension = { nested: [{ valid: true }, { invalid: new Uint8Array([1]) }] }; c[Symbol("hidden")] = "value";
    assert.throws(() => new PlanProposal(proposal(x.bytes, x.base, c)), (error) => error.code === "PLAN_PROPOSAL_JSON_DOMAIN_INVALID");
  });
});

test("one canonical JSON payload is immutable, normalizes -0, and survives caller mutation", () => {
  const x = fixture(); const c = candidate(x.base);
  c.extension = { nested: [{ enabled: true, count: -0, nullable: null }], labels: ["ordinary", "json"] };
  const input = proposal(x.bytes, x.base, c); const immutable = new PlanProposal(input); const digest = immutable.proposal_digest;
  c.extension.nested[0].enabled = false; c.extension.nested[0].count = 99; c.task_items[0].title = "caller mutation"; input.change_reason = "caller mutation";
  assert.equal(immutable.candidate_plan.extension.nested[0].enabled, true);
  assert.equal(Object.is(immutable.candidate_plan.extension.nested[0].count, -0), false);
  assert.equal(immutable.candidate_plan.extension.nested[0].count, 0);
  assert.equal(immutable.candidate_plan.task_items[0].title, "Item ITEM-1");
  assert.equal(immutable.proposal_digest, digest);
  assert.throws(() => { immutable.candidate_plan.extension.nested[0].enabled = false; }, TypeError);
  const preview = new PlanPort(x.path).materialize(immutable, x.bytes);
  assert.equal(preview.candidate_plan.extension.nested[0].enabled, true);
  assert.equal(JSON.parse(/```json task-ledger\n([\s\S]*?)\n```/.exec(preview.bytes.toString("utf8"))[1]).extension.nested[0].count, 0);
});

test("Ledger validator enforces every required Task and TaskItem field", async (t) => {
  const taskFields = ["schema_version", "task_id", "title", "objective", "requirements_version", "plan_revision_id", "status", "completion_criteria", "risk", "created_at", "updated_at", "current_item", "next_item", "next_step", "task_items"];
  for (const field of taskFields) await t.test(`Task.${field}`, () => { const value = task(); delete value[field]; assert.throws(() => validateTaskLedger(value), (error) => error.code === "LEDGER_FIELD_MISSING"); });
  const itemFields = ["task_item_id", "task_id", "title", "description", "status", "depends_on", "completion_criteria", "evidence", "requirements_refs", "risk", "milestone", "last_updated_at", "last_updated_by"];
  for (const field of itemFields) await t.test(`TaskItem.${field}`, () => { const value = task(); delete value.task_items[0][field]; assert.throws(() => validateTaskLedger(value), (error) => error.code === "LEDGER_FIELD_MISSING"); });
});

test("Ledger validator rejects empty IDs, bad timestamps, and significant wrong types", async (t) => {
  const cases = [
    ["empty task_id", (v) => { v.task_id = ""; }], ["empty task_item_id", (v) => { v.task_items[0].task_item_id = ""; }],
    ["numeric title", (v) => { v.title = 1; }], ["empty objective", (v) => { v.objective = ""; }], ["empty task criteria", (v) => { v.completion_criteria = []; }],
    ["non-string risk", (v) => { v.risk = { level: "HIGH" }; }], ["offset timestamp", (v) => { v.updated_at = "2026-08-20T12:00:00+02:00"; }],
    ["impossible timestamp", (v) => { v.created_at = "2026-02-30T10:00:00.000Z"; }], ["task_items wrong type", (v) => { v.task_items = {}; }],
    ["depends_on wrong type", (v) => { v.task_items[0].depends_on = "ITEM-2"; }], ["completion criteria element type", (v) => { v.task_items[0].completion_criteria = [1]; }],
    ["evidence element type", (v) => { v.task_items[0].evidence = [false]; }], ["requirements refs type", (v) => { v.task_items[0].requirements_refs = null; }],
    ["empty last_updated_by", (v) => { v.task_items[0].last_updated_by = ""; }], ["duplicate dependency", (v) => { v.task_items[1].depends_on = ["ITEM-1", "ITEM-1"]; }],
    ["optional ID wrong type", (v) => { v.task_items[0].last_session_id = 7; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = task(); mutate(value); assert.throws(() => validateTaskLedger(value)); });
  await t.test("unknown fields remain forward-compatible only inside strict JSON", () => {
    const value = task(); value.compatible_extension = { enabled: true, values: [null, 1, "x"] };
    assert.doesNotThrow(() => validateTaskLedger(value)); value.compatible_extension.values.push(Number.NaN);
    assert.throws(() => validateTaskLedger(value), (error) => error.code === "LEDGER_JSON_DOMAIN_INVALID");
  });
});

test("candidate preparation is complete before final CAS and concurrent edits are detected", async (t) => {
  await t.test("edit after all preparation and before final observation", () => {
    const x = fixture(); const human = Buffer.from(x.bytes.toString("utf8").replace("Human prose before", "Human edit before"));
    const port = new PlanPort(x.path, { writerOptions: { testHooks: { afterPreparation: () => writeFileSync(x.path, human) } } });
    assert.throws(() => port.apply(proposal(x.bytes, x.base)), (error) => error.code === "PLAN_CAS_CONFLICT"); assert.deepEqual(readFileSync(x.path), human);
  });
  await t.test("edit while candidate temp is being fsynced", () => {
    const x = fixture(); const human = Buffer.from(x.bytes.toString("utf8").replace("Human prose after", "Human edit during preparation"));
    const fdPaths = new Map(); let edited = false;
    const io = {
      openSync(path, flags, mode) { const fd = openSync(path, flags, mode); fdPaths.set(fd, String(path)); return fd; },
      fsyncSync(fd) { const result = fsyncSync(fd); if (!edited && fdPaths.get(fd)?.includes(".replace.tmp")) { edited = true; writeFileSync(x.path, human); } return result; },
      closeSync(fd) { fdPaths.delete(fd); return closeSync(fd); },
    };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io } }).apply(proposal(x.bytes, x.base)), (error) => error.code === "PLAN_CAS_CONFLICT");
    assert.equal(edited, true); assert.deepEqual(readFileSync(x.path), human);
  });
  await t.test("no candidate or provenance preparation occurs after final authority read", () => {
    const x = fixture(); const events = []; const fdPaths = new Map(); let planReads = 0;
    const io = {
      openSync(path, flags, mode) { events.push(["open", String(path)]); const fd = openSync(path, flags, mode); fdPaths.set(fd, String(path)); return fd; },
      closeSync(fd) { const result = closeSync(fd); fdPaths.delete(fd); return result; },
      readFileSync(target, ...args) { const path = typeof target === "number" ? fdPaths.get(target) : String(target); if (path === x.path) { planReads += 1; if (planReads === 2) events.push(["FINAL_AUTHORITY_READ", path]); } events.push(["read", path]); return readFileSync(target, ...args); },
      writeFileSync(target, value, options) { events.push(["write", fdPaths.get(target) ?? String(target)]); return writeFileSync(target, value, options); },
      fsyncSync(fd) { events.push(["fsync", fdPaths.get(fd)]); return fsyncSync(fd); },
      fchmodSync(fd, mode) { events.push(["fchmod", fdPaths.get(fd)]); return fchmodSync(fd, mode); },
      linkSync(from, to) { events.push(["link", String(to)]); return linkSync(from, to); },
      renameSync(from, to) { events.push(["rename", String(from), String(to)]); return renameSync(from, to); },
    };
    new PlanPort(x.path, { writerOptions: { io } }).apply(proposal(x.bytes, x.base));
    const finalIndex = events.findIndex(([name]) => name === "FINAL_AUTHORITY_READ"); const renameIndex = events.findIndex(([name], index) => index > finalIndex && name === "rename");
    assert.ok(finalIndex >= 0 && renameIndex > finalIndex); const gap = events.slice(finalIndex + 1, renameIndex);
    assert.equal(gap.some(([name, path]) => ["write", "fsync", "fchmod", "link"].includes(name) || String(path).includes(".replace.tmp") || String(path).includes("plan-proposals") || String(path).includes("plan-history")), false, JSON.stringify(gap));
    assert.equal(gap.filter(([name]) => name === "open").every(([, path]) => path.endsWith("plan-write.lock")), true, JSON.stringify(gap));
  });
});

test("recovery requires deterministic candidate evidence and a matching filesystem commit witness", async (t) => {
  await t.test("external exact candidate bytes after a failed attempt are ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const preview = new PlanPort(x.path).materialize(input, x.bytes);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input));
    writeFileSync(x.path, preview.bytes);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS"); assert.deepEqual(readFileSync(x.path), preview.bytes);
  });
  await t.test("tampered applied result cannot simulate authority", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const result = new PlanPort(x.path).apply(input); const appliedPath = join(x.root, result.provenance_reference);
    const stored = JSON.parse(readFileSync(appliedPath, "utf8")); stored.content_digest = `sha256:${"0".repeat(64)}`; exactJsonWrite(appliedPath, stored);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_PROVENANCE_INVALID");
  });
  await t.test("precreated legacy prepared/applied records with wrong candidate are rejected", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const root = proposalRecordRoot(x, input); mkdirSync(root, { recursive: true });
    exactJsonWrite(join(root, "prepared.json"), { proposal_id: input.proposal_id, proposal_digest: "wrong", candidate_content_digest: `sha256:${"1".repeat(64)}` });
    exactJsonWrite(join(root, "applied.json"), { proposal_id: input.proposal_id, candidate_content_digest: `sha256:${"1".repeat(64)}` });
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_PROVENANCE_INVALID"); assert.deepEqual(readFileSync(x.path), x.bytes);
  });
});

test("applied timestamps distinguish preparation, commit, and crash recovery truthfully", async (t) => {
  await t.test("failed preparation T1 then successful retry T2", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input));
    const result = new PlanPort(x.path, { now: () => "2026-08-20T11:00:00.000Z" }).apply(input);
    assert.equal(result.prepared_at, "2026-08-20T11:00:00.000Z"); assert.equal(result.applied_at, "2026-08-20T11:00:00.000Z"); assert.equal(result.recovered_at, null);
  });
  await t.test("rename witnessed but result missing never invents applied_at", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    const io = { linkSync(from, to) { if (String(to).endsWith("applied.json")) throw new Error("stop after commit"); return linkSync(from, to); } };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input), (error) => error.code === "PLAN_APPLY_COMMITTED_PROVENANCE_PENDING");
    const recovered = new PlanPort(x.path, { now: () => "2026-08-20T12:00:00.000Z" }).apply(input);
    assert.equal(recovered.prepared_at, "2026-08-20T10:06:00.000Z"); assert.equal(recovered.applied_at, null); assert.equal(recovered.recovered_at, "2026-08-20T12:00:00.000Z");
  });
});

test("exact previous Markdown bytes remain content-addressed and recoverable across revisions", () => {
  const x = fixture({ eol: "\r\n", prose: { before: "Arbitrary prose α with  spaces.", after: "Tail prose\tkept." } }); const baseOne = Buffer.from(x.bytes); const port = new PlanPort(x.path);
  const first = port.apply(proposal(baseOne, x.base)); assert.deepEqual(readFileSync(join(x.root, first.provenance.previous_snapshot_reference)), baseOne);
  const baseTwo = readFileSync(x.path); const observedTwo = port.observe().plan;
  const candidateThree = candidate(observedTwo, { plan_revision_id: "PLAN-CANDIDATE-3", updated_at: "2026-08-20T10:10:00.000Z", next_step: "Third revision." });
  const second = port.apply(proposal(baseTwo, observedTwo, candidateThree, { proposal_id: "sequential-proposal", proposed_plan_revision_id: "PLAN-CANDIDATE-3", created_at: candidateThree.updated_at }));
  assert.deepEqual(readFileSync(join(x.root, second.provenance.previous_snapshot_reference)), baseTwo); assert.deepEqual(readFileSync(join(x.root, first.provenance.previous_snapshot_reference)), baseOne);
});

test("relevant history corruption fails closed before replacement", () => {
  const x = fixture(); const input = proposal(x.bytes, x.base); const history = join(x.root, ".guardian", "plan-history", `sha256-${sha256(x.bytes).slice("sha256:".length)}.md`);
  mkdirSync(dirname(history), { recursive: true }); writeFileSync(history, "corrupt history bytes\n");
  assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_HISTORY_CORRUPT"); assert.deepEqual(readFileSync(x.path), x.bytes);
});

test("lock ownership loss prevents commit and never removes a replacement writer lock", async (t) => {
  for (const [name, replace] of [
    ["lock inode/path replaced", (path) => { unlinkSync(path); writeFileSync(path, "writer-B-lock\n"); }],
    ["lock content/token replaced", (path) => writeFileSync(path, "writer-B-token\n")],
  ]) await t.test(name, () => {
    const x = fixture(); const lockPath = join(x.root, ".guardian", "plan-write.lock");
    const port = new PlanPort(x.path, { writerOptions: { testHooks: { afterPreparation: () => replace(lockPath) } } });
    assert.throws(() => port.apply(proposal(x.bytes, x.base)), (error) => error.code === "PLAN_LOCK_OWNERSHIP_LOST"); assert.deepEqual(readFileSync(x.path), x.bytes);
    assert.equal(readFileSync(lockPath, "utf8"), name.startsWith("lock inode") ? "writer-B-lock\n" : "writer-B-token\n");
  });
});

test("PlanRevisionWriter exposes no public raw atomic replacement bypass", () => {
  const methods = Object.getOwnPropertyNames(PlanRevisionWriter.prototype); assert.equal(methods.includes("atomicReplace"), false); assert.equal(methods.some((name) => /replace/i.test(name)), false); assert.equal(methods.includes("commit"), true);
  const x = fixture(); const writer = new PlanRevisionWriter(x.path);
  assert.throws(() => writer.commit({ prepare: () => ({ bytes: Buffer.from("raw bypass") }) }), (error) => error.code === "PLAN_VALIDATOR_REQUIRED");
});

test("POSIX authority mode is preserved by the prepared-temp rename", { skip: process.platform === "win32" }, () => {
  const x = fixture(); chmodSync(x.path, 0o640); new PlanPort(x.path).apply(proposal(readFileSync(x.path), x.base)); assert.equal(statSync(x.path).mode & 0o777, 0o640);
});

test("owner-gate uses the same owned CAS writer and preserves exact history", () => {
  const blocked = task({ status: "BLOCKED", current_item: null, next_item: "ITEM-1", next_step: "Owner gate: execute /aio handoff confirm", owner_gate: { kind: "HANDOFF_CONFIRM", status: "BLOCKED", command: "/aio handoff confirm", item_id: "ITEM-1", satisfied_plan_revision_id: "PLAN-GATE-HISTORY", satisfied_task_status: "IN_PROGRESS", satisfied_next_item: "ITEM-2", satisfied_next_step: "Continue ITEM-1, then ITEM-2." } });
  blocked.task_items[0].status = "BLOCKED"; const x = fixture({ task: blocked }); const old = Buffer.from(x.bytes);
  new TaskLedger(x.path).satisfyOwnerGate({ command: "/aio handoff confirm", actor: "human:test" });
  const history = join(x.root, ".guardian", "plan-history", `sha256-${sha256(old).slice("sha256:".length)}.md`); assert.deepEqual(readFileSync(history), old);
});

test("provenance symlinks and unexpected hardlinks are rejected", async (t) => {
  await t.test("record directory symlink", (context) => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const root = proposalRecordRoot(x, input); const outside = mkdtempSync(join(tmpdir(), "aiopago-provenance-outside-")); mkdirSync(dirname(root), { recursive: true });
    try { symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir"); } catch (error) { if (error.code === "EPERM") { context.skip("symlink privilege unavailable"); return; } throw error; }
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_STATE_PATH_REDIRECTED" || error.code === "PLAN_PROVENANCE_INVALID"); assert.deepEqual(readFileSync(x.path), x.bytes);
  });
  await t.test("proposal registration hardlink", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") } }).apply(input));
    const registration = join(proposalRecordRoot(x, input), "proposal.json"); linkSync(registration, join(x.root, "unexpected-registration-hardlink.json"));
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_PROVENANCE_INVALID"); assert.deepEqual(readFileSync(x.path), x.bytes);
  });
});

test("recovery state matrix keeps pre-commit states retryable and unrelated authority conflicting", async (t) => {
  await t.test("A/C: proposal registration and base history exist, no intent, base unchanged", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    const io = {
      linkSync(from, to) {
        if (dirname(String(to)).endsWith("attempts")) throw new Error("interrupt before commit intent publication");
        return linkSync(from, to);
      },
    };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input));
    assert.deepEqual(readFileSync(x.path), x.bytes);
    assert.equal(existsSync(join(proposalRecordRoot(x, input), "proposal.json")), true);
    const history = join(x.root, ".guardian", "plan-history", `sha256-${sha256(x.bytes).slice("sha256:".length)}.md`);
    assert.deepEqual(readFileSync(history), x.bytes);
    assert.equal(new PlanPort(x.path, { now: () => "2026-08-20T11:00:00.000Z" }).apply(input).plan_revision_id, "PLAN-CANDIDATE-2");
  });
  await t.test("B/D: prepared candidate and durable intent without rename do not report applied", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") } }).apply(input));
    assert.deepEqual(readFileSync(x.path), x.bytes);
    assert.equal(existsSync(join(proposalRecordRoot(x, input), "applied.json")), false);
    assert.equal(new PlanPort(x.path).apply(input).plan_revision_id, "PLAN-CANDIDATE-2");
  });
  await t.test("G: unrelated newer authority is a recovery conflict", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") } }).apply(input));
    const humanTask = structuredClone(x.base); humanTask.plan_revision_id = "PLAN-HUMAN-NEWER"; humanTask.updated_at = "2026-08-20T10:03:00.000Z";
    const human = Buffer.from(ledgerText(humanTask)); writeFileSync(x.path, human);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_PROPOSAL_RECOVERY_CONFLICT");
    assert.deepEqual(readFileSync(x.path), human);
  });
});
