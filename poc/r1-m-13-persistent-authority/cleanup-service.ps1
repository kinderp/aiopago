# Elevated cleanup for the exact temporary R1-M-13 PoC service and roots only.
param([Parameter(Mandatory=$true)][string]$ExpectedBrokerSha256)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$service='AiopagoR1M13Poc';$sc="$env:SystemRoot\System32\sc.exe";$parent=Join-Path $env:ProgramData 'Aiopago';$root=Join-Path $parent 'R1M13Poc';$public=Join-Path $parent 'R1M13PocPublic';$broker=Join-Path $root 'bin\broker-service.exe'
$qc=&$sc qc $service|Out-String;if($LASTEXITCODE-ne0){throw 'POC_SERVICE_NOT_FOUND_BEFORE_CLEANUP'}
if($qc-notlike "*$broker*" -or $qc-notlike '*NT AUTHORITY\LocalService*'){throw 'SERVICE_IDENTITY_MISMATCH_REFUSE_DELETE'}
if(!(Test-Path -LiteralPath $broker)){throw 'BROKER_MISSING_REFUSE_DELETE'}
$actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $broker).Hash.ToLowerInvariant();if($actual-ne$ExpectedBrokerSha256.ToLowerInvariant()){throw 'BROKER_HASH_MISMATCH_REFUSE_DELETE'}
$status=&$sc query $service|Out-String;if($LASTEXITCODE-ne0){throw 'SERVICE_QUERY_FAILED'};if($status-match 'STATE\s+: 4|STATO\s+: 4'){&$sc stop $service *> $null;Start-Sleep -Milliseconds 300}
&$sc delete $service|Out-Host;if($LASTEXITCODE-ne0){throw 'SERVICE_DELETE_FAILED'}
$deadline=(Get-Date).AddSeconds(20);do{Start-Sleep -Milliseconds 100;&$sc query $service *> $null;$queryExit=$LASTEXITCODE}while($queryExit-ne1060-and(Get-Date)-lt$deadline)
if($queryExit-ne1060){throw "SERVICE_STILL_PRESENT:$queryExit"}
foreach($process in @(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -like "$root*" -or $_.CommandLine -like "*$root*"})){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}
# Remove only the exact public reparse entries created by p0-medium-attack.mjs
# before recursive cleanup, so cleanup never traverses an attacker cycle/target.
$attacker=Join-Path $public 'attacker';foreach($name in @('canonical-junction','binary-junction','canonical-substitute','binary-substitute')){$link=Join-Path $attacker $name;if(Test-Path -LiteralPath $link){& "$env:SystemRoot\System32\cmd.exe" /d /c "rmdir `"$link`""|Out-Null}}
Remove-Item -LiteralPath $root -Recurse -Force;Remove-Item -LiteralPath $public -Recurse -Force
if((Test-Path -LiteralPath $parent)-and(@(Get-ChildItem -Force -LiteralPath $parent).Count-eq0)){Remove-Item -LiteralPath $parent -Force}
[ordered]@{serviceStopped=$true;serviceDeleted=$true;queryAfterDelete=$queryExit;protectedRootRemoved=!(Test-Path $root);publicRootRemoved=!(Test-Path $public);parentRemoved=!(Test-Path $parent);brokerProcesses=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -like "$root*"}).Count;secretRetained=$false;result='PASS'}|ConvertTo-Json -Compress
