#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('all', 'bonsai', 'image', 'naive', 'muse')]
    [string]$Models = 'all',
    [switch]$SkipModels,
    [switch]$SkipPythonDependencies,
    [switch]$SkipNodeDependencies,
    [switch]$VerifyOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'bootstrap.ps1')

function Invoke-PortablePython([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency/setup command failed; no model was started.' }
}

function Resolve-PortablePython {
    $installed = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($installed) {
        try {
            # Avoid nested quote loss in Windows PowerShell 5.1 native arguments.
            $version = & $installed.Source -c 'import sys; sys.stdout.write(str(sys.version_info.major)+chr(46)+str(sys.version_info.minor))' 2>$null
            if ($LASTEXITCODE -eq 0 -and "$version".Trim() -eq '3.11') { return $installed.Source }
        } catch { Write-Host 'Using the verified portable Python runtime.' }
    }
    $runtime = Join-Path $projectRoot '.local-runtime\python'
    $python = Join-Path $runtime 'tools\python.exe'
    if (-not (Test-Path -LiteralPath $python)) {
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        $archive = Join-Path $runtime 'python-3.11.9.zip'
        $hash = '9283876d58c017e0e846f95b490da3bca0fc0a6ee1134b2870677cfb7eec3c67'
        if (-not (Test-Path -LiteralPath $archive)) {
            & curl.exe --fail --location --retry 3 --output $archive 'https://www.nuget.org/api/v2/package/python/3.11.9'
            if ($LASTEXITCODE -ne 0) { throw 'Portable Python download failed.' }
        }
        if (-not (Test-LumaFlowSha256 -Path $archive -ExpectedHash $hash)) { throw 'Portable Python checksum mismatch.' }
        Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
    }
    return $python
}

Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath '.env.local') -and -not (Test-Path -LiteralPath '.env')) {
        Copy-Item -LiteralPath 'config\local.env.example' -Destination '.env.local'
    }
    $state = Join-Path $projectRoot '.local-data\cowagent'
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $state 'config.json'))) {
        Copy-Item -LiteralPath 'config\cowagent.local.example.json' -Destination (Join-Path $state 'config.json')
    }
    $bridgePath = Join-Path $projectRoot '.local-data\agent-bridge.json'
    if (-not (Test-Path -LiteralPath $bridgePath)) {
        $randomBytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
        $bridge = @{ knowledgeToken = ([BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant(); knowledgeUrl = 'http://127.0.0.1:3000/api/v1/knowledge/agent-library' }
        $bridge | ConvertTo-Json | Set-Content -LiteralPath $bridgePath -Encoding UTF8
    }
    $python = Resolve-PortablePython
    if (-not $SkipModels) {
        $arguments = @((Join-Path $PSScriptRoot 'install-local-models.py'), '--models', $Models)
        if ($VerifyOnly) { $arguments += '--verify-only' }
        Invoke-PortablePython $python $arguments
    }
    if ($VerifyOnly) { Write-Host 'Bundle checks passed. No models started.'; return }
    if (-not $SkipNodeDependencies) {
        Initialize-LumaFlowLog | Out-Null
        $node = Resolve-LumaFlowNode -Root $projectRoot
        $env:PATH = (Split-Path -Parent $node.NodePath) + [IO.Path]::PathSeparator + $env:PATH
        Ensure-LumaFlowDependencies -Node $node -Root $projectRoot
    }
    if (-not $SkipPythonDependencies) {
        foreach ($name in @('cowagent', 'naive', 'qwen-image')) {
            $venv = Join-Path $projectRoot ".local-data\venvs\$name"
            $venvPython = Join-Path $venv 'Scripts\python.exe'
            if (-not (Test-Path -LiteralPath $venvPython)) { Invoke-PortablePython $python @('-m', 'venv', $venv) }
            Invoke-PortablePython $venvPython @('-m', 'pip', 'install', '--upgrade', 'pip')
            if ($name -eq 'cowagent') {
                Invoke-PortablePython $venvPython @('-m', 'pip', 'install', '-r', (Join-Path $projectRoot 'vendor\lumaflow-core\backend\requirements.txt'), 'openai>=2,<3', 'tiktoken>=0.3.2', 'fastapi', 'uvicorn', 'httpx', 'playwright==1.52.0', 'mcp')
            } else {
                Invoke-PortablePython $venvPython @('-m', 'pip', 'install', 'torch==2.10.0', '--index-url', 'https://download.pytorch.org/whl/cu128')
                Invoke-PortablePython $venvPython @('-m', 'pip', 'install', '-r', (Join-Path $projectRoot 'config\requirements-models.txt'))
            }
        }
    }
    $runtime = Join-Path $projectRoot '.local-runtime\bonsai'
    if (Test-Path -LiteralPath (Join-Path $runtime 'llama-cuda-12.4.zip')) {
        $bin = Join-Path $runtime 'bin'
        Expand-Archive -LiteralPath (Join-Path $runtime 'llama-cuda-12.4.zip') -DestinationPath $bin -Force
        Expand-Archive -LiteralPath (Join-Path $runtime 'cudart-12.4.zip') -DestinationPath $bin -Force
    }
    Write-Host 'Setup complete. All model services remain stopped. Double-click Start-LumaFlow.cmd for website + Agent backend.'
} finally { Pop-Location }
