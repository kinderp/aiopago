import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, digestObject, sha256, utcNow } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { assertNoSecrets } from "./secret-scan.mjs";

function safeId(id) {
  invariant(typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id), "ARTIFACT_ID_INVALID");
  return id;
}

export class ArtifactStore {
  constructor(root, storage) {
    this.root = resolve(root);
    this.storage = storage;
    mkdirSync(this.root, { recursive: true });
  }

  persist(kind, id, payload) {
    safeId(id);
    assertNoSecrets(payload);
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
    const directory = join(this.root, kind === "checkpoint" ? "checkpoints" : "manifests");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.json`);
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
    this.storage.indexArtifact({ kind, id, path: path.replaceAll("\\", "/"), digest, contentDigest });
    return { id, kind, path: path.replaceAll("\\", "/"), digest, content_digest: contentDigest, payload: sealedPayload, bytes };
  }

  verify(kind, id, expectedDigest = undefined) {
    const index = this.storage.getArtifact(kind, id);
    invariant(index && !index.superseded, index?.superseded ? "SUPERSEDED_CHECKPOINT" : "ARTIFACT_NOT_FOUND", id);
    const bytes = readFileSync(index.path);
    const digest = sha256(bytes);
    invariant(digest === index.digest && (!expectedDigest || digest === expectedDigest), kind === "checkpoint" ? "CHECKPOINT_MISMATCH" : "MANIFEST_MISMATCH");
    const envelope = JSON.parse(bytes.toString("utf8"));
    invariant(envelope.artifact_kind === kind && envelope.artifact_id === id, "ARTIFACT_IDENTITY_MISMATCH");
    const contentDigest = envelope.payload.content_digest;
    invariant(digestObject({ ...envelope.payload, content_digest: null }) === contentDigest && contentDigest === index.content_digest, "ARTIFACT_CONTENT_MISMATCH");
    assertNoSecrets(envelope.payload);
    return { ...index, bytes, digest, payload: envelope.payload };
  }
}
