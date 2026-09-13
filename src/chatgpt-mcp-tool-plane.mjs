import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { invariant } from "./errors.mjs";
import { assertNoSecrets } from "./secret-scan.mjs";

export const CHATGPT_MCP_TOOL_PLANE_VERSION = "0.1.0";
export const CHATGPT_MCP_MAX_FILE_CHARS = 120_000;
export const CHATGPT_MCP_MAX_SEARCH_RESULTS = 40;

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

export const CHATGPT_MCP_READ_TOOLS = Object.freeze([
  Object.freeze({
    name: "aiopago_project_status",
    title: "Aiopago project status",
    description: "Read the current Aiopago task, Git projection, and worktree status for the active local project.",
    inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "aiopago_read_file",
    title: "Read project file",
    description: "Read a bounded UTF-8 text file inside the active Aiopago target repository. Paths outside the repository, symlink escapes, reserved runtime state, binary files, and secret-shaped output are refused.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        path: Object.freeze({ type: "string", minLength: 1, description: "Repository-relative file path" }),
        max_chars: Object.freeze({ type: "integer", minimum: 1, maximum: CHATGPT_MCP_MAX_FILE_CHARS }),
      }),
      required: Object.freeze(["path"]),
      additionalProperties: false,
    }),
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "aiopago_search_repo",
    title: "Search project repository",
    description: "Search tracked project text with git grep and return a bounded set of matching lines. The search is read-only and shell-free.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({ type: "string", minLength: 1, maxLength: 512 }),
        max_results: Object.freeze({ type: "integer", minimum: 1, maximum: CHATGPT_MCP_MAX_SEARCH_RESULTS }),
      }),
      required: Object.freeze(["query"]),
      additionalProperties: false,
    }),
    annotations: READ_ONLY_ANNOTATIONS,
  }),
]);

function insideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function safeRelativePath(targetRoot, requestedPath) {
  invariant(typeof requestedPath === "string" && requestedPath.trim(), "CHATGPT_MCP_PATH_REQUIRED", "path must be a non-empty repository-relative string");
  invariant(!isAbsolute(requestedPath), "CHATGPT_MCP_PATH_ABSOLUTE", "absolute paths are not admitted by the ChatGPT MCP read surface");
  const root = realpathSync(resolve(targetRoot));
  const absolute = resolve(root, requestedPath);
  invariant(insideRoot(root, absolute), "CHATGPT_MCP_PATH_ESCAPE", "requested path escapes the target repository");
  const rel = relative(root, absolute).replaceAll("\\", "/");
  invariant(!rel.startsWith(".git/") && rel !== ".git", "CHATGPT_MCP_PATH_RESERVED", ".git is not exposed to ChatGPT MCP file reads");
  invariant(!rel.startsWith(".guardian/runtime/") && rel !== ".guardian/runtime", "CHATGPT_MCP_PATH_RESERVED", "Aiopago runtime state is not exposed to ChatGPT MCP file reads");
  invariant(existsSync(absolute), "CHATGPT_MCP_FILE_NOT_FOUND", `file not found: ${rel}`);
  const linkStat = lstatSync(absolute);
  invariant(!linkStat.isSymbolicLink(), "CHATGPT_MCP_PATH_SYMLINK", "symlink file reads are not admitted by the ChatGPT MCP surface");
  const canonical = realpathSync(absolute);
  invariant(insideRoot(root, canonical), "CHATGPT_MCP_PATH_ESCAPE", "canonical file path escapes the target repository");
  invariant(statSync(canonical).isFile(), "CHATGPT_MCP_PATH_NOT_FILE", `not a regular file: ${rel}`);
  return Object.freeze({ root, absolute: canonical, relative: rel });
}

function boundedInteger(value, fallback, max, code) {
  const resolved = value == null ? fallback : Number(value);
  invariant(Number.isInteger(resolved) && resolved >= 1 && resolved <= max, code, `${code}: expected integer between 1 and ${max}`);
  return resolved;
}

function boundedTextFile(targetRoot, path, maxChars = CHATGPT_MCP_MAX_FILE_CHARS) {
  const resolved = safeRelativePath(targetRoot, path);
  const limit = boundedInteger(maxChars, CHATGPT_MCP_MAX_FILE_CHARS, CHATGPT_MCP_MAX_FILE_CHARS, "CHATGPT_MCP_MAX_CHARS_INVALID");
  const size = statSync(resolved.absolute).size;
  invariant(size <= CHATGPT_MCP_MAX_FILE_CHARS * 4, "CHATGPT_MCP_FILE_TOO_LARGE", `file exceeds the MCP inspection ceiling: ${resolved.relative}`);
  const raw = readFileSync(resolved.absolute);
  invariant(!raw.includes(0), "CHATGPT_MCP_BINARY_FILE", `binary file is not exposed: ${resolved.relative}`);
  const text = raw.toString("utf8");
  const truncated = text.length > limit;
  const result = Object.freeze({
    path: resolved.relative,
    content: truncated ? text.slice(0, limit) : text,
    truncated,
    original_chars: text.length,
  });
  assertNoSecrets(result, "$.mcp.read_file");
  return result;
}

function gitSearch(targetRoot, query, maxResults = CHATGPT_MCP_MAX_SEARCH_RESULTS, execFile = execFileSync) {
  invariant(typeof query === "string" && query.trim(), "CHATGPT_MCP_SEARCH_QUERY_REQUIRED", "query must be non-empty");
  invariant(query.length <= 512, "CHATGPT_MCP_SEARCH_QUERY_TOO_LONG", "query exceeds 512 characters");
  const limit = boundedInteger(maxResults, CHATGPT_MCP_MAX_SEARCH_RESULTS, CHATGPT_MCP_MAX_SEARCH_RESULTS, "CHATGPT_MCP_SEARCH_LIMIT_INVALID");
  let output = "";
  try {
    output = execFile("git", ["-C", targetRoot, "grep", "-n", "-I", "-F", "-e", query, "--", "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.status === 1) output = "";
    else throw error;
  }
  const all = output.split(/\r?\n/).filter(Boolean);
  const matches = all.slice(0, limit).map((line) => {
    const first = line.indexOf(":");
    const second = first < 0 ? -1 : line.indexOf(":", first + 1);
    return second < 0
      ? Object.freeze({ raw: line.slice(0, 2_000) })
      : Object.freeze({ path: line.slice(0, first), line: Number(line.slice(first + 1, second)) || null, text: line.slice(second + 1, second + 1 + 2_000) });
  });
  const result = Object.freeze({ query, matches: Object.freeze(matches), truncated: all.length > limit, total_observed: all.length });
  assertNoSecrets(result, "$.mcp.search_repo");
  return result;
}

function projectStatus({ ledger, observeGit }) {
  invariant(ledger && typeof ledger.read === "function", "CHATGPT_MCP_LEDGER_REQUIRED");
  invariant(typeof observeGit === "function", "CHATGPT_MCP_GIT_OBSERVER_REQUIRED");
  const task = ledger.read();
  const git = observeGit();
  const result = Object.freeze({
    task: Object.freeze({
      task_id: task.task_id ?? null,
      title: task.title ?? null,
      objective: task.objective ?? null,
      status: task.status ?? null,
      current_item: task.current_item ?? null,
      next_item: task.next_item ?? null,
      next_step: task.next_step ?? null,
      plan_revision_id: task.plan_revision_id ?? null,
    }),
    git: Object.freeze({
      repository_id: git.repository_id ?? null,
      branch: git.branch ?? null,
      head_sha: git.head_sha ?? null,
      base_sha: git.base_sha ?? null,
      worktree_digest: git.worktree_digest ?? null,
      status_entries: Object.freeze((git.status_entries ?? []).slice(0, 100)),
    }),
  });
  assertNoSecrets(result, "$.mcp.project_status");
  return result;
}

export class ChatgptMcpReadToolPlane {
  constructor({ targetRoot, ledger, observeGit, execFile = execFileSync }) {
    invariant(typeof targetRoot === "string" && targetRoot, "CHATGPT_MCP_TARGET_ROOT_REQUIRED");
    this.targetRoot = realpathSync(resolve(targetRoot));
    this.ledger = ledger;
    this.observeGit = observeGit;
    this.execFile = execFile;
  }

  listTools() {
    return CHATGPT_MCP_READ_TOOLS;
  }

  callTool(name, input = {}) {
    invariant(input && typeof input === "object" && !Array.isArray(input), "CHATGPT_MCP_TOOL_INPUT_INVALID");
    if (name === "aiopago_project_status") return projectStatus(this);
    if (name === "aiopago_read_file") return boundedTextFile(this.targetRoot, input.path, input.max_chars);
    if (name === "aiopago_search_repo") return gitSearch(this.targetRoot, input.query, input.max_results, this.execFile);
    invariant(false, "CHATGPT_MCP_TOOL_UNKNOWN", `unknown ChatGPT MCP tool: ${name}`);
  }
}
