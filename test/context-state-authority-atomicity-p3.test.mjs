import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONTEXT_STATE_STORAGE_SCHEMA_VERSION,
  ContextStateStore,
} from "../src/context-state.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const TASK = "TASK-P3-AUTHORITY";
const NOW = "2026-09-03T00:00:00.000Z";

function storagePath() {
  return join(mkdtempSync(join(tmpdir(), "aiopago-p3-authority-")), "guardian.sqlite");
}

function migrationTableExists(storage) {
  return Boolean(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_state_migrations'").get());
}

function contextIndexExists(storage) {
  return Boolean(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='context_state_event_type_seq'").get());
}

test("P3 conflicting pre-existing context authority blocks adoption before migration progress is recorded", () => {
  const storage = new GuardianStorage(storagePath());
  try {
    storage.db.prepare("INSERT INTO authorities(name,authority,schema_version) VALUES(?,?,?)")
      .run("context_state_journal", "foreign authority owner", "0.1.0");

    assert.throws(
      () => new ContextStateStore(storage, TASK),
      (error) => error?.code === "CONTEXT_STATE_STORAGE_METADATA_INVALID"
        && error?.details?.observed_authority === "foreign authority owner"
        && /Do not downgrade/.test(error?.details?.remediation ?? ""),
    );

    assert.equal(migrationTableExists(storage), false, "conflicting authority must block before migration table creation");
    assert.equal(contextIndexExists(storage), false, "conflicting authority must block before context index creation");
    assert.deepEqual(
      { ...storage.db.prepare("SELECT authority,schema_version FROM authorities WHERE name='context_state_journal'").get() },
      { authority: "foreign authority owner", schema_version: "0.1.0" },
      "failed adoption must not overwrite the pre-existing authority claim",
    );
  } finally {
    storage.close();
  }
});

test("P3 recorded migration without its required authority metadata fails closed on open", () => {
  const storage = new GuardianStorage(storagePath());
  try {
    storage.db.exec("CREATE TABLE context_state_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    storage.db.prepare("INSERT INTO context_state_migrations(version,applied_at) VALUES(?,?)")
      .run(CONTEXT_STATE_STORAGE_SCHEMA_VERSION, NOW);

    assert.throws(
      () => new ContextStateStore(storage, TASK),
      (error) => error?.code === "CONTEXT_STATE_STORAGE_METADATA_INVALID"
        && /missing/.test(error?.message ?? "")
        && /Do not downgrade/.test(error?.details?.remediation ?? ""),
    );

    assert.equal(contextIndexExists(storage), false, "invalid migration metadata must block before access-index creation");
    assert.deepEqual(
      storage.db.prepare("SELECT version FROM context_state_migrations ORDER BY version").all().map((row) => row.version),
      [CONTEXT_STATE_STORAGE_SCHEMA_VERSION],
      "open failure must not rewrite migration history",
    );
  } finally {
    storage.close();
  }
});
