import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextStateStore } from "../src/context-state.mjs";
import { GuardianStorage } from "../src/storage.mjs";

const TASK = "TASK-P3-AUTHORITY-REVIEW";

function storagePath() {
  return join(mkdtempSync(join(tmpdir(), "aiopago-p3-authority-")), "guardian.sqlite");
}

test("P3 review: incompatible pre-existing context authority blocks migration atomically", () => {
  const storage = new GuardianStorage(storagePath());
  try {
    storage.db.prepare("INSERT INTO authorities(name,authority,schema_version) VALUES(?,?,?)")
      .run("context_state_journal", "foreign authority claim", "9.9.9");

    const before = storage.db.prepare("SELECT name,authority,schema_version FROM authorities WHERE name=?")
      .get("context_state_journal");

    assert.throws(
      () => new ContextStateStore(storage, TASK),
      (error) => error?.code === "CONTEXT_STATE_STORAGE_METADATA_INVALID"
        && error?.details?.observed_authority === "foreign authority claim"
        && error?.details?.observed_schema_version === "9.9.9"
        && /Do not downgrade/.test(error?.details?.remediation ?? ""),
    );

    const after = storage.db.prepare("SELECT name,authority,schema_version FROM authorities WHERE name=?")
      .get("context_state_journal");
    assert.deepEqual({ ...after }, { ...before }, "failed adoption must not overwrite the pre-existing authority claim");
    assert.equal(
      storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_state_migrations'").get(),
      undefined,
      "migration table must not be created after incompatible authority metadata",
    );
    assert.equal(
      storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='context_state_event_type_seq'").get(),
      undefined,
      "context-state access index must not be created after incompatible authority metadata",
    );
  } finally {
    storage.close();
  }
});
