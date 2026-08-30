# Elevated provisioning for the temporary R1-M-13 service PoC only.
param([Parameter(Mandatory=$true)][string]$BrokerSource,[Parameter(Mandatory=$true)][string]$Worktree)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$service='AiopagoR1M13Poc'; $sc="$env:SystemRoot\System32\sc.exe"; $ic="$env:SystemRoot\System32\icacls.exe"
$parent=Join-Path $env:ProgramData 'Aiopago'; $root=Join-Path $parent 'R1M13Poc'; $public=Join-Path $parent 'R1M13PocPublic'
$bin=Join-Path $root 'bin'; $canonical=Join-Path $root 'canonical'; $control=Join-Path $root 'control'; $output=Join-Path $root 'test-output'
function Native([string]$File,[string[]]$Arguments){ & $File @Arguments | Out-Host; if($LASTEXITCODE-ne 0){throw "NATIVE_FAILED($LASTEXITCODE): $File $Arguments"} }
& $sc query $service *> $null; if($LASTEXITCODE-ne 1060){throw 'PREEXISTING_SERVICE'}
if(Test-Path -LiteralPath $root){throw 'PREEXISTING_ROOT'}; if(Test-Path -LiteralPath $public){throw 'PREEXISTING_PUBLIC_ROOT'}
New-Item -ItemType Directory -Force -Path $bin,$canonical,$control,$output,$public|Out-Null
$broker=Join-Path $bin 'broker-service.exe'; Copy-Item -LiteralPath $BrokerSource -Destination $broker
$node=(Get-Command node.exe).Source; Copy-Item -LiteralPath $node -Destination (Join-Path $bin 'node.exe')
Copy-Item -LiteralPath (Join-Path $Worktree 'poc\r1-m-13-persistent-authority\p2-service-runtime.mjs') -Destination (Join-Path $bin 'p2-service-runtime.mjs')
$sourceSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $BrokerSource).Hash.ToLowerInvariant(); $installedSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $broker).Hash.ToLowerInvariant()
if($sourceSha-ne$installedSha){throw 'COPY_HASH_MISMATCH'}
Native $sc @('create',$service,'type=','own','start=','demand','error=','normal','obj=','NT AUTHORITY\LocalService','binPath=',"`"$broker`" --windows-service")
# RESTRICTED was physically attempted first. The service ran, but dynamically
# linked children (Node and whoami) failed loader initialization with 0xc0000142.
# Do not grant this service across Windows system paths merely to force that
# token through. UNRESTRICTED still adds the service-specific SID; protected
# DACLs below grant that SID, never the shared LocalService SID.
Native $sc @('sidtype',$service,'unrestricted'); $sid="NT SERVICE\$service"; $user="$env:USERDOMAIN\$env:USERNAME"
function ExactAcl([string]$Path,[string[]]$Rules){
  # Add explicit recovery/admin rules before removing inherited access.
  Native $ic (@($Path,'/grant:r') + $Rules)
  Native $ic @($Path,'/inheritance:r')
}
ExactAcl $parent @('SYSTEM:(OI)(CI)(F)','BUILTIN\Administrators:(OI)(CI)(F)','BUILTIN\Users:(RX)',"${sid}:(RX)")
ExactAcl $root @('SYSTEM:(OI)(CI)(F)','BUILTIN\Administrators:(OI)(CI)(F)',"${sid}:(RX)")
ExactAcl $bin @('SYSTEM:(OI)(CI)(F)','BUILTIN\Administrators:(OI)(CI)(F)',"${sid}:(OI)(CI)(RX)")
ExactAcl $canonical @('SYSTEM:(OI)(CI)(F)','BUILTIN\Administrators:(OI)(CI)(F)',"${sid}:(OI)(CI)(F)")
ExactAcl $control @('SYSTEM:(OI)(CI)(F)','BUILTIN\Administrators:(OI)(CI)(F)',"${sid}:(OI)(CI)(R)")
ExactAcl $output @('SYSTEM:(OI)(CI)(F)','BUILTIN\Administrators:(OI)(CI)(F)',"${sid}:(OI)(CI)(F)")
ExactAcl $public @('SYSTEM:(OI)(CI)(F)','BUILTIN\Administrators:(OI)(CI)(F)',"${user}:(OI)(CI)(M)","${sid}:(OI)(CI)(M)")
# Ownership matters independently of textual allow ACEs: never leave the
# invoking P0 SID as owner of a protected object (owners may rewrite DACLs).
Native $ic @($parent,'/setowner','BUILTIN\Administrators')
Native $ic @($root,'/setowner','BUILTIN\Administrators','/t','/c')
Set-Content -LiteralPath (Join-Path $control 'projection-path.txt') -Value (Join-Path $public 'projection.json') -Encoding ASCII
Set-Content -LiteralPath (Join-Path $control 'mode.txt') -Value 'before' -Encoding ASCII
[ordered]@{service=$service;root=$root;publicRoot=$public;broker=$broker;projection=(Join-Path $public 'projection.json');sourceSha=$sourceSha;installedSha=$installedSha;nodeSha=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $bin 'node.exe')).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress
& $sc qc $service; & $sc qsidtype $service; & $sc showsid $service; & $sc sdshow $service
foreach($path in @($parent,$root,$bin,$canonical,$control,$output,$public)){Write-Output "--- ACL $path";& $ic $path}
