param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$ServiceSid)
$ErrorActionPreference='Stop'
function Protect([string]$Path,[Security.AccessControl.FileSystemRights]$ServiceRights){
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';$prop=[Security.AccessControl.PropagationFlags]::None;$allow=[Security.AccessControl.AccessControlType]::Allow
 $system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18');$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$service=New-Object Security.Principal.SecurityIdentifier($ServiceSid)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow)))
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admins,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow)))
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($service,$ServiceRights,$inherit,$prop,$allow)))
 Set-Acl -LiteralPath $Path -AclObject $acl
}
Protect $Root ([Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize')
Protect (Join-Path $Root 'bin') ([Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize')
Protect (Join-Path $Root 'output') ([Security.AccessControl.FileSystemRights]::FullControl)
