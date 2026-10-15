[CmdletBinding()]
param(
    [switch]$NoBootstrap
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $repo '.local-runtime\octop\venv\Scripts\python.exe'
$script = Join-Path $PSScriptRoot 'octop-runtime.py'

if (-not (Test-Path -LiteralPath $runtime)) {
    throw "Octop runtime is not installed. Run scripts\setup-octop.py first."
}

$args = @($script, 'start')
if ($NoBootstrap) { $args += '--no-bootstrap' }
& $runtime @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
