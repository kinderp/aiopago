import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { invariant } from "./errors.mjs";

function git(cwd, args, { optional = false } = {}) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", optional ? "ignore" : "pipe"] }).trim();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

export function observeGitState(cwd = process.cwd()) {
  const workdir = realpathSync(resolve(cwd)).replaceAll("\\", "/");
  const root = git(workdir, ["rev-parse", "--show-toplevel"]).replaceAll("\\", "/");
  invariant(root.toLowerCase() === workdir.toLowerCase(), "GIT_WORKTREE_MISMATCH", `Expected repository root ${workdir}, observed ${root}`);
  const head = git(workdir, ["rev-parse", "HEAD"], { optional: true });
  const upstream = git(workdir, ["rev-parse", "@{upstream}"], { optional: true });
  const base = upstream && head ? git(workdir, ["merge-base", "HEAD", "@{upstream}"], { optional: true }) : head;
  const porcelain = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: workdir });
  const statusEntries = porcelain.toString("utf8").split("\0").filter(Boolean).sort();
  return {
    repository_id: root,
    workdir,
    branch: git(workdir, ["branch", "--show-current"]),
    head_sha: head,
    base_sha: base,
    commit_shas: head ? [head] : [],
    index_digest: null,
    worktree_digest: null,
    status_entries: statusEntries,
    observed_at: new Date().toISOString(),
  };
}

export function sameGitState(expected, actual) {
  const identity = ["repository_id", "workdir", "branch", "head_sha", "base_sha"];
  return identity.every((key) => expected[key] === actual[key]) && JSON.stringify(expected.status_entries) === JSON.stringify(actual.status_entries);
}
