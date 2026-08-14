import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256, utcNow } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

const BLOCK = /```json task-ledger\s*\r?\n([\s\S]*?)\r?\n```/;
const TASK_STATUS_VALUES = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED", "SUPERSEDED"];
const TASK_STATES = new Set(TASK_STATUS_VALUES);
const TASK_STATUS_MESSAGE = `status must be one of ${TASK_STATUS_VALUES.join(", ")}`;
const MAX_RESUME_LIST_ENTRIES = 64;
const MAX_RESUME_ENTRY_LENGTH = 2048;

function validateBoundedStringList(value, field, code = "LEDGER_RESUME_CONTEXT_INVALID") {
  invariant(Array.isArray(value) && value.length <= MAX_RESUME_LIST_ENTRIES, code, `${field} must be an array with at most ${MAX_RESUME_LIST_ENTRIES} entries`);
  for (const entry of value) invariant(typeof entry === "string" && entry.length > 0 && entry.length <= MAX_RESUME_ENTRY_LENGTH, code, `${field} entries must be non-empty bounded strings`);
  return value;
}

export function validateRequiredLocalPaths(value, code = "LEDGER_REQUIRED_LOCAL_PATH_INVALID") {
  validateBoundedStringList(value, "required_local_paths", code);
  for (const path of value) {
    const components = path.split("/");
    invariant(!path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && components.every((component) => component.length > 0 && component !== "." && component !== ".."), code, `required_local_paths entries must be normalized repo-relative paths: ${path}`);
  }
  return value;
}

export function canonicalRequiredLocalPaths(value = [], code = "LEDGER_REQUIRED_LOCAL_PATH_INVALID") {
  validateRequiredLocalPaths(value, code);
  const canonical = [...new Set(["TASK_PLAN.md", ...value])];
  invariant(canonical.length <= MAX_RESUME_LIST_ENTRIES, code, `required_local_paths including TASK_PLAN.md must have at most ${MAX_RESUME_LIST_ENTRIES} entries`);
  return canonical;
}

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
      current_item: task.current_item,
      next_item: task.next_item,
    });
  }

  satisfyOwnerGate({ command, actor }) {
    const bytes = readFileSync(this.path);
    const text = bytes.toString("utf8");
    const match = text.match(BLOCK);
    invariant(match, "LEDGER_FORMAT_INVALID", "TASK_PLAN.md must contain one json task-ledger block");
    let task;
    try { task = JSON.parse(match[1]); }
    catch (error) { invariant(false, "LEDGER_JSON_INVALID", error.message); }
    this.validate(task);
    const gate = task.owner_gate;
    if (!gate || gate.status === "SATISFIED") return this.read();
    invariant(gate.kind === "HANDOFF_CONFIRM" && gate.status === "BLOCKED", "OWNER_GATE_INVALID");
    invariant(command === gate.command && actor?.startsWith("human:"), "OWNER_GATE_AUTHORIZATION_REQUIRED");
    invariant(task.current_item === null && task.next_item === gate.item_id, "OWNER_GATE_LIFECYCLE_MISMATCH");
    const item = task.task_items.find((candidate) => candidate.task_item_id === gate.item_id);
    invariant(item?.status === "BLOCKED", "OWNER_GATE_ITEM_NOT_BLOCKED");
    invariant(typeof gate.satisfied_plan_revision_id === "string" && gate.satisfied_plan_revision_id !== task.plan_revision_id, "OWNER_GATE_REVISION_REQUIRED");
    invariant(typeof gate.satisfied_next_step === "string" && gate.satisfied_next_step.length > 0 && !gate.satisfied_next_step.includes(gate.command), "OWNER_GATE_NEXT_STEP_INVALID");
    const previousRevision = task.plan_revision_id;
    const previousUpdatedAt = task.updated_at;
    const now = utcNow();
    gate.status = "SATISFIED";
    gate.satisfied_at = now;
    gate.satisfied_by = actor;
    task.plan_revision_id = gate.satisfied_plan_revision_id;
    task.status = gate.satisfied_task_status ?? "IN_PROGRESS";
    task.updated_at = now;
    task.current_item = gate.item_id;
    task.next_item = gate.satisfied_next_item ?? null;
    task.next_step = gate.satisfied_next_step;
    item.status = "IN_PROGRESS";
    item.last_updated_at = now;
    item.last_updated_by = actor;
    this.validate(task);
    const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
    const json = JSON.stringify(task, null, 2).replaceAll("\n", lineEnding);
    const updated = text.replace(match[1], json)
      .replace(`**Current revision:** \`${previousRevision}\``, `**Current revision:** \`${task.plan_revision_id}\``)
      .replace(`**Updated:** ${previousUpdatedAt}`, `**Updated:** ${now}`);
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, updated, "utf8");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, this.path);
      try { const dirFd = openSync(dirname(this.path), "r"); fsyncSync(dirFd); closeSync(dirFd); } catch {}
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
    return this.read();
  }

  validate(task) {
    for (const field of ["schema_version", "task_id", "title", "objective", "requirements_version", "plan_revision_id", "status", "completion_criteria", "risk", "created_at", "updated_at", "current_item", "next_item", "next_step", "task_items"]) {
      invariant(Object.hasOwn(task, field), "LEDGER_FIELD_MISSING", `Ledger missing ${field}`);
    }
    invariant(task.schema_version === "0.1.0", "LEDGER_SCHEMA_UNSUPPORTED");
    invariant(TASK_STATES.has(task.status), "LEDGER_STATUS_INVALID", `task ${TASK_STATUS_MESSAGE}`);
    if (Object.hasOwn(task, "minimal_reads")) validateBoundedStringList(task.minimal_reads, "minimal_reads");
    canonicalRequiredLocalPaths(Object.hasOwn(task, "required_local_paths") ? task.required_local_paths : []);
    invariant(Array.isArray(task.task_items) && task.task_items.length > 0, "LEDGER_ITEMS_INVALID");
    if (task.status === "DONE") {
      invariant(Array.isArray(task.evidence) && task.evidence.length > 0, "DONE_WITHOUT_EVIDENCE");
      invariant(task.task_items.every((item) => ["DONE", "DROPPED", "SUPERSEDED"].includes(item.status)), "DONE_WITH_OPEN_ITEMS");
    }
    const ids = new Set();
    for (const item of task.task_items) {
      invariant(item.task_id === task.task_id, "LEDGER_TASK_ID_MISMATCH");
      invariant(typeof item.task_item_id === "string" && !ids.has(item.task_item_id), "LEDGER_ITEM_ID_INVALID");
      invariant(TASK_STATES.has(item.status), "LEDGER_ITEM_STATUS_INVALID", `item ${TASK_STATUS_MESSAGE}`);
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
    const inProgress = task.task_items.filter((item) => item.status === "IN_PROGRESS");
    invariant(inProgress.length <= 1, "LEDGER_MULTIPLE_CURRENT_ITEMS", "at most one item may be IN_PROGRESS");
    invariant(task.current_item === null || (typeof task.current_item === "string" && ids.has(task.current_item)), "LEDGER_CURRENT_ITEM_INVALID", "current_item must be null or reference an existing item");
    invariant(task.next_item === null || (typeof task.next_item === "string" && ids.has(task.next_item)), "LEDGER_NEXT_ITEM_INVALID", "next_item must be null or reference an existing item");
    invariant(task.current_item !== task.next_item || task.current_item === null, "LEDGER_LIFECYCLE_INVALID", "current_item and next_item must differ");
    if (task.current_item === null) invariant(inProgress.length === 0, "LEDGER_CURRENT_ITEM_MISMATCH", "current_item must reference the sole IN_PROGRESS item, or be null when none is IN_PROGRESS");
    else invariant(inProgress.length === 1 && inProgress[0].task_item_id === task.current_item, "LEDGER_CURRENT_ITEM_MISMATCH", "current_item must reference the sole IN_PROGRESS item");
    if (task.next_item !== null) invariant(["PLANNED", "BLOCKED"].includes(byId.get(task.next_item).status), "LEDGER_NEXT_ITEM_INVALID", "next_item must reference a PLANNED or BLOCKED item");
    if (task.status === "DONE") invariant(task.current_item === null && task.next_item === null, "DONE_WITH_OPEN_LIFECYCLE");
  }
}
