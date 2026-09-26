#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot '.local-runtime\bonsai'
$tokenPath = Join-Path $runtime 'proxy-token.txt'
$proxyUrl = 'http://127.0.0.1:8082/v1/models'
$modelId = 'ternary-bonsai-2-27b'

& (Join-Path $PSScriptRoot 'start-bonsai.ps1')
if (-not (Test-Path -LiteralPath $tokenPath)) {
    throw 'The Bonsai proxy token is missing. Run setup-bonsai-proxy.ps1 first.'
}
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
if ($token.Length -lt 32) { throw 'The Bonsai proxy token is invalid.' }

function Test-ProxyReady {
    try {
        $models = Invoke-RestMethod -Uri $proxyUrl -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3
        return $modelId -in @($models.data.id)
    } catch { return $false }
}

if (-not (Test-ProxyReady)) {
    if (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue) {
        throw 'Port 8082 is occupied by an unexpected service.'
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script = Join-Path $PSScriptRoot 'start-bonsai-proxy.ps1'
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $script + '"'))
    $proxy = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $projectRoot `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "proxy-$stamp.out.log") `
        -RedirectStandardError (Join-Path $runtime "proxy-$stamp.err.log") -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-ProxyReady) { break }
        if ($proxy.HasExited) { throw "Bonsai proxy exited. Check logs in $runtime" }
        Start-Sleep -Seconds 1
    }
    if (-not (Test-ProxyReady)) { throw "Bonsai proxy did not start. Check logs in $runtime" }
}

for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $status = & tailscale status --json 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -eq 0 -and $status.BackendState -eq 'Running') { break }
    Start-Sleep -Seconds 2
}
if ($status.BackendState -ne 'Running') { throw 'Tailscale did not connect within two minutes.' }

$null = & tailscale funnel --bg 8082 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Funnel could not be started.' }
$funnel = & tailscale funnel status 2>&1
if ($LASTEXITCODE -ne 0 -or ($funnel -join "`n") -notmatch 'Funnel on') { throw 'Tailscale Funnel did not report an active route.' }
Write-Host "Bonsai API ready through Tailscale Funnel: https://$($status.Self.DNSName.TrimEnd('.'))/v1"
