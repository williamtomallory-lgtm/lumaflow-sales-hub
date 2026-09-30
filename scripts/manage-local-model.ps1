#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('configured', 'naive-n05-flash-int4-experimental', 'image')]
    [string]$Profile,
    [switch]$Startup,
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$specs = @{
    configured = @{ Port = 8081; Model = 'ternary-bonsai-2-27b'; Marker = 'Ternary-Bonsai-2-27B-PTQ1_0.gguf'; Name = 'llama-server.exe' }
    'naive-n05-flash-int4-experimental' = @{ Port = 8083; Model = 'naive-n0.5-flash-int4-48l-1e'; Marker = 'serve-naive-int4.py'; Name = 'python.exe' }
    image = @{ Port = 8084; Model = 'Qwen/Qwen-Image-2.1'; Marker = 'serve-qwen-image.py'; Name = 'python.exe' }
}
function Get-Services([string]$Key) {
    $spec = $specs[$Key]
    $known = @(Get-CimInstance Win32_Process -Filter "Name='$($spec.Name)'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($spec.Marker) -and $_.CommandLine.Contains($projectRoot) })
    $listeners = @(Get-NetTCPConnection -LocalPort $spec.Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -and $listeners[0].OwningProcess -notin @($known.ProcessId)) { throw "Port $($spec.Port) is occupied by an unrelated application; it was left running." }
    return $known
}
function Test-Ready([string]$Key) {
    $spec = $specs[$Key]
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$($spec.Port)/health" -TimeoutSec 2
        $models = Invoke-RestMethod "http://127.0.0.1:$($spec.Port)/v1/models" -TimeoutSec 2
        $settingsMatch = if ($Key -eq 'image') { $health.quantization -eq 'experimental-low-bit' } elseif ($Key -eq 'naive-n05-flash-int4-experimental') { $health.gpu_packed_weights -eq $true } else { $true }
        return $health.status -eq 'ok' -and $spec.Model -in @($models.data.id) -and $settingsMatch
    } catch { return $false }
}
function Stop-Service([string]$Key) {
    $owners = @(Get-Services $Key)
    if (-not $owners.Count) { return }
    $spec = $specs[$Key]
    $listeners = @(Get-NetTCPConnection -LocalPort $spec.Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count) {
        # A request in another tab must finish before its model is unloaded.
        if ($Key -eq 'configured') {
            $slots = @(Invoke-RestMethod "http://127.0.0.1:$($spec.Port)/slots" -TimeoutSec 3)
            if ($slots | Where-Object { $_.is_processing }) { throw 'MODEL_BUSY: Bonsai is answering; retry when it finishes.' }
        } else {
            $health = Invoke-RestMethod "http://127.0.0.1:$($spec.Port)/health" -TimeoutSec 3
            if ($health.busy) { throw 'MODEL_BUSY: The local model is processing a request.' }
        }
    }
    # Matches include the Windows venv launcher and its actual Python child.
    foreach ($owner in $owners) { Stop-Process -Id $owner.ProcessId -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 30; $i++) {
        if (-not @(Get-Services $Key).Count) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "The $Key process did not exit."
}
$mutex = New-Object System.Threading.Mutex($false, 'Local\LumaFlow-ModelRuntime')
$ownsLock = $false
$launched = $false
$selectionFile = Join-Path $projectRoot '.local-runtime\selected-local-model.json'
$previousSelection = $null
$selectionChanged = $false
try {
    try { $ownsLock = $mutex.WaitOne(1000) } catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
    if (-not $ownsLock) { throw 'MODEL_BUSY: Another model is loading. Please wait.' }
    if ($Startup -and (Test-Path -LiteralPath $selectionFile)) {
        $saved = Get-Content -LiteralPath $selectionFile -Raw | ConvertFrom-Json
        if ($saved.profile -ne 'configured') { Write-Output 'Automatic Bonsai start deferred to the selected model.'; exit 0 }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $selectionFile) -Force | Out-Null
    if (Test-Path -LiteralPath $selectionFile) { $previousSelection = Get-Content -LiteralPath $selectionFile -Raw }
    $temporarySelection = $selectionFile + '.tmp'
    @{ profile = $Profile; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporarySelection -Encoding UTF8
    Move-Item -LiteralPath $temporarySelection -Destination $selectionFile -Force
    $selectionChanged = $true
    $started = [Diagnostics.Stopwatch]::StartNew()
    foreach ($key in $specs.Keys) { if ($key -ne $Profile) { Stop-Service $key } }
    if (Test-Ready $Profile) { Write-Output "ready profile=$Profile elapsed_ms=$($started.ElapsedMilliseconds)"; exit 0 }
    if (@(Get-Services $Profile).Count) {
        try { $currentHealth = Invoke-RestMethod "http://127.0.0.1:$($specs[$Profile].Port)/health" -TimeoutSec 2 } catch { $currentHealth = $null }
        if ($currentHealth.status -eq 'ok') { Stop-Service $Profile }
    }
    if (-not @(Get-Services $Profile).Count) {
        if ($Profile -eq 'configured') {
            & (Join-Path $PSScriptRoot 'start-bonsai.ps1') -NoWait
        } else {
            $isImage = $Profile -eq 'image'
            $envFolder = if ($isImage) { 'qwen-image' } else { 'naive' }
            $scriptName = if ($isImage) { 'serve-qwen-image.py' } else { 'serve-naive-int4.py' }
            $python = Join-Path $projectRoot ".local-data\venvs\$envFolder\Scripts\python.exe"
            $script = Join-Path $PSScriptRoot $scriptName
            if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $script)) { throw 'The requested local runtime is not installed.' }
            $logDir = Join-Path $projectRoot ".local-runtime\$envFolder"
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            $arguments = @(('"' + $script + '"'), '--host', '127.0.0.1', '--port', "$($specs[$Profile].Port)")
            if (-not $isImage) { $arguments += @('--device', 'cuda', '--row-block', '1024', '--gpu-weights') }
            $env:CUDA_MODULE_LOADING = 'LAZY'
            Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "server-$stamp.out.log") -RedirectStandardError (Join-Path $logDir "server-$stamp.err.log") | Out-Null
        }
        $launched = $true
    }
    while ($started.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (Test-Ready $Profile) { Write-Output "ready profile=$Profile elapsed_ms=$($started.ElapsedMilliseconds)"; exit 0 }
        Start-Sleep -Milliseconds 700
    }
    throw 'The selected model did not become ready. Check its local runtime log.'
} catch {
    if ($launched) {
        foreach ($owner in @(Get-Services $Profile)) { Stop-Process -Id $owner.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    if ($selectionChanged) {
        if ($previousSelection) { $previousSelection | Set-Content -LiteralPath $selectionFile -Encoding UTF8 }
        else { '{"profile":"configured"}' | Set-Content -LiteralPath $selectionFile -Encoding UTF8 }
    }
    throw
} finally {
    if ($ownsLock) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
