#Requires -Version 5.1
[CmdletBinding()]
param([switch]$NoWait)

$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot '.local-runtime\bonsai'
$binary = Join-Path $runtime 'bin\llama-server.exe'
$model = Join-Path $PSScriptRoot '.local-data\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
$mmproj = Join-Path $PSScriptRoot '.local-data\models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'
$url = 'http://127.0.0.1:8081'
$alias = 'ternary-bonsai-2-27b'

function Test-BonsaiReady {
    try {
        $health = Invoke-RestMethod "$url/health" -TimeoutSec 2
        $models = Invoke-RestMethod "$url/v1/models" -TimeoutSec 2
        return $health.status -eq 'ok' -and $alias -in @($models.data.id)
    } catch { return $false }
}

if (-not (Test-Path -LiteralPath $binary) -or -not (Test-Path -LiteralPath $model) -or -not (Test-Path -LiteralPath $mmproj)) {
    throw 'Bonsai is not installed. Run ./Setup-Bonsai.ps1 first.'
}
if ((Get-Item -LiteralPath $model).Length -ne 5946648928) {
    throw 'Unexpected Bonsai weight size. Run ./Setup-Bonsai.ps1 to verify/finish the download.'
}
if ((Get-Item -LiteralPath $mmproj).Length -ne 629246976) {
    throw 'Unexpected Bonsai vision-projector size. Run ./Setup-Bonsai.ps1 to verify/finish the download.'
}

if (Test-BonsaiReady) {
    $listener = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
        # The public LumaFlow project can already be serving this exact model
        # from the sibling NewProject runtime. Reuse that verified local service.
        $sibling = Join-Path (Split-Path $PSScriptRoot -Parent) 'NewProject'
        $siblingBinary = Join-Path $sibling '.local-runtime\bonsai\bin\llama-server.exe'
        $siblingModel = Join-Path $sibling '.local-data\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
        $siblingMmproj = Join-Path $sibling '.local-data\models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'
        if ($owner.ExecutablePath -eq $siblingBinary -and
            $owner.CommandLine.Contains($siblingModel) -and
            $owner.CommandLine.Contains($siblingMmproj)) {
            Write-Host "Bonsai text and vision ready: $url (shared local service)"
            return
        }
        if ($owner.ExecutablePath -ne $binary) { throw 'Port 8081 is occupied by another application.' }
        if ($owner.CommandLine -like "*--mmproj*$([IO.Path]::GetFileName($mmproj))*") {
            Write-Host "Bonsai text and vision ready: $url (existing service)"
            return
        }
        if ($owner.CommandLine -notlike "*$([IO.Path]::GetFileName($model))*") {
            throw 'Port 8081 is serving another llama model; it was not stopped.'
        }
        Write-Host 'Restarting the existing Bonsai process to load the vision projector...'
        Stop-Process -Id $listener.OwningProcess -Force
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (-not (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
    }
}

# Do not start a second copy or terminate an unrelated listener on this port.
$listener = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = Get-Process -Id $listener[0].OwningProcess -ErrorAction Stop
    if ($owner.Path -ne $binary) { throw 'Port 8081 is occupied by another application.' }
    Write-Host 'Waiting for the existing Bonsai process to finish loading...'
} else {
    # These options were tested on an 8 GB RTX 5060 Laptop GPU. One slot, 8K
    # context and a small prefill batch leave room for the Windows desktop.
    # No Ollama import: PTQ1_0 requires PrismML-specific ternary CUDA kernels.
    $arguments = @(
        '--model', ('"' + $model + '"'), '--alias', $alias,
        '--mmproj', ('"' + $mmproj + '"'), '--no-mmproj-offload',
        '--host', '127.0.0.1', '--port', '8081', '--cors-origins', 'localhost',
        '-ngl', '99', '-c', '8192', '-np', '1', '-b', '256', '-ub', '128',
        '-fa', 'on', '--jinja', '--reasoning', 'off',
        '--temp', '0.7', '--top-p', '0.8', '--top-k', '20'
    )
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $process = Start-Process -FilePath $binary -ArgumentList $arguments -WorkingDirectory (Split-Path $binary) `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "server-$stamp.out.log") `
        -RedirectStandardError (Join-Path $runtime "server-$stamp.err.log") -PassThru
    Write-Host "Bonsai loading, PID $($process.Id). Logs: $runtime"
}
if ($NoWait) { return }
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-BonsaiReady) {
        Write-Host "Bonsai text and vision ready: $url/v1; model=$alias; context=8192; reasoning=off"
        return
    }
    if ($process -and $process.HasExited) { throw "Bonsai exited. Check logs in $runtime" }
    Start-Sleep -Seconds 1
}
throw "Bonsai did not become ready. Check logs in $runtime"
