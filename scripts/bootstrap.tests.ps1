[CmdletBinding()]
param()

# Lightweight deployment tests: no Pester, npm, model download, or process
# termination is required. They dot-source bootstrap.ps1 so helper behavior
# can be checked in an isolated path without touching the project data.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$bootstrapPath = Join-Path $PSScriptRoot "bootstrap.ps1"
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($bootstrapPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) { throw "bootstrap.ps1 parser errors: $($parseErrors -join '; ')" }
. $bootstrapPath

function Assert-LumaFlowTest {
    param(
        [bool]$Condition,
        [Parameter(Mandatory)]
        [string]$Message
    )
    if (-not $Condition) { throw "FAIL: $Message" }
    Write-Host "PASS: $Message"
}

function Get-LumaFlowBytes {
    param([Parameter(Mandatory)][string]$Path)
    return [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path))
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "LumaFlow deployment test path $([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
try {
    $logRoot = Join-Path $testRoot ".local-data\logs"
    [IO.Directory]::CreateDirectory($logRoot) | Out-Null
    Initialize-LumaFlowLog -Root $testRoot | Out-Null

    $source = Join-Path $testRoot "payload with spaces.txt"
    Set-Content -LiteralPath $source -Value "LumaFlow deployment test" -Encoding UTF8 -NoNewline
    $hash = Get-LumaFlowSha256 -Path $source
    Assert-LumaFlowTest ($hash -match '^[0-9a-f]{64}$') "SHA-256 helper returns a digest"
    Assert-LumaFlowTest (Test-LumaFlowSha256 -Path $source -ExpectedHash $hash) "matching SHA-256 is accepted"
    Assert-LumaFlowTest (-not (Test-LumaFlowSha256 -Path $source -ExpectedHash ("0" * 64))) "wrong SHA-256 is rejected"
    $quoted = ConvertTo-LumaFlowWindowsArgument -Argument (Join-Path $testRoot "payload with spaces.txt")
    Assert-LumaFlowTest ($quoted.StartsWith('"') -and $quoted.EndsWith('"')) "paths with spaces are quoted for child processes"
    $escapedRoot = $false
    try { Assert-LumaFlowPathUnderRoot -Path (Join-Path $testRoot "..") -Root $testRoot | Out-Null } catch { $escapedRoot = $true }
    Assert-LumaFlowTest $escapedRoot "recursive cleanup rejects parent/outside paths"
    $equalRoot = $false
    try { Assert-LumaFlowPathUnderRoot -Path $testRoot -Root $testRoot | Out-Null } catch { $equalRoot = $true }
    Assert-LumaFlowTest $equalRoot "recursive cleanup rejects the root itself"
    Write-LumaFlowLog -Message ""
    Assert-LumaFlowTest $true "empty native output does not fail setup"

    $example = Join-Path $testRoot ".env.example"
    $local = Join-Path $testRoot ".env.local"
    Set-Content -LiteralPath $example -Value "DATABASE_URL=`nDEMO_WRITES_ENABLED=false`n" -Encoding UTF8 -NoNewline
    Set-Content -LiteralPath $local -Value "DATABASE_URL=postgresql://private-sentinel`n" -Encoding UTF8 -NoNewline
    $before = Get-LumaFlowBytes -Path $local
    Ensure-LumaFlowEnvironment -Root $testRoot | Out-Null
    Assert-LumaFlowTest ((Get-LumaFlowBytes -Path $local) -eq $before) "existing .env.local is byte-for-byte preserved"

    Remove-Item -LiteralPath $local -Force
    $plain = Join-Path $testRoot ".env"
    Set-Content -LiteralPath $plain -Value "DATABASE_URL=postgresql://plain-sentinel`n" -Encoding UTF8 -NoNewline
    Ensure-LumaFlowEnvironment -Root $testRoot | Out-Null
    Assert-LumaFlowTest (-not (Test-Path -LiteralPath $local)) "existing .env prevents creation of a higher-priority .env.local"

    Remove-Item -LiteralPath $plain -Force
    Ensure-LumaFlowEnvironment -Root $testRoot | Out-Null
    Assert-LumaFlowTest (Test-Path -LiteralPath $local) "missing environment files get a one-time .env.local setup"
    $createdText = Get-Content -LiteralPath $local -Raw
    Assert-LumaFlowTest ($createdText -match '(?m)^DATA_SOURCE=json\s*$') "new-machine environment explicitly selects the JSON demo"
    Assert-LumaFlowTest ($createdText -match '(?m)^DATABASE_URL=\s*$') "new-machine environment does not attempt the example PostgreSQL URL"
    $createdBytes = Get-LumaFlowBytes -Path $local
    Ensure-LumaFlowEnvironment -Root $testRoot | Out-Null
    Assert-LumaFlowTest ((Get-LumaFlowBytes -Path $local) -eq $createdBytes) "repeated environment setup is idempotent"

    New-Item -ItemType Directory -Path (Join-Path $testRoot ".next"),(Join-Path $testRoot "src") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $testRoot ".next/BUILD_ID") -Value "synthetic-test-build"
    $sourceInput = Join-Path $testRoot "src/test.ts"
    Set-Content -LiteralPath $sourceInput -Value "export const version = 1;"
    $inputHashes = Get-LumaFlowBuildInputHashes -Root $testRoot
    $inputs = @($inputHashes.GetEnumerator() | ForEach-Object { @{ path = $_.Key; sha256 = $_.Value } })
    Save-LumaFlowJsonAtomic -Path (Join-Path $testRoot ".local-data/next-build-state.json") -Value @{ version = 1; inputs = $inputs }
    Assert-LumaFlowTest (Test-LumaFlowBuildStateCurrent -Root $testRoot) "unchanged build inputs are recognized"
    Set-Content -LiteralPath $sourceInput -Value "export const version = 2;"
    Assert-LumaFlowTest (-not (Test-LumaFlowBuildStateCurrent -Root $testRoot)) "source changes invalidate the production build"
    Set-Content -LiteralPath (Join-Path $testRoot ".local-data/next-build-state.json") -Value "broken"
    Assert-LumaFlowTest (-not (Test-LumaFlowBuildStateCurrent -Root $testRoot)) "corrupt build state fails closed"

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $occupiedPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        Assert-LumaFlowTest (Test-LumaFlowPortInUse -Port $occupiedPort) "occupied loopback port is detected"
        $processCountBefore = @(Get-Process -Id $PID).Count
        $thrown = $false
        try { Get-LumaFlowSha256 -Path (Join-Path $testRoot "missing.bin") | Out-Null } catch { $thrown = $true }
        Assert-LumaFlowTest $thrown "missing artifact fails closed"
        Assert-LumaFlowTest (@(Get-Process -Id $PID).Count -eq $processCountBefore) "helper failure does not terminate unrelated processes"
    } finally {
        $listener.Stop()
    }
    Write-Host "All deployment helper tests passed."
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $safeTestRoot = Assert-LumaFlowPathUnderRoot -Path $testRoot -Root ([IO.Path]::GetTempPath())
        Remove-Item -LiteralPath $safeTestRoot -Recurse -Force
    }
}
