import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, digestObject, sha256, utcNow } from "./canonical.mjs";
import { fail, invariant } from "./errors.mjs";
import { requireSecureRecoveryInputAuthority } from "./recovery-input-authority.mjs";

const SECRET_KEY = /(^|_)(api_?key|access_?token|refresh_?token|password|secret|credential)s?($|_)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/;

function scan(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && child != null) fail("SECRET_SCAN_FAILED", `Sensitive field at ${path}.${key}`);
      scan(child, `${path}.${key}`);
    }
  } else if (typeof value === "string" && SECRET_VALUE.test(value)) fail("SECRET_SCAN_FAILED", `Secret-shaped value at ${path}`);
}

function safeId(id) {
  invariant(typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id), "ARTIFACT_ID_INVALID");
  return id;
}

export class ArtifactStore {
  constructor(root, storage, { authority = null } = {}) {
    this.root = resolve(root);
    this.storage = storage;
    this.authority = authority ? requireSecureRecoveryInputAuthority(authority) : null;
    mkdirSync(this.root, { recursive: true });
  }

  path(kind, id) {
    safeId(id);
    invariant(kind === "checkpoint" || kind === "manifest", "ARTIFACT_KIND_INVALID");
    return join(this.root, kind === "checkpoint" ? "checkpoints" : "manifests", `${id}.json`);
  }

  persist(kind, id, payload, relationship = null) {
    safeId(id);
    scan(payload);
    const contentBase = { ...structuredClone(payload), content_digest: null };
    const contentDigest = digestObject(contentBase);
    const sealedPayload = { ...contentBase, content_digest: contentDigest };
    const envelope = {
      artifact_version: "1.0.0",
      artifact_kind: kind,
      artifact_id: id,
      sealed_at: payload.created_at ?? utcNow(),
      payload: sealedPayload,
    };
    const bytes = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
    const digest = sha256(bytes);
    const path = this.path(kind, id);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    if (existsSync(path)) {
      const prior = readFileSync(path);
      invariant(prior.equals(bytes), "ARTIFACT_ID_CONFLICT", `${id} already exists with different bytes`);
    } else {
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      let fd;
      try {
        fd = openSync(temp, "wx", 0o600);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        renameSync(temp, path);
        try { const dirFd = openSync(dirname(path), "r"); fsyncSync(dirFd); closeSync(dirFd); } catch {}
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temp)) unlinkSync(temp);
        throw error;
      }
    }
    let protectedIdentity = null;
    if (this.authority) {
      invariant(relationship && typeof relationship === "object", "ARTIFACT_AUTHORITY_RELATIONSHIP_REQUIRED");
      protectedIdentity = this.authority.requestArtifactRegistration(`${kind}:${id}`, {
        kind,
        artifact_id: id,
        handoff_id: relationship.handoffId,
        artifact_digest: digest,
        content_digest: contentDigest,
        plan_semantic_digest: relationship.planSemanticDigest,
        checkpoint_id: relationship.checkpointId ?? null,
        checkpoint_digest: relationship.checkpointDigest ?? null,
      }).artifact;
    }
    this.storage.indexArtifact({ kind, id, path: path.replaceAll("\\", "/"), digest, contentDigest });
    return { id, kind, path: path.replaceAll("\\", "/"), digest, content_digest: contentDigest, payload: sealedPayload, bytes, protected_identity: protectedIdentity };
  }

  recoveryInputReadiness(handoffId) {
    const authority = requireSecureRecoveryInputAuthority(this.authority);
    const reservation = authority.getHandoffReservation(handoffId);
    const plan = authority.getPlanAuthorityForHandoff(handoffId);
    invariant(reservation && plan, "RECOVERY_INPUT_PLAN_UNAVAILABLE");
    const checkpoint = this.verify("checkpoint", reservation.checkpoint_id, undefined, handoffId);
    const manifest = this.verify("manifest", reservation.resume_manifest_id, undefined, handoffId);
    return authority.recoveryInputReadiness({
      handoff_id: handoffId,
      plan: plan.snapshot,
      checkpoint: { artifact_id: checkpoint.artifact_id, artifact_digest: checkpoint.digest, content_digest: checkpoint.content_digest },
      manifest: { artifact_id: manifest.artifact_id, artifact_digest: manifest.digest, content_digest: manifest.content_digest },
    });
  }

  verify(kind, id, expectedDigest = undefined, expectedHandoffId = undefined) {
    const protectedIdentity = this.authority?.getArtifactAuthority(kind, id) ?? null;
    const index = this.authority ? null : this.storage.getArtifact(kind, id);
    invariant(protectedIdentity || (index && !index.superseded), index?.superseded ? "SUPERSEDED_CHECKPOINT" : "ARTIFACT_NOT_FOUND", id);
    if (this.authority && expectedHandoffId !== undefined) invariant(protectedIdentity?.handoff_id === expectedHandoffId,
      kind === "checkpoint" ? "CHECKPOINT_MISMATCH" : "MANIFEST_MISMATCH", "Artifact belongs to another protected handoff");
    const path = this.authority ? this.path(kind, id) : index.path;
    // One physical read produces the exact detached bytes that are hashed,
    // parsed, and returned to the privileged consumer. The path is never
    // reopened after verification, so a replacement cannot alter this use.
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    const authoritativeDigest = protectedIdentity?.artifact_digest ?? index.digest;
    invariant(digest === authoritativeDigest && (!expectedDigest || digest === expectedDigest), kind === "checkpoint" ? "CHECKPOINT_MISMATCH" : "MANIFEST_MISMATCH");
    const envelope = JSON.parse(bytes.toString("utf8"));
    invariant(envelope.artifact_kind === kind && envelope.artifact_id === id, "ARTIFACT_IDENTITY_MISMATCH");
    const contentDigest = envelope.payload.content_digest;
    const authoritativeContentDigest = protectedIdentity?.content_digest ?? index.content_digest;
    invariant(digestObject({ ...envelope.payload, content_digest: null }) === contentDigest && contentDigest === authoritativeContentDigest, "ARTIFACT_CONTENT_MISMATCH");
    if (this.authority) this.authority.verifyArtifactAuthority({
      kind, artifact_id: id, handoff_id: protectedIdentity.handoff_id,
      artifact_digest: digest, content_digest: contentDigest,
    });
    scan(envelope.payload);
    return { ...(protectedIdentity ?? index), path: path.replaceAll("\\", "/"), bytes, digest, content_digest: contentDigest, payload: envelope.payload };
  }
}
