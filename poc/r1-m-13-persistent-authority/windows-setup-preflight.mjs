// Non-mutating Windows setup preflight for the protected-service restart PoC.
import { execFileSync, spawnSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("WINDOWS_ONLY_POC");

const identity = JSON.parse(execFileSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command",
  "$i=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]$i;[ordered]@{name=$i.Name;sid=$i.User.Value;elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress",
], { encoding: "utf8", windowsHide: true }));

// `net session` is a non-mutating, real access check for an elevated
// administrator token on supported client Windows systems.
const netSession = spawnSync(`${process.env.SystemRoot}\\System32\\net.exe`, ["session"], {
  encoding: "utf8", windowsHide: true,
});
const setupAvailable = identity.elevated === true && netSession.status === 0;

process.stdout.write(`${JSON.stringify({
  schema: "aiopago.r1-m-13-service-setup-preflight/1",
  platform: `${process.platform}/${process.arch}`,
  pid: process.pid,
  identity,
  elevationProbe: {
    operation: "net.exe session (non-mutating administrator access check)",
    exitCode: netSession.status,
    stderr: netSession.stderr.trim(),
  },
  requiredServiceIdentity: "NT AUTHORITY\\LocalService with NT SERVICE\\AiopagoR1M13Poc service SID (RESTRICTED preferred; UNRESTRICTED accepted only with service-SID-only protected DACL after the documented child-loader blocker)",
  requiredProtectedRoot: `${process.env.ProgramData}\\Aiopago\\R1M13Poc`,
  setupAvailable,
  verdict: setupAvailable ? "OS_SETUP_AVAILABLE" : "BLOCKED_BY_REQUIRED_OS_SETUP",
}, null, 2)}\n`);
