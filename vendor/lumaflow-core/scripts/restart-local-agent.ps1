#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [int]$Port = 9876,
    [int]$ReadyTimeoutSeconds = 45,
    [switch]$PreserveConfiguredChannels
)

$ErrorActionPreference = 'Stop'

function Get-ListeningProcess([int]$TargetPort) {
    $connections = @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue)
    $ids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($ids.Count -eq 0) { return @() }
    return @($ids | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_)" })
}

function Wait-PortState([int]$TargetPort, [bool]$Listening, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $current = @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue)
        if (($current.Count -gt 0) -eq $Listening) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($Listening) {
        throw "CowAgent did not listen on port $TargetPort within the timeout."
    }
    throw "The old CowAgent listener on port $TargetPort did not stop within the timeout."
}

$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$backend = Join-Path $root 'backend'
$stateDir = Join-Path $root '.local-data\cowagent'
$bridgePath = Join-Path $root '.local-data\agent-bridge.json'
$logDir = Join-Path $root '.local-runtime'
$configPath = Join-Path $stateDir 'config.json'
$python = Join-Path $backend '.venv\Scripts\python.exe'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutPath = Join-Path $logDir "cowagent-restart-$stamp.out.log"
$stderrPath = Join-Path $logDir "cowagent-restart-$stamp.err.log"

foreach ($required in @($backend, $stateDir, $python, $configPath, $bridgePath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required CowAgent path is missing: $required"
    }
}
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

# This maintenance restart is deliberately limited to the web backend. Refuse
# a config that would also start an IM channel or a terminal session.
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$configuredChannels = @($config.channel_type)
if ($configuredChannels.Count -ne 1 -or [string]$configuredChannels[0] -ne 'web') {
    throw 'CowAgent config is not web-only; refusing to start another channel during this maintenance restart.'
}
$teamPath = Join-Path $stateDir 'workspace\agents\team.json'
# Connection repairs may explicitly preserve and reload registered channels.
# Their existing configuration and credential files are kept unchanged.
if (Test-Path -LiteralPath $teamPath) {
    $team = Get-Content -LiteralPath $teamPath -Raw | ConvertFrom-Json
    if (@($team.channel_instances).Count -gt 0 -and -not $PreserveConfiguredChannels) {
        throw 'CowAgent team config has channel instances; refusing to start them during this maintenance restart.'
    }
}

# Resolve the exact listener before stopping anything. Only a Python process
# running app.py is eligible; unrelated services on the port are left alone.
$oldProcesses = @(Get-ListeningProcess $Port)
if ($oldProcesses.Count -gt 1) {
    throw "More than one process is listening on port $Port; refusing to choose a target."
}
if ($oldProcesses.Count -eq 1) {
    $old = $oldProcesses[0]
    $commandLine = [string]$old.CommandLine
    if ([string]$old.Name -ne 'python.exe' -or $commandLine -notmatch '(?i)(^|\s)-u\s+app\.py(\s|$)') {
        throw "Port $Port is owned by a process other than CowAgent app.py; refusing to stop it."
    }
    Stop-Process -Id ([int]$old.ProcessId) -Force
    Wait-PortState $Port $false 20
}

# Read the bridge file only to build the child environment. Neither value is
# written to output, logs, process arguments, or the generated status message.
try {
    $bridge = Get-Content -LiteralPath $bridgePath -Raw | ConvertFrom-Json
} catch {
    throw 'The private agent bridge configuration could not be read.'
}
if (-not ($bridge.knowledgeToken -is [string]) -or [string]::IsNullOrWhiteSpace($bridge.knowledgeToken) -or
    -not ($bridge.knowledgeUrl -is [string]) -or [string]::IsNullOrWhiteSpace($bridge.knowledgeUrl)) {
    throw 'The private agent bridge configuration is incomplete.'
}

$settings = @{
    COW_DATA_DIR = $stateDir
    COW_WEB_PORT = [string]$Port
    COW_LUMAFLOW_UI_URL = 'http://127.0.0.1:3000/'
    COW_DESKTOP = '1'
    PYTHONIOENCODING = 'utf-8'
    LUMAFLOW_KNOWLEDGE_TOKEN = [string]$bridge.knowledgeToken
    LUMAFLOW_KNOWLEDGE_URL = [string]$bridge.knowledgeUrl
}
$previous = @{}
try {
    foreach ($key in $settings.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    Start-Process -FilePath $python -ArgumentList @('-u', 'app.py') -WorkingDirectory $backend `
        -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath | Out-Null
} finally {
    foreach ($key in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
}

Wait-PortState $Port $true $ReadyTimeoutSeconds
$newProcesses = @(Get-ListeningProcess $Port)
if ($newProcesses.Count -ne 1) {
    throw "CowAgent listener verification found $($newProcesses.Count) matching process(es)."
}
$new = $newProcesses[0]
if ([string]$new.Name -ne 'python.exe' -or [string]$new.CommandLine -notmatch '(?i)(^|\s)-u\s+app\.py(\s|$)') {
    throw 'The new listener is not the expected CowAgent app.py process.'
}

$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 10
$agents = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/agents" -TimeoutSec 15
if ($health.status -ne 'ok') { throw 'CowAgent health verification failed.' }
if ($agents.status -ne 'success' -or $agents.profile_edit_supported -ne $true) {
    throw 'The running CowAgent does not advertise live profile editing support.'
}

[pscustomobject]@{
    Status = 'ready'
    Port = $Port
    ProcessId = [int]$new.ProcessId
    Health = [string]$health.status
    ProfileEditSupported = [bool]$agents.profile_edit_supported
    StdoutLog = $stdoutPath
    StderrLog = $stderrPath
} | Format-List
