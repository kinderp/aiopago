import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHATGPT_MCP_READ_TOOLS,
  ChatgptMcpReadToolPlane,
} from "../src/chatgpt-mcp-tool-plane.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiopago-mcp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".guardian", "runtime"), { recursive: true });
  writeFileSync(join(root, "src", "authority.ts"), "export const authorityEpoch = 4;\n");
  writeFileSync(join(root, ".guardian", "runtime", "guardian.sqlite"), "private-runtime");
  const ledger = {
    read: () => ({
      task_id: "TASK-MCP",
      title: "MCP tool plane",
      objective: "Expose bounded local read context",
      status: "IN_PROGRESS",
      current_item: "ITEM-1",
      next_item: null,
      next_step: "test",
      plan_revision_id: "PLAN-1",
    }),
  };
  const observeGit = () => ({
    repository_id: "repo",
    branch: "feat/mcp",
    head_sha: "abc",
    base_sha: "abc",
    worktree_digest: "digest",
    status_entries: [" M src/authority.ts"],
  });
  return { root, ledger, observeGit };
}

test("MCP catalog is explicitly read-only", () => {
  assert.deepEqual(CHATGPT_MCP_READ_TOOLS.map((tool) => tool.name), [
    "aiopago_project_status",
    "aiopago_read_file",
    "aiopago_search_repo",
  ]);
  for (const tool of CHATGPT_MCP_READ_TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
});

test("project status exposes bounded task and Git projection", () => {
  const f = fixture();
  const plane = new ChatgptMcpReadToolPlane(f);
  const status = plane.callTool("aiopago_project_status");
  assert.equal(status.task.task_id, "TASK-MCP");
  assert.equal(status.git.branch, "feat/mcp");
  assert.deepEqual(status.git.status_entries, [" M src/authority.ts"]);
});

test("read_file stays inside repo and blocks runtime state", () => {
  const f = fixture();
  const plane = new ChatgptMcpReadToolPlane(f);
  const file = plane.callTool("aiopago_read_file", { path: "src/authority.ts" });
  assert.match(file.content, /authorityEpoch/);
  assert.equal(file.truncated, false);
  assert.throws(() => plane.callTool("aiopago_read_file", { path: "../outside.txt" }), (error) => error?.code === "CHATGPT_MCP_PATH_ESCAPE");
  assert.throws(() => plane.callTool("aiopago_read_file", { path: ".guardian/runtime/guardian.sqlite" }), (error) => error?.code === "CHATGPT_MCP_PATH_RESERVED");
});

test("read_file secret scans content before returning it", () => {
  const f = fixture();
  writeFileSync(join(f.root, "src", "secret.txt"), "token=sk-abcdefghijklmnop\n");
  const plane = new ChatgptMcpReadToolPlane(f);
  assert.throws(() => plane.callTool("aiopago_read_file", { path: "src/secret.txt" }), (error) => error?.code === "SECRET_SCAN_FAILED");
});

test("search_repo invokes git without a shell and bounds results", () => {
  const f = fixture();
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    return "src/a.ts:1:authority epoch\nsrc/b.ts:2:authority epoch\n";
  };
  const plane = new ChatgptMcpReadToolPlane({ ...f, execFile });
  const result = plane.callTool("aiopago_search_repo", { query: "authority; rm -rf /", max_results: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args.slice(0, 7), ["-C", f.root, "grep", "-n", "-I", "-F", "-e"]);
  assert.equal(calls[0].args[7], "authority; rm -rf /");
  assert.equal(calls[0].options.stdio[0], "ignore");
});

test("unknown MCP tools fail closed", () => {
  const f = fixture();
  const plane = new ChatgptMcpReadToolPlane(f);
  assert.throws(() => plane.callTool("aiopago_write_file", {}), (error) => error?.code === "CHATGPT_MCP_TOOL_UNKNOWN");
});
