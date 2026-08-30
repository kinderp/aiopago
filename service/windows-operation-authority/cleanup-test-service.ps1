# Explicit elevated cleanup for scoped physical test resources only.
param(
 [Parameter(Mandatory=$true)][string]$ServiceName,
 [Parameter(Mandatory=$true)][string]$SentinelServiceName,
 [Parameter(Mandatory=$true)][string]$TestRoot,
 [Parameter(Mandatory=$true)][string]$SentinelRoot
)
$ErrorActionPreference='Continue';$sc="$env:SystemRoot\System32\sc.exe"
foreach($service in @($ServiceName,$SentinelServiceName)){
 if(-not ($service.StartsWith('AiopagoOperationAuthorityTest-') -or $service.StartsWith('AiopagoOperationAuthoritySentinel-'))){throw "REFUSE_NON_TEST_SERVICE: $service"}
 & $sc stop $service *> $null; Start-Sleep -Milliseconds 500
 & $sc delete $service *> $null
 for($i=0;$i -lt 30;$i++){& $sc query $service *> $null;if($LASTEXITCODE -eq 1060){break};Start-Sleep -Milliseconds 200}
}
$expected=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Aiopago\OperationAuthorityTests'))
$actual=[IO.Path]::GetFullPath($TestRoot)
if(-not $actual.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'REFUSE_NON_TEST_ROOT'}
foreach($path in @($actual,$SentinelRoot)){if($path -and (Test-Path -LiteralPath $path)){Remove-Item -LiteralPath $path -Recurse -Force}}
$parent=Split-Path -Parent $actual
if((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force|Select-Object -First 1)){Remove-Item -LiteralPath $parent -Force}
