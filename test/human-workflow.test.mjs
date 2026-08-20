import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeRepository } from "../src/bootstrap.mjs";
import { runCli } from "../src/cli.mjs";
import { sha256 } from "../src/canonical.mjs";
import { observeHumanWorkflow, observeTaskPlan, projectHumanWorkflow } from "../src/human-workflow.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { readRuntimeProjection } from "../src/runtime-reader.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const fakePi = async () => ({ root: "/fake/pi", version: "0.83.0", name: "@earendil-works/pi-coding-agent" });
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function temp() { return mkdtempSync(join(tmpdir(), "eiopago-human-workflow-")); }

function task(overrides = {}) {
  return {
    schema_version: "0.1.0",
    task_id: "TASK-HUMAN",
    title: "Human workflow fixture",
    objective: "Make the current Eiopago task understandable without opening Pi.",
    requirements_version: "REQ-HUMAN-1",
    plan_revision_id: "PLAN-HUMAN-1",
    status: "IN_PROGRESS",
    completion_criteria: ["Status is readable", "The plan remains authoritative"],
    risk: "MEDIUM",
    created_at: "2026-08-16T10:00:00.000Z",
    updated_at: "2026-08-16T10:00:00.000Z",
    current_item: "ITEM-HUMAN-1",
    next_item: "ITEM-HUMAN-2",
    next_step: "Finish the read-only projection, then run the complete acceptance suite.",
    evidence: [],
    model_policy: null,
    reasoning_policy: "high",
    minimal_reads: ["TASK_PLAN.md"],
    task_items: [
      {
        task_item_id: "ITEM-HUMAN-1", task_id: "TASK-HUMAN", title: "Build read-only projection",
        description: "Expose status without Pi.", status: "IN_PROGRESS", depends_on: [],
        completion_criteria: ["Projection is bounded"], evidence: [], requirements_refs: ["0.2-A"],
        risk: "MEDIUM", milestone: "0.2-A", last_updated_at: "2026-08-16T10:00:00.000Z", last_updated_by: "human:test",
      },
      {
        task_item_id: "ITEM-HUMAN-2", task_id: "TASK-HUMAN", title: "Run acceptance",
        description: "Run all gates.", status: "PLANNED", depends_on: ["ITEM-HUMAN-1"],
        completion_criteria: ["All gates pass"], evidence: [], requirements_refs: ["0.2-A"],
        risk: "LOW", milestone: "0.2-A", last_updated_at: "2026-08-16T10:00:00.000Z", last_updated_by: "human:test",
      },
    ],
    ...overrides,
  };
}

function writeLedger(root, value = task()) {
  const text = `# Human workflow fixture\n\n\`\`\`json task-ledger\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
  writeFileSync(join(root, "TASK_PLAN.md"), text);
  return text;
}

async function fixture({ runtime = false } = {}) {
  const root = temp();
  git(root, ["init"]);
  await initializeRepository(root, { piInspector: fakePi, now: "2026-08-16T10:00:00.000Z" });
  writeLedger(root);
  if (runtime) {
    const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
    storage.ensureLatch("TASK-HUMAN");
    storage.close();
  }
  return root;
}

function capture(root) {
  const runtimeRoot = join(root, ".guardian", "runtime");
  const runtimeEntries = readdirSync(runtimeRoot).sort();
  const paths = [join(root, "TASK_PLAN.md"), ...runtimeEntries.map((name) => join(runtimeRoot, name))]
    .filter((path) => existsSync(path));
  return {
    files: paths.map((path) => {
      const bytes = readFileSync(path);
      const stat = statSync(path);
      return { path, digest: sha256(bytes), bytes, mtimeMs: stat.mtimeMs };
    }),
    runtimeEntries,
  };
}

function planAuthority(root) { return new TaskLedger(join(root, "TASK_PLAN.md")).read(); }

function seedResumeReady(storage, plan, suffix = "one") {
  storage.ensureLatch(plan.task_id);
  const latch = storage.engageLatch(plan.task_id, "INTEGRITY", "human:test");
  const handoffId = `HO-${suffix}`;
  storage.reserveHandoff({
    handoff_id: handoffId,
    source_session_id: `SES-source-${suffix}`,
    source_session_file: `/private/source-${suffix}.jsonl`,
    target_session_id: null,
    target_session_file: null,
    task_id: plan.task_id,
    state: "SAFE_TO_HANDOFF",
    latch_generation: latch.generation,
    runner_instance_id: `RUNNER-${suffix}`,
    session_binding_id: `BIND-${suffix}`,
    task_plan_revision: plan.plan_revision_id,
    task_plan_digest: plan.content_digest,
    requirements_version: plan.requirements_version,
    current_item: plan.current_item,
    next_item: plan.next_item,
    next_step: plan.next_step,
    resume_prompt_id: null,
    resume_prompt: `private resume prompt ${suffix}`,
    authorization_state: "NOT_AUTHORIZED",
    admission_state: "NOT_COMMITTED",
    admission_id: null,
    dispatch_state: "NOT_STARTED",
    dispatch_attempt_id: null,
    dispatch_attempt_no: 0,
  });
  const created = storage.getHandoff(handoffId);
  created.target_session_id = `SES-target-${suffix}`;
  created.target_session_file = `/private/target-${suffix}.jsonl`;
  created.state = "REPLACEMENT_SESSION_CREATED_PAUSED";
  storage.saveHandoff(created, "REPLACEMENT_SESSION_CREATED_PAUSED", { target_session_id: created.target_session_id });
  storage.bindRunnerSession(handoffId, {
    replacement_session_id: created.target_session_id,
    runner_instance_id: created.runner_instance_id,
    session_binding_id: created.session_binding_id,
  });
  const ready = storage.getHandoff(handoffId);
  ready.resume_prompt_id = `RP-${suffix}`;
  ready.state = "RESUME_READY";
  storage.saveHandoff(ready, "CONTINUITY_VALIDATED", {});
  return storage.getHandoff(handoffId);
}

function assertUnchanged(before, after) {
  assert.deepEqual(after.runtimeEntries, before.runtimeEntries);
  assert.equal(after.files.length, before.files.length);
  for (let index = 0; index < before.files.length; index += 1) {
    assert.equal(after.files[index].path, before.files[index].path);
    assert.equal(after.files[index].digest, before.files[index].digest);
    assert.deepEqual(after.files[index].bytes, before.files[index].bytes);
    assert.equal(after.files[index].mtimeMs, before.files[index].mtimeMs);
  }
}

async function command(argv, options = {}) {
  const lines = [];
  const raw = [];
  const result = await runCli(argv, {
    stdout: (text) => lines.push(text),
    rawStdout: (text) => raw.push(text),
    checkEnvironment: async () => { throw new Error("read-only commands must not inspect Pi or the model environment"); },
    ...options,
  });
  return { result, output: lines.join("\n"), raw: raw.join("") };
}

test("0.2-A CLI status, why, next and plan are human-readable and leave plan/runtime bytes and mtimes unchanged", async () => {
  const root = await fixture({ runtime: true });
  const before = capture(root);

  const status = await command(["status", "--target", root]);
  assert.equal(status.result.action, "status");
  assert.match(status.output, /Eiopago — richiede attenzione/);
  assert.match(status.output, /Obiettivo: Make the current Eiopago task understandable/);
  assert.match(status.output, /Attività corrente: Build read-only projection/);
  assert.doesNotMatch(status.output, /TASK-HUMAN|ITEM-HUMAN|PLAN-HUMAN|latch|handoff/i);

  const why = await command(["why", "--target", root]);
  assert.match(why.output, /non espone ancora una verifica read-only canonica/);

  const next = await command(["next", "--target", root]);
  assert.match(next.output, /non dedurre avvio o retry/);
  assert.doesNotMatch(next.output, /esegui “eio”|\/eio resume/i);

  const plan = await command(["plan", "--target", root]);
  assert.match(plan.output, /Piano autorevole: Human workflow fixture/);
  assert.match(plan.output, /Artifact: .*TASK_PLAN\.md/);
  assert.match(plan.output, /Build read-only projection — in corso/);
  assert.doesNotMatch(plan.output, /ITEM-HUMAN-1|PLAN-HUMAN-1/);

  const check = await command(["plan", "--check", "--target", root]);
  assert.match(check.output, /TASK_PLAN\.md valido/);

  const technical = await command(["plan", "--technical", "--target", root]);
  assert.match(technical.output, /Task ID: TASK-HUMAN/);
  assert.match(technical.output, /Revisione: PLAN-HUMAN-1/);
  assert.match(technical.output, /Digest: sha256:[a-f0-9]{64}/);
  assert.match(technical.output, /Current item: ITEM-HUMAN-1/);

  assertUnchanged(before, capture(root));
});

test("a live WAL runtime fails closed without changing database or sidecar bytes and mtimes", async () => {
  const root = await fixture();
  const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
  try {
    storage.ensureLatch("TASK-HUMAN");
    storage.engageLatch("TASK-HUMAN", "HUMAN_TAKEOVER", "human:test");
    const before = capture(root);
    assert.equal(before.runtimeEntries.includes("guardian.sqlite-wal"), true);
    assert.equal(before.runtimeEntries.includes("guardian.sqlite-shm"), true);

    const status = await command(["status", "--target", root]);
    assert.match(status.output, /Eiopago — richiede attenzione/);
    assert.match(status.output, /non può essere verificato in sicurezza dall’osservatore esterno/);
    const next = await command(["next", "--target", root]);
    assert.match(next.output, /non avviare né riprovare eio/);
    assert.doesNotMatch(next.output, /esegui “eio”|avvia eio/i);
    assertUnchanged(before, capture(root));
  } finally { storage.close(); }
});

test("eio plan --raw returns the authoritative text even when Ledger validation fails", async () => {
  const root = await fixture({ runtime: true });
  const invalid = "# Human-owned plan\n\nThis is intentionally invalid while being repaired.\n";
  writeFileSync(join(root, "TASK_PLAN.md"), invalid);
  const before = capture(root);

  const raw = await command(["plan", "--raw", "--target", root]);
  assert.equal(raw.raw, invalid);
  assert.equal(raw.output, "");

  await assert.rejects(
    () => command(["plan", "--check", "--target", root]),
    (error) => error.code === "LEDGER_FORMAT_INVALID",
  );
  const status = await command(["status", "--target", root]);
  assert.match(status.output, /Eiopago — richiede attenzione/);
  assert.match(status.output, /TASK_PLAN\.md non è valido/);
  assert.match(status.output, /eio plan --check/);

  assertUnchanged(before, capture(root));
});

test("a direct human edit becomes the next observed authority and is never overwritten", async () => {
  const root = await fixture();
  const first = await command(["plan", "--target", root]);
  assert.match(first.output, /Make the current Eiopago task understandable/);

  const edited = task({
    objective: "Honor a direct human edit as the canonical plan.",
    plan_revision_id: "PLAN-HUMAN-MANUAL-2",
    updated_at: "2026-08-16T10:05:00.000Z",
  });
  const humanBytes = writeLedger(root, edited);
  const before = capture(root);
  const second = await command(["status", "--target", root]);
  assert.match(second.output, /Honor a direct human edit as the canonical plan/);
  assert.equal(readFileSync(join(root, "TASK_PLAN.md"), "utf8"), humanBytes);
  assertUnchanged(before, capture(root));
});

test("public workflow projection never constructs READY without a canonical core observation", async () => {
  const activePlan = { valid: true, plan: task(), path: "/repo/TASK_PLAN.md", digest: "sha256:plan" };
  for (const runtime of [
    undefined,
    { available: false, workflow: "NEEDS_ATTENTION", condition: "RUNTIME_NOT_OBSERVED", error: { code: "RUNTIME_NOT_VERIFIED", message: "not observed" } },
    { available: true, workflow: "READY", condition: "FUTURE_CONDITION", error: null },
    { available: true, workflow: "FUTURE_STATE", condition: "UNKNOWN", error: null },
  ]) {
    const projected = projectHumanWorkflow({ initialized: true, plan: activePlan, runtime });
    assert.equal(projected.state, "NEEDS_ATTENTION");
    assert.equal(projected.technical.code, "RUNTIME_NOT_VERIFIED");
    assert.doesNotMatch(projected.next, /esegui “eio”|\/eio resume/i);
  }

  const root = await fixture();
  const notObserved = observeHumanWorkflow(root, { includeRuntime: false });
  const projected = projectHumanWorkflow(notObserved);
  assert.equal(projected.state, "NEEDS_ATTENTION");
  assert.equal(projected.technical.code, "RUNTIME_NOT_VERIFIED");
});

test("read-only workflow commands describe an uninitialized Git repository without creating Eiopago state", async () => {
  const root = temp();
  git(root, ["init"]);
  const before = readdirSync(root).sort();

  const status = await command(["status", "--target", root]);
  assert.match(status.output, /Eiopago — da configurare/);
  const why = await command(["why", "--target", root]);
  assert.match(why.output, /non è ancora inizializzato/);
  const next = await command(["next", "--target", root]);
  assert.match(next.output, /eio init/);

  assert.deepEqual(readdirSync(root).sort(), before);
  assert.equal(existsSync(join(root, ".guardian")), false);
  assert.equal(existsSync(join(root, "TASK_PLAN.md")), false);
});

test("observeTaskPlan exposes raw bytes independently from validation", async () => {
  const root = await fixture();
  const path = join(root, "TASK_PLAN.md");
  const valid = observeTaskPlan(path);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.bytes, readFileSync(path));
  assert.equal(valid.digest, valid.plan.content_digest);

  writeFileSync(path, "foreign plan\n");
  const invalid = observeTaskPlan(path);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.text, "foreign plan\n");
  assert.equal(invalid.error.code, "LEDGER_FORMAT_INVALID");
});

test("plan --raw never invokes TaskLedger.read or the validator", async () => {
  const root = await fixture();
  const expected = readFileSync(join(root, "TASK_PLAN.md"), "utf8");
  const raw = await command(["plan", "--raw", "--target", root], {
    workflowOptions: {
      planOptions: { readTaskLedger: () => { throw new Error("validator must not run"); } },
    },
  });
  assert.equal(raw.raw, expected);
});

test("review regressions fail closed at the architectural boundary without presenter hard-coding", async (t) => {
  const cases = [
    ["future operation state", (storage) => {
      storage.db.prepare("INSERT INTO operations(operation_id,task_id,latch_generation,profile,state,outcome,admitted_at) VALUES(?,?,?,?,?,?,?)")
        .run("OP-FUTURE", "TASK-HUMAN", 0, "READ_ONLY", "FUTURE_STATE", null, "2026-08-16T10:00:00.000Z");
    }],
    ["latch row disagrees with HUMAN_TAKEOVER journal", (storage, plan) => {
      seedResumeReady(storage, plan, "takeover-mismatch");
      storage.engageLatch(plan.task_id, "HUMAN_TAKEOVER", "human:test");
      storage.db.prepare("UPDATE latches SET reason='INTEGRITY' WHERE task_id=?").run(plan.task_id);
    }],
    ["authorization actor is not human", (storage, plan) => {
      const handoff = seedResumeReady(storage, plan, "actor");
      storage.authorizeAndAdmit(handoff.handoff_id, "human:test", `resume:${handoff.resume_prompt_id}`, "ADM-actor");
      storage.beginDispatch(handoff.handoff_id, "DSP-actor", 1);
      storage.finishDispatch(handoff.handoff_id, "ACKNOWLEDGED");
      storage.db.prepare("UPDATE authorizations SET actor='future:machine' WHERE handoff_id=?").run(handoff.handoff_id);
    }],
    ["RESUME_ADMISSION_COMMITTED event is missing", (storage, plan) => {
      const handoff = seedResumeReady(storage, plan, "missing-admission-event");
      storage.authorizeAndAdmit(handoff.handoff_id, "human:test", `resume:${handoff.resume_prompt_id}`, "ADM-missing-event");
      storage.beginDispatch(handoff.handoff_id, "DSP-missing-event", 1);
      storage.finishDispatch(handoff.handoff_id, "ACKNOWLEDGED");
      storage.db.prepare("DELETE FROM journal WHERE handoff_id=? AND event_type='RESUME_ADMISSION_COMMITTED'").run(handoff.handoff_id);
    }],
    ["authorization/admission/dispatch journal sequence is incomplete", (storage, plan) => {
      const handoff = seedResumeReady(storage, plan, "incomplete-sequence");
      storage.authorizeAndAdmit(handoff.handoff_id, "human:test", `resume:${handoff.resume_prompt_id}`, "ADM-incomplete");
      storage.beginDispatch(handoff.handoff_id, "DSP-incomplete", 1);
      storage.finishDispatch(handoff.handoff_id, "ACKNOWLEDGED");
      storage.db.prepare("DELETE FROM journal WHERE handoff_id=? AND event_type IN ('RESUME_AUTHORIZED','RESUME_DISPATCH_INTENT')").run(handoff.handoff_id);
    }],
  ];

  for (const [name, corrupt] of cases) {
    await t.test(name, async () => {
      const root = await fixture();
      const path = join(root, ".guardian", "runtime", "guardian.sqlite");
      const storage = new GuardianStorage(path);
      const plan = planAuthority(root);
      corrupt(storage, plan);
      storage.close();
      const observed = readRuntimeProjection(path, plan);
      assert.equal(observed.workflow, "NEEDS_ATTENTION");
      assert.equal(observed.error.code, "RUNTIME_NOT_VERIFIED");
      const projected = projectHumanWorkflow({ initialized: true, targetRoot: root, plan: { valid: true, plan, path: join(root, "TASK_PLAN.md") }, runtime: observed });
      assert.equal(projected.state, "NEEDS_ATTENTION");
      assert.doesNotMatch(projected.next, /esegui “eio”|\/eio resume/i);
    });
  }
});

test("all persisted authorization/admission/dispatch states remain unverified without the Core Observation Port", async (t) => {
  const cases = [
    ["RESUME_READY", (storage, h) => h],
    ["RESUME_ADMISSION_COMMITTED", (storage, h) => storage.authorizeAndAdmit(h.handoff_id, "human:test", `resume:${h.resume_prompt_id}`, `ADM-${h.handoff_id}`).handoff],
    ["RESUME_DISPATCHING", (storage, h) => {
      const admitted = storage.authorizeAndAdmit(h.handoff_id, "human:test", `resume:${h.resume_prompt_id}`, `ADM-${h.handoff_id}`).handoff;
      return storage.beginDispatch(h.handoff_id, `DSP-${h.handoff_id}`, 1).handoff;
    }],
    ["RESUME_DISPATCHED", (storage, h) => {
      storage.authorizeAndAdmit(h.handoff_id, "human:test", `resume:${h.resume_prompt_id}`, `ADM-${h.handoff_id}`);
      storage.beginDispatch(h.handoff_id, `DSP-${h.handoff_id}`, 1);
      return storage.finishDispatch(h.handoff_id, "DISPATCHED");
    }],
    ["RESUME_DISPATCH_FAILED", (storage, h) => {
      storage.authorizeAndAdmit(h.handoff_id, "human:test", `resume:${h.resume_prompt_id}`, `ADM-${h.handoff_id}`);
      storage.beginDispatch(h.handoff_id, `DSP-${h.handoff_id}`, 1);
      return storage.finishDispatch(h.handoff_id, "FAILED", "known failure");
    }],
    ["RESUME_DISPATCH_UNKNOWN", (storage, h) => {
      storage.authorizeAndAdmit(h.handoff_id, "human:test", `resume:${h.resume_prompt_id}`, `ADM-${h.handoff_id}`);
      storage.beginDispatch(h.handoff_id, `DSP-${h.handoff_id}`, 1);
      return storage.finishDispatch(h.handoff_id, "UNKNOWN", "ambiguous");
    }],
    ["RESUMED", (storage, h) => {
      storage.authorizeAndAdmit(h.handoff_id, "human:test", `resume:${h.resume_prompt_id}`, `ADM-${h.handoff_id}`);
      storage.beginDispatch(h.handoff_id, `DSP-${h.handoff_id}`, 1);
      return storage.finishDispatch(h.handoff_id, "ACKNOWLEDGED");
    }],
  ];

  for (const [state, advance] of cases) {
    await t.test(state, async () => {
      const root = await fixture();
      const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
      const plan = planAuthority(root);
      const final = advance(storage, seedResumeReady(storage, plan, state));
      assert.equal(final.state, state);
      storage.close();
      const observed = readRuntimeProjection(join(root, ".guardian", "runtime", "guardian.sqlite"), plan);
      assert.equal(observed.workflow, "NEEDS_ATTENTION");
      assert.equal(observed.error.code, "RUNTIME_NOT_VERIFIED");
    });
  }
});

test("unknown handoff state fails closed", async () => {
  const root = await fixture();
  const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
  const plan = planAuthority(root);
  const handoff = seedResumeReady(storage, plan, "unknown");
  const projection = storage.getHandoff(handoff.handoff_id);
  projection.state = "FUTURE_RUNTIME_STATE";
  storage.db.prepare("UPDATE handoffs SET state=?,projection_json=? WHERE handoff_id=?").run(projection.state, JSON.stringify(projection), handoff.handoff_id);
  storage.close();
  const observed = readRuntimeProjection(join(root, ".guardian", "runtime", "guardian.sqlite"), plan);
  assert.equal(observed.workflow, "NEEDS_ATTENTION");
  assert.equal(observed.error.code, "RUNTIME_NOT_VERIFIED");
});

test("takeover authority from the prior task survives a direct plan task_id change", async () => {
  const root = await fixture();
  const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
  storage.ensureLatch("TASK-HUMAN");
  storage.engageLatch("TASK-HUMAN", "HUMAN_TAKEOVER", "human:test");
  storage.close();
  const changed = task({ task_id: "TASK-NEW", plan_revision_id: "PLAN-NEW" });
  changed.task_items = changed.task_items.map((item) => ({ ...item, task_id: "TASK-NEW" }));
  writeLedger(root, changed);
  const status = await command(["status", "--target", root]);
  assert.match(status.output, /richiede attenzione/);
  assert.doesNotMatch(status.output, /pronto a continuare/);
});

test("a prior dispatch ambiguity is not hidden by a later acknowledged handoff", async () => {
  const root = await fixture();
  const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
  const plan = planAuthority(root);
  const first = seedResumeReady(storage, plan, "ambiguous-first");
  storage.authorizeAndAdmit(first.handoff_id, "human:test", `resume:${first.resume_prompt_id}`, "ADM-first");
  storage.beginDispatch(first.handoff_id, "DSP-first", 1);
  storage.finishDispatch(first.handoff_id, "UNKNOWN", "transport ambiguous");
  const second = seedResumeReady(storage, plan, "successful-second");
  storage.authorizeAndAdmit(second.handoff_id, "human:test", `resume:${second.resume_prompt_id}`, "ADM-second");
  storage.beginDispatch(second.handoff_id, "DSP-second", 1);
  storage.finishDispatch(second.handoff_id, "ACKNOWLEDGED");
  storage.close();
  const observed = readRuntimeProjection(join(root, ".guardian", "runtime", "guardian.sqlite"), plan);
  assert.equal(observed.workflow, "NEEDS_ATTENTION");
  assert.equal(observed.error.code, "RUNTIME_NOT_VERIFIED");
});

test("generation, row/projection, admission projection, and Runner binding mismatches fail closed", async (t) => {
  const corruptions = [
    ["generation", (storage) => storage.db.prepare("UPDATE latches SET generation=generation+2 WHERE task_id='TASK-HUMAN'").run()],
    ["row/projection", (storage, h) => storage.db.prepare("UPDATE handoffs SET state='RESUME_DISPATCHING' WHERE handoff_id=?").run(h.handoff_id)],
    ["admission projection", (storage, h) => {
      const projection = storage.getHandoff(h.handoff_id);
      projection.dispatch_state = "DISPATCHING";
      storage.db.prepare("UPDATE handoffs SET projection_json=? WHERE handoff_id=?").run(JSON.stringify(projection), h.handoff_id);
    }],
    ["binding", (storage, h) => storage.db.prepare("UPDATE runner_session_bindings SET runner_instance_id='RUNNER-incompatible' WHERE handoff_id=?").run(h.handoff_id)],
  ];
  for (const [name, corrupt] of corruptions) {
    await t.test(name, async () => {
      const root = await fixture();
      const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
      const plan = planAuthority(root);
      const handoff = seedResumeReady(storage, plan, name.replaceAll(" ", "-"));
      corrupt(storage, handoff);
      storage.close();
      const observed = readRuntimeProjection(join(root, ".guardian", "runtime", "guardian.sqlite"), plan);
      assert.equal(observed.workflow, "NEEDS_ATTENTION");
      assert.equal(observed.error.code, "RUNTIME_NOT_VERIFIED");
    });
  }
});

test("WAL/SHM appearance or disappearance during observation fails closed", async () => {
  const root = await fixture({ runtime: true });
  const path = join(root, ".guardian", "runtime", "guardian.sqlite");
  const plan = planAuthority(root);
  const clean = { database: true, sidecars: [] };
  for (const sequence of [
    [clean, clean, { database: true, sidecars: ["-wal"] }, clean, clean],
    [{ database: true, sidecars: ["-shm"] }, clean, clean, clean, clean],
  ]) {
    let index = 0;
    const observed = readRuntimeProjection(path, plan, {
      probeRuntimeFiles: () => sequence[Math.min(index++, sequence.length - 1)],
    });
    assert.equal(observed.workflow, "NEEDS_ATTENTION");
    assert.equal(observed.error.code, "RUNTIME_NOT_QUIESCENT");
  }
});

test("runtime reader performs acquisition only and never opens or interprets SQLite", async () => {
  const root = await fixture({ runtime: true });
  const path = join(root, ".guardian", "runtime", "guardian.sqlite");
  const plan = planAuthority(root);
  let databaseFactoryCalls = 0;
  const observed = readRuntimeProjection(path, plan, { databaseFactory: () => { databaseFactoryCalls += 1; throw new Error("must not open SQLite"); } });
  assert.equal(observed.workflow, "NEEDS_ATTENTION");
  assert.equal(observed.error.code, "RUNTIME_NOT_VERIFIED");
  assert.equal(databaseFactoryCalls, 0);
  assert.equal(readdirSync(tmpdir()).some((name) => name.startsWith("eiopago-runtime-read-")), false);
});

test("public runtime observation and output omit projection_json private fields", async () => {
  const root = await fixture();
  const storage = new GuardianStorage(join(root, ".guardian", "runtime", "guardian.sqlite"));
  const plan = planAuthority(root);
  seedResumeReady(storage, plan, "private-data");
  storage.close();
  const status = await command(["status", "--target", root]);
  assert.equal(status.result.observation.runtime.workflow, "NEEDS_ATTENTION");
  const publicRuntime = JSON.stringify(status.result.observation.runtime);
  for (const secret of ["resume_prompt", "source_session_file", "target_session_file", "checkpoint_id", "resume_manifest_id", "private resume prompt", "/private/"]) {
    assert.doesNotMatch(publicRuntime, new RegExp(secret));
    assert.doesNotMatch(status.output, new RegExp(secret));
  }
  assert.deepEqual(Object.keys(status.result.observation.runtime).sort(), ["available", "condition", "error", "workflow"]);
});

test("new read-only commands discover nested directories and linked worktrees", async () => {
  const root = await fixture();
  const nested = join(root, "nested", "deeper");
  mkdirSync(nested, { recursive: true });
  for (const name of ["status", "why", "next", "plan"]) {
    const result = await command([name, "--target", nested]);
    assert.equal(result.result.action, name);
  }

  const main = temp();
  git(main, ["init"]);
  git(main, ["config", "user.email", "human-workflow@example.invalid"]);
  git(main, ["config", "user.name", "Human Workflow Test"]);
  writeFileSync(join(main, "seed.txt"), "seed\n");
  git(main, ["add", "seed.txt"]);
  git(main, ["commit", "-m", "seed"]);
  const linked = temp();
  rmSync(linked, { recursive: true });
  git(main, ["worktree", "add", "-b", `human-workflow-${Date.now()}`, linked]);
  await initializeRepository(linked, { piInspector: fakePi, now: "2026-08-16T10:00:00.000Z" });
  writeLedger(linked);
  const linkedNested = join(linked, "nested", "deeper");
  mkdirSync(linkedNested, { recursive: true });
  for (const name of ["status", "why", "next", "plan"]) {
    const result = await command([name, "--target", linkedNested]);
    assert.equal(result.result.action, name);
    assert.equal(result.result.observation.targetRoot.toLowerCase(), linked.toLowerCase());
  }
});
