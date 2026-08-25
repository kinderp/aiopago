import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invariant } from "./errors.mjs";

export const SUPPORTED_PI_VERSION = "0.83.0";
export const SUPPORTED_PI_RANGE = SUPPORTED_PI_VERSION;

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

export function isSupportedPiVersion(version) {
  return version === SUPPORTED_PI_VERSION;
}

export async function resolvePiRoot() {
  // Resolve only from Aiopago's deterministic installation dependency slots,
  // never NODE_PATH, the target cwd, an environment override, or a generic
  // package resolver.
  const trusted = await trustedPiRoot();
  if (trusted) return trusted;
  invariant(false, "PI_UNAVAILABLE", `Aiopago's exact Pi ${SUPPORTED_PI_VERSION} dependency is missing; reinstall Aiopago`);
}

export async function inspectPi() {
  const root = await resolvePiRoot();
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")); }
  catch (error) { invariant(false, "PI_PACKAGE_INVALID", `${root}: ${error.message}`); }
  invariant(manifest.name === "@earendil-works/pi-coding-agent", "PI_PACKAGE_INVALID", `Unexpected package at ${root}`);
  invariant(isSupportedPiVersion(manifest.version), "PI_VERSION_UNSUPPORTED", `Pi ${manifest.version} is unsupported; expected exactly ${SUPPORTED_PI_VERSION}; reinstall Aiopago`);
  return Object.freeze({ root, version: manifest.version, name: manifest.name });
}

export async function loadPi() {
  const info = await inspectPi();
  // Pi 0.83.0 ships an npm shrinkwrap. Its privileged pi-ai runtime is accepted
  // only from that exact dependency's own physical tree, never from a cwd or
  // independently selected sibling package.
  const aiRoot = await trustedDirectory(
    join(info.root, "node_modules", "@earendil-works", "pi-ai"),
    "Trusted pi-ai installation",
  );
  invariant(aiRoot, "PI_PACKAGE_INVALID", `Aiopago's trusted Pi dependency is missing its pinned pi-ai runtime; reinstall Aiopago`);
  let aiManifest;
  try { aiManifest = JSON.parse(await readFile(join(aiRoot, "package.json"), "utf8")); }
  catch (error) { invariant(false, "PI_PACKAGE_INVALID", `${aiRoot}: ${error.message}`); }
  invariant(aiManifest.name === "@earendil-works/pi-ai" && aiManifest.version === SUPPORTED_PI_VERSION,
    "PI_VERSION_UNSUPPORTED", `pi-ai ${aiManifest.version ?? "unknown"} is unsupported; expected exactly ${SUPPORTED_PI_VERSION}; reinstall Aiopago`);
  // Physical checks are trusted-process installation validation and
  // defense-in-depth, not self-attestation against pre-import same-process JS.
  const ai = await import(pathToFileURL(join(aiRoot, "dist", "index.js")));
  const coding = await import(pathToFileURL(join(info.root, "dist", "index.js")));
  return { ...info, coding, ai };
}
