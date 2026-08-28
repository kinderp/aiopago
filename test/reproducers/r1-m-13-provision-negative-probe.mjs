import { readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
const root = option("--root"), output = option("--output");
if (!root || !output) throw new Error("ROOT_OUTPUT_REQUIRED");
const attempts = [];
function attempt(name, use) {
  try { use(); attempts.push({ name, denied: false }); }
  catch (error) { attempts.push({ name, denied: ["EACCES", "EPERM"].includes(error?.code) || /denied|accesso negato/i.test(error?.message ?? ""), error: `${error?.code ?? error?.name}: ${error?.message}` }); }
}
attempt("root_enumerate", () => readdirSync(root));
attempt("root_create", () => writeFileSync(join(root, `p0-${process.pid}.txt`), "forged"));
const acl = spawnSync(join(process.env.SystemRoot, "System32", "icacls.exe"), [root, "/grant", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)(F)`], { encoding: "utf8", windowsHide: true });
attempts.push({ name: "root_acl_change", denied: acl.status === 5 || /access is denied|accesso negato/i.test(`${acl.stdout}${acl.stderr}`), exitCode: acl.status, stdout: String(acl.stdout).trim(), stderr: String(acl.stderr).trim() });
writeFileSync(output, `${JSON.stringify({ schema: "aiopago.operation-authority-provision-negative/1", pid: process.pid, attempts, allDenied: attempts.every((value) => value.denied) }, null, 2)}\n`);
