[CmdletBinding()]
param(
    [string]$SourceRoot = 'C:\Users\Willi\AppData\Local\Temp\lumaflow-octop-source-20261012',
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$ExpectedCommit = '664c1fb38e354ea987041aa14b151e20d15ce71f'
$DashboardPath = Join-Path $SourceRoot 'dashboard'
$OutputPath = Join-Path $SourceRoot 'src\octop\dashboard'

function Invoke-NpmCommand {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $DashboardPath 'package.json'))) {
    throw "Dashboard package.json was not found under '$DashboardPath'."
}
if (-not (Test-Path -LiteralPath (Join-Path $DashboardPath 'package-lock.json'))) {
    throw "Dashboard package-lock.json was not found under '$DashboardPath'."
}

$resolvedCommit = (& git -C $SourceRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $ExpectedCommit) {
    throw "Expected upstream commit $ExpectedCommit, found '$resolvedCommit'."
}

$oldNodeEnv = $env:NODE_ENV
$oldNodeOptions = $env:NODE_OPTIONS
Push-Location $DashboardPath
try {
    if (-not $SkipInstall) {
        Invoke-NpmCommand @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
    }

    $env:NODE_ENV = 'production'
    if ([string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) {
        $env:NODE_OPTIONS = '--max-old-space-size=4096'
    }
    Invoke-NpmCommand @('run', 'build:docker')
}
finally {
    Pop-Location
    if ($null -eq $oldNodeEnv) { $env:NODE_ENV = $null } else { $env:NODE_ENV = $oldNodeEnv }
    if ($null -eq $oldNodeOptions) { $env:NODE_OPTIONS = $null } else { $env:NODE_OPTIONS = $oldNodeOptions }
}

$indexPath = Join-Path $OutputPath 'index.html'
$assetsPath = Join-Path $OutputPath 'assets'
if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "Build completed without '$indexPath'."
}
if (-not (Test-Path -LiteralPath $assetsPath)) {
    throw "Build completed without '$assetsPath'."
}

$files = @(Get-ChildItem -LiteralPath $OutputPath -File -Recurse)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
$lockHash = (Get-FileHash -LiteralPath (Join-Path $DashboardPath 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{
    sourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
    upstreamCommit = $resolvedCommit
    outputDirectory = (Resolve-Path -LiteralPath $OutputPath).Path
    fileCount = $files.Count
    bytes = [int64]$bytes
    packageLockSha256 = $lockHash
} | ConvertTo-Json -Compress
