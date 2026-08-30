// Focused Windows same-user persistent-authority probe. Non-production.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("WINDOWS_ONLY_POC");

const here = dirname(fileURLToPath(import.meta.url));
const sourceScript = join(here, "same-user-anchor.ps1");
const root = mkdtempSync(join(tmpdir(), "aiopago-r1-m-13-persistent-anchor-"));
// This worktree is on a Windows Dev Drive where PowerShell script execution is
// disabled. Execute an exact temporary copy; hashes/evidence remain in stdout.
const script = join(root, "same-user-anchor.ps1");
copyFileSync(sourceScript, script);
const suffix = `${process.pid}-${Date.now()}`;
const credentialName = `AiopagoR1M13Credential-${suffix}`;
const softwareKeyName = `AiopagoR1M13SoftwareCng-${suffix}`;
const tpmKeyName = `AiopagoR1M13TpmCng-${suffix}`;
const invocations = [];

function invoke(action, { name, provider, allowUnavailable = false, timeout = 30_000 } = {}) {
  return new Promise((resolveInvocation, rejectInvocation) => {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Action", action, "-Root", root];
    if (name) args.push("-Name", name);
    if (provider) args.push("-Provider", provider);
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.once("error", rejectInvocation);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      let value;
      try { value = JSON.parse(stdout.trim()); }
      catch { return rejectInvocation(new Error(`${action}: invalid JSON; code=${code}; stdout=${stdout}; stderr=${stderr}`)); }
      const entry = { action, pid: child.pid, exitCode: code, signal, value, stderr: stderr.trim() || null };
      invocations.push(entry);
      if (code !== 0 && !(allowUnavailable && value.available === false)) {
        return rejectInvocation(new Error(`${action}: exit=${code}; ${value.error ?? stderr}`));
      }
      resolveInvocation(entry);
    });
  });
}

const matrix = [];
let tpm = { available: false, reason: "NOT_PROBED" };
try {
  const identity = await invoke("identity");

  const ntfsCreate = await invoke("ntfs-create");
  const ntfsAttack = await invoke("ntfs-attack");
  assert.equal(ntfsAttack.value.readSha256, ntfsCreate.value.secretSha256);
  matrix.push({
    primitive: "ordinary NTFS current-user-only ACL file",
    rawSecretReadable: true, p0CanInvokeCryptographicOperation: true,
    p0CanDeleteOrReplace: ntfsAttack.value.delete && ntfsAttack.value.replace,
    p0CanChangeAccessPolicy: ntfsAttack.value.aclChange, survivesRestart: true,
    distinctAuthority: false, verdict: "REJECT_SAME_SID",
    actual: ntfsAttack.value,
  });

  const dpapiCreate = await invoke("dpapi-create");
  const dpapiAttack = await invoke("dpapi-attack");
  assert.equal(dpapiAttack.value.clearSha256, dpapiCreate.value.secretSha256);
  matrix.push({
    primitive: "DPAPI CurrentUser",
    rawSecretReadable: true, p0CanInvokeCryptographicOperation: true,
    p0CanDeleteOrReplace: dpapiAttack.value.replace,
    p0CanChangeAccessPolicy: true, survivesRestart: true,
    distinctAuthority: false, verdict: "REJECT_SAME_LOGON_CREDENTIAL",
    actual: dpapiAttack.value,
  });

  const credentialCreate = await invoke("credential-create", { name: credentialName });
  const credentialAttack = await invoke("credential-attack", { name: credentialName });
  assert.equal(credentialAttack.value.clearSha256, credentialCreate.value.secretSha256);
  matrix.push({
    primitive: "Windows current-user PasswordVault / Credential Locker",
    rawSecretReadable: true, p0CanInvokeCryptographicOperation: true,
    p0CanDeleteOrReplace: credentialAttack.value.delete && credentialAttack.value.replace,
    p0CanChangeAccessPolicy: "same current-user credential set (no distinct per-process policy)",
    survivesRestart: true, distinctAuthority: false,
    verdict: "REJECT_SAME_LOGON_CREDENTIAL_SET", actual: credentialAttack.value,
  });

  const softwareProvider = "Microsoft Software Key Storage Provider";
  const softwareCreate = await invoke("cng-create", { name: softwareKeyName, provider: softwareProvider });
  const softwareAttack = await invoke("cng-attack", { name: softwareKeyName, provider: softwareProvider });
  assert.equal(softwareAttack.value.oldFingerprint, softwareCreate.value.fingerprint);
  assert.equal(softwareAttack.value.cryptographicSignUsable, true);
  matrix.push({
    primitive: "CNG persisted non-exportable ECDSA P-256 key (software KSP)",
    rawSecretReadable: softwareAttack.value.privateExportable,
    p0CanInvokeCryptographicOperation: softwareAttack.value.cryptographicSignUsable,
    p0CanDeleteOrReplace: softwareAttack.value.delete && softwareAttack.value.replace,
    p0CanChangeAccessPolicy: "key belongs to the same user SID",
    survivesRestart: softwareCreate.value.persisted,
    distinctAuthority: false, verdict: "REJECT_SIGNING_ORACLE_AVAILABLE_TO_P0",
    actual: softwareAttack.value,
  });

  const tpmProvider = "Microsoft Platform Crypto Provider";
  const tpmCreate = await invoke("cng-create", { name: tpmKeyName, provider: tpmProvider, allowUnavailable: true, timeout: 45_000 });
  if (tpmCreate.exitCode === 0) {
    const tpmAttack = await invoke("cng-attack", { name: tpmKeyName, provider: tpmProvider, timeout: 45_000 });
    assert.equal(tpmAttack.value.oldFingerprint, tpmCreate.value.fingerprint);
    tpm = { available: true, create: tpmCreate.value, attack: tpmAttack.value };
    matrix.push({
      primitive: "TPM-backed CNG persisted non-exportable ECDSA P-256 key (platform KSP)",
      rawSecretReadable: tpmAttack.value.privateExportable,
      p0CanInvokeCryptographicOperation: tpmAttack.value.cryptographicSignUsable,
      p0CanDeleteOrReplace: tpmAttack.value.delete && tpmAttack.value.replace,
      p0CanChangeAccessPolicy: "key belongs to the same user SID",
      survivesRestart: tpmCreate.value.persisted,
      distinctAuthority: false, verdict: "REJECT_TPM_DOES_NOT_AUTHENTICATE_CALLING_PROCESS",
      actual: tpmAttack.value,
    });
  } else {
    tpm = { available: false, reason: tpmCreate.value.error, errorType: tpmCreate.value.errorType };
    matrix.push({
      primitive: "TPM-backed CNG persisted key (platform KSP)", rawSecretReadable: "NOT_TESTABLE",
      p0CanInvokeCryptographicOperation: "NOT_TESTABLE", p0CanDeleteOrReplace: "NOT_TESTABLE",
      p0CanChangeAccessPolicy: "NOT_TESTABLE", survivesRestart: "NOT_TESTABLE",
      distinctAuthority: false, verdict: "UNAVAILABLE_ON_HOST; WOULD_REJECT_IF_SAME_USER_CAN_OPEN/SIGN",
      actual: tpm,
    });
  }

  process.stdout.write(`${JSON.stringify({
    schema: "aiopago.r1-m-13-same-user-anchor-evidence/1",
    platform: `${process.platform}/${process.arch}`,
    p0HarnessPid: process.pid,
    windowsIdentity: identity.value,
    root,
    allAttackProcessesDistinctFromHarness: invocations.filter((item) => /attack$/.test(item.action)).every((item) => item.pid !== process.pid),
    matrix,
    tpm,
    decision: "PERSISTENT AUTHORITY REQUIRES A DISTINCT OS SECURITY IDENTITY",
    invocations: invocations.map(({ action, pid, exitCode }) => ({ action, pid, exitCode })),
  }, null, 2)}\n`);
} finally {
  await invoke("credential-clean", { name: credentialName, allowUnavailable: true }).catch(() => {});
  await invoke("cng-clean", { name: softwareKeyName, provider: "Microsoft Software Key Storage Provider", allowUnavailable: true }).catch(() => {});
  await invoke("cng-clean", { name: tpmKeyName, provider: "Microsoft Platform Crypto Provider", allowUnavailable: true, timeout: 45_000 }).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
