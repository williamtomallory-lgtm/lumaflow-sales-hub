#Requires -Version 5.1
[CmdletBinding()]
param([switch]$NoBrowser, [switch]$StartBonsai, [int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'bootstrap.ps1')
Initialize-LumaFlowLog | Out-Null
$node = Resolve-LumaFlowNode -Root $projectRoot
$env:PATH = (Split-Path -Parent $node.NodePath) + [IO.Path]::PathSeparator + $env:PATH
$env:LOCAL_MODEL_SWITCHING = if ($StartBonsai) { 'true' } else { 'false' }
$bridgePath = Join-Path $projectRoot '.local-data\agent-bridge.json'
if (-not (Test-Path -LiteralPath $bridgePath)) { throw 'Run Setup-LumaFlow.cmd first to initialize the private knowledge bridge.' }
$bridge = Get-Content -LiteralPath $bridgePath -Raw | ConvertFrom-Json
if (-not $bridge.knowledgeToken -or $bridge.knowledgeToken.Length -lt 32) { throw 'Private knowledge bridge configuration is invalid.' }
$env:LUMAFLOW_KNOWLEDGE_TOKEN = $bridge.knowledgeToken
$env:LUMAFLOW_KNOWLEDGE_URL = "http://127.0.0.1:$Port/api/v1/knowledge/agent-library"
if ($StartBonsai) { & (Join-Path $PSScriptRoot 'manage-local-model.ps1') -Profile configured }
$logDirectory = Join-Path $projectRoot '.local-data\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
function Test-Service([string]$Url) {
    try { $null = Invoke-RestMethod -Uri $Url -TimeoutSec 3; return $true } catch { return $false }
}
if (-not (Test-Service 'http://127.0.0.1:9876/api/health')) {
    if (Get-NetTCPConnection -LocalPort 9876 -State Listen -ErrorAction SilentlyContinue) { throw 'Agent port 9876 is occupied by another service.' }
    $python = Join-Path $projectRoot '.local-data\venvs\cowagent\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw 'Run Setup-LumaFlow.cmd first to install the Agent backend.' }
    $env:COW_DATA_DIR = Join-Path $projectRoot '.local-data\cowagent'
    $env:COW_WEB_PORT = '9876'
    $env:COW_LUMAFLOW_UI_URL = "http://127.0.0.1:$Port/"
    $env:COW_DESKTOP = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $backend = Join-Path $projectRoot 'vendor\lumaflow-core\backend'
    Start-Process -FilePath $python -ArgumentList @('-u', 'app.py') -WorkingDirectory $backend -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "cowagent-$stamp.out.log") -RedirectStandardError (Join-Path $logDirectory "cowagent-$stamp.err.log") | Out-Null
}
if (-not (Test-Service "http://127.0.0.1:$Port/api/v1/health")) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Website port $Port is occupied by another service." }
    Ensure-LumaFlowDependencies -Node $node -Root $projectRoot
    $argsString = @('--env-file-if-exists=.env.local', 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', "$Port") -join ' '
    Start-Process -FilePath $node.NodePath -ArgumentList $argsString -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory "website-$stamp.out.log") -RedirectStandardError (Join-Path $logDirectory "website-$stamp.err.log") | Out-Null
}
foreach ($service in @('http://127.0.0.1:9876/api/health', "http://127.0.0.1:$Port/api/v1/health")) {
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-Service $service) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Service did not become ready: $service. See .local-data/logs." }
}
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
Write-Host "LumaFlow ready at http://127.0.0.1:$Port/. Model inference is $(if ($StartBonsai) { 'enabled for Bonsai' } else { 'disabled' })."
