import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { initializeRepository } from "../src/bootstrap.mjs";
import { canonicalJson, sha256, stableId } from "../src/canonical.mjs";
import { TaskLedger, validateTaskLedger } from "../src/ledger.mjs";
import { MAX_PLAN_BYTES, PlanRevisionWriter } from "../src/plan-store.mjs";
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

test("compact origin/main bootstrap Ledger is directly mutable and metadata layouts fail closed", async (t) => {
  await t.test("real bootstrap compact template applies without prose migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "aiopago-bootstrap-plan-")); git(root, ["init"]);
    await initializeRepository(root, { piInspector: async () => ({ root: "/fake/pi", version: "0.83.0", name: "pi" }), now: BASE_TIME });
    const path = join(root, "TASK_PLAN.md"); const before = readFileSync(path); const port = new PlanPort(path); const observed = port.observe();
    const c = candidate(observed.plan); const input = proposal(before, observed.plan, c); const preview = port.materialize(input, before);
    const outside = (bytes) => bytes.toString("utf8").replace(/```json task-ledger\r?\n[\s\S]*?\r?\n```/, "```json task-ledger\n<JSON>\n```");
    assert.equal(outside(preview.bytes), outside(before));
    const result = port.apply(input); assert.equal(result.plan_revision_id, "PLAN-CANDIDATE-2");
    const text = readFileSync(path, "utf8"); assert.equal(text.includes("**Current revision:**"), false); assert.match(text, /## Ledger lifecycle contract/);
  });
  for (const [name, mutate] of [
    ["one of three", (text) => text.replace(`**Requirements version:** \`REQ-PLAN-1\`\n`, "").replace(`**Updated:** ${BASE_TIME}\n`, "")],
    ["two of three", (text) => text.replace(`**Updated:** ${BASE_TIME}\n`, "")],
    ["duplicate", (text) => text.replace(`**Updated:** ${BASE_TIME}`, `**Updated:** ${BASE_TIME}\n**Updated:** ${BASE_TIME}`)],
    ["mismatch", (text) => text.replace("**Requirements version:** `REQ-PLAN-1`", "**Requirements version:** `REQ-WRONG`")],
  ]) await t.test(`${name} metadata rejects`, () => {
    const x = fixture(); const bytes = Buffer.from(mutate(x.bytes.toString("utf8"))); writeFileSync(x.path, bytes);
    assert.throws(() => new PlanPort(x.path).apply(proposal(bytes, x.base)), (error) => error.code === "PLAN_METADATA_MISMATCH");
    assert.deepEqual(readFileSync(x.path), bytes);
  });
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

test("proposal identity uses a volatile same-PlanPort receipt and restart remains ambiguous", () => {
  const x = fixture();
  const input = proposal(x.bytes, x.base);
  const port = new PlanPort(x.path, { now: () => "2026-08-20T10:06:00.000Z" });
  const first = port.apply(input);
  const bytes = readFileSync(x.path);
  const second = port.apply(structuredClone(input));
  assert.deepEqual(second, first);
  assert.deepEqual(readFileSync(x.path), bytes);
  assert.throws(() => new PlanPort(x.path).apply(structuredClone(input)), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
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

test("generic PlanProposal cannot delete, introduce, or mutate owner_gate authority", async (t) => {
  const gated = task({
    status: "BLOCKED", current_item: null, next_item: "ITEM-1", next_step: "Owner gate: execute /aio handoff confirm",
    owner_gate: { kind: "HANDOFF_CONFIRM", status: "BLOCKED", command: "/aio handoff confirm", item_id: "ITEM-1", satisfied_plan_revision_id: "PLAN-GATE-2", satisfied_task_status: "IN_PROGRESS", satisfied_next_item: "ITEM-2", satisfied_next_step: "Continue ITEM-1." },
  });
  gated.task_items[0].status = "BLOCKED";
  const cases = [
    ["delete gate", (c) => { delete c.owner_gate; }],
    ["forge SATISFIED", (c) => { c.owner_gate.status = "SATISFIED"; }],
    ["change command", (c) => { c.owner_gate.command = "/aio other"; }],
    ["change item", (c) => { c.owner_gate.item_id = "ITEM-2"; }],
    ["forge satisfied_by", (c) => { c.owner_gate.satisfied_by = "human:forged"; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const x = fixture({ task: structuredClone(gated) }); const c = candidate(x.base); mutate(c);
    assert.throws(() => new PlanPort(x.path).apply(proposal(x.bytes, x.base, c)), (error) => error.code === "PLAN_OWNER_GATE_MUTATION_FORBIDDEN");
    assert.deepEqual(readFileSync(x.path), x.bytes);
  });
  await t.test("unchanged gate cannot bypass the protected lifecycle projection", async (projection) => {
    const bypasses = [
      ["protected item IN_PROGRESS", (c) => { c.status = "IN_PROGRESS"; c.current_item = "ITEM-1"; c.next_item = "ITEM-2"; c.task_items[0].status = "IN_PROGRESS"; }],
      ["protected item DONE", (c) => { c.next_item = "ITEM-2"; c.task_items[0].status = "DONE"; c.task_items[0].evidence = ["forged done"]; }],
      ["protected item DROPPED", (c) => { c.next_item = "ITEM-2"; Object.assign(c.task_items[0], { status: "DROPPED", reason: "skip", actor: "human:forged", timestamp: NEXT_TIME }); }],
      ["current item change", (c) => { c.status = "IN_PROGRESS"; c.current_item = "ITEM-2"; c.next_item = null; c.task_items[1].status = "IN_PROGRESS"; }],
      ["next item change", (c) => { c.next_item = "ITEM-2"; }],
      ["task status advance", (c) => { c.status = "PLANNED"; }],
      ["next step bypass", (c) => { c.next_step = "Execute work without confirmation."; }],
      ["another item IN_PROGRESS", (c) => { c.status = "IN_PROGRESS"; c.current_item = "ITEM-2"; c.next_item = null; c.task_items[1].status = "IN_PROGRESS"; }],
      ["dependency topology bypass", (c) => { c.task_items[1].depends_on = []; }],
    ];
    for (const [name, mutate] of bypasses) await projection.test(name, () => {
      const x = fixture({ task: structuredClone(gated) }); const c = candidate(x.base, { next_step: x.base.next_step }); mutate(c);
      assert.doesNotThrow(() => new PlanProposal(proposal(x.bytes, x.base, c)));
      assert.throws(() => new PlanPort(x.path).apply(proposal(x.bytes, x.base, c)), (error) => error.code === "PLAN_OWNER_LATCH_BYPASS_FORBIDDEN");
      assert.deepEqual(readFileSync(x.path), x.bytes);
    });
  });
  await t.test("unchanged blocked latch permits only unrelated non-lifecycle mutation", () => {
    const x = fixture({ task: structuredClone(gated) }); const c = candidate(x.base, { next_step: x.base.next_step, title: "Safe prose metadata edit" });
    c.task_items[1].description = "Safe unrelated description edit.";
    const result = new PlanPort(x.path).apply(proposal(x.bytes, x.base, c));
    assert.equal(result.plan_revision_id, "PLAN-CANDIDATE-2"); assert.deepEqual(new TaskLedger(x.path).read().owner_gate, gated.owner_gate);
  });
  await t.test("a proposal cannot introduce an owner gate", () => {
    const x = fixture(); const c = candidate(x.base); c.owner_gate = structuredClone(gated.owner_gate);
    assert.throws(() => new PlanPort(x.path).apply(proposal(x.bytes, x.base, c)), (error) => error.code === "PLAN_OWNER_GATE_MUTATION_FORBIDDEN");
    assert.deepEqual(readFileSync(x.path), x.bytes);
  });
});

test("PlanPort always reconstructs proposal fields and never trusts PlanProposal prototypes or digests", () => {
  const x = fixture(); const input = proposal(x.bytes, x.base); const expected = new PlanProposal(input); const forgedDigest = `sha256:${"0".repeat(64)}`;
  const prototypeForgery = Object.assign(Object.create(PlanProposal.prototype), structuredClone(input), { proposal_digest: forgedDigest });
  assert.equal(new PlanPort(x.path).proposal(prototypeForgery).proposal_digest, expected.proposal_digest);

  class ForgedSubclass extends PlanProposal {
    constructor(value) { return Object.assign(Object.create(new.target.prototype), structuredClone(value), { proposal_digest: forgedDigest }); }
  }
  const subclassForgery = new ForgedSubclass(input);
  assert.equal(subclassForgery instanceof PlanProposal, true);
  assert.equal(new PlanPort(x.path).proposal(subclassForgery).proposal_digest, expected.proposal_digest);

  const modifiedPrototype = structuredClone(input);
  Object.setPrototypeOf(modifiedPrototype, { proposal_digest: forgedDigest });
  modifiedPrototype.proposal_digest = forgedDigest;
  assert.equal(new PlanPort(x.path).proposal(modifiedPrototype).proposal_digest, expected.proposal_digest);

  const reconstructed = new PlanPort(x.path).proposal(expected);
  assert.notEqual(reconstructed, expected);
  assert.equal(reconstructed.proposal_digest, expected.proposal_digest);
  assert.equal(canonicalJson(reconstructed.candidate_plan), canonicalJson(expected.candidate_plan));
  assert.throws(() => new PlanPort(x.path).proposal(Object.create(PlanProposal.prototype)), (error) => error.code === "PLAN_PROPOSAL_FIELDS_INVALID");
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

test("interruption after plan replacement is ambiguous and never invents recovered success", () => {
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
  assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  assert.equal(existsSync(join(proposalRecordRoot(x, input), "applied.json")), false);
  assert.deepEqual(readFileSync(x.path), committed);
});

function proposalRecordRoot(x, input) {
  return join(x.root, ".guardian", "plan-proposals", stableId("proposal", input.proposal_id));
}

function exactJsonWrite(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

function forgeAppliedFromIntent(x, input, materialized, appliedAt = "2026-08-20T10:07:00.000Z") {
  const root = proposalRecordRoot(x, input); const attempts = join(root, "attempts"); const name = readdirSync(attempts)[0];
  const intentPath = join(attempts, name); const intent = JSON.parse(readFileSync(intentPath, "utf8")); const appliedPath = join(root, "applied.json");
  const value = {
    schema: PLAN_APPLY_RESULT_SCHEMA, proposal_id: input.proposal_id, proposal_digest: new PlanProposal(input).proposal_digest, task_id: input.task_id,
    previous_revision_id: input.base_plan_revision_id, plan_revision_id: input.proposed_plan_revision_id, previous_content_digest: input.base_content_digest,
    content_digest: materialized.content_digest, prepared_at: intent.prepared_at, applied_at: appliedAt, recovered_at: null, diff: materialized.diff,
    provenance: intent.provenance, provenance_reference: relative(x.root, appliedPath).replaceAll("\\", "/"),
    commit_witness: { schema: "aiopago.plan-commit-witness/0.2.0", attempt_token: intent.attempt_token, filesystem_identity: intent.candidate_temp_filesystem_identity, commit_intent_reference: relative(x.root, intentPath).replaceAll("\\", "/") },
  };
  exactJsonWrite(appliedPath, value); return value;
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

test("schema 0.1.0 terminal provenance accepts compatible aliases without new supersession policy", async (t) => {
  const legacy = { reason: "Replaced by a better-scoped item.", actor: "human:owner", timestamp: NEXT_TIME };
  const modern = { terminal_reason: legacy.reason, terminal_actor: legacy.actor, terminal_at: legacy.timestamp };
  for (const [name, provenance] of [["legacy", legacy], ["terminal aliases", modern], ["both equal", { ...legacy, ...modern }]]) await t.test(name, () => {
    const value = task({ next_item: null }); value.task_items[1].status = "DROPPED"; Object.assign(value.task_items[1], provenance);
    assert.doesNotThrow(() => validateTaskLedger(value));
  });
  await t.test("conflicting aliases reject", () => {
    const value = task({ next_item: null }); value.task_items[1].status = "DROPPED"; Object.assign(value.task_items[1], legacy, modern, { terminal_actor: "human:other" });
    assert.throws(() => validateTaskLedger(value), (error) => error.code === "LEDGER_TERMINAL_PROVENANCE_CONFLICT");
  });
  for (const [name, provenance] of [["missing semantic field", { reason: "why", actor: "human:test" }], ["mixed partial aliases", { ...legacy, terminal_reason: legacy.reason }]]) await t.test(name, () => {
    const value = task({ next_item: null }); value.task_items[1].status = "DROPPED"; Object.assign(value.task_items[1], provenance);
    assert.throws(() => validateTaskLedger(value), (error) => error.code === "LEDGER_TERMINAL_PROVENANCE_REQUIRED");
  });
  await t.test("old 0.1.0 terminal form remains readable and mutable", () => {
    const value = task({ next_item: null }); value.task_items[1].status = "DROPPED"; Object.assign(value.task_items[1], legacy);
    const x = fixture({ task: value }); assert.equal(new TaskLedger(x.path).read().task_items[1].reason, legacy.reason);
    const c = candidate(value); c.task_items[1].description = "Mutated without rewriting legacy provenance.";
    const result = new PlanPort(x.path).apply(proposal(x.bytes, value, c)); assert.equal(result.plan_revision_id, "PLAN-CANDIDATE-2");
    const stored = new TaskLedger(x.path).read().task_items[1]; assert.equal(stored.reason, legacy.reason); assert.equal(Object.hasOwn(stored, "terminal_reason"), false);
  });
  await t.test("old non-reciprocal supersession fixture remains valid", () => {
    const value = task({ status: "PLANNED", current_item: null, next_item: "ITEM-2", task_items: [item("ITEM-1", "SUPERSEDED", { ...legacy, superseded_by: "ITEM-2" }), item("ITEM-2", "PLANNED")] });
    assert.doesNotThrow(() => validateTaskLedger(value));
  });
  for (const [name, mutate] of [["unknown", (v) => { v.task_items[0].superseded_by = "UNKNOWN"; }], ["self", (v) => { v.task_items[0].superseded_by = "ITEM-1"; }]]) await t.test(`replacement ${name} rejects`, () => {
    const value = task({ status: "PLANNED", current_item: null, next_item: "ITEM-2", task_items: [item("ITEM-1", "SUPERSEDED", { ...legacy, superseded_by: "ITEM-2" }), item("ITEM-2", "PLANNED")] }); mutate(value);
    assert.throws(() => validateTaskLedger(value), (error) => error.code === "LEDGER_SUPERSESSION_INVALID");
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
  await t.test("mutation while final lock ownership is attested is detected by the subsequent authority observation", () => {
    const x = fixture(); const human = Buffer.from(x.bytes.toString("utf8").replace("Human prose after", "Human edit during lock attestation"));
    const fdPaths = new Map(); let mutated = false;
    const io = {
      openSync(path, flags, mode) { const fd = openSync(path, flags, mode); fdPaths.set(fd, String(path)); return fd; },
      closeSync(fd) { const result = closeSync(fd); fdPaths.delete(fd); return result; },
      readFileSync(target, ...args) {
        const bytes = readFileSync(target, ...args);
        if (!mutated && typeof target === "number" && fdPaths.get(target)?.endsWith("plan-write.lock")) { mutated = true; writeFileSync(x.path, human); }
        return bytes;
      },
    };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io } }).apply(proposal(x.bytes, x.base)), (error) => error.code === "PLAN_CAS_CONFLICT");
    assert.equal(mutated, true); assert.deepEqual(readFileSync(x.path), human);
  });
  await t.test("same-size mutation after raw bytes copy is caught by post-read metadata", () => {
    const x = fixture(); let planReads = 0; let mutated = false; const fdPaths = new Map();
    const human = Buffer.from(x.bytes); const index = human.indexOf(Buffer.from("Human prose before")); human[index] = human[index] === 0x48 ? 0x4a : 0x48;
    assert.equal(human.length, x.bytes.length);
    const io = {
      openSync(path, flags, mode) { const fd = openSync(path, flags, mode); fdPaths.set(fd, String(path)); return fd; },
      closeSync(fd) { fdPaths.delete(fd); return closeSync(fd); },
      readFileSync(target, ...args) {
        const path = typeof target === "number" ? fdPaths.get(target) : String(target); const bytes = readFileSync(target, ...args);
        if (path === x.path && ++planReads === 3) { mutated = true; writeFileSync(x.path, human); }
        return bytes;
      },
    };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io } }).apply(proposal(x.bytes, x.base)), (error) => error.code === "PLAN_CAS_CONFLICT");
    assert.equal(mutated, true); assert.deepEqual(readFileSync(x.path), human);
  });
  await t.test("final authority observation is immediately adjacent to rename", () => {
    const x = fixture(); const events = []; const fdPaths = new Map(); let planReads = 0; let finalPlanFd;
    const io = {
      openSync(path, flags, mode) { events.push(["open", String(path)]); const fd = openSync(path, flags, mode); fdPaths.set(fd, String(path)); return fd; },
      closeSync(fd) { const path = fdPaths.get(fd); const result = closeSync(fd); fdPaths.delete(fd); events.push(["close", path]); if (fd === finalPlanFd) events.push(["FINAL_AUTHORITY_OBSERVATION_COMPLETE", path]); return result; },
      readFileSync(target, ...args) { const path = typeof target === "number" ? fdPaths.get(target) : String(target); if (path === x.path) { planReads += 1; if (planReads === 3) finalPlanFd = target; } events.push(["read", path]); return readFileSync(target, ...args); },
      writeFileSync(target, value, options) { events.push(["write", fdPaths.get(target) ?? String(target)]); return writeFileSync(target, value, options); },
      fsyncSync(fd) { events.push(["fsync", fdPaths.get(fd)]); return fsyncSync(fd); },
      fchmodSync(fd, mode) { events.push(["fchmod", fdPaths.get(fd)]); return fchmodSync(fd, mode); },
      linkSync(from, to) { events.push(["link", String(to)]); return linkSync(from, to); },
      renameSync(from, to) { events.push(["rename", String(from), String(to)]); return renameSync(from, to); },
    };
    new PlanPort(x.path, { writerOptions: { io } }).apply(proposal(x.bytes, x.base));
    const finalIndex = events.findIndex(([name]) => name === "FINAL_AUTHORITY_OBSERVATION_COMPLETE"); const renameIndex = events.findIndex(([name], index) => index > finalIndex && name === "rename");
    assert.ok(finalIndex >= 0 && renameIndex === finalIndex + 1, JSON.stringify(events.slice(finalIndex, renameIndex + 1)));
  });
});

test("recovery requires deterministic candidate evidence and a matching filesystem commit witness", async (t) => {
  await t.test("external write of exact candidate bytes after a failed attempt is ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const preview = new PlanPort(x.path).materialize(input, x.bytes);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input));
    writeFileSync(x.path, preview.bytes);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS"); assert.deepEqual(readFileSync(x.path), preview.bytes);
  });
  await t.test("external copy of exact candidate bytes is ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const preview = new PlanPort(x.path).materialize(input, x.bytes); const source = join(x.root, "external-candidate.md");
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") } }).apply(input));
    writeFileSync(source, preview.bytes); unlinkSync(x.path); copyFileSync(source, x.path);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
  await t.test("external rename of an orphan Aiopago temp is ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const orphan = join(x.root, "orphan-candidate.tmp");
    const io = { renameSync(from, to) { if (String(to) === x.path && String(from).includes(".replace.tmp")) { renameSync(from, orphan); throw new Error("simulated death before native authority rename"); } return renameSync(from, to); } };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io } }).apply(input), /simulated death/);
    assert.deepEqual(readFileSync(x.path), x.bytes); renameSync(orphan, x.path);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
  await t.test("real process kill immediately after rename and before result is ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const inputPath = join(x.root, "proposal-input.json"); const childPath = join(x.root, "kill-after-rename.mjs");
    writeFileSync(inputPath, JSON.stringify(input));
    writeFileSync(childPath, `import { readFileSync } from "node:fs";\nimport { PlanPort } from ${JSON.stringify(new URL("../src/plan-proposal.mjs", import.meta.url).href)};\nconst input = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));\nnew PlanPort(${JSON.stringify(x.path)}, { writerOptions: { testHooks: { afterRename() { process.kill(process.pid, "SIGKILL"); } } } }).apply(input);\n`);
    const child = spawnSync(process.execPath, [childPath], { cwd: x.root, timeout: 30_000 });
    assert.notEqual(child.status, 0, child.stderr?.toString());
    assert.equal(new TaskLedger(x.path).read().plan_revision_id, "PLAN-CANDIDATE-2");
    const lockPath = join(x.root, ".guardian", "plan-write.lock"); assert.equal(existsSync(lockPath), true); unlinkSync(lockPath);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
    assert.equal(existsSync(join(proposalRecordRoot(x, input), "applied.json")), false);
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

test("disk applied evidence cannot authenticate restart or precreation", async (t) => {
  await t.test("external orphan-temp rename plus forged exact applied evidence is ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const preview = new PlanPort(x.path).materialize(input, x.bytes); const orphan = join(x.root, "external-orphan.tmp");
    const io = { renameSync(from, to) { if (String(to) === x.path && String(from).includes(".replace.tmp")) { renameSync(from, orphan); throw new Error("stop before authority rename"); } return renameSync(from, to); } };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input), /stop before authority rename/);
    forgeAppliedFromIntent(x, input, preview); renameSync(orphan, x.path);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
  await t.test("external write plus forged exact applied evidence is ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const preview = new PlanPort(x.path).materialize(input, x.bytes);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input));
    forgeAppliedFromIntent(x, input, preview); writeFileSync(x.path, preview.bytes);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
  await t.test("even genuine exact disk applied evidence is ambiguous to a new PlanPort", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const live = new PlanPort(x.path); const first = live.apply(input);
    assert.deepEqual(live.apply(input), first);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
  await t.test("precreated exact applied result prevents live success", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); let precreated = false;
    const io = { linkSync(from, to) { if (String(to).endsWith("applied.json")) { copyFileSync(from, to); precreated = true; } return linkSync(from, to); } };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input), (error) => error.code === "PLAN_APPLY_COMMITTED_PROVENANCE_PENDING");
    assert.equal(precreated, true); assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
  await t.test("forged earlier applied_at is provenance-invalid before ambiguity", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const result = new PlanPort(x.path, { now: () => "2026-08-20T10:06:00.000Z" }).apply(input);
    const path = join(x.root, result.provenance_reference); const stored = JSON.parse(readFileSync(path, "utf8")); stored.applied_at = "1970-01-01T00:00:00.000Z"; exactJsonWrite(path, stored);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_PROVENANCE_INVALID");
  });
});

test("applied timestamps distinguish preparation, live commit, and ambiguous crash windows truthfully", async (t) => {
  await t.test("failed preparation T1 then successful retry T2", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input));
    const result = new PlanPort(x.path, { now: () => "2026-08-20T11:00:00.000Z" }).apply(input);
    assert.equal(result.prepared_at, "2026-08-20T11:00:00.000Z"); assert.equal(result.applied_at, "2026-08-20T11:00:00.000Z"); assert.equal(result.recovered_at, null);
  });
  await t.test("wall clock rollback after rename returns pending without inventing a timestamp", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const times = ["2026-08-20T10:06:00.000Z", "1970-01-01T00:00:00.000Z"];
    assert.throws(() => new PlanPort(x.path, { now: () => times.shift() }).apply(input), (error) => error.code === "PLAN_APPLY_COMMITTED_PROVENANCE_PENDING");
    assert.equal(existsSync(join(proposalRecordRoot(x, input), "applied.json")), false);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
  await t.test("rename witnessed but result missing is ambiguous", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    const io = { linkSync(from, to) { if (String(to).endsWith("applied.json")) throw new Error("stop after commit"); return linkSync(from, to); } };
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io }, now: () => "2026-08-20T10:06:00.000Z" }).apply(input), (error) => error.code === "PLAN_APPLY_COMMITTED_PROVENANCE_PENDING");
    assert.throws(() => new PlanPort(x.path, { now: () => "2026-08-20T12:00:00.000Z" }).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
    assert.equal(existsSync(join(proposalRecordRoot(x, input), "applied.json")), false);
  });
});

test("strict UTF-8 authority rejects malformed bytes and preserves valid Unicode and BOM", async (t) => {
  await t.test("malformed unrelated prose fails closed for read and mutation", () => {
    const x = fixture(); const malformed = Buffer.from(x.bytes); malformed[malformed.indexOf(Buffer.from("Human prose before")) + 2] = 0x80; writeFileSync(x.path, malformed);
    assert.throws(() => new TaskLedger(x.path).read(), (error) => error.code === "PLAN_UTF8_INVALID");
    const input = proposal(malformed, x.base);
    assert.equal(existsSync(join(x.root, ".guardian")), false);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_UTF8_INVALID");
    assert.deepEqual(readFileSync(x.path), malformed);
    assert.equal(existsSync(join(x.root, ".guardian")), false);
  });
  await t.test("valid Unicode and a UTF-8 BOM are accepted and preserved", () => {
    const x = fixture({ prose: { before: "Unicode α € 😀 before.", after: "Unicode 尾 after." } });
    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), x.bytes]); writeFileSync(x.path, bomBytes);
    const result = new PlanPort(x.path).apply(proposal(bomBytes, x.base)); const committed = readFileSync(x.path);
    assert.equal(result.plan_revision_id, "PLAN-CANDIDATE-2"); assert.deepEqual(committed.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.match(committed.toString("utf8"), /Unicode α € 😀 before/); assert.match(committed.toString("utf8"), /Unicode 尾 after/);
  });
});

test("oversized materialized authority is rejected before temp, intent, history, or replacement", () => {
  const x = fixture(); const c = candidate(x.base); c.padding = "x".repeat(MAX_PLAN_BYTES);
  const before = readFileSync(x.path);
  assert.throws(() => new PlanPort(x.path).apply(proposal(x.bytes, x.base, c)), (error) => error.code === "PLAN_AUTHORITY_TOO_LARGE");
  assert.deepEqual(readFileSync(x.path), before);
  const guardianFiles = allFiles(x.root).filter((path) => path.includes(`${join(x.root, ".guardian")}\\`) || path.includes(`${join(x.root, ".guardian")}/`));
  assert.deepEqual(guardianFiles, []);
});

test("attempt capacity is enforced before attempt 129 while applied idempotency remains available", async (t) => {
  function fillAttempts(x, input, { preserveWitness = false } = {}) {
    const attempts = join(proposalRecordRoot(x, input), "attempts"); const seedName = readdirSync(attempts)[0]; const seed = JSON.parse(readFileSync(join(attempts, seedName), "utf8"));
    for (let index = 1; readdirSync(attempts).length < 128; index += 1) {
      const token = index.toString(16).padStart(64, "0"); if (token === seed.attempt_token) continue;
      const copy = structuredClone(seed); copy.attempt_token = token;
      copy.candidate_temp_filesystem_identity = { device: seed.base_filesystem_identity.device, inode: (BigInt(seed.base_filesystem_identity.inode) + 10_000n + BigInt(index)).toString() };
      exactJsonWrite(join(attempts, `${token}.json`), copy);
    }
    if (preserveWitness) assert.equal(readdirSync(attempts).length, 128);
    return attempts;
  }
  await t.test("base authority at capacity explicitly abandons proposal without creating an intent", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io: failureIo("replace") } }).apply(input));
    const attempts = fillAttempts(x, input); const before = readFileSync(x.path);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_ATTEMPT_LIMIT_REACHED" && error.details.disposition === "ABANDON_PROPOSAL");
    assert.equal(readdirSync(attempts).length, 128); assert.deepEqual(readFileSync(x.path), before);
  });
  await t.test("live receipt remains idempotent at capacity but restart does not", () => {
    const x = fixture(); const input = proposal(x.bytes, x.base); const port = new PlanPort(x.path); const first = port.apply(input); const committed = readFileSync(x.path);
    fillAttempts(x, input, { preserveWitness: true });
    const second = port.apply(input);
    assert.deepEqual(second, first); assert.deepEqual(readFileSync(x.path), committed);
    assert.throws(() => new PlanPort(x.path).apply(input), (error) => error.code === "PLAN_RECOVERY_AMBIGUOUS");
  });
});

test("directory fsync surfaces unexpected errors and only tolerates explicit unsupported cases", async (t) => {
  function directoryIo(stage, code) {
    const fdPaths = new Map(); let injected = false;
    return {
      get injected() { return injected; },
      openSync(path, flags, mode) {
        if (stage === "open" && String(path).endsWith(join(".guardian", "plan-history")) && !injected) { injected = true; const error = new Error("injected directory open failure"); error.code = code; throw error; }
        const fd = openSync(path, flags, mode); fdPaths.set(fd, String(path)); return fd;
      },
      fsyncSync(fd) {
        if (stage === "fsync" && fdPaths.get(fd)?.endsWith(join(".guardian", "plan-history")) && !injected) { injected = true; const error = new Error("injected directory fsync failure"); error.code = code; throw error; }
        return fsyncSync(fd);
      },
      closeSync(fd) {
        const path = fdPaths.get(fd); fdPaths.delete(fd);
        if (stage === "close" && path?.endsWith(join(".guardian", "plan-history")) && !injected) { closeSync(fd); injected = true; const error = new Error("injected directory close failure"); error.code = code; throw error; }
        return closeSync(fd);
      },
    };
  }
  for (const stage of ["open", "fsync", "close"]) await t.test(`unexpected directory ${stage} error surfaces`, () => {
    const x = fixture(); const io = directoryIo(stage, `E${"IO"}`);
    assert.throws(() => new PlanPort(x.path, { writerOptions: { io } }).apply(proposal(x.bytes, x.base)), /injected directory/);
    assert.equal(io.injected, true); assert.deepEqual(readFileSync(x.path), x.bytes);
  });
  await t.test("explicit ENOTSUP directory fsync is documented best effort", () => {
    const x = fixture(); const io = directoryIo("fsync", "ENOTSUP"); const result = new PlanPort(x.path, { writerOptions: { io } }).apply(proposal(x.bytes, x.base));
    assert.equal(io.injected, true); assert.equal(result.plan_revision_id, "PLAN-CANDIDATE-2");
  });
});

test("exact-existing immutable records are re-durabilized after directory fsync failure", () => {
  const root = mkdtempSync(join(tmpdir(), "aiopago-redurable-")); const destination = join(root, "records", "record.json"); const value = Buffer.from("durable evidence\n");
  let failDirectorySync = true; let directoryAttempts = 0; const fdPaths = new Map();
  const io = {
    openSync(path, flags, mode) { const fd = openSync(path, flags, mode); fdPaths.set(fd, String(path)); return fd; },
    closeSync(fd) { fdPaths.delete(fd); return closeSync(fd); },
    fsyncSync(fd) { if (fdPaths.get(fd) === dirname(destination)) { directoryAttempts += 1; if (failDirectorySync) { const error = new Error("injected redurability I/O failure"); error.code = `E${"IO"}`; throw error; } } return fsyncSync(fd); },
  };
  const writer = new PlanRevisionWriter(join(root, "TASK_PLAN.md"), { io });
  assert.throws(() => writer.writeImmutable(destination, value), /injected redurability I\/O failure/); assert.deepEqual(readFileSync(destination), value);
  assert.throws(() => writer.writeImmutable(destination, value), /injected redurability I\/O failure/); assert.equal(directoryAttempts, 2);
  failDirectorySync = false; assert.doesNotThrow(() => writer.writeImmutable(destination, value)); assert.equal(directoryAttempts, 3);
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
