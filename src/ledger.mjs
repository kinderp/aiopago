import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

const BLOCK = /```json task-ledger\s*\r?\n([\s\S]*?)\r?\n```/;
const TASK_STATES = new Set(["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED", "SUPERSEDED"]);

export class TaskLedger {
  constructor(path = "TASK_PLAN.md") {
    this.path = resolve(path);
  }

  read() {
    const bytes = readFileSync(this.path);
    const text = bytes.toString("utf8");
    const match = text.match(BLOCK);
    invariant(match, "LEDGER_FORMAT_INVALID", "TASK_PLAN.md must contain one json task-ledger block");
    let task;
    try { task = JSON.parse(match[1]); }
    catch (error) { invariant(false, "LEDGER_JSON_INVALID", error.message); }
    this.validate(task);
    return Object.freeze({
      ...structuredClone(task),
      content_digest: sha256(bytes),
      path: this.path,
      current_item: task.task_items.find((item) => item.status === "IN_PROGRESS")?.task_item_id ?? null,
    });
  }

  validate(task) {
    for (const field of ["schema_version", "task_id", "title", "objective", "requirements_version", "plan_revision_id", "status", "completion_criteria", "risk", "created_at", "updated_at", "next_step", "task_items"]) {
      invariant(Object.hasOwn(task, field), "LEDGER_FIELD_MISSING", `Ledger missing ${field}`);
    }
    invariant(task.schema_version === "0.1.0", "LEDGER_SCHEMA_UNSUPPORTED");
    invariant(TASK_STATES.has(task.status), "LEDGER_STATUS_INVALID");
    invariant(Array.isArray(task.task_items) && task.task_items.length > 0, "LEDGER_ITEMS_INVALID");
    if (task.status === "DONE") {
      invariant(Array.isArray(task.evidence) && task.evidence.length > 0, "DONE_WITHOUT_EVIDENCE");
      invariant(task.task_items.every((item) => ["DONE", "DROPPED", "SUPERSEDED"].includes(item.status)), "DONE_WITH_OPEN_ITEMS");
    }
    const ids = new Set();
    for (const item of task.task_items) {
      invariant(item.task_id === task.task_id, "LEDGER_TASK_ID_MISMATCH");
      invariant(typeof item.task_item_id === "string" && !ids.has(item.task_item_id), "LEDGER_ITEM_ID_INVALID");
      invariant(TASK_STATES.has(item.status), "LEDGER_ITEM_STATUS_INVALID");
      invariant(Array.isArray(item.depends_on) && Array.isArray(item.completion_criteria) && Array.isArray(item.evidence), "LEDGER_ITEM_FIELDS_INVALID");
      if (item.status === "DONE") invariant(item.completion_criteria.length > 0 && item.evidence.length > 0, "DONE_WITHOUT_EVIDENCE");
      ids.add(item.task_item_id);
    }
    for (const item of task.task_items) for (const dependency of item.depends_on) invariant(ids.has(dependency), "LEDGER_DEPENDENCY_UNKNOWN", dependency);
    const visiting = new Set();
    const visited = new Set();
    const byId = new Map(task.task_items.map((item) => [item.task_item_id, item]));
    const visit = (id) => {
      invariant(!visiting.has(id), "LEDGER_DAG_CYCLE", id);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id).depends_on) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
    invariant(task.task_items.filter((item) => item.status === "IN_PROGRESS").length <= 1, "LEDGER_MULTIPLE_CURRENT_ITEMS");
  }
}
