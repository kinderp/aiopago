# Explicit elevated, scoped provisioning for physical operation-authority tests.
param(
  [Parameter(Mandatory=$true)][string]$ServiceName,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$BrokerSource,
  [Parameter(Mandatory=$true)][string]$WorkerSource,
  [Parameter(Mandatory=$true)][string]$NodeSource,
  [Parameter(Mandatory=$true)][string]$MediumLauncher,
  [Parameter(Mandatory=$true)][string]$NegativeProbe,
  [Parameter(Mandatory=$true)][string]$PublicOutput
)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if(-not $ServiceName.StartsWith('AiopagoOperationAuthorityTest-')){throw 'TEST_SERVICE_NAME_REQUIRED'}
$sc="$env:SystemRoot\System32\sc.exe"
function Native([string]$File,[string[]]$Arguments){& $File @Arguments|Out-Host;if($LASTEXITCODE-ne 0){throw "NATIVE_FAILED($LASTEXITCODE): $File $Arguments"}}
& $sc query $ServiceName *> $null; if($LASTEXITCODE-ne 1060){throw 'PREEXISTING_SERVICE'}
if(Test-Path -LiteralPath $Root){throw 'PREEXISTING_ROOT'}
$parent=Split-Path -Parent $Root
New-Item -ItemType Directory -Force -Path $parent|Out-Null
$bin=Join-Path $Root 'bin';$canonical=Join-Path $Root 'canonical';$runtime=Join-Path $Root 'runtime';$control=Join-Path $Root 'control'
New-Item -ItemType Directory -Force -Path $Root,$bin,$canonical,$runtime,$control,$PublicOutput|Out-Null
$sidText=(& $sc showsid $ServiceName|Out-String)
$sid=[regex]::Match($sidText,'S-1-5-80-(?:\d+-){4}\d+').Value;if(-not $sid){throw 'SERVICE_SID_UNAVAILABLE'}
function ProtectDirectory([string]$Path,[Security.Principal.SecurityIdentifier]$ServiceIdentity,[Security.AccessControl.FileSystemRights]$ServiceRights,[Security.Principal.SecurityIdentifier]$UserIdentity=$null,[Security.AccessControl.FileSystemRights]$UserRights=0){
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';$prop=[Security.AccessControl.PropagationFlags]::None;$allow=[Security.AccessControl.AccessControlType]::Allow
  foreach($entry in @(@((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),[Security.AccessControl.FileSystemRights]::FullControl),@((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')),[Security.AccessControl.FileSystemRights]::FullControl))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($entry[0],$entry[1],$inherit,$prop,$allow)))}
  if($null -ne $ServiceIdentity){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($ServiceIdentity,$ServiceRights,$inherit,$prop,$allow)))}
  if($null -ne $UserIdentity){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($UserIdentity,$UserRights,$inherit,$prop,$allow)))}
  Set-Acl -LiteralPath $Path -AclObject $acl
}
# No private/config/binary bytes exist yet. Harden owner/DACL first. A numeric
# service SID is installed directly into the DACL; account-name resolution and
# service registration are deliberately not prerequisites.
$serviceIdentity=New-Object Security.Principal.SecurityIdentifier($sid)
$usersIdentity=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$currentIdentity=New-Object Security.Principal.SecurityIdentifier([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
ProtectDirectory $parent $null 0 $usersIdentity ([Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize')
ProtectDirectory $Root $serviceIdentity ([Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize')
ProtectDirectory $bin $serviceIdentity ([Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize')
ProtectDirectory $canonical $serviceIdentity ([Security.AccessControl.FileSystemRights]::FullControl)
# P1S-created SQLite/key/WAL files are initially owned by shared LocalService.
# An inheritable OWNER RIGHTS deny removes the owner's implicit WRITE_DAC and
# WRITE_OWNER, while the unique service SID retains data access. The canonical
# directory itself is SYSTEM-owned so Administrators' explicit recovery access
# is not affected by the owner-specific deny.
$canonicalAcl=Get-Acl -LiteralPath $canonical
$canonicalAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))
$ownerRights=New-Object Security.Principal.SecurityIdentifier('S-1-3-4')
$ownerDeny=New-Object Security.AccessControl.FileSystemAccessRule($ownerRights,([Security.AccessControl.FileSystemRights]'ChangePermissions,TakeOwnership'),([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
$canonicalAcl.AddAccessRule($ownerDeny);Set-Acl -LiteralPath $canonical -AclObject $canonicalAcl
ProtectDirectory $runtime $serviceIdentity ([Security.AccessControl.FileSystemRights]::FullControl)
ProtectDirectory $control $serviceIdentity ([Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize')
ProtectDirectory $PublicOutput $null 0 $currentIdentity ([Security.AccessControl.FileSystemRights]::Modify)
$negative=Join-Path $PublicOutput 'provision-negative.json'
& $MediumLauncher $NodeSource $NegativeProbe '--root' $Root '--output' $negative|Out-Host
if($LASTEXITCODE-ne 0){throw 'MEDIUM_NEGATIVE_PROBE_LAUNCH_FAILED'}
$probe=Get-Content -Raw -LiteralPath $negative|ConvertFrom-Json
if(-not $probe.allDenied){throw 'ROOT_NOT_PROTECTED_BEFORE_COPY'}
# Only now install protected bytes/config. Service and first secret do not exist.
$broker=Join-Path $bin 'broker-service.exe';$node=Join-Path $bin 'node.exe';$worker=Join-Path $bin 'operation-authority-worker.mjs'
Copy-Item -LiteralPath $BrokerSource -Destination $broker
Copy-Item -LiteralPath $NodeSource -Destination $node
Copy-Item -LiteralPath $WorkerSource -Destination $worker
$brokerSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $broker).Hash.ToLowerInvariant()
$nodeSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant()
$workerSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $worker).Hash.ToLowerInvariant()
if($brokerSha -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $BrokerSource).Hash.ToLowerInvariant()){throw 'BROKER_COPY_HASH_MISMATCH'}
if($workerSha -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $WorkerSource).Hash.ToLowerInvariant()){throw 'WORKER_COPY_HASH_MISMATCH'}
$config=[ordered]@{schema='aiopago.operation-authority-service-config/1';serviceName=$ServiceName;serviceSid=$sid;root=$Root;protocol='aiopago.operation-authority-protocol/7';testScope=$true;brokerSha256=$brokerSha;nodeSha256=$nodeSha;workerSha256=$workerSha}
$config|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $control 'service-config.json') -Encoding UTF8
[ordered]@{schema='aiopago.operation-authority-test-scenario/1';requests=@()}|ConvertTo-Json -Depth 20 -Compress|Set-Content -LiteralPath (Join-Path $control 'scenario.json') -Encoding UTF8
# Service is created last; P1S creates identity and canonical DB on first start.
$image="`"$broker`" --config `"$(Join-Path $control 'service-config.json')`""
Native $sc @('create',$ServiceName,'type=','own','start=','demand','error=','normal','obj=','NT AUTHORITY\LocalService','binPath=',$image)
Native $sc @('sidtype',$ServiceName,'unrestricted')
[ordered]@{schema='aiopago.operation-authority-provision-result/1';serviceName=$ServiceName;serviceSid=$sid;sidType='UNRESTRICTED';root=$Root;bin=$bin;canonical=$canonical;runtime=$runtime;control=$control;broker=$broker;node=$node;worker=$worker;brokerSha256=$brokerSha;nodeSha256=$nodeSha;workerSha256=$workerSha;preSecretNegativeProbe=$probe}|ConvertTo-Json -Depth 20 -Compress
