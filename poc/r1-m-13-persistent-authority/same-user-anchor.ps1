# R1-M-13 same-user Windows trust-anchor probe. Non-production; test data only.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Name = "AiopagoR1M13PersistentAuthorityPoc",
  [string]$Provider = "Microsoft Software Key Storage Provider"
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

function Hex([byte[]]$Bytes) { return ([BitConverter]::ToString($Bytes)).Replace("-", "").ToLowerInvariant() }
function Sha256([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return Hex ($sha.ComputeHash($Bytes)) } finally { $sha.Dispose() }
}
function RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count; $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes); return $bytes } finally { $rng.Dispose() }
}
function Json($Value) { $Value | ConvertTo-Json -Compress -Depth 8 }
function EnsureRoot { [IO.Directory]::CreateDirectory($Root) | Out-Null }
function CngFingerprint([Security.Cryptography.CngKey]$Key) { return Sha256 ($Key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) }
function PasswordVault { return [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new() }
function VaultCredential([string]$Resource, [string]$Password) { return [Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new($Resource, [Environment]::UserName, $Password) }

try {
  switch ($Action) {
    "identity" {
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = New-Object Security.Principal.WindowsPrincipal($identity)
      Json ([ordered]@{ action=$Action; name=$identity.Name; sid=$identity.User.Value; elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); authenticationType=$identity.AuthenticationType })
    }
    "ntfs-create" {
      EnsureRoot; $directory = Join-Path $Root "same-user-ntfs"
      if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
      [IO.Directory]::CreateDirectory($directory) | Out-Null; $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
      $acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($identity.User); $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
      $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($directory, $acl)
      $secret = RandomBytes 32; $path = Join-Path $directory "authority.bin"; [IO.File]::WriteAllBytes($path, $secret)
      Json ([ordered]@{ action=$Action; path=$path; ownerSid=$identity.User.Value; secretSha256=Sha256 $secret })
    }
    "ntfs-attack" {
      $directory=Join-Path $Root "same-user-ntfs"; $path=Join-Path $directory "authority.bin"; $raw=[IO.File]::ReadAllBytes($path)
      $acl=[IO.Directory]::GetAccessControl($directory); $acl.SetAccessRuleProtection($false,$true); [IO.Directory]::SetAccessControl($directory,$acl)
      [IO.File]::WriteAllBytes($path,(RandomBytes 32)); [IO.File]::Delete($path); [IO.File]::WriteAllBytes($path,(RandomBytes 32))
      Json ([ordered]@{ action=$Action; rawSecretReadable=$true; readSha256=Sha256 $raw; write=$true; delete=$true; replace=$true; aclChange=$true })
    }
    "dpapi-create" {
      EnsureRoot; $secret=RandomBytes 32; $protected=[Security.Cryptography.ProtectedData]::Protect($secret,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $path=Join-Path $Root "dpapi-current-user.bin"; [IO.File]::WriteAllBytes($path,$protected)
      Json ([ordered]@{ action=$Action; path=$path; secretSha256=Sha256 $secret; ciphertextEqualsSecret=((Sha256 $secret) -eq (Sha256 $protected)) })
    }
    "dpapi-attack" {
      $path=Join-Path $Root "dpapi-current-user.bin"; $clear=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $replacement=[Security.Cryptography.ProtectedData]::Protect((RandomBytes 32),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes($path,$replacement)
      Json ([ordered]@{ action=$Action; rawSecretReadableAfterDpapi=$true; clearSha256=Sha256 $clear; protectedOperationUsable=$true; replace=$true })
    }
    "credential-create" {
      $vault=PasswordVault; try { $old=$vault.Retrieve($Name,[Environment]::UserName); $vault.Remove($old) } catch {}
      $secret=Hex (RandomBytes 32); $vault.Add((VaultCredential $Name $secret))
      Json ([ordered]@{ action=$Action; resource=$Name; secretSha256=Sha256 ([Text.Encoding]::UTF8.GetBytes($secret)); persist="Windows current-user PasswordVault/Credential Locker" })
    }
    "credential-attack" {
      $vault=PasswordVault; $credential=$vault.Retrieve($Name,[Environment]::UserName); $credential.RetrievePassword(); $clear=$credential.Password
      $vault.Remove($credential); $replacement=Hex (RandomBytes 32); $vault.Add((VaultCredential $Name $replacement)); $check=$vault.Retrieve($Name,[Environment]::UserName); $check.RetrievePassword()
      Json ([ordered]@{ action=$Action; rawSecretReadable=$true; clearSha256=Sha256 ([Text.Encoding]::UTF8.GetBytes($clear)); cryptographicUsePossible=$true; delete=$true; replace=($check.Password -eq $replacement) })
    }
    "credential-clean" {
      $deleted=$false; $vault=PasswordVault; try { $old=$vault.Retrieve($Name,[Environment]::UserName); $vault.Remove($old); $deleted=$true } catch {}
      Json ([ordered]@{ action=$Action; deleted=$deleted })
    }
    "cng-create" {
      $providerObject=New-Object Security.Cryptography.CngProvider($Provider); try { $existing=[Security.Cryptography.CngKey]::Open($Name,$providerObject); $existing.Delete(); $existing.Dispose() } catch {}
      $parameters=New-Object Security.Cryptography.CngKeyCreationParameters; $parameters.Provider=$providerObject; $parameters.ExportPolicy=[Security.Cryptography.CngExportPolicies]::None; $parameters.KeyUsage=[Security.Cryptography.CngKeyUsages]::Signing
      $key=[Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256,$Name,$parameters)
      try { $privateExportable=$true; try { $null=$key.Export([Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob) } catch { $privateExportable=$false }
        Json ([ordered]@{ action=$Action; provider=$Provider; keyName=$Name; fingerprint=CngFingerprint $key; privateExportable=$privateExportable; persisted=!$key.IsEphemeral })
      } finally { $key.Dispose() }
    }
    "cng-attack" {
      $providerObject=New-Object Security.Cryptography.CngProvider($Provider); $key=[Security.Cryptography.CngKey]::Open($Name,$providerObject); $oldFingerprint=CngFingerprint $key
      $privateExportable=$true; try { $null=$key.Export([Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob) } catch { $privateExportable=$false }
      $signer=New-Object Security.Cryptography.ECDsaCng($key); try { $signature=$signer.SignData([Text.Encoding]::UTF8.GetBytes("forged durable mutation"),[Security.Cryptography.HashAlgorithmName]::SHA256) } finally { $signer.Dispose() }
      $key=[Security.Cryptography.CngKey]::Open($Name,$providerObject); $key.Delete(); $key.Dispose()
      $parameters=New-Object Security.Cryptography.CngKeyCreationParameters; $parameters.Provider=$providerObject; $parameters.ExportPolicy=[Security.Cryptography.CngExportPolicies]::None; $parameters.KeyUsage=[Security.Cryptography.CngKeyUsages]::Signing
      $replacement=[Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256,$Name,$parameters); try { $newFingerprint=CngFingerprint $replacement } finally { $replacement.Dispose() }
      Json ([ordered]@{ action=$Action; provider=$Provider; privateExportable=$privateExportable; cryptographicSignUsable=($signature.Length -gt 0); signatureBytes=$signature.Length; delete=$true; replace=$true; oldFingerprint=$oldFingerprint; newFingerprint=$newFingerprint; identityChanged=($oldFingerprint -ne $newFingerprint) })
    }
    "cng-clean" {
      $providerObject=New-Object Security.Cryptography.CngProvider($Provider); $deleted=$false; try { $key=[Security.Cryptography.CngKey]::Open($Name,$providerObject); $key.Delete(); $key.Dispose(); $deleted=$true } catch {}
      Json ([ordered]@{ action=$Action; provider=$Provider; deleted=$deleted })
    }
    default { throw "UNKNOWN_ACTION: $Action" }
  }
} catch {
  Json ([ordered]@{ action=$Action; provider=$Provider; available=$false; errorType=$_.Exception.GetType().FullName; error=$_.Exception.Message }); exit 2
}
