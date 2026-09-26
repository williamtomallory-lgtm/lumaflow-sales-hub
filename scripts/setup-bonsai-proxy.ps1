#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $projectRoot '.local-runtime\bonsai\proxy-token.txt'
New-Item -ItemType Directory -Path (Split-Path -Parent $secretPath) -Force | Out-Null

if (Test-Path -LiteralPath $secretPath) {
    $existing = (Get-Content -LiteralPath $secretPath -Raw).Trim()
    if ($existing.Length -lt 32) { throw 'Existing proxy token is too short; file was not changed.' }
    Write-Host 'Existing private Bonsai API token is ready.'
    return
}

$bytes = New-Object byte[] 48
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[IO.File]::WriteAllText($secretPath, $token, [Text.Encoding]::ASCII)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl -LiteralPath $secretPath
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
))
Set-Acl -LiteralPath $secretPath -AclObject $acl
Write-Host "Created a private API token at $secretPath. The token value is not displayed."
