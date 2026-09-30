#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$NoWait,
    [switch]$Restart,
    [ValidateSet('optimized', 'baseline')]
    [string]$PerformanceProfile = 'optimized'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot '.local-runtime\bonsai'
$binary = Join-Path $runtime 'bin\llama-server.exe'
$model = Join-Path $projectRoot '.local-data\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
$mmproj = Join-Path $projectRoot '.local-data\models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'
$chatTemplate = Join-Path $PSScriptRoot 'bonsai-codex-chat-template.jinja'
$url = 'http://127.0.0.1:8081'
$alias = 'ternary-bonsai-2-27b'

# Measured on RTX 5060 Laptop 8 GB / 16 GB system RAM. Baseline retains
# the original arguments for a reproducible comparison or a one-command rollback.
$optimized = $PerformanceProfile -eq 'optimized'
$BatchSize = if ($optimized) { 1024 } else { 256 }
$MicroBatchSize = if ($optimized) { 512 } else { 128 }
$arguments = @(
    '--model', ('"' + $model + '"'), '--alias', $alias,
    '--mmproj', ('"' + $mmproj + '"'), '--no-mmproj-offload',
    '--chat-template-file', ('"' + $chatTemplate + '"'),
    '--host', '127.0.0.1', '--port', '8081', '--cors-origins', 'localhost',
    '-ngl', '99', '-c', '32768', '-np', '1', '-b', "$BatchSize", '-ub', "$MicroBatchSize",
    '--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0',
    '-fa', 'on', '--jinja', '--reasoning', 'off',
    '--temp', '0.7', '--top-p', '0.8', '--top-k', '20'
)
if ($optimized) {
    $arguments += @('--threads', '8', '--threads-batch', '8', '--cache-ram', '1024')
    # Context-copy drafting uses the existing target model; no second weights.
    # This reuses llama.cpp's implementation, inspired by TensorFold's context
    # drafts. It does not implement TensorFold's row-exact CUDA kernels.
    $arguments += @('--spec-type', 'ngram-simple', '--spec-ngram-simple-size-n', '12', '--spec-ngram-simple-size-m', '16')
}

function Test-BonsaiReady {
    try {
        $health = Invoke-RestMethod "$url/health" -TimeoutSec 2
        $models = Invoke-RestMethod "$url/v1/models" -TimeoutSec 2
        return $health.status -eq 'ok' -and $alias -in @($models.data.id)
    } catch { return $false }
}

if (-not (Test-Path -LiteralPath $binary) -or -not (Test-Path -LiteralPath $model) -or -not (Test-Path -LiteralPath $mmproj) -or -not (Test-Path -LiteralPath $chatTemplate)) {
    throw 'Bonsai is not installed. Run ./scripts/setup-bonsai.ps1 first.'
}
if ((Get-Item -LiteralPath $model).Length -ne 5946648928) {
    throw 'Unexpected Bonsai weight size. Run ./scripts/setup-bonsai.ps1 to verify/finish the download.'
}
if ((Get-Item -LiteralPath $mmproj).Length -ne 629246976) {
    throw 'Unexpected Bonsai vision-projector size. Run ./scripts/setup-bonsai.ps1 to verify/finish the download.'
}

if (Test-BonsaiReady) {
    $listener = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
        if ($owner.ExecutablePath -ne $binary) { throw 'Port 8081 is occupied by another application.' }
        if ($owner.CommandLine.Trim().EndsWith(($arguments -join ' '), [StringComparison]::Ordinal)) {
            Write-Host "Bonsai text + vision ready: $url (existing $PerformanceProfile service)"
            return
        }
        if (-not $owner.CommandLine.Contains(('"' + $model + '"'))) {
            throw 'Port 8081 is serving another llama model; it was not stopped.'
        }
        if (-not $Restart) {
            throw 'Bonsai is running with different settings. Retry with -Restart when no clients are submitting requests.'
        }
        $slots = @(Invoke-RestMethod "$url/slots" -TimeoutSec 3)
        if ($slots | Where-Object { $_.is_processing }) {
            throw 'Bonsai is processing a request. Retry the launcher after it finishes; no request was interrupted.'
        }
        Write-Host 'Restarting the idle Bonsai service to apply the requested runtime settings...'
        Stop-Process -Id $listener.OwningProcess -Force
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (-not (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
        if (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) {
            throw 'Port 8081 was not released after stopping Bonsai; no success was reported.'
        }
    }
}

$listener = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)" -ErrorAction Stop
    if ($owner.ExecutablePath -ne $binary) { throw 'Port 8081 is occupied by another application.' }
    if (-not $owner.CommandLine.Trim().EndsWith(($arguments -join ' '), [StringComparison]::Ordinal)) {
        throw 'A Bonsai process with different settings is loading; wait for it before switching profiles.'
    }
    Write-Host 'Waiting for the existing Bonsai process to finish loading...'
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $process = Start-Process -FilePath $binary -ArgumentList $arguments -WorkingDirectory (Split-Path $binary) `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "server-$stamp.out.log") `
        -RedirectStandardError (Join-Path $runtime "server-$stamp.err.log") -PassThru
    Write-Host "Bonsai loading, PID $($process.Id). Logs: $runtime"
}
if ($NoWait) { return }
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-BonsaiReady) {
        Write-Host "Bonsai text + vision ready: $url/v1; model=$alias; context=32768; KV=Q4; profile=$PerformanceProfile"
        return
    }
    if ($process -and $process.HasExited) { throw "Bonsai exited. Check logs in $runtime" }
    Start-Sleep -Seconds 1
}
throw "Bonsai did not become ready. Check logs in $runtime"
