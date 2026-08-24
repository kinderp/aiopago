import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

execFileSync(process.execPath, ["scripts/check-brand-migration.mjs"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/build-package.mjs"], { stdio: "inherit" });
for (const path of ["dist/index.mjs", "dist/cli-entry.mjs"]) {
  const source = readFileSync(path, "utf8");
  if (/storageDatabaseForInternal|ForInternalTest|internalTestCapabilities/.test(source)) {
    throw new Error(`source-test authority instrumentation leaked into ${path}`);
  }
}

const roots = ["src", "dist", "bin", "scripts", "test"];
const files = [];
function walk(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) walk(child);
    else if (child.endsWith(".mjs")) files.push(child);
  }
}
for (const root of roots) walk(root);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`syntax ok: ${files.length} modules`);
