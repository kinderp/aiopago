import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GITIGNORE_START,
  checkPortableEnvironment,
  initializeRepository,
  isSupportedNodeVersion,
} from "../src/bootstrap.mjs";
import { formatCliError, runCli } from "../src/cli.mjs";
import { GuardianError } from "../src/errors.mjs";
import { TaskLedger } from "../src/ledger.mjs";
import { isSupportedPiVersion, resolvePiRoot } from "../src/pi-loader.mjs";
import {
  DEFAULT_REPOSITORY_CONFIG,
  INSTALLATION_ROOT,
  discoverTargetRepository,
  loadRepositoryContext,
  validateRepositoryConfig,
} from "../src/repository.mjs";

const fakePi = async () => ({ root: "/fake/pi", version: "0.83.0", name: "@earendil-works/pi-coding-agent" });
function temp(prefix = "eiopago portable ") { return mkdtempSync(join(tmpdir(), prefix)); }
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function repo(prefix) { const root = temp(prefix); git(root, ["init"]); return root; }
function init(root, options = {}) { return initializeRepository(root, { piInspector: fakePi, now: "2026-08-09T00:00:00.000Z", ...options }); }

function validLedger(root) {
  const task = {
    schema_version: "0.1.0", task_id: "TASK-EXISTING", title: "Existing", objective: "Preserve this Ledger",
    requirements_version: "REQ-1", plan_revision_id: "PLAN-1", status: "IN_PROGRESS", completion_criteria: ["done"],
    risk: "MEDIUM", created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z",
    current_item: "ITEM-1", next_item: null, next_step: "continue", evidence: [], model_policy: null,
    reasoning_policy: "high", minimal_reads: ["TASK_PLAN.md"],
    task_items: [{ task_item_id: "ITEM-1", task_id: "TASK-EXISTING", title: "Work", description: "bounded", status: "IN_PROGRESS", depends_on: [], completion_criteria: ["done"], evidence: [], requirements_refs: [], risk: "MEDIUM", milestone: "LOCAL", last_updated_at: "2026-08-09T00:00:00.000Z", last_updated_by: "human" }],
  };
  const text = `# Existing\n\n\`\`\`json task-ledger\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`;
  writeFileSync(join(root, "TASK_PLAN.md"), text);
  return text;
}

test("portable init creates the minimal versioned contract and ignored runtime without touching application files", async () => {
  const root = repo("eiopago clean repo with spaces ");
  writeFileSync(join(root, "application.txt"), "do not change\n");
  const result = await init(root);
  assert.equal(result.installationRoot, INSTALLATION_ROOT);
  assert.equal(result.targetRoot, discoverTargetRepository(root));
  assert.notEqual(result.installationRoot.toLowerCase(), result.targetRoot.toLowerCase());
  assert.equal(readFileSync(join(root, "application.txt"), "utf8"), "do not change\n");
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".guardian", "config.json"), "utf8")), DEFAULT_REPOSITORY_CONFIG);
  assert.equal(existsSync(join(root, ".guardian", "runtime")), true);
  assert.equal(existsSync(join(root, ".guardian", "checkpoints")), false);
  assert.equal(existsSync(join(root, ".guardian", "manifests")), false);
  assert.equal(new TaskLedger(join(root, "TASK_PLAN.md")).read().plan_revision_id, "PLAN-INITIAL-1");
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8").includes(GITIGNORE_START), true);
  assert.equal(git(root, ["check-ignore", ".guardian/runtime/probe.sqlite"]), ".guardian/runtime/probe.sqlite");
  assert.throws(() => git(root, ["check-ignore", ".guardian/config.json"]));
  assert.throws(() => git(root, ["check-ignore", "TASK_PLAN.md"]));
  assert.deepEqual(git(root, ["status", "--short"]).split(/\r?\n/).sort(), ["?? .gitignore", "?? .guardian/", "?? TASK_PLAN.md", "?? application.txt"].sort());
});

test("re-init is idempotent and preserves a valid Ledger, config, gitignore, and runtime state", async () => {
  const root = repo("eiopago reinit ");
  const first = await init(root);
  writeFileSync(join(root, ".guardian", "runtime", "existing.db"), "state");
  const snapshots = ["TASK_PLAN.md", ".guardian/config.json", ".gitignore"].map((path) => readFileSync(join(root, path)));
  const second = await init(join(root, ".guardian"));
  assert.equal(second.targetRoot, first.targetRoot);
  ["TASK_PLAN.md", ".guardian/config.json", ".gitignore"].forEach((path, index) => assert.deepEqual(readFileSync(join(root, path)), snapshots[index]));
  assert.equal(readFileSync(join(root, ".guardian", "runtime", "existing.db"), "utf8"), "state");
  assert.equal(second.actions.updated.length, 0);
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8").split(GITIGNORE_START).length - 1, 1);
});

test("init preserves an existing compatible Ledger byte-for-byte", async () => {
  const root = repo("eiopago valid ledger ");
  const ledger = validLedger(root);
  const result = await init(root);
  assert.equal(readFileSync(join(root, "TASK_PLAN.md"), "utf8"), ledger);
  assert.equal(result.actions.preserved.some((value) => value.startsWith("TASK_PLAN.md")), true);
});

test("init fails closed on an unrecognized TASK_PLAN.md before creating Eiopago state", async () => {
  const root = repo("eiopago foreign plan ");
  writeFileSync(join(root, "TASK_PLAN.md"), "# Application task plan\n\nNot an Eiopago Ledger.\n");
  await assert.rejects(() => init(root), (error) => error.code === "TASK_PLAN_NOT_EIOPAGO_LEDGER");
  assert.equal(existsSync(join(root, ".guardian")), false);
  assert.equal(existsSync(join(root, ".gitignore")), false);
  assert.match(readFileSync(join(root, "TASK_PLAN.md"), "utf8"), /Application task plan/);
});

test("init fails closed on an ambiguous Ledger with multiple task-ledger blocks", async () => {
  const root = repo("eiopago ambiguous ledger ");
  const ledger = validLedger(root);
  writeFileSync(join(root, "TASK_PLAN.md"), `${ledger}\n${ledger}`);
  await assert.rejects(() => init(root), (error) => error.code === "TASK_PLAN_NOT_EIOPAGO_LEDGER");
  assert.equal(existsSync(join(root, ".guardian")), false);
  assert.equal(existsSync(join(root, ".gitignore")), false);
});

test("init appends one bounded block to an existing .gitignore and can expose versioned config under a prior .guardian ignore", async () => {
  const root = repo("eiopago gitignore ");
  writeFileSync(join(root, ".gitignore"), "dist/\n.guardian/\n");
  await init(root);
  const text = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(text, /^dist\/\n\.guardian\/\n\n# Eiopago/m);
  assert.equal(text.split(GITIGNORE_START).length - 1, 1);
  assert.throws(() => git(root, ["check-ignore", ".guardian/config.json"]));
  assert.equal(git(root, ["check-ignore", ".guardian/runtime/probe"]), ".guardian/runtime/probe");
  await init(root);
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), text);
});

test("init handles a partial .guardian directory without deleting existing content", async () => {
  const root = repo("eiopago partial guardian ");
  mkdirSync(join(root, ".guardian"));
  writeFileSync(join(root, ".guardian", "owner-note.txt"), "preserve");
  await init(root);
  assert.equal(readFileSync(join(root, ".guardian", "owner-note.txt"), "utf8"), "preserve");
  assert.equal(existsSync(join(root, ".guardian", "config.json")), true);
  assert.equal(git(root, ["check-ignore", ".guardian/owner-note.txt"]), ".guardian/owner-note.txt");
  assert.throws(() => git(root, ["check-ignore", ".guardian/config.json"]));
});

test("init rejects redirected reserved state before writing target files", async () => {
  const root = repo("eiopago redirected state ");
  const outside = temp("eiopago outside state ");
  symlinkSync(outside, join(root, ".guardian"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => init(root), (error) => error.code === "REPOSITORY_STATE_PATH_REDIRECTED");
  assert.equal(existsSync(join(root, "TASK_PLAN.md")), false);
  assert.equal(existsSync(join(root, ".gitignore")), false);
  assert.deepEqual(readdirSync(outside), []);
});

test("target discovery accepts nested paths and linked Git worktrees", async () => {
  const main = repo("eiopago main worktree ");
  git(main, ["config", "user.email", "portable@example.invalid"]);
  git(main, ["config", "user.name", "Portable Test"]);
  writeFileSync(join(main, "seed.txt"), "seed\n");
  git(main, ["add", "seed.txt"]); git(main, ["commit", "-m", "seed"]);
  const linked = temp("eiopago linked worktree ");
  // git worktree requires the destination not to exist.
  const { rmSync } = await import("node:fs");
  rmSync(linked, { recursive: true });
  git(main, ["worktree", "add", "-b", "portable-linked", linked]);
  mkdirSync(join(linked, "nested", "deeper"), { recursive: true });
  const result = await init(join(linked, "nested", "deeper"));
  assert.equal(result.targetRoot.toLowerCase(), discoverTargetRepository(linked).toLowerCase());
  assert.equal(existsSync(join(linked, ".guardian", "config.json")), true);
  assert.equal(existsSync(join(main, ".guardian", "config.json")), false);
});

test("wrong and non-Git targets fail with stable diagnostics", async () => {
  const missing = join(temp("eiopago missing parent "), "does-not-exist");
  await assert.rejects(() => init(missing), (error) => error.code === "TARGET_PATH_NOT_FOUND");
  const plain = temp("eiopago not git ");
  await assert.rejects(() => init(plain), (error) => error.code === "TARGET_NOT_GIT_WORKTREE");
});

test("init surfaces dubious ownership with exact manual remediation and never changes Git trust", async () => {
  const root = temp("eiopago dubious ownership ");
  const target = realpathSync(root);
  const requested = join(target, "nested", "deeper");
  mkdirSync(requested, { recursive: true });
  const gitTarget = process.platform === "win32" ? target.replaceAll("\\", "/") : target;
  const commandTarget = /^[A-Za-z0-9_./:+-]+$/.test(gitTarget) ? gitTarget : JSON.stringify(gitTarget);
  const calls = [];
  const execFile = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "--version") return "git version 2.50.1";
    const error = new Error("Command failed: git rev-parse --is-inside-work-tree");
    error.status = 128;
    error.stderr = Buffer.from(`fatal: detected dubious ownership in repository at '${gitTarget}'\n'${gitTarget}/.git' is on a file system that does not record ownership\nTo add an exception for this directory, call:\n\ngit config --global --add safe.directory ${gitTarget}\n`);
    throw error;
  };

  let received;
  await assert.rejects(() => init(requested, { execFile }), (error) => {
    received = error;
    return error.code === "GIT_SAFE_DIRECTORY_REQUIRED";
  });
  const expectedMessage = `Git requires explicit trust for this worktree:\n${gitTarget}\n\nIf you trust this repository, run manually:\n\ngit config --global --add safe.directory ${commandTarget}\n\nEiopago does not modify Git global configuration automatically.`;
  assert.equal(received.message, expectedMessage);
  assert.equal(formatCliError(received), `eio: GIT_SAFE_DIRECTORY_REQUIRED: ${expectedMessage}`);
  assert.equal(calls.some((call) => call.slice(1, 5).join(" ") === "config --global --add safe.directory"), false);
  assert.deepEqual(readdirSync(root), ["nested"]);
  assert.equal(existsSync(join(root, ".guardian")), false);
});

test("repository Git failure classification remains conservative", () => {
  const root = temp("eiopago classified Git failures ");
  const gitTarget = process.platform === "win32" ? realpathSync(root).replaceAll("\\", "/") : realpathSync(root);
  const dubious = `fatal: detected dubious ownership in repository at '${gitTarget}'\nTo add an exception for this directory, call:\n\ngit config --global --add safe.directory ${gitTarget}\n`;
  const failingExec = (stderr, properties = {}) => () => {
    const error = new Error("simulated Git failure");
    error.status = 128;
    error.stderr = Buffer.from(stderr);
    Object.assign(error, properties);
    throw error;
  };

  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec("fatal: not a git repository (or any of the parent directories): .git\n") }),
    (error) => error.code === "TARGET_NOT_GIT_WORKTREE",
  );
  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec("", { code: "ENOENT" }) }),
    (error) => error.code === "GIT_UNAVAILABLE",
  );
  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec("fatal: invalid value for safe.directory\ngit config --global --add safe.directory /somewhere\n") }),
    (error) => error.code === "TARGET_NOT_GIT_WORKTREE",
  );
  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec(`fatal: detected dubious ownership in repository at '${gitTarget}'\n`) }),
    (error) => error.code === "TARGET_NOT_GIT_WORKTREE",
  );
  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec(dubious, { status: 1 }) }),
    (error) => error.code === "TARGET_NOT_GIT_WORKTREE",
  );
  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec("", { stderr: dubious }) }),
    (error) => error.code === "GIT_SAFE_DIRECTORY_REQUIRED",
  );
  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec("", { stderr: "", message: dubious }) }),
    (error) => error.code === "GIT_SAFE_DIRECTORY_REQUIRED",
  );
  const outsideInspectionBound = `${"x".repeat(64 * 1024)}${dubious}`;
  assert.throws(
    () => discoverTargetRepository(root, { execFile: failingExec("", { stderr: outsideInspectionBound, message: outsideInspectionBound }) }),
    (error) => error.code === "TARGET_NOT_GIT_WORKTREE",
  );
});

test("repository config paths are explicit, normalized, and cannot escape the target", async () => {
  const root = repo("eiopago context ");
  await init(root);
  const context = loadRepositoryContext(join(root, ".guardian"));
  assert.equal(context.configRoot, join(context.targetRoot, ".guardian"));
  assert.equal(context.runtimeRoot, join(context.configRoot, "runtime"));
  assert.equal(context.taskLedgerPath, join(context.targetRoot, "TASK_PLAN.md"));
  assert.throws(
    () => validateRepositoryConfig({ ...DEFAULT_REPOSITORY_CONFIG, runtime_root: "../outside" }, context.targetRoot),
    (error) => error.code === "REPOSITORY_CONFIG_PATH_ESCAPE",
  );
  assert.throws(
    () => validateRepositoryConfig({ ...DEFAULT_REPOSITORY_CONFIG, access_token: "not-allowed" }, context.targetRoot),
    (error) => error.code === "REPOSITORY_CONFIG_FIELDS_INVALID",
  );
});

test("environment checks reject incompatible Node, missing Git, and unavailable Pi without updates", async () => {
  assert.equal(isSupportedNodeVersion("22.19.0"), true);
  assert.equal(isSupportedNodeVersion("23.0.0"), true);
  assert.equal(isSupportedNodeVersion("22.18.9"), false);
  assert.equal(isSupportedPiVersion("0.83.0"), true);
  assert.equal(isSupportedPiVersion("0.83.0-beta.1"), false);
  assert.equal(isSupportedPiVersion("0.84.0"), false);
  let piCalls = 0;
  await assert.rejects(
    () => checkPortableEnvironment({ nodeVersion: "20.0.0", piInspector: async () => { piCalls += 1; } }),
    (error) => error.code === "NODE_VERSION_UNSUPPORTED",
  );
  assert.equal(piCalls, 0);
  const missingGit = () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; };
  await assert.rejects(() => checkPortableEnvironment({ execFile: missingGit, piInspector: fakePi }), (error) => error.code === "GIT_UNAVAILABLE");
  await assert.rejects(
    () => checkPortableEnvironment({ piInspector: async () => { throw new GuardianError("PI_UNAVAILABLE", "install Pi"); } }),
    (error) => error.code === "PI_UNAVAILABLE",
  );
  await assert.rejects(
    () => resolvePiRoot({ root: join(temp("eiopago missing pi root "), "missing") }),
    (error) => error.code === "PI_UNAVAILABLE",
  );
  const unrelated = temp("eiopago unrelated project pi ");
  const unrelatedPi = join(unrelated, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(unrelatedPi, "dist"), { recursive: true });
  writeFileSync(join(unrelatedPi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0", main: "dist/index.js" }));
  writeFileSync(join(unrelatedPi, "dist", "index.js"), "export {};\n");
  assert.notEqual((await resolvePiRoot({ searchRoot: unrelated })).toLowerCase(), unrelatedPi.toLowerCase());
});

test("CLI routes explicit init and launch targets through the repository contract", async () => {
  const root = repo("eiopago cli target ");
  const output = [];
  const initialized = await runCli(["init", "--target", root], {
    stdout: (text) => output.push(text),
    bootstrapOptions: { piInspector: fakePi, now: "2026-08-09T00:00:00.000Z" },
  });
  assert.equal(initialized.action, "init");
  assert.match(output[0], /Eiopago init complete/);
  const priorCwd = process.cwd();
  try {
    process.chdir(root);
    const implicit = await runCli(["init"], {
      stdout: () => {},
      bootstrapOptions: { piInspector: fakePi, now: "2026-08-09T00:00:00.000Z" },
    });
    assert.equal(implicit.result.targetRoot.toLowerCase(), discoverTargetRepository(root).toLowerCase());
    assert.equal(implicit.result.actions.updated.length, 0);
  } finally { process.chdir(priorCwd); }
  let received = null;
  let ran = false;
  let disposed = false;
  const launched = await runCli(["--target", join(root, ".guardian")], {
    stdout: () => {},
    checkEnvironment: async () => ({}),
    createRunner: async ({ repository }) => {
      received = repository;
      return { async runInteractive() { ran = true; }, async dispose() { disposed = true; } };
    },
  });
  assert.equal(launched.action, "launch");
  assert.equal(received.targetRoot.toLowerCase(), discoverTargetRepository(root).toLowerCase());
  assert.equal(ran, true);
  assert.equal(disposed, true);
});

test("portable launch fails fast with eio init guidance and never falls back to the installation cwd", async () => {
  const uninitialized = repo("eiopago uninitialized launch ");
  let createCalls = 0;
  await assert.rejects(
    () => runCli(["--target", uninitialized], {
      stdout: () => {},
      checkEnvironment: async () => ({}),
      createRunner: async () => { createCalls += 1; },
    }),
    (error) => error.code === "REPOSITORY_NOT_INITIALIZED" && error.message.includes("eio init"),
  );
  assert.equal(createCalls, 0);
  assert.equal(existsSync(join(uninitialized, ".guardian")), false);
});

test("package bin is invocable with an unrelated cwd and does not create target files", () => {
  const outside = temp("eiopago package invocation ");
  const output = execFileSync(process.execPath, [join(INSTALLATION_ROOT, "bin", "eio.mjs"), "--version"], {
    cwd: outside,
    encoding: "utf8",
  });
  assert.equal(output.trim(), "0.1.0");
  assert.deepEqual(readdirSync(outside), []);
});

test("package declares a real CLI bin, ESM export, engine, and supported Pi peer", () => {
  const manifest = JSON.parse(readFileSync(join(INSTALLATION_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.bin.eio, "bin/eio.mjs");
  assert.equal(manifest.exports["."], "./src/index.mjs");
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.83.0 <0.84.0");
});
