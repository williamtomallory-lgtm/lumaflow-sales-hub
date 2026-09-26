#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $projectRoot '.local-runtime\bonsai\proxy-token.txt'
if (-not (Test-Path -LiteralPath $secretPath)) { & (Join-Path $PSScriptRoot 'setup-bonsai-proxy.ps1') }
$env:BONSAI_PROXY_TOKEN = (Get-Content -LiteralPath $secretPath -Raw).Trim()
if ($env:BONSAI_PROXY_TOKEN.Length -lt 32) { throw 'The local Bonsai API token is invalid.' }
$env:BONSAI_PROXY_PORT = '8082'
Push-Location $projectRoot
try { & node (Join-Path $PSScriptRoot 'bonsai-api-proxy.mjs') } finally { Pop-Location }
