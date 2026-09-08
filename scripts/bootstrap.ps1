[CmdletBinding()]
param(
    [ValidateSet("start", "setup", "check")]
    [string]$Action = "start",
    [ValidateRange(1024, 65535)]
    [int]$Port = 3000,
    [ValidateSet("8b", "14b")]
    [string]$Model = "8b",
    [switch]$NoBrowser,
    [switch]$PreferPortableNode,
    [switch]$SkipDependencies,
    [switch]$SkipModelSetup,
    [switch]$ForceBuild
)

# LumaFlow's first-run path is deliberately self-contained.  It does not
# install anything machine-wide and it never needs an elevated PowerShell.
# Keep all state below the project directory so a project copied to another
# drive (including a path containing spaces) behaves the same way.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:LumaFlowRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:LumaFlowRuntimeRoot = Join-Path $script:LumaFlowRoot ".local-runtime"
$script:LumaFlowDataRoot = Join-Path $script:LumaFlowRoot ".local-data"
$script:LumaFlowLogPath = $null
$script:LumaFlowSecrets = @()

$script:LumaFlowNodeVersion = "22.23.2"
$script:LumaFlowNodeArchiveName = "node-v$($script:LumaFlowNodeVersion)-win-x64.zip"
$script:LumaFlowNodeArchiveUrl = "https://nodejs.org/dist/v$($script:LumaFlowNodeVersion)/$($script:LumaFlowNodeArchiveName)"
# SHA-256 from nodejs.org/dist/v22.23.2/SHASUMS256.txt.
$script:LumaFlowNodeArchiveSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"

function Get-LumaFlowSecretValues {
    [CmdletBinding()]
    param()

    $names = @(
        "DATABASE_URL",
        "API_WRITE_TOKEN",
        "ASSISTANT_API_TOKEN",
        "LLM_API_KEY",
        "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY"
    )
    foreach ($name in $names) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $value
        }
    }
}

function Protect-LumaFlowLogText {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [string]$Text
    )

    if ($null -eq $Text) { return "" }
    $safe = $Text
    foreach ($secret in $script:LumaFlowSecrets) {
        if (-not [string]::IsNullOrEmpty($secret)) {
            $safe = $safe.Replace($secret, "<redacted>")
        }
    }
    return $safe
}

function Initialize-LumaFlowLog {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    $logDirectory = Join-Path $Root ".local-data\logs"
    [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
    $script:LumaFlowLogPath = Join-Path $logDirectory "bootstrap.log"
    $script:LumaFlowSecrets = @(Get-LumaFlowSecretValues)
    $header = "`n===== LumaFlow bootstrap $(Get-Date -Format o) ====="
    Add-Content -LiteralPath $script:LumaFlowLogPath -Value $header -Encoding UTF8
    return $script:LumaFlowLogPath
}

function Write-LumaFlowLog {
    [CmdletBinding()]
    param(
        [ValidateSet("INFO", "WARN", "ERROR")]
        [string]$Level = "INFO",
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Message
    )

    if ([string]::IsNullOrWhiteSpace($Message)) { return }
    $safeMessage = Protect-LumaFlowLogText $Message
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Level] $safeMessage"
    if ($script:LumaFlowLogPath) {
        Add-Content -LiteralPath $script:LumaFlowLogPath -Value $line -Encoding UTF8
    }
    if ($Level -eq "ERROR") {
        [Console]::Error.WriteLine($line)
    } elseif ($Level -eq "WARN") {
        Write-Warning $safeMessage
    } else {
        Write-Host $safeMessage
    }
}

function Get-LumaFlowSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "File not found: $Path"
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-LumaFlowSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [ValidatePattern('^[0-9a-fA-F]{64}$')]
        [string]$ExpectedHash
    )

    return (Get-LumaFlowSha256 -Path $Path) -eq $ExpectedHash.ToLowerInvariant()
}

function Assert-LumaFlowPathUnderRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Root
    )

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $pathFull = [IO.Path]::GetFullPath($Path)
    if (-not $pathFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate recursively outside the intended runtime directory: $pathFull"
    }
    return $pathFull
}

function Get-LumaFlowBuildInputPaths {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    $paths = @()
    foreach ($directoryName in @("src", "public")) {
        $directory = Join-Path $Root $directoryName
        if (Test-Path -LiteralPath $directory -PathType Container) {
            $paths += @(Get-ChildItem -LiteralPath $directory -File -Recurse -Force | ForEach-Object { $_.FullName })
        }
    }
    foreach ($name in @("package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "eslint.config.mjs")) {
        $path = Join-Path $Root $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { $paths += $path }
    }
    $paths += @(Get-ChildItem -LiteralPath $Root -File -Force -Filter ".env*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    return @($paths | Sort-Object -Unique)
}

function Get-LumaFlowBuildInputHashes {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    $result = @{}
    foreach ($path in Get-LumaFlowBuildInputPaths -Root $Root) {
        $relative = $path.Substring(([IO.Path]::GetFullPath($Root)).Length + 1).Replace("\", "/")
        $result[$relative] = Get-LumaFlowSha256 -Path $path
    }
    return $result
}

function Test-LumaFlowBuildStateCurrent {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    if (-not (Test-Path -LiteralPath (Join-Path $Root ".next\BUILD_ID") -PathType Leaf)) { return $false }
    $statePath = Join-Path $Root ".local-data\next-build-state.json"
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
    try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($state.version -ne 1 -or $null -eq $state.inputs) { return $false }
        $current = Get-LumaFlowBuildInputHashes -Root $Root
        $expected = @($state.inputs)
        if ($expected.Count -ne $current.Count) { return $false }
        foreach ($input in $expected) {
            if (-not $input.path -or -not $current.ContainsKey([string]$input.path)) { return $false }
            if ($current[[string]$input.path] -ne ([string]$input.sha256).ToLowerInvariant()) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

function Get-LumaFlowNodeVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$NodePath
    )

    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $null }
    try {
        $output = (& $NodePath --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $output -notmatch "^v(\d+)(?:\.\d+){0,2}") { return $null }
        return [pscustomobject]@{
            Text = $output
            Major = [int]$Matches[1]
        }
    } catch {
        return $null
    }
}

function Get-LumaFlowNodeCandidate {
    [CmdletBinding()]
    param()

    $commands = @()
    $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($nodeCommand) { $commands += $nodeCommand.Source }
    $nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
    if ($nodeCommand -and $commands -notcontains $nodeCommand.Source) { $commands += $nodeCommand.Source }

    foreach ($candidate in $commands) {
        $version = Get-LumaFlowNodeVersion -NodePath $candidate
        if ($version -and $version.Major -ge 22) {
            $candidateDirectory = Split-Path -Parent $candidate
            $npm = Join-Path $candidateDirectory "npm.cmd"
            if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
                $npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
                if ($npmCommand) { $npm = $npmCommand.Source }
            }
            if (Test-Path -LiteralPath $npm -PathType Leaf) {
                return [pscustomobject]@{
                    NodePath = $candidate
                    NpmPath = $npm
                    Version = $version.Text
                    Major = $version.Major
                    Portable = $false
                }
            }
        }
    }
    return $null
}

function ConvertTo-LumaFlowWindowsArgument {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$Argument
    )

    # ProcessStartInfo.ArgumentList is available in PowerShell 7/.NET Core;
    # this quoting fallback keeps the launcher compatible with inbox Windows
    # PowerShell 5.1 as well.
    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { return $Argument }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($slashes * 2) + 1)))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) {
            [void]$builder.Append(('\' * $slashes))
            $slashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function New-LumaFlowProcessStartInfo {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [Parameter(Mandatory)]
        [string]$WorkingDirectory,
        [switch]$RedirectOutput,
        [string]$StandardOutputPath,
        [string]$StandardErrorPath
    )

    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    if ($RedirectOutput) {
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
    }
    $argumentListProperty = $info.PSObject.Properties["ArgumentList"]
    if ($argumentListProperty) {
        foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
    } else {
        $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-LumaFlowWindowsArgument $_ }) -join " ")
    }
    return $info
}

function Invoke-LumaFlowNative {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [Parameter(Mandatory)]
        [string]$WorkingDirectory,
        [string]$DisplayName = $FilePath
    )

    Write-LumaFlowLog -Message "Running $DisplayName."
    # Invoke through PowerShell's native-command binder so .cmd files and
    # paths containing spaces work on both PowerShell 5.1 and 7. Output is
    # streamed on the main runspace (event callbacks cannot safely call
    # PowerShell functions from .NET thread-pool threads).
    $savedPreference = $ErrorActionPreference
    Push-Location -LiteralPath $WorkingDirectory
    try {
      # Windows PowerShell 5.1 wraps native stderr in ErrorRecord; a warning
      # must not terminate npm. The actual process exit code remains decisive.
      $ErrorActionPreference = "Continue"
      & $FilePath @Arguments 2>&1 | ForEach-Object {
        $line = Protect-LumaFlowLogText ($_.ToString())
        if ($_ -is [Management.Automation.ErrorRecord]) {
            Write-LumaFlowLog -Level WARN -Message $line
        } else {
            Write-LumaFlowLog -Message $line
        }
      }
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedPreference
      Pop-Location
    }
    if ($exitCode -ne 0) {
        throw "$DisplayName failed with exit code $exitCode. See $script:LumaFlowLogPath."
    }
}

function Save-LumaFlowJsonAtomic {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [object]$Value
    )

    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).partial"
    try {
        $json = $Value | ConvertTo-Json -Depth 8
        Set-Content -LiteralPath $temporary -Value $json -Encoding UTF8 -NoNewline
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Get-LumaFlowPackageLockHash {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    $lock = Join-Path $Root "package-lock.json"
    if (-not (Test-Path -LiteralPath $lock -PathType Leaf)) { throw "package-lock.json is missing; this project requires npm ci." }
    return Get-LumaFlowSha256 -Path $lock
}

function Ensure-LumaFlowEnvironment {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    $local = Join-Path $Root ".env.local"
    $plain = Join-Path $Root ".env"
    $example = Join-Path $Root ".env.example"
    if (Test-Path -LiteralPath $local -PathType Leaf) {
        Write-LumaFlowLog -Message "Preserving existing .env.local; it will not be overwritten."
        return ".env.local"
    }
    if (Test-Path -LiteralPath $plain -PathType Leaf) {
        Write-LumaFlowLog -Message "Preserving existing .env; no .env.local was created."
        return ".env"
    }
    if (Test-Path -LiteralPath $example -PathType Leaf) {
        # A clean clone is an explicit local demo: do not make it attempt the
        # placeholder PostgreSQL URL from .env.example. This only transforms
        # the newly-created file; existing .env/.env.local bytes stay intact.
        $content = Get-Content -LiteralPath $example -Raw -ErrorAction Stop
        $content = [regex]::Replace($content, "(?m)^DATABASE_URL=.*$", "DATABASE_URL=")
        if ($content -notmatch "(?m)^DATA_SOURCE=") { $content = "DATA_SOURCE=json`r`n" + $content }
        Set-Content -LiteralPath $local -Value $content -Encoding UTF8 -NoNewline
        Write-LumaFlowLog -Message "Created .env.local with explicit DATA_SOURCE=json demo defaults because no environment file existed. Placeholder values were not printed."
        return ".env.local"
    }
    Write-LumaFlowLog -Level WARN -Message "No .env, .env.local, or .env.example exists. The app can still use its built-in local model profile, but optional server settings are unset."
    return $null
}

function Ensure-LumaFlowDependencies {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Node,
        [string]$Root = $script:LumaFlowRoot
    )

    $statePath = Join-Path $Root ".local-data\npm-install-state.json"
    $lockHash = Get-LumaFlowPackageLockHash -Root $Root
    $nextPackage = Join-Path $Root "node_modules\next\package.json"
    $state = $null
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $state = $null }
    }
    $ready = (Test-Path -LiteralPath $nextPackage -PathType Leaf) -and
        $state -and
        $state.packageLockSha256 -eq $lockHash -and
        $state.nodeMajor -eq $Node.Major
    if ($ready) {
        Write-LumaFlowLog -Message "Dependencies already match package-lock.json and Node $($Node.Major); reusing node_modules."
        return
    }

    Write-LumaFlowLog -Message "Installing locked dependencies with npm ci (first run or package-lock changed)."
    Invoke-LumaFlowNative -FilePath $Node.NpmPath -Arguments @("ci", "--no-audit", "--no-fund") -WorkingDirectory $Root -DisplayName "npm ci"
    Save-LumaFlowJsonAtomic -Path $statePath -Value ([ordered]@{
            packageLockSha256 = $lockHash
            nodeMajor = $Node.Major
            installedAt = (Get-Date).ToUniversalTime().ToString("o")
        })
    Write-LumaFlowLog -Message "Locked dependencies are ready."
}

function Get-LumaFlowPortableNode {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "The portable Node fallback is Windows-only. Install Node.js 22+ for this operating system and rerun."
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "This launcher requires 64-bit Windows because the pinned Node portable archive is win-x64."
    }

    $runtimeRoot = Join-Path $Root ".local-runtime"
    $installDirectory = Join-Path $runtimeRoot "node-v$($script:LumaFlowNodeVersion)-win-x64"
    $nodePath = Join-Path $installDirectory "node.exe"
    $npmPath = Join-Path $installDirectory "npm.cmd"
    if (Test-Path -LiteralPath $nodePath -PathType Leaf) {
        $version = Get-LumaFlowNodeVersion -NodePath $nodePath
        if ($version -and $version.Major -ge 22) {
            if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) { throw "Portable Node is incomplete: npm.cmd is missing from $installDirectory." }
            Write-LumaFlowLog -Message "Reusing verified project-local Node $($version.Text) at $installDirectory."
            return [pscustomobject]@{ NodePath = $nodePath; NpmPath = $npmPath; Version = $version.Text; Major = $version.Major; Portable = $true }
        }
        throw "A Node executable exists at $installDirectory but did not report a usable Node 22+ version; refusing to overwrite it."
    }

    [IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
    $archivePath = Join-Path $runtimeRoot $script:LumaFlowNodeArchiveName
    $archiveValid = $false
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $archiveValid = Test-LumaFlowSha256 -Path $archivePath -ExpectedHash $script:LumaFlowNodeArchiveSha256
        if ($archiveValid) {
            Write-LumaFlowLog -Message "Reusing the cached Node $($script:LumaFlowNodeVersion) archive after SHA-256 verification."
        } else {
            Write-LumaFlowLog -Level WARN -Message "Cached Node archive failed its pinned SHA-256 check; it will be replaced after a new verified download."
        }
    }
    if (-not $archiveValid) {
        $partial = "$archivePath.partial"
        Write-LumaFlowLog -Message "Downloading official Node.js $($script:LumaFlowNodeVersion) portable x64 (~30 MB; no administrator permission required)."
        try {
            Invoke-WebRequest -Uri $script:LumaFlowNodeArchiveUrl -OutFile $partial -UseBasicParsing -ErrorAction Stop
        } catch {
            throw "Node.js download failed. Check internet access and rerun. Details: $($_.Exception.Message)"
        }
        $downloadHash = Get-LumaFlowSha256 -Path $partial
        if ($downloadHash -ne $script:LumaFlowNodeArchiveSha256) {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            throw "Node.js archive SHA-256 mismatch; refusing to extract or execute the download."
        }
        Move-Item -LiteralPath $partial -Destination $archivePath -Force
        Write-LumaFlowLog -Message "Official Node.js archive SHA-256 verified."
    }

    $staging = Join-Path $runtimeRoot ".node-extract-$([Guid]::NewGuid().ToString('N'))"
    try {
        Write-LumaFlowLog -Message "Extracting portable Node.js to the project drive."
        Expand-Archive -LiteralPath $archivePath -DestinationPath $staging -Force
        $nested = Get-ChildItem -LiteralPath $staging -Directory -ErrorAction Stop |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "node.exe") -PathType Leaf } |
            Select-Object -First 1
        if (-not $nested) { throw "The verified Node.js archive did not contain node.exe." }
        if (Test-Path -LiteralPath $installDirectory) {
            throw "Portable Node target already exists but is incomplete: $installDirectory. Remove that exact folder manually and rerun."
        }
        $safeNested = Assert-LumaFlowPathUnderRoot -Path $nested.FullName -Root $runtimeRoot
        $safeInstall = Assert-LumaFlowPathUnderRoot -Path $installDirectory -Root $runtimeRoot
        Move-Item -LiteralPath $safeNested -Destination $safeInstall
    } finally {
        if (Test-Path -LiteralPath $staging) {
            $safeStaging = Assert-LumaFlowPathUnderRoot -Path $staging -Root $runtimeRoot
            Remove-Item -LiteralPath $safeStaging -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
        throw "Portable Node extraction completed without node.exe and npm.cmd at $installDirectory."
    }
    $version = Get-LumaFlowNodeVersion -NodePath $nodePath
    if (-not $version -or $version.Major -lt 22) { throw "Extracted portable Node did not report Node 22+." }
    Write-LumaFlowLog -Message "Portable Node $($version.Text) is ready."
    return [pscustomobject]@{ NodePath = $nodePath; NpmPath = $npmPath; Version = $version.Text; Major = $version.Major; Portable = $true }
}

function Resolve-LumaFlowNode {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot,
        [switch]$PreferPortable
    )

    if (-not $PreferPortable) {
        $system = Get-LumaFlowNodeCandidate
        if ($system) {
            Write-LumaFlowLog -Message "Using system Node $($system.Version) ($($system.NodePath)); no portable download is needed."
            return $system
        }
    }
    Write-LumaFlowLog -Message "No usable system Node 22+ was found; using the pinned project-local portable runtime."
    return Get-LumaFlowPortableNode -Root $Root
}

function Get-LumaFlowListeningProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )

    try {
        $connection = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -First 1
        if ($connection) {
            $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
            return [pscustomobject]@{ Port = $Port; Pid = $connection.OwningProcess; Name = if ($process) { $process.ProcessName } else { "unknown" } }
        }
    } catch {
        # Get-NetTCPConnection is absent on some minimal Windows images. The
        # TCP probe below still determines whether it is safe to bind.
    }
    return $null
}

function Get-LumaFlowProcessDetails {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId
    )

    try {
        return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop |
            Select-Object -First 1 ProcessId, ParentProcessId, CommandLine, ExecutablePath
    } catch {
        return $null
    }
}

function Test-LumaFlowProcessCommandBelongsToRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId,
        [string]$Root = $script:LumaFlowRoot
    )

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $details = Get-LumaFlowProcessDetails -ProcessId $ProcessId
    if (-not $details) { return $false }
    $commandLine = ([string]$details.CommandLine).Replace("/", "\")
    return $commandLine.IndexOf(($rootFull + "\"), [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine -match "(?i)local-model\.mjs"
}

function Test-LumaFlowProcessTreeBelongsToRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId,
        [string]$Root = $script:LumaFlowRoot
    )

    $current = $ProcessId
    for ($count = 0; $count -lt 8 -and $current -gt 0; $count++) {
        if (Test-LumaFlowProcessCommandBelongsToRoot -ProcessId $current -Root $Root) { return $true }
        $details = Get-LumaFlowProcessDetails -ProcessId $current
        if (-not $details -or [int]$details.ParentProcessId -eq $current) { break }
        $current = [int]$details.ParentProcessId
    }
    return $false
}

function Get-LumaFlowAppStatePath {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    return Join-Path $Root ".local-data\app-process.json"
}

function Get-LumaFlowOwnedAppProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$Port,
        [ValidateSet("8b", "14b")]
        [string]$Model = "8b",
        [string]$Root = $script:LumaFlowRoot
    )

    $statePath = Get-LumaFlowAppStatePath -Root $Root
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { return $null }
    if ([IO.Path]::GetFullPath([string]$state.root) -ne [IO.Path]::GetFullPath($Root) -or
        [int]$state.port -ne $Port -or [string]$state.model -ne $Model) { return $null }
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if (-not $process -or $process.HasExited) { return $null }
    try {
        # PS7 converts ISO JSON strings to DateTime; casting through string
        # drops its UTC Kind and breaks ownership checks across time zones.
        $recordedStart = ([DateTime]$state.startedAt).ToUniversalTime()
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $recordedStart).TotalSeconds) -gt 1) { return $null }
    } catch { return $null }
    if (-not (Test-LumaFlowProcessCommandBelongsToRoot -ProcessId $process.Id -Root $Root)) { return $null }
    return [pscustomobject]@{ Process = $process; State = $state }
}

function Test-LumaFlowPortInUse {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$Port,
        [int]$TimeoutMilliseconds = 350
    )

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if ($task.Wait($TimeoutMilliseconds) -and $client.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Invoke-LumaFlowJsonGet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Uri,
        [int]$TimeoutSeconds = 3
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSeconds -ErrorAction Stop
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { return $null }
        return ($response.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-LumaFlowAppReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$Port,
        [ValidateSet("8b", "14b")]
        [string]$Model = "8b"
    )

    $base = "http://127.0.0.1:$Port"
    $health = Invoke-LumaFlowJsonGet -Uri "$base/api/v1/health"
    if ($null -eq $health) { return $false }
    $models = Invoke-LumaFlowJsonGet -Uri "$base/api/v1/assistant/models"
    if ($null -eq $models) { return $false }
    $expected = if ($Model -eq "14b") { "local-qwen3-14b" } else { "local-qwen3-8b" }
    $entry = @($models.data.models) | Where-Object { $_.id -eq $expected } | Select-Object -First 1
    return ($null -ne $entry -and $entry.reachable -eq $true)
}

function Get-LumaFlowAppLogPath {
    [CmdletBinding()]
    param(
        [string]$Root = $script:LumaFlowRoot
    )

    $logDirectory = Join-Path $Root ".local-data\logs"
    [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
    return Join-Path $logDirectory "next-app.log"
}

function Start-LumaFlowAppProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Node,
        [string]$Root = $script:LumaFlowRoot,
        [Parameter(Mandatory)]
        [int]$Port,
        [ValidateSet("8b", "14b")]
        [string]$Model = "8b",
        [switch]$ForceBuild
    )

    $logPath = Get-LumaFlowAppLogPath -Root $Root
    $scriptPath = Join-Path $Root "scripts\local-model.mjs"
    $arguments = @($scriptPath, "up", "--model=$Model", "--port=$Port")
    if ($ForceBuild) { $arguments += "--force-build" }
    # Start-Process handles log file handles reliably even after this launcher
    # exits. It also avoids inheriting a console that may be closed by a
    # double-clicked .cmd file.
    $argumentString = ($arguments | ForEach-Object { ConvertTo-LumaFlowWindowsArgument $_ }) -join " "
    $errorPath = "$logPath.error.log"
    $process = Start-Process -FilePath $Node.NodePath -ArgumentList $argumentString -WorkingDirectory $Root -RedirectStandardOutput $logPath -RedirectStandardError $errorPath -PassThru -WindowStyle Hidden
    Save-LumaFlowJsonAtomic -Path (Get-LumaFlowAppStatePath -Root $Root) -Value ([ordered]@{
            pid = $process.Id
            root = [IO.Path]::GetFullPath($Root)
            port = $Port
            model = $Model
            startedAt = $process.StartTime.ToUniversalTime().ToString("o")
        })
    Write-LumaFlowLog -Message "Started the loopback app process (PID $($process.Id)); app output is in $logPath and $errorPath."
    return $process
}

function Remove-LumaFlowAppStateIfOwned {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId,
        [string]$Root = $script:LumaFlowRoot
    )

    $statePath = Get-LumaFlowAppStatePath -Root $Root
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return }
    try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ([int]$state.pid -eq $ProcessId) { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue }
    } catch {
        # A stale/corrupt marker is not allowed to influence process ownership.
    }
}

function Stop-LumaFlowAppProcessTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [Diagnostics.Process]$Process
    )

    if ($Process.HasExited) { return }
    Write-LumaFlowLog -Level WARN -Message "Stopping only the verified LumaFlow process tree (PID $($Process.Id)) for rebuild or startup cleanup."
    try {
        # This is an exact, verified PID tree, never a name-wide kill.
        # Windows console-free children need /F for reliable cleanup.
        $stopper = Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", [string]$Process.Id, "/T", "/F") -WindowStyle Hidden -PassThru
        [void]$stopper.WaitForExit(5000)
        [void]$Process.WaitForExit(5000)
        if (-not $Process.HasExited) { throw "Owned process did not exit" }
    } catch {
        Write-LumaFlowLog -Level WARN -Message "Could not automatically stop PID $($Process.Id). Close that exact process after reviewing the app log."
    }
    Remove-LumaFlowAppStateIfOwned -ProcessId $Process.Id
}

function Wait-LumaFlowAppReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [Diagnostics.Process]$Process,
        [Parameter(Mandatory)]
        [int]$Port,
        [ValidateSet("8b", "14b")]
        [string]$Model = "8b",
        [int]$TimeoutSeconds = 600
    )

    $started = [DateTime]::UtcNow
    $lastProgress = -1
    while (([DateTime]::UtcNow - $started).TotalSeconds -lt $TimeoutSeconds) {
        if ($Process.HasExited) {
            throw "The app process exited before health checks passed (exit code $($Process.ExitCode)). See $(Get-LumaFlowAppLogPath)."
        }
        if (Test-LumaFlowAppReady -Port $Port -Model $Model) {
            Write-LumaFlowLog -Message "App health and the selected local $Model model are ready on http://127.0.0.1:$Port."
            return
        }
        $progress = [int](([DateTime]::UtcNow - $started).TotalSeconds / 10)
        if ($progress -ne $lastProgress) {
            $lastProgress = $progress
            Write-LumaFlowLog -Message "Waiting for Next.js health and local model checks... ($([int](([DateTime]::UtcNow - $started).TotalSeconds))s)"
        }
        Start-Sleep -Milliseconds 1000
    }
    throw "Timed out after $TimeoutSeconds seconds waiting for app health and the selected local model. See $(Get-LumaFlowAppLogPath) and $script:LumaFlowLogPath."
}

function Open-LumaFlowBrowser {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Uri
    )

    try {
        Start-Process -FilePath $Uri | Out-Null
        Write-LumaFlowLog -Message "Opened $Uri in the default browser."
    } catch {
        Write-LumaFlowLog -Level WARN -Message "Could not open the browser automatically. Open $Uri manually."
    }
}

function Invoke-LumaFlowBootstrap {
    [CmdletBinding()]
    param(
        [ValidateSet("start", "setup", "check")]
        [string]$Action = "start",
        [int]$Port = 3000,
        [ValidateSet("8b", "14b")]
        [string]$Model = "8b",
        [switch]$NoBrowser,
        [switch]$PreferPortableNode,
        [switch]$SkipDependencies,
        [switch]$SkipModelSetup,
        [switch]$ForceBuild
    )

    if (-not (Test-Path -LiteralPath (Join-Path $script:LumaFlowRoot "package.json") -PathType Leaf)) {
        throw "This script must run from the LumaFlow project directory; package.json was not found beside scripts/."
    }
    Initialize-LumaFlowLog | Out-Null
    Write-LumaFlowLog -Message "Project root: $script:LumaFlowRoot"
    Write-LumaFlowLog -Message "Requested action=$Action model=$Model port=$Port."
    Ensure-LumaFlowEnvironment -Root $script:LumaFlowRoot | Out-Null
    $node = Resolve-LumaFlowNode -Root $script:LumaFlowRoot -PreferPortable:$PreferPortableNode
    # npm lifecycle scripts call "node"; portable Node must also be on the
    # child PATH, not merely be the executable used to launch npm/Next.
    $env:PATH = (Split-Path -Parent $node.NodePath) + [IO.Path]::PathSeparator + $env:PATH
    if ($Action -eq "start" -and (Test-LumaFlowPortInUse -Port $Port)) {
        $owner = Get-LumaFlowListeningProcess -Port $Port
        $owned = Get-LumaFlowOwnedAppProcess -Port $Port -Model $Model -Root $script:LumaFlowRoot
        $healthy = Test-LumaFlowAppReady -Port $Port -Model $Model
        if ($owned -and $owner -and (Test-LumaFlowProcessTreeBelongsToRoot -ProcessId $owner.Pid -Root $script:LumaFlowRoot)) {
            $buildCurrent = (Test-LumaFlowBuildStateCurrent -Root $script:LumaFlowRoot)
            if ($healthy -and $buildCurrent -and -not $ForceBuild) {
                Write-LumaFlowLog -Message "A healthy LumaFlow app owned by this workspace is already listening on port $Port; reusing it because the recorded build inputs are unchanged."
                if (-not $NoBrowser) { Open-LumaFlowBrowser -Uri "http://127.0.0.1:$Port" }
                return
            }
            if (-not $buildCurrent -or $ForceBuild) {
                Write-LumaFlowLog -Message "This workspace has a stale production build on port $Port; stopping only its recorded process tree before rebuilding."
                Stop-LumaFlowAppProcessTree -Process $owned.Process
                Start-Sleep -Milliseconds 500
                if (Test-LumaFlowPortInUse -Port $Port) {
                    throw "The previous LumaFlow process still owns port $Port. No other process was terminated; stop PID $($owned.Process.Id) manually or choose -Port another value."
                }
            } elseif (-not $healthy) {
                throw "This workspace process owns port $Port but has not passed health/model checks yet. Wait for its log ($(Get-LumaFlowAppLogPath)) or choose another port; no process was terminated."
            }
        } else {
            if ($owner) {
                throw "Port $Port is already in use by $($owner.Name) (PID $($owner.Pid)); it is not a verified LumaFlow process from this workspace. No process was terminated. Choose -Port another value or stop that exact app yourself."
            }
            throw "Port $Port is already in use by an unidentified process. No process was terminated. Choose -Port another value."
        }
    }

    if (-not $SkipDependencies) { Ensure-LumaFlowDependencies -Node $node -Root $script:LumaFlowRoot }
    if ($Action -eq "check") {
        Write-LumaFlowLog -Message "Bootstrap checks passed. Node $($node.Version) and locked dependencies are available."
        return
    }
    if ($Action -eq "setup") {
        if ($SkipModelSetup) {
            Write-LumaFlowLog -Message "Model setup was explicitly skipped."
        } else {
            Invoke-LumaFlowNative -FilePath $node.NodePath -Arguments @((Join-Path $script:LumaFlowRoot "scripts\local-model.mjs"), "setup", "--model=$Model") -WorkingDirectory $script:LumaFlowRoot -DisplayName "local model setup"
        }
        Write-LumaFlowLog -Message "Setup completed."
        return
    }

    if (-not $SkipModelSetup) {
        Invoke-LumaFlowNative -FilePath $node.NodePath -Arguments @((Join-Path $script:LumaFlowRoot "scripts\local-model.mjs"), "setup", "--model=$Model") -WorkingDirectory $script:LumaFlowRoot -DisplayName "local model setup"
    } else {
        Write-LumaFlowLog -Level WARN -Message "Model setup was explicitly skipped; local-model.mjs up will still require the selected model to be installed."
    }

    $process = $null
    $startupSucceeded = $false
    try {
        $process = Start-LumaFlowAppProcess -Node $node -Root $script:LumaFlowRoot -Port $Port -Model $Model -ForceBuild:$ForceBuild
        Wait-LumaFlowAppReady -Process $process -Port $Port -Model $Model
        $startupSucceeded = $true
        if (-not $NoBrowser) { Open-LumaFlowBrowser -Uri "http://127.0.0.1:$Port" }
        Write-LumaFlowLog -Message "LumaFlow is running at http://127.0.0.1:$Port. Repeat this launcher to reuse the app, dependencies, and local model."
    } catch {
        if ($process -and -not $startupSucceeded) { Stop-LumaFlowAppProcessTree -Process $process }
        throw
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    $bootstrapLock = $null
    try {
        [IO.Directory]::CreateDirectory($script:LumaFlowDataRoot) | Out-Null
        try {
            $bootstrapLock = [IO.File]::Open((Join-Path $script:LumaFlowDataRoot "bootstrap.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch { throw "Another launcher is active in this workspace. Wait for it to finish; no services were stopped." }
        Invoke-LumaFlowBootstrap -Action $Action -Port $Port -Model $Model -NoBrowser:$NoBrowser -PreferPortableNode:$PreferPortableNode -SkipDependencies:$SkipDependencies -SkipModelSetup:$SkipModelSetup -ForceBuild:$ForceBuild
        exit 0
    } catch {
        if (-not $script:LumaFlowLogPath) {
            try { Initialize-LumaFlowLog | Out-Null } catch { }
        }
        Write-LumaFlowLog -Level ERROR -Message (Protect-LumaFlowLogText $_.Exception.Message)
        if ($script:LumaFlowLogPath) { Write-Host "Bootstrap failed. Review $script:LumaFlowLogPath" }
        exit 1
    } finally {
        if ($bootstrapLock) { $bootstrapLock.Dispose() }
    }
}
