#Requires -Version 5.1
[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$frontend = Join-Path $projectRoot 'frontend'
$backend = Join-Path $projectRoot 'backend'
$stateDir = Join-Path $projectRoot '.local-data\cowagent'
$logDir = Join-Path $projectRoot '.local-runtime'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bridgePath = Join-Path $projectRoot '.local-data\agent-bridge.json'

function Test-LocalService([string]$Url) {
    try {
        $null = Invoke-RestMethod -Uri $Url -TimeoutSec 3
        return $true
    } catch { return $false }
}

function Wait-LocalService([string]$Name, [string]$Url) {
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        if (Test-LocalService $Url) { Write-Host "$Name ready: $Url"; return }
        Start-Sleep -Seconds 1
    }
    throw "$Name did not become ready. See logs in $logDir"
}

function Test-KnowledgeBridge {
    if (-not (Test-Path -LiteralPath $bridgePath)) { return }
    $bridge = Get-Content -LiteralPath $bridgePath -Raw | ConvertFrom-Json
    if (-not $bridge.knowledgeToken -or $bridge.knowledgeToken.Length -lt 32) {
        throw 'The private knowledge bridge configuration is invalid.'
    }
    try {
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/v1/knowledge/agent-library?agentId=startup-probe' `
            -Headers @{ Authorization = "Bearer $($bridge.knowledgeToken)" } -TimeoutSec 10
        if ($result.meta.bodyIncluded -ne $true) { throw 'Not an authenticated bridge response.' }
    } catch {
        # Never include the exception/request headers: they may contain tokens.
        throw 'Website knowledge bridge is not ready. Restart LumaFlow after configuring the private bridge.'
    }
    Write-Host 'Website knowledge bridge authenticated; no documents exported by this check.'
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $projectRoot '.local-data\postgres\data\PG_VERSION')) {
    & (Join-Path $projectRoot 'Setup-Postgres.ps1') -StartOnly
    if (-not $?) { throw 'Local PostgreSQL did not start.' }
}
if (-not (Test-LocalService 'http://127.0.0.1:11434/api/tags')) {
    $ollama = (Get-Command ollama -ErrorAction Stop).Source
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "ollama-$stamp.out.log") `
        -RedirectStandardError (Join-Path $logDir "ollama-$stamp.err.log") | Out-Null
    Wait-LocalService 'Ollama' 'http://127.0.0.1:11434/api/tags'
}

# An installed optional Bonsai runtime is started only when this workstation
# explicitly selects it in the frontend or CowAgent configuration.
$bonsaiSelected = $false
$frontendEnv = Join-Path $frontend '.env.local'
if (Test-Path -LiteralPath $frontendEnv) {
    $bonsaiSelected = [bool](Select-String -LiteralPath $frontendEnv -Pattern '^LLM_MODEL=ternary-bonsai-2-27b\s*$' -Quiet)
}
$cowConfigPath = Join-Path $stateDir 'config.json'
if (Test-Path -LiteralPath $cowConfigPath) {
    $cowConfig = Get-Content -LiteralPath $cowConfigPath -Raw | ConvertFrom-Json
    $bonsaiSelected = $bonsaiSelected -or $cowConfig.model -eq 'ternary-bonsai-2-27b'
}
if ($bonsaiSelected) {
    # The shared NewProject runtime uses the verified 32K/Q4 context needed by
    # CowAgent's tool schemas. Prefer it on a cold start as well as at runtime.
    $workRuntime = Join-Path (Split-Path $projectRoot -Parent) 'NewProject\scripts\start-bonsai.ps1'
    if (Test-Path -LiteralPath $workRuntime) {
        & $workRuntime
    } else {
        & (Join-Path $projectRoot 'Start-Bonsai.ps1')
    }
}

if (-not (Test-LocalService 'http://127.0.0.1:9876/api/health')) {
    $python = Join-Path $backend '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw 'Install backend/.venv dependencies first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $stateDir 'config.json'))) {
        throw 'Local CowAgent config is missing: .local-data/cowagent/config.json'
    }
    $settings = @{
        COW_DATA_DIR = $stateDir
        COW_WEB_PORT = '9876'
        COW_LUMAFLOW_UI_URL = 'http://127.0.0.1:3000/'
        COW_DESKTOP = '1'
        PYTHONIOENCODING = 'utf-8'
    }
    if (Test-Path -LiteralPath $bridgePath) {
        $bridge = Get-Content -LiteralPath $bridgePath -Raw | ConvertFrom-Json
        $settings.LUMAFLOW_KNOWLEDGE_TOKEN = $bridge.knowledgeToken
        $settings.LUMAFLOW_KNOWLEDGE_URL = $bridge.knowledgeUrl
    }
    $previous = @{}
    try {
        foreach ($key in $settings.Keys) {
            $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
        }
        Start-Process -FilePath $python -ArgumentList @('-u', 'app.py') -WorkingDirectory $backend `
            -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "cowagent-$stamp.out.log") `
            -RedirectStandardError (Join-Path $logDir "cowagent-$stamp.err.log") | Out-Null
    } finally {
        foreach ($key in $previous.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
        }
    }
    Wait-LocalService 'CowAgent' 'http://127.0.0.1:9876/api/health'
}

if (-not (Test-LocalService 'http://127.0.0.1:3000/api/v1/health')) {
    if (-not (Test-Path -LiteralPath (Join-Path $frontend '.next\BUILD_ID'))) {
        throw 'Production build is missing. Run npm run build in frontend first.'
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $previousToken = [Environment]::GetEnvironmentVariable('LUMAFLOW_KNOWLEDGE_TOKEN', 'Process')
    try {
        # Node's env-file does not override inherited values. Both processes
        # must use the same private bridge file even in an existing shell.
        if (Test-Path -LiteralPath $bridgePath) {
            $bridge = Get-Content -LiteralPath $bridgePath -Raw | ConvertFrom-Json
            [Environment]::SetEnvironmentVariable('LUMAFLOW_KNOWLEDGE_TOKEN', $bridge.knowledgeToken, 'Process')
        }
        Start-Process -FilePath $node -ArgumentList @('--env-file-if-exists=.env.local', 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000') `
            -WorkingDirectory $frontend -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDir "frontend-$stamp.out.log") `
            -RedirectStandardError (Join-Path $logDir "frontend-$stamp.err.log") | Out-Null
    } finally {
        [Environment]::SetEnvironmentVariable('LUMAFLOW_KNOWLEDGE_TOKEN', $previousToken, 'Process')
    }
    Wait-LocalService 'LumaFlow' 'http://127.0.0.1:3000/api/v1/health'
}

Test-KnowledgeBridge

Write-Host 'LumaFlow: http://127.0.0.1:3000/'
Write-Host 'Manage WeChat from the Agents page. Keep this computer awake for replies.'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:3000/' }
