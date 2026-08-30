import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../src/artifact-store.mjs";
import { canonicalJson, digestObject, sha256 } from "../src/canonical.mjs";
import { planSemanticDigest } from "../src/plan-semantics-internal.mjs";
import { ProtectedSqliteOperationAuthority } from "../src/protected-operation-authority.mjs";
import { requireSecureRecoveryInputAuthority } from "../src/recovery-input-authority.mjs";
import { GuardianStorage, storageDatabaseForInternalTest } from "../src/storage.mjs";

function exactLatch(latch) {
  return { task_id: latch.task_id, state: latch.state, generation: latch.generation, reason: latch.reason };
}

function projection({ task = "TASK-INPUT-A", handoff = "HO-INPUT-A", source = "SESSION-SOURCE-A", runner = "RUNNER-A", binding = "BIND-A", revision = "PLAN-A", objective = "Protected recovery input A", checkpoint = "CP-A", manifest = "RM-A" } = {}) {
  const contentDigest = sha256(Buffer.from(`${task}:${revision}:canonical-plan-bytes`, "utf8"));
  const plan = {
    task_id: task, objective, current_item: "ITEM-1", next_item: "ITEM-2", next_step: "Continue exact work",
    plan_revision_id: revision, content_digest: contentDigest, requirements_version: "REQ-1",
    completion_criteria: ["bounded"], relevant_decisions: ["decision-A"], relevant_tests: ["test-A"],
    evidence_references: ["evidence-A"], minimal_reads: ["TASK_PLAN.md"], required_local_paths: ["TASK_PLAN.md"],
    model_policy: "offline/fake", reasoning_policy: "off",
  };
  return {
    handoff_id: handoff, source_session_id: source, source_session_file: `sessions/${source}.jsonl`,
    target_session_id: null, target_session_file: null, runner_instance_id: runner, session_binding_id: binding,
    parent_session_id: source, parent_session_file: `sessions/${source}.jsonl`, parent_checkpoint_id: null,
    recovery_of_handoff_id: null, task_id: task, current_item: plan.current_item, next_item: plan.next_item,
    next_step: plan.next_step, task_plan_revision: revision, task_plan_digest: contentDigest,
    requirements_version: plan.requirements_version, latch_generation: 1, checkpoint_id: checkpoint,
    checkpoint_digest: null, resume_manifest_id: manifest, resume_manifest_digest: null,
    resume_prompt_id: null, resume_prompt_digest: null, resume_prompt: null,
    authorization_state: "NOT_AUTHORIZED", admission_state: "NOT_COMMITTED", admission_id: null,
    dispatch_state: "NOT_STARTED", dispatch_attempt_id: null, dispatch_attempt_no: 0,
    expected_git_state: { repository_id: "repo", workdir: "project", branch: "test", head_sha: "a".repeat(40), base_sha: "a".repeat(40), index_digest: `sha256:${"b".repeat(64)}`, worktree_digest: `sha256:${"c".repeat(64)}`, status_entries: [] },
    model_policy: plan.model_policy, reasoning_policy: plan.reasoning_policy, reserved_plan_snapshot: plan,
    state: "SAFE_TO_HANDOFF", created_at: "2026-08-30T12:00:00.000Z", updated_at: "2026-08-30T12:00:00.000Z",
  };
}

function reserve(authority, p, expectedLatest = null) {
  const clear = authority.ensureLatch(p.task_id);
  const engaged = clear.state === "ENGAGED" ? clear : authority.claimLatch({
    taskId: p.task_id, reason: "INTEGRITY", actor: "human:handoff", expected: exactLatch(clear), requestId: `LATCH-${p.handoff_id}`,
  });
  p.latch_generation = engaged.generation;
  const result = authority.requestHandoffReservation(p.handoff_id, { projection: p, expectedLatch: exactLatch(engaged), expectedLatest });
  return { result, engaged };
}

function bind(authority, p, target = `TARGET-${p.handoff_id}`, incarnation = 1) {
  const value = { handoff_id: p.handoff_id, replacement_session_id: target, runner_instance_id: p.runner_instance_id, session_binding_id: p.session_binding_id, lifecycle_incarnation: incarnation };
  return authority.requestLifecycleBindingCreate(`BIND-${p.handoff_id}`, { binding: value }).binding;
}

function fixture(label = "A") {
  const root = mkdtempSync(join(tmpdir(), `aiopago-recovery-input-${label}-`));
  const canonical = join(root, "canonical"); mkdirSync(canonical);
  const authority = new ProtectedSqliteOperationAuthority(join(canonical, "operations.sqlite"), { allowInitialize: true });
  const storage = new GuardianStorage(join(root, "project", ".guardian", "runtime", "guardian.sqlite"));
  const artifacts = new ArtifactStore(join(root, "project", ".guardian"), storage, { authority });
  return { root, authority, storage, artifacts, close() { storage.close(); authority.close(); } };
}

function seal(x, p) {
  const planDigest = planSemanticDigest(p.reserved_plan_snapshot, { requireAll: true });
  const checkpoint = x.artifacts.persist("checkpoint", p.checkpoint_id, {
    created_at: p.created_at, checkpoint_id: p.checkpoint_id, task_id: p.task_id,
    plan_revision_id: p.task_plan_revision, plan_content_digest: p.task_plan_digest,
  }, { handoffId: p.handoff_id, planSemanticDigest: planDigest });
  const manifest = x.artifacts.persist("manifest", p.resume_manifest_id, {
    created_at: p.created_at, resume_manifest_id: p.resume_manifest_id, handoff_id: p.handoff_id,
    task_id: p.task_id, objective: p.reserved_plan_snapshot.objective, checkpoint_id: p.checkpoint_id,
    checkpoint_digest: checkpoint.digest,
  }, { handoffId: p.handoff_id, planSemanticDigest: planDigest, checkpointId: p.checkpoint_id, checkpointDigest: checkpoint.digest });
  return { checkpoint, manifest, planDigest };
}

function actual(artifact) {
  return { artifact_id: artifact.id ?? artifact.artifact_id, artifact_digest: artifact.digest ?? artifact.artifact_digest, content_digest: artifact.content_digest };
}

test("protected handoff commit atomically freezes the smallest canonical plan snapshot and project forgeries cannot redefine it", () => {
  const x = fixture("plan");
  try {
    assert.equal(requireSecureRecoveryInputAuthority(x.authority), x.authority);
    const p = projection();
    const { result } = reserve(x.authority, p);
    const protectedPlan = x.authority.getPlanAuthorityForHandoff(p.handoff_id);
    assert.equal(result.plan_authority.plan_semantic_digest, protectedPlan.semantic_digest);
    assert.deepEqual(protectedPlan.snapshot, p.reserved_plan_snapshot);
    const projectPlan = join(x.root, "project", "TASK_PLAN.md");
    mkdirSync(dirname(projectPlan), { recursive: true });
    const forgeries = [
      { plan_revision_id: "PLAN-Z" }, { plan_revision_id: "PLAN-0" },
      { content_digest: `sha256:${"9".repeat(64)}` }, { objective: "P0 forged objective" },
      { requirements_version: "REQ-FORGED" }, { current_item: "ITEM-ATTACKER", next_item: null, next_step: "attacker position" },
      { owner_gate: { kind: "HANDOFF_CONFIRM", status: "SATISFIED", satisfied_at: "2099-01-01T00:00:00.000Z" } },
      { updated_at: "2099-01-01T00:00:00.000Z" },
    ];
    for (const forgery of forgeries) {
      writeFileSync(projectPlan, canonicalJson({ ...p.reserved_plan_snapshot, ...forgery }));
      assert.deepEqual(x.authority.getPlanAuthorityForHandoff(p.handoff_id), protectedPlan);
    }
    const after = x.authority.getPlanAuthorityForHandoff(p.handoff_id);

    const target = "SESSION-NEXT"; bind(x.authority, p, target);
    const conflicting = projection({ task: p.task_id, handoff: "HO-INPUT-NEXT", source: target, runner: p.runner_instance_id, binding: "BIND-NEXT", revision: p.task_plan_revision, objective: "same revision, conflicting semantics", checkpoint: "CP-NEXT", manifest: "RM-NEXT" });
    conflicting.task_plan_digest = p.task_plan_digest;
    conflicting.reserved_plan_snapshot.content_digest = p.task_plan_digest;
    assert.throws(() => reserve(x.authority, conflicting, { handoff_id: p.handoff_id, reservation_digest: result.reservation.reservation_digest }),
      (error) => error.code === "PLAN_AUTHORITY_CONFLICT");
    assert.equal(x.authority.getHandoffReservation(conflicting.handoff_id), null, "plan conflict must roll back the whole next reservation graph");
  } finally { x.close(); }
});

test("bounded 1.4 upgrade backfills protected reservation plan identity but never trusts project artifacts retroactively", () => {
  const x = fixture("upgrade");
  const p = projection(); reserve(x.authority, p); x.close();
  const legacy = new DatabaseSync(join(x.root, "canonical", "operations.sqlite"));
  legacy.exec("DROP TABLE artifact_authority; DROP TABLE handoff_plan_authority; DROP TABLE plan_authority_snapshots; UPDATE authority_metadata SET schema_version='aiopago.operation-authority/1.4.0' WHERE singleton=1;");
  legacy.close();
  const upgraded = new ProtectedSqliteOperationAuthority(join(x.root, "canonical", "operations.sqlite"));
  try {
    assert.equal(upgraded.status().schema, "aiopago.operation-authority/1.5.0");
    assert.equal(upgraded.getPlanAuthorityForHandoff(p.handoff_id).plan_revision_id, p.task_plan_revision);
    assert.equal(upgraded.getArtifactAuthority("checkpoint", p.checkpoint_id), null, "old project digest/index must not become protected authority");
  } finally { upgraded.close(); }
});

test("checkpoint and manifest identities are protected, mutually bound, idempotent, and recovery readiness is read-only", () => {
  const x = fixture("ready");
  try {
    const p = projection(); reserve(x.authority, p); bind(x.authority, p);
    const sealed = seal(x, p);
    const before = { cp: x.authority.getArtifactAuthority("checkpoint", p.checkpoint_id), rm: x.authority.getArtifactAuthority("manifest", p.resume_manifest_id) };
    const ready = x.artifacts.recoveryInputReadiness(p.handoff_id);
    assert.equal(ready.result, "RECOVERY_INPUT_READY"); assert.equal(ready.ready, true); assert.equal(ready.recovery_authority_available, false);
    storageDatabaseForInternalTest(x.storage).prepare("INSERT INTO handoffs(handoff_id,source_session_id,target_session_id,task_id,state,latch_generation,projection_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(p.handoff_id, p.source_session_id, "TARGET-FORGED", p.task_id, "RESUME_DISPATCH_UNKNOWN", 999999, JSON.stringify({ ...p, state: "RESUME_DISPATCH_UNKNOWN", dispatch_state: "UNKNOWN" }), p.created_at, "2099-01-01T00:00:00.000Z");
    assert.equal(x.artifacts.recoveryInputReadiness(p.handoff_id).result, "RECOVERY_INPUT_READY", "forged project UNKNOWN is not a protected recovery subject");
    assert.deepEqual(x.authority.getArtifactAuthority("checkpoint", p.checkpoint_id), before.cp);
    assert.deepEqual(x.authority.getArtifactAuthority("manifest", p.resume_manifest_id), before.rm);
    assert.equal(x.authority.requestArtifactRegistration("CP-A", {
      kind: "checkpoint", artifact_id: p.checkpoint_id, handoff_id: p.handoff_id,
      artifact_digest: sealed.checkpoint.digest, content_digest: sealed.checkpoint.content_digest,
      plan_semantic_digest: sealed.planDigest,
    }).idempotent, true);
    assert.throws(() => x.authority.requestArtifactRegistration("CP-CONFLICT", {
      kind: "checkpoint", artifact_id: p.checkpoint_id, handoff_id: p.handoff_id,
      artifact_digest: `sha256:${"9".repeat(64)}`, content_digest: sealed.checkpoint.content_digest,
      plan_semantic_digest: sealed.planDigest,
    }), (error) => error.code === "ARTIFACT_AUTHORITY_CONFLICT");
  } finally { x.close(); }
});

test("byte replacement, truncation, delete/recreate, and path substitution never change protected expected artifact identity", async (t) => {
  for (const attack of ["replace", "truncate", "delete-recreate", "rename-substitute", "hardlink", "symlink"]) {
    await t.test(attack, () => {
      const x = fixture(attack);
      try {
        const p = projection(); reserve(x.authority, p); bind(x.authority, p); seal(x, p);
        const expected = x.authority.getArtifactAuthority("checkpoint", p.checkpoint_id);
        const path = x.artifacts.path("checkpoint", p.checkpoint_id);
        if (attack === "replace") writeFileSync(path, Buffer.from("forged checkpoint\n"));
        if (attack === "truncate") writeFileSync(path, Buffer.alloc(0));
        if (attack === "delete-recreate") { unlinkSync(path); writeFileSync(path, Buffer.from("recreated\n")); }
        if (attack === "rename-substitute") { renameSync(path, `${path}.original`); writeFileSync(path, Buffer.from("renamed substitute\n")); }
        if (attack === "hardlink") {
          const other = join(x.root, "attacker-hardlink.json"); writeFileSync(other, Buffer.from("hardlinked forgery\n")); unlinkSync(path); linkSync(other, path);
        }
        if (attack === "symlink") {
          const other = join(x.root, "attacker-checkpoint.json"); writeFileSync(other, Buffer.from("linked forgery\n")); unlinkSync(path);
          try { symlinkSync(other, path, "file"); }
          catch (error) { t.diagnostic(`symlink unavailable: ${error.code}`); return; }
        }
        assert.throws(() => x.artifacts.recoveryInputReadiness(p.handoff_id),
          (error) => ["CHECKPOINT_MISMATCH", "ARTIFACT_CONTENT_MISMATCH"].includes(error.code));
        assert.deepEqual(x.authority.getArtifactAuthority("checkpoint", p.checkpoint_id), expected);
      } finally { x.close(); }
    });
  }
});

test("verify-use consumes detached A bytes even when P0 replaces the path with B immediately afterward", () => {
  const x = fixture("toctou");
  try {
    const p = projection(); reserve(x.authority, p); bind(x.authority, p); const sealed = seal(x, p);
    const verifiedA = x.artifacts.verify("manifest", p.resume_manifest_id, undefined, p.handoff_id);
    const exactA = Buffer.from(verifiedA.bytes);
    writeFileSync(x.artifacts.path("manifest", p.resume_manifest_id), Buffer.from("replacement B\n"));
    assert.equal(verifiedA.bytes.equals(exactA), true);
    assert.equal(verifiedA.payload.objective, p.reserved_plan_snapshot.objective);
    assert.throws(() => x.artifacts.verify("manifest", p.resume_manifest_id, undefined, p.handoff_id), (error) => error.code === "MANIFEST_MISMATCH");
    assert.equal(readFileSync(x.artifacts.path("manifest", p.resume_manifest_id), "utf8"), "replacement B\n");
    assert.equal(sealed.manifest.digest, x.authority.getArtifactAuthority("manifest", p.resume_manifest_id).artifact_digest);
  } finally { x.close(); }
});

test("recovery-input sentinel rejects forged plan, cross-handoff artifacts, and stale lifecycle without recovery mutation", () => {
  const x = fixture("sentinel");
  try {
    const a = projection(); reserve(x.authority, a); const bindingA = bind(x.authority, a); const sealedA = seal(x, a);
    const b = projection({ task: "TASK-INPUT-B", handoff: "HO-INPUT-B", source: "SESSION-SOURCE-B", runner: "RUNNER-B", binding: "BIND-B", revision: "PLAN-B", objective: "B", checkpoint: "CP-B", manifest: "RM-B" });
    reserve(x.authority, b); bind(x.authority, b); const sealedB = seal(x, b);
    const planA = x.authority.getPlanAuthorityForHandoff(a.handoff_id).snapshot;
    assert.throws(() => x.authority.recoveryInputReadiness({
      handoff_id: a.handoff_id, plan: { ...planA, objective: "forged" }, checkpoint: actual(sealedA.checkpoint), manifest: actual(sealedA.manifest),
    }), (error) => error.code === "RECOVERY_INPUT_PLAN_MISMATCH");
    assert.throws(() => x.authority.recoveryInputReadiness({
      handoff_id: a.handoff_id, plan: planA, checkpoint: actual(sealedA.checkpoint), manifest: actual(sealedB.manifest),
    }), (error) => ["MANIFEST_MISMATCH", "RECOVERY_INPUT_RELATIONSHIP_MISMATCH"].includes(error.code));
    x.authority.requestLifecycleBindingTransition("STALE-A", { expected: bindingA, nextStatus: "SUPERSEDED", reason: "session_shutdown" });
    assert.throws(() => x.authority.recoveryInputReadiness({
      handoff_id: a.handoff_id, plan: planA, checkpoint: actual(sealedA.checkpoint), manifest: actual(sealedA.manifest),
    }), (error) => error.code === "RECOVERY_INPUT_LIFECYCLE_STALE");
    assert.equal(x.authority.getResumeState(a.handoff_id).authorization, null);
  } finally { x.close(); }
});

test("M-07 sealed failed-manifest tamper is rejected before every protected recovery-adjacent mutation", () => {
  const x = fixture("m07");
  try {
    const p = projection(); reserve(x.authority, p); bind(x.authority, p); seal(x, p);
    const manifestPath = x.artifacts.path("manifest", p.resume_manifest_id);
    const envelope = JSON.parse(readFileSync(manifestPath, "utf8"));
    envelope.payload.objective = "P0 replacement semantics";
    envelope.payload.minimal_reads = ["attacker-read"];
    envelope.payload.content_digest = digestObject({ ...envelope.payload, content_digest: null });
    const forgedBytes = Buffer.from(`${canonicalJson(envelope)}\n`);
    writeFileSync(manifestPath, forgedBytes);
    storageDatabaseForInternalTest(x.storage).prepare("UPDATE artifacts SET digest=?,content_digest=? WHERE kind='manifest' AND artifact_id=?")
      .run(sha256(forgedBytes), envelope.payload.content_digest, p.resume_manifest_id);
    assert.throws(() => x.artifacts.recoveryInputReadiness(p.handoff_id),
      (error) => ["MANIFEST_MISMATCH", "ARTIFACT_CONTENT_MISMATCH"].includes(error.code));
    assert.equal(x.authority.getLifecycleBinding(p.handoff_id).status, "ACTIVE");
    const resume = x.authority.getResumeState(p.handoff_id);
    assert.equal(resume.readiness, null); assert.equal(resume.authorization, null); assert.equal(resume.admission, null); assert.equal(resume.dispatch, null);
  } finally { x.close(); }
});

test("protected manifest expected identity rejects every behavior-significant P0 semantic rewrite even with self-consistent project hashes", async (t) => {
  const x = fixture("manifest-matrix");
  try {
    const p = projection(); reserve(x.authority, p); bind(x.authority, p); seal(x, p);
    const path = x.artifacts.path("manifest", p.resume_manifest_id);
    const genuine = readFileSync(path);
    const attacks = [
      ["objective", "forged objective"], ["decisions", ["forged decision"]], ["tests", ["forged test"]],
      ["evidence", ["forged evidence"]], ["minimal_reads", ["attacker read"]], ["task_id", "TASK-FORGED"],
      ["task_plan_revision", "PLAN-FORGED"], ["task_plan_digest", `sha256:${"6".repeat(64)}`],
      ["checkpoint_id", "CP-FORGED"], ["handoff_id", "HO-FORGED"],
    ];
    for (const [field, value] of attacks) await t.test(field, () => {
      const envelope = JSON.parse(genuine.toString("utf8"));
      envelope.payload[field] = value;
      envelope.payload.content_digest = digestObject({ ...envelope.payload, content_digest: null });
      writeFileSync(path, `${canonicalJson(envelope)}\n`);
      assert.throws(() => x.artifacts.recoveryInputReadiness(p.handoff_id), (error) => error.code === "MANIFEST_MISMATCH");
      assert.equal(x.authority.getResumeState(p.handoff_id).readiness, null);
      writeFileSync(path, genuine);
    });
  } finally { x.close(); }
});

test("ambiguous protected DISPATCHING subject is recovery-input ready while recovery authority stays unavailable", () => {
  const x = fixture("ambiguous");
  try {
    const p = projection(); const { result, engaged } = reserve(x.authority, p); const binding = bind(x.authority, p); const sealed = seal(x, p);
    const prompt = "AIOPAGO_RESUME_V1\ntask_id=TASK-INPUT-A";
    const readiness = x.authority.requestResumeReadiness("READY-AMBIGUOUS", {
      handoff_id: p.handoff_id, reservation_digest: result.reservation.reservation_digest,
      binding, latch: exactLatch(engaged), checkpoint_digest: sealed.checkpoint.digest,
      resume_manifest_digest: sealed.manifest.digest, resume_prompt_id: "RP-AMBIGUOUS",
      resume_prompt_digest: sha256(Buffer.from(prompt)), resume_prompt: prompt, plan_semantic_digest: sealed.planDigest,
    }).readiness;
    const decided = x.authority.requestResumeDecision("YES-AMBIGUOUS", {
      answer: "YES", actor: "human:/aio-resume", handoff_id: p.handoff_id,
      readiness_digest: readiness.readiness_digest, resume_prompt_id: readiness.resume_prompt_id,
      authorization_id: "AUTH-AMBIGUOUS", admission_id: "ADM-AMBIGUOUS",
      idempotency_key: "resume:RP-AMBIGUOUS", dispatch_attempt_id: "DSP-AMBIGUOUS", attempt_no: 1,
      binding, latch: exactLatch(engaged),
    });
    assert.equal(decided.state.dispatch.state, "DISPATCHING");
    const ready = x.artifacts.recoveryInputReadiness(p.handoff_id);
    assert.equal(ready.result, "RECOVERY_INPUT_READY");
    assert.equal(ready.dispatch.state, "DISPATCHING");
    assert.equal(ready.recovery_authority_available, false);
  } finally { x.close(); }
});

test("artifact authority crash before COMMIT leaves no partial registration after restart", () => {
  const x = fixture("crash");
  const p = projection(); reserve(x.authority, p); bind(x.authority, p);
  const planDigest = planSemanticDigest(p.reserved_plan_snapshot, { requireAll: true });
  const request = { kind: "checkpoint", artifact_id: p.checkpoint_id, handoff_id: p.handoff_id, artifact_digest: `sha256:${"7".repeat(64)}`, content_digest: `sha256:${"8".repeat(64)}`, plan_semantic_digest: planDigest };
  const dbPath = x.authority.path; x.close();
  const moduleUrl = new URL("../src/protected-operation-authority.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { ProtectedSqliteOperationAuthority } from ${JSON.stringify(moduleUrl)};
    const authority = new ProtectedSqliteOperationAuthority(${JSON.stringify(dbPath)});
    authority.crashBeforeArtifactCommitForPhysicalTest("CRASH-CP", ${JSON.stringify(request)});
  `], { encoding: "utf8" });
  assert.equal(child.status, 103, child.stderr);
  const reopened = new ProtectedSqliteOperationAuthority(dbPath);
  try { assert.equal(reopened.getArtifactAuthority("checkpoint", p.checkpoint_id), null); }
  finally { reopened.close(); }
});
