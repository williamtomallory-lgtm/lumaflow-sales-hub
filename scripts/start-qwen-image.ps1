#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$NoWait,
    [ValidateRange(1, 65535)]
    [int]$Port = 8084,
    [ValidateRange(5, 3600)]
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonCandidates = @(
    (Join-Path $projectRoot '.local-data\venvs\qwen-image\Scripts\python.exe'),
    (Join-Path $projectRoot '.local-runtime\python\tools\python.exe')
)
$python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$script = Join-Path $projectRoot 'scripts\serve-qwen-image.py'
$config = Join-Path $projectRoot 'config\qwen-image-2.1-gguf.json'
if (-not $python) { throw 'Qwen Image Python runtime is not installed.' }
if (-not (Test-Path -LiteralPath $script)) { throw 'Qwen Image worker script is missing.' }
if (-not (Test-Path -LiteralPath $config)) { throw 'Qwen Image GGUF configuration is missing.' }

function Get-WorkerProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script) -and $_.CommandLine.Contains($projectRoot) })
}
function Test-Ready {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
        return $health.status -eq 'ok' -and $health.quantization -eq 'gguf-q4_k'
    } catch { return $false }
}
function ConvertTo-ProcessArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('"', '\"') + '"'
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
$known = @(Get-WorkerProcesses)
if ($listeners.Count -and -not ($known.ProcessId -contains $listeners[0].OwningProcess)) {
    throw "Port $Port is occupied by an unrelated application."
}
if (-not (Test-Ready) -and -not $known.Count) {
    $logDir = Join-Path $projectRoot '.local-runtime\qwen-image'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $env:QWEN_IMAGE_CONFIG = $config
    $workerArguments = @('-u', $script, '--host', '127.0.0.1', '--port', "$Port") | ForEach-Object { ConvertTo-ProcessArgument $_ }
    Start-Process -FilePath $python -ArgumentList ($workerArguments -join ' ') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "server-$stamp.out.log") -RedirectStandardError (Join-Path $logDir "server-$stamp.err.log") | Out-Null
}
if ($NoWait) { exit 0 }
for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    if (Test-Ready) {
        Write-Output "ready profile=image port=$Port model=Qwen/Qwen-Image-2.1 quantization=gguf-q4_k"
        exit 0
    }
    Start-Sleep -Seconds 1
}
throw 'Qwen Image worker did not become ready. Check .local-runtime\qwen-image logs.'
