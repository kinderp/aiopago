import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function resolvePiRoot() {
  const candidates = [
    process.env.PI_CODING_AGENT_ROOT,
    join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent"),
  ].filter(Boolean);
  for (const root of candidates) {
    try { await access(join(root, "package.json")); return root; } catch {}
  }
  throw new Error("Cannot locate @earendil-works/pi-coding-agent; set PI_CODING_AGENT_ROOT");
}

export async function loadPi() {
  const root = await resolvePiRoot();
  const coding = await import(pathToFileURL(join(root, "dist", "index.js")));
  const ai = await import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")));
  return { root, coding, ai };
}
