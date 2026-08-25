import { access, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invariant } from "./errors.mjs";

export const SUPPORTED_PI_RANGE = ">=0.83.0 <0.84.0";

function packageRootFromEntry(entry) {
  let current = dirname(resolve(entry));
  while (true) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        if (JSON.parse(readFileSync(manifestPath, "utf8")).name === "@earendil-works/pi-coding-agent") return current;
      } catch {}
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolutionCandidate(base) {
  try {
    const require = createRequire(join(resolve(base), "package.json"));
    return packageRootFromEntry(require.resolve("@earendil-works/pi-coding-agent"));
  } catch { return null; }
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

  // Resolve from Aiopago's own installation, not from the selected target
  // repository: an unrelated project's Pi copy must not become authoritative.
  const candidates = [
    resolutionCandidate(dirname(fileURLToPath(import.meta.url))),
    join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent"),
  ].filter(Boolean);
  const visited = new Set();
  for (const candidate of candidates) {
    const root = resolve(candidate);
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (visited.has(key)) continue;
    visited.add(key);
    try { await access(join(root, "package.json")); return root; } catch {}
  }
  invariant(false, "PI_UNAVAILABLE", "Cannot locate @earendil-works/pi-coding-agent beside Aiopago; install Pi 0.83.x or set PI_CODING_AGENT_ROOT");
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
  const coding = await import(pathToFileURL(join(info.root, "dist", "index.js")));
  const aiCandidates = [
    join(info.root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
    join(dirname(info.root), "pi-ai", "dist", "index.js"),
  ];
  let aiEntry = null;
  for (const candidate of aiCandidates) {
    try { await access(candidate); aiEntry = candidate; break; } catch {}
  }
  invariant(aiEntry, "PI_PACKAGE_INVALID", `Cannot resolve @earendil-works/pi-ai from ${info.root}`);
  const ai = await import(pathToFileURL(aiEntry));
  return { ...info, coding, ai };
}
