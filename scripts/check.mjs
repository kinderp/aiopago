import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

execFileSync(process.execPath, ["scripts/check-brand-migration.mjs"], { stdio: "inherit" });

const roots = ["src", "bin", "scripts", "test"];
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
