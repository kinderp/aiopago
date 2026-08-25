import { access, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invariant } from "./errors.mjs";

export const SUPPORTED_PI_RANGE = ">=0.83.0 <0.84.0";

const INSTALLATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function trustedDirectory(path, label) {
  const root = resolve(path);
  let stat;
  try { stat = await lstat(root); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), "PI_TRUSTED_INSTALLATION_REDIRECTED", `${label} must be a physical directory: ${root}`);
  let canonical;
  try { canonical = await realpath(root); }
  catch (error) { invariant(false, "PI_TRUSTED_INSTALLATION_REDIRECTED", `${label} cannot be canonically resolved: ${root}: ${error.message}`); }
  invariant(samePath(canonical, root), "PI_TRUSTED_INSTALLATION_REDIRECTED", `${label} must not traverse a symlink or junction: ${root}`);
  for (const relativePath of ["package.json", join("dist", "index.js")]) {
    const file = join(root, relativePath);
    let fileStat;
    try { fileStat = await lstat(file); }
    catch (error) { invariant(false, "PI_PACKAGE_INVALID", `${label} is incomplete: ${file}: ${error.message}`); }
    invariant(fileStat.isFile() && !fileStat.isSymbolicLink(), "PI_TRUSTED_INSTALLATION_REDIRECTED", `${label} entry must be a physical regular file: ${file}`);
    invariant(samePath(await realpath(file), file), "PI_TRUSTED_INSTALLATION_REDIRECTED", `${label} entry must not be redirected: ${file}`);
  }
  return root;
}

async function trustedPiRoot() {
  // These are npm's two deterministic dependency layouts: nested below the
  // Aiopago package or physically adjacent in the containing node_modules.
  // Do not invoke a package resolver here: createRequire/NODE_PATH and target
  // cwd resolution are ambient attacker-selected search paths.
  const candidates = [
    join(INSTALLATION_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
    join(dirname(INSTALLATION_ROOT), "@earendil-works", "pi-coding-agent"),
  ];
  for (const candidate of candidates) {
    const trusted = await trustedDirectory(candidate, "Trusted Pi installation");
    if (trusted) return trusted;
  }
  return null;
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return match ? match.slice(1).map(Number) : null;
}

export function isSupportedPiVersion(version) {
  const parts = versionParts(version);
  return Boolean(parts && parts[0] === 0 && parts[1] === 83);
}

export async function resolvePiRoot(options = {}) {
  const configuredRoot = options.trustedInstallationOnly === true
    ? null
    : options.root ?? process.env.PI_CODING_AGENT_ROOT;
  if (configuredRoot) {
    const root = resolve(configuredRoot);
    try { await access(join(root, "package.json")); return root; }
    catch { invariant(false, "PI_UNAVAILABLE", `Configured Pi root is unavailable: ${root}`); }
  }

  // Resolve only from Aiopago's deterministic installation dependency slots,
  // never NODE_PATH, the target cwd, or another ambient package search root.
  const trusted = await trustedPiRoot();
  if (trusted) return trusted;
  const guidance = options.trustedInstallationOnly === true
    ? "install Pi 0.83.x as Aiopago's physical npm dependency"
    : "install Pi 0.83.x beside Aiopago or set PI_CODING_AGENT_ROOT";
  invariant(false, "PI_UNAVAILABLE", `Cannot locate @earendil-works/pi-coding-agent beside Aiopago; ${guidance}`);
}

export async function inspectPi(options = {}) {
  const root = await resolvePiRoot(options);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")); }
  catch (error) { invariant(false, "PI_PACKAGE_INVALID", `${root}: ${error.message}`); }
  invariant(manifest.name === "@earendil-works/pi-coding-agent", "PI_PACKAGE_INVALID", `Unexpected package at ${root}`);
  invariant(isSupportedPiVersion(manifest.version), "PI_VERSION_UNSUPPORTED", `Pi ${manifest.version} is unsupported; expected ${SUPPORTED_PI_RANGE}`);
  return Object.freeze({ root, version: manifest.version, name: manifest.name });
}

export async function loadPi(options = {}) {
  const info = await inspectPi(options);
  const aiRoots = [
    join(info.root, "node_modules", "@earendil-works", "pi-ai"),
    join(dirname(info.root), "pi-ai"),
  ];
  let aiRoot = null;
  for (const candidate of aiRoots) {
    if (options.trustedInstallationOnly === true) {
      const trusted = await trustedDirectory(candidate, "Trusted pi-ai installation");
      if (trusted) { aiRoot = trusted; break; }
    } else {
      try { await access(join(candidate, "dist", "index.js")); aiRoot = candidate; break; } catch {}
    }
  }
  invariant(aiRoot, "PI_PACKAGE_INVALID", `Cannot resolve @earendil-works/pi-ai from ${info.root}`);
  // Validate every privileged dependency path before evaluating Pi. A fake
  // coding-agent must not receive the extension factory before pi-ai fails.
  const ai = await import(pathToFileURL(join(aiRoot, "dist", "index.js")));
  const coding = await import(pathToFileURL(join(info.root, "dist", "index.js")));
  return { ...info, coding, ai };
}
