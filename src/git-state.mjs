import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

function git(cwd, args, { optional = false } = {}) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", optional ? "ignore" : "pipe"] }).trim();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

function gitBytes(cwd, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function worktreeDigest(workdir) {
  const paths = gitBytes(workdir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .toString("utf8").split("\0").filter(Boolean).sort();
  const records = [];
  for (const path of paths) {
    const absolute = resolve(workdir, path);
    let kind = "missing";
    let mode = 0;
    let bytes = Buffer.alloc(0);
    try {
      const stat = lstatSync(absolute);
      mode = stat.mode & 0o111;
      if (stat.isSymbolicLink()) {
        kind = "symlink";
        bytes = Buffer.from(readlinkSync(absolute), "utf8");
      } else if (stat.isFile()) {
        kind = "file";
        bytes = readFileSync(absolute);
      } else if (stat.isDirectory()) {
        // A cached path can be a submodule. Its HEAD/status remain represented by
        // the index and porcelain snapshot; the directory marker prevents it
        // from being confused with a missing path.
        kind = "directory";
      } else {
        kind = "other";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    records.push({ path, kind, mode, content_digest: sha256(bytes) });
  }
  return sha256(Buffer.from(JSON.stringify(records), "utf8"));
}

export function observeGitState(cwd = process.cwd()) {
  const workdir = realpathSync(resolve(cwd)).replaceAll("\\", "/");
  const root = git(workdir, ["rev-parse", "--show-toplevel"]).replaceAll("\\", "/");
  invariant(root.toLowerCase() === workdir.toLowerCase(), "GIT_WORKTREE_MISMATCH", `Expected repository root ${workdir}, observed ${root}`);
  const head = git(workdir, ["rev-parse", "HEAD"], { optional: true });
  const upstream = git(workdir, ["rev-parse", "@{upstream}"], { optional: true });
  const base = upstream && head ? git(workdir, ["merge-base", "HEAD", "@{upstream}"], { optional: true }) : head;
  const porcelain = gitBytes(workdir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const statusEntries = porcelain.toString("utf8").split("\0").filter(Boolean).sort();
  return {
    repository_id: root,
    workdir,
    branch: git(workdir, ["branch", "--show-current"]),
    head_sha: head,
    base_sha: base,
    commit_shas: head ? [head] : [],
    index_digest: sha256(gitBytes(workdir, ["ls-files", "--stage", "-z"])),
    worktree_digest: worktreeDigest(workdir),
    status_entries: statusEntries,
    observed_at: new Date().toISOString(),
  };
}

export function sameGitState(expected, actual) {
  const digest = /^sha256:[a-f0-9]{64}$/;
  if (![expected?.index_digest, expected?.worktree_digest, actual?.index_digest, actual?.worktree_digest].every((value) => digest.test(value))) return false;
  const identity = ["repository_id", "workdir", "branch", "head_sha", "base_sha", "index_digest", "worktree_digest"];
  return identity.every((key) => expected[key] === actual[key]) && JSON.stringify(expected.status_entries) === JSON.stringify(actual.status_entries);
}
