#Requires -Version 5.1
[CmdletBinding()]
param(
    # Start-Local.ps1 uses this path after the cluster has already been
    # initialized.  It deliberately does not touch configuration, roles,
    # schema, or .env.local in this mode.
    [switch]$StartOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:LumaFlowRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$script:RuntimeRoot = Join-Path $script:LumaFlowRoot ".local-runtime"
$script:DataRoot = Join-Path $script:LumaFlowRoot ".local-data"
$script:PostgresRoot = Join-Path $script:DataRoot "postgres"
$script:PostgresData = Join-Path $script:PostgresRoot "data"
$script:SecretsPath = Join-Path $script:DataRoot "postgres-secrets.json"
$script:FrontendRoot = Join-Path $script:LumaFlowRoot "frontend"
$script:BootstrapScript = Join-Path $script:FrontendRoot "scripts\bootstrap-local-postgres.mjs"
$script:SchemaPath = Join-Path $script:FrontendRoot "database\schema.sql"
$script:Port = 5432
$script:DatabaseName = "lumaflow"
$script:OwnerRole = "lumaflow_owner"
$script:AppRole = "lumaflow_app"
$script:SetupLog = $null
$script:PostgresLog = $null
$script:PgBin = $null
$script:PgCtl = $null
$script:PgIsReady = $null
$script:InitDb = $null

function Write-PostgresSetupLog {
    [CmdletBinding()]
    param(
        [ValidateSet("INFO", "WARN", "ERROR")]
        [string]$Level = "INFO",
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Message
    )

    if ([string]::IsNullOrWhiteSpace($Message)) { return }
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Level] $Message"
    if ($script:SetupLog) {
        Add-Content -LiteralPath $script:SetupLog -Value $line -Encoding UTF8
    }
    if ($Level -eq "ERROR") {
        [Console]::Error.WriteLine($Message)
    } elseif ($Level -eq "WARN") {
        Write-Warning $Message
    } else {
        Write-Host $Message
    }
}

function Set-PrivateAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [switch]$Directory
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Cannot protect missing path: $Path"
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $icacls = Get-Command icacls.exe -ErrorAction SilentlyContinue
    if ($null -ne $icacls) {
        # Use SIDs instead of localized group names.  /inheritance:r plus the
        # explicit current-user grant leaves no Users/Everyone/System access
        # on the credential file or its backup directory.
        $arguments = @(
            $Path,
            "/inheritance:r",
            "/remove:g",
            "*S-1-1-0", "*S-1-5-32-545", "*S-1-5-11", "*S-1-5-32-544", "*S-1-5-18",
            "/grant:r",
            $(if ($Directory) { "${identity}:(OI)(CI)(F)" } else { "${identity}:(F)" })
        )
        $null = & $icacls.Source @arguments 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Could not apply a private ACL to the local PostgreSQL credential path." }
        return
    }

    # Windows ships icacls.exe, but retain a .NET fallback for constrained
    # PowerShell environments where it is not on PATH.
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else { [Security.AccessControl.InheritanceFlags]::None }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-Utf8Atomically {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Content
    )

    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $utf8 = New-Object Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($temporary, $Content, $utf8)
        Move-Item -LiteralPath $temporary -Destination $Path -Force | Out-Null
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function New-PostgresSecretValue {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")
}

function Test-RequiredSecretProperty {
    param(
        [Parameter(Mandatory)]
        [PSObject]$Object,
        [Parameter(Mandatory)]
        [string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        throw "The local PostgreSQL secret file is missing '$Name'. Delete only the incomplete secret file after stopping this cluster, then rerun setup."
    }
}

function Get-PostgresSecrets {
    $initialized = Test-Path -LiteralPath (Join-Path $script:PostgresData "PG_VERSION") -PathType Leaf
    if (Test-Path -LiteralPath $script:SecretsPath -PathType Leaf) {
        try {
            $secrets = Get-Content -LiteralPath $script:SecretsPath -Raw | ConvertFrom-Json
        } catch {
            throw "The local PostgreSQL secret file is not valid JSON. It was not replaced."
        }
        foreach ($name in @("host", "port", "database", "ownerRole", "ownerPassword", "appRole", "appPassword")) {
            Test-RequiredSecretProperty -Object $secrets -Name $name
        }
        if ([string]$secrets.host -ne "127.0.0.1" -or [int]$secrets.port -ne $script:Port -or [string]$secrets.database -ne $script:DatabaseName -or [string]$secrets.ownerRole -ne $script:OwnerRole -or [string]$secrets.appRole -ne $script:AppRole) {
            throw "The local PostgreSQL secret file does not match this project's fixed local database settings; refusing to use a different endpoint or role."
        }
        return $secrets
    }

    if ($initialized -or $StartOnly) {
        throw "The PostgreSQL cluster is already initialized but $script:SecretsPath is missing; refusing to generate a new password for an existing cluster."
    }

    $secrets = [ordered]@{
        version = 1
        host = "127.0.0.1"
        port = $script:Port
        database = $script:DatabaseName
        ownerRole = $script:OwnerRole
        ownerPassword = New-PostgresSecretValue
        appRole = $script:AppRole
        appPassword = New-PostgresSecretValue
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $json = $secrets | ConvertTo-Json -Depth 4
    Write-Utf8Atomically -Path $script:SecretsPath -Content $json
    Set-PrivateAcl -Path $script:SecretsPath
    Write-PostgresSetupLog -Message "Created the ignored local PostgreSQL credential file with private ACLs."
    return ($json | ConvertFrom-Json)
}

function Find-PostgresBinaries {
    $candidate = Join-Path $script:RuntimeRoot "postgres-package\extracted\pgsql\bin"
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw "Portable PostgreSQL binaries were not found at $candidate. This setup does not download or install PostgreSQL."
    }
    Ensure-PostgresShare -PgsqlRoot (Split-Path -Parent $candidate)
    foreach ($name in @("postgres.exe", "pg_ctl.exe", "pg_isready.exe", "initdb.exe")) {
        $path = Join-Path $candidate $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Portable PostgreSQL binary is missing: $path"
        }
    }
    $script:PgBin = $candidate
    $script:PgCtl = Join-Path $candidate "pg_ctl.exe"
    $script:PgIsReady = Join-Path $candidate "pg_isready.exe"
    $script:InitDb = Join-Path $candidate "initdb.exe"
}

function Ensure-PostgresShare {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$PgsqlRoot)

    $shareRoot = Join-Path $PgsqlRoot "share"
    $bkiPath = Join-Path $shareRoot "postgres.bki"
    if (Test-Path -LiteralPath $bkiPath -PathType Leaf) { return }

    # Some portable PostgreSQL archives are unpacked by a first-run helper
    # with only bin/ selected.  Recover the required share/ files from the
    # already-downloaded archive; never fetch another package here.
    $archive = Get-ChildItem -LiteralPath (Join-Path $script:RuntimeRoot "postgres-package") -File -Filter "postgresql-*-windows-x64-binaries.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $archive) {
        throw "PostgreSQL share files are missing (postgres.bki), and no existing portable archive is available. This setup does not download PostgreSQL."
    }
    $zip = $null
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [IO.Compression.ZipFile]::OpenRead($archive.FullName)
        $rootFull = [IO.Path]::GetFullPath($PgsqlRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $entries = @($zip.Entries | Where-Object { $_.FullName.StartsWith("pgsql/share/", [StringComparison]::OrdinalIgnoreCase) -and -not $_.FullName.EndsWith("/") })
        if ($entries.Count -eq 0) {
            throw "The existing PostgreSQL archive does not contain pgsql/share files."
        }
        foreach ($entry in $entries) {
            $relative = $entry.FullName.Substring("pgsql/".Length).Replace("/", [IO.Path]::DirectorySeparatorChar)
            $destination = [IO.Path]::GetFullPath((Join-Path $PgsqlRoot $relative))
            if (-not $destination.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to extract a PostgreSQL archive entry outside the portable runtime directory."
            }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
            $input = $entry.Open()
            try {
                $output = [IO.File]::Open($destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $input.CopyTo($output) } finally { $output.Dispose() }
            } finally { $input.Dispose() }
        }
        Write-PostgresSetupLog -Message "Recovered PostgreSQL share files from the existing local archive ($($entries.Count) files); no download was performed."
    } finally {
        if ($null -ne $zip) { $zip.Dispose() }
    }
    if (-not (Test-Path -LiteralPath $bkiPath -PathType Leaf)) {
        throw "PostgreSQL share extraction completed without postgres.bki; refusing to initialize the cluster."
    }
}

function Get-LocalPortListeners {
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$Port)

    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
            [PSCustomObject]@{
                LocalAddress = [string]$_.LocalAddress
                OwningProcess = [int]$_.OwningProcess
            }
        })
    }

    $listeners = @()
    $netstat = & netstat.exe -ano -p tcp 2>$null
    foreach ($line in @($netstat)) {
        if ($line -match "^\s*([^\s:]+|\[[^\]]+\]):$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            $listeners += [PSCustomObject]@{ LocalAddress = $matches[1]; OwningProcess = [int]$matches[2] }
        }
    }
    return $listeners
}

function Get-ClusterPid {
    $pidPath = Join-Path $script:PostgresData "postmaster.pid"
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { return $null }
    $firstLine = (Get-Content -LiteralPath $pidPath -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($firstLine -match '^\d+$') { return [int]$firstLine }
    return $null
}

function Test-ClusterRunning {
    if (-not (Test-Path -LiteralPath (Join-Path $script:PostgresData "PG_VERSION") -PathType Leaf)) { return $false }
    Push-Location -LiteralPath $script:PgBin
    try {
        & $script:PgCtl status -D $script:PostgresData 1>$null 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        Pop-Location
    }
}

function Assert-PortIsSafe {
    param([Parameter(Mandatory)][bool]$ClusterRunning)

    $listeners = @(Get-LocalPortListeners -Port $script:Port)
    if ($listeners.Count -eq 0) {
        if ($ClusterRunning) {
            throw "The local PostgreSQL cluster reports running but nothing listens on 127.0.0.1:$script:Port; refusing to continue."
        }
        return
    }

    if (-not $ClusterRunning) {
        throw "TCP port $script:Port is already occupied; refusing to stop, replace, or reconfigure another process."
    }
    $clusterPid = Get-ClusterPid
    if ($null -eq $clusterPid) {
        throw "TCP port $script:Port is occupied and the local cluster PID cannot be verified; refusing to continue."
    }
    $foreign = @($listeners | Where-Object { $_.OwningProcess -ne $clusterPid })
    if ($foreign.Count -gt 0) {
        throw "TCP port $script:Port is also owned by another process; refusing to stop, replace, or reconfigure it."
    }
}

function Set-PostgresSetting {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Value
    )

    $raw = if (Test-Path -LiteralPath $Path -PathType Leaf) { Get-Content -LiteralPath $Path -Raw } else { "" }
    $newline = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
    $hadFinalNewline = $raw.EndsWith("`n") -or $raw.EndsWith("`r")
    $normalized = $raw -replace "`r`n", "`n" -replace "`r", "`n"
    $lines = if ([string]::IsNullOrEmpty($normalized)) { @() } else { $normalized -split "`n" }
    if ($hadFinalNewline -and $lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") {
        $lines = @($lines[0..($lines.Count - 2)])
    }
    $pattern = "^\s*" + [Regex]::Escape($Name) + "\s*="
    $found = $false
    $changed = $false
    $output = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in $lines) {
        if ($line -match $pattern) {
            if (-not $found) {
                $canonical = "$Name = $Value"
                [void]$output.Add($canonical)
                if ($line -ne $canonical) { $changed = $true }
                $found = $true
            } else {
                $changed = $true
            }
        } else {
            [void]$output.Add($line)
        }
    }
    if (-not $found) {
        if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne "") { [void]$output.Add("") }
        [void]$output.Add("$Name = $Value")
        $changed = $true
    }
    $updated = ($output -join $newline)
    if ($hadFinalNewline) { $updated += $newline }
    if (-not $changed -and $updated -eq $raw) { return $false }
    Write-Utf8Atomically -Path $Path -Content $updated
    return $true
}

function Ensure-PostgresConfig {
    $configPath = Join-Path $script:PostgresData "postgresql.conf"
    $changed = $false
    $changed = (Set-PostgresSetting -Path $configPath -Name "listen_addresses" -Value "'127.0.0.1'") -or $changed
    $changed = (Set-PostgresSetting -Path $configPath -Name "port" -Value ([string]$script:Port)) -or $changed
    $changed = (Set-PostgresSetting -Path $configPath -Name "password_encryption" -Value "'scram-sha-256'") -or $changed
    return $changed
}

function Ensure-PostgresHba {
    $hbaPath = Join-Path $script:PostgresData "pg_hba.conf"
    if (-not (Test-Path -LiteralPath $hbaPath -PathType Leaf)) {
        throw "PostgreSQL pg_hba.conf is missing: $hbaPath"
    }
    $raw = Get-Content -LiteralPath $hbaPath -Raw
    $newline = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
    $lines = $raw -replace "`r`n", "`n" -replace "`r", "`n" -split "`n"
    $changed = $false
    $updatedLines = foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
            $line
            continue
        }
        $parts = $trimmed -split "\s+"
        if ($parts.Count -lt 4) {
            throw "pg_hba.conf contains an invalid active rule; refusing to weaken or guess its authentication policy."
        }
        $method = $parts[$parts.Count - 1].ToLowerInvariant()
        if ($method -eq "trust") {
            throw "pg_hba.conf contains an active trust rule; refusing to start an unauthenticated PostgreSQL server."
        }
        if ($method -eq "md5" -or $method -eq "password") {
            $prefix = $line.Substring(0, $line.IndexOf($parts[$parts.Count - 1], [StringComparison]::Ordinal))
            $line = $prefix + "scram-sha-256"
            $changed = $true
        } elseif ($method -ne "scram-sha-256") {
            throw "pg_hba.conf contains a non-SCRAM authentication rule; refusing to change an existing cluster implicitly."
        }
        $line
    }
    $updated = ($updatedLines -join $newline)
    if ($raw.EndsWith("`n") -or $raw.EndsWith("`r")) { $updated += $newline }
    if ($changed) {
        Write-Utf8Atomically -Path $hbaPath -Content $updated
    }
    return $changed
}

function Invoke-PostgresCtl {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage
    )

    # Start pg_ctl without creating a visible console window.  pg_ctl itself
    # detaches postgres into the background. Start-Process -Wait waits for
    # descendants too on Windows, so use Process.WaitForExit to wait ONLY for
    # the short control command, not the long-lived database server.
    $quotedArguments = @($Arguments | ForEach-Object {
        $value = [string]$_
        if ($value -match '[\s"]') { '"' + $value.Replace('"', '\"') + '"' } else { $value }
    }) -join " "
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $stdoutPath = Join-Path $script:RuntimeRoot "postgres-pgctl-$stamp-$([Guid]::NewGuid().ToString('N')).out.log"
    $stderrPath = Join-Path $script:RuntimeRoot "postgres-pgctl-$stamp-$([Guid]::NewGuid().ToString('N')).err.log"
    try {
        $process = Start-Process -FilePath $script:PgCtl -ArgumentList $quotedArguments -WorkingDirectory $script:PgBin -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        if (-not $process.WaitForExit(90000)) { throw 'pg_ctl did not finish within 90 seconds.' }
        $process.Refresh()
        $exitCode = $process.ExitCode
    } catch {
        throw $FailureMessage
    }
    foreach ($path in @($stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            foreach ($line in @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)) {
                if ($script:SetupLog) { Add-Content -LiteralPath $script:SetupLog -Value ("pg_ctl: " + [string]$line) -Encoding UTF8 }
            }
        }
    }
    if ($exitCode -ne 0) {
        throw $FailureMessage
    }
}

function Start-LocalPostgres {
    $arguments = @("start", "-D", $script:PostgresData, "-l", $script:PostgresLog, "-w")
    Invoke-PostgresCtl -Arguments $arguments -FailureMessage "PostgreSQL did not start. See $script:PostgresLog and $script:SetupLog."
}

function Wait-ForLocalPostgres {
    function Test-Ready {
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $script:PgIsReady
        $startInfo.WorkingDirectory = $script:PgBin
        $startInfo.Arguments = "-h 127.0.0.1 -p $script:Port -d postgres"
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        try {
            if (-not $process.Start()) { return $false }
            if (-not $process.WaitForExit(2000)) {
                try { $process.Kill() } catch { }
                return $false
            }
            return ($process.ExitCode -eq 0)
        } finally {
            $process.Dispose()
        }
    }

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $ready = Test-Ready
        if ($ready) {
            $listeners = @(Get-LocalPortListeners -Port $script:Port)
            $clusterPid = Get-ClusterPid
            if ($listeners.Count -gt 0 -and $null -ne $clusterPid -and @($listeners | Where-Object { $_.OwningProcess -ne $clusterPid }).Count -eq 0) {
                return
            }
        }
        Start-Sleep -Seconds 1
    }
    throw "PostgreSQL did not become ready on 127.0.0.1:$script:Port. See $script:PostgresLog and $script:SetupLog."
}

function Invoke-NodeBootstrap {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if ($null -eq $nodeCommand) { throw "Node.js is required to provision the PostgreSQL schema, but no node executable was found." }
    if (-not (Test-Path -LiteralPath $script:BootstrapScript -PathType Leaf)) {
        throw "Missing PostgreSQL Node bootstrap script: $script:BootstrapScript"
    }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $stdout = Join-Path $script:RuntimeRoot "postgres-bootstrap-$stamp.out.log"
    $stderr = Join-Path $script:RuntimeRoot "postgres-bootstrap-$stamp.err.log"
    & $nodeCommand.Source $script:BootstrapScript 1> $stdout 2> $stderr
    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL role/schema/env bootstrap failed. See $stdout and $stderr."
    }
}

try {
    [IO.Directory]::CreateDirectory($script:RuntimeRoot) | Out-Null
    [IO.Directory]::CreateDirectory($script:DataRoot) | Out-Null
    [IO.Directory]::CreateDirectory($script:PostgresRoot) | Out-Null
    $script:SetupLog = Join-Path $script:RuntimeRoot "postgres-setup.log"
    $script:PostgresLog = Join-Path $script:RuntimeRoot "postgres-server.log"
    Add-Content -LiteralPath $script:SetupLog -Value ("`n===== LumaFlow PostgreSQL setup $(Get-Date -Format o) =====") -Encoding UTF8

    Find-PostgresBinaries
    $initialized = Test-Path -LiteralPath (Join-Path $script:PostgresData "PG_VERSION") -PathType Leaf
    if ($StartOnly -and -not $initialized) {
        throw "-StartOnly requires an initialized local PostgreSQL cluster at $script:PostgresData."
    }
    if ((Test-Path -LiteralPath $script:PostgresData -PathType Container) -and -not $initialized) {
        $entries = @(Get-ChildItem -LiteralPath $script:PostgresData -Force -ErrorAction SilentlyContinue)
        if ($entries.Count -gt 0) {
            throw "The PostgreSQL data directory exists but is not an initialized cluster; refusing to delete or overwrite it."
        }
    }

    $running = Test-ClusterRunning
    Assert-PortIsSafe -ClusterRunning $running

    if ($StartOnly) {
        if (-not $running) {
            Start-LocalPostgres
            Wait-ForLocalPostgres
        }
        Write-PostgresSetupLog -Message "Local PostgreSQL cluster is running on 127.0.0.1:$script:Port (start-only; no migration or configuration was run)."
        exit 0
    }

    $secrets = Get-PostgresSecrets
    if (-not $initialized) {
        $temporaryPassword = Join-Path $script:RuntimeRoot "postgres-init-$([Guid]::NewGuid().ToString('N')).pw"
        try {
            Write-Utf8Atomically -Path $temporaryPassword -Content ([string]$secrets.ownerPassword)
            Set-PrivateAcl -Path $temporaryPassword
            $initArguments = @("-D", $script:PostgresData, "-U", $script:OwnerRole, "--auth=scram-sha-256", "--encoding=UTF8", "--pwfile=$temporaryPassword")
            Push-Location -LiteralPath $script:PgBin
            try {
                $initOutput = @(& $script:InitDb @initArguments 2>&1)
                $initExitCode = $LASTEXITCODE
            } finally {
                Pop-Location
            }
            foreach ($line in $initOutput) {
                Add-Content -LiteralPath $script:SetupLog -Value ("initdb: " + [string]$line) -Encoding UTF8
            }
            if ($initExitCode -ne 0) {
                throw "PostgreSQL cluster initialization failed. See $script:SetupLog."
            }
            if (-not (Test-Path -LiteralPath (Join-Path $script:PostgresData "PG_VERSION") -PathType Leaf)) {
                throw "initdb returned success but did not create PG_VERSION; refusing to continue."
            }
            $initialized = $true
            Write-PostgresSetupLog -Message "Initialized the persistent UTF-8 PostgreSQL cluster with SCRAM authentication."
        } finally {
            if (Test-Path -LiteralPath $temporaryPassword) {
                Remove-Item -LiteralPath $temporaryPassword -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $configChanged = Ensure-PostgresConfig
    $hbaChanged = Ensure-PostgresHba
    if ($running -and ($configChanged -or $hbaChanged)) {
        Invoke-PostgresCtl -Arguments @("restart", "-D", $script:PostgresData, "-l", $script:PostgresLog, "-w") -FailureMessage "PostgreSQL configuration changed but the local cluster could not be restarted. See $script:PostgresLog."
        Wait-ForLocalPostgres
    } elseif (-not $running) {
        Start-LocalPostgres
        Wait-ForLocalPostgres
    }

    # The Node script connects as the migration owner, creates the database and
    # app role, applies schema.sql, grants app DML only, and merges .env.local.
    Invoke-NodeBootstrap
    if (Test-Path -LiteralPath $script:SecretsPath -PathType Leaf) { Set-PrivateAcl -Path $script:SecretsPath }
    $envPath = Join-Path $script:FrontendRoot ".env.local"
    if (Test-Path -LiteralPath $envPath -PathType Leaf) { Set-PrivateAcl -Path $envPath }
    $backupDirectory = Join-Path $script:DataRoot "postgres-env-backups"
    if (Test-Path -LiteralPath $backupDirectory -PathType Container) {
        Set-PrivateAcl -Path $backupDirectory -Directory
        foreach ($backup in @(Get-ChildItem -LiteralPath $backupDirectory -File -Force)) {
            Set-PrivateAcl -Path $backup.FullName
        }
    }

    Write-PostgresSetupLog -Message "Local PostgreSQL is running on 127.0.0.1:$script:Port; migration owner, restricted app role, schema, and server env are ready."
    Write-PostgresSetupLog -Message "No sample business records were inserted. PostgreSQL will remain running until explicitly stopped with pg_ctl."
} catch {
    $message = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { "unknown error" }
    if ($script:SetupLog) { Add-Content -LiteralPath $script:SetupLog -Value ("[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ERROR] $message") -Encoding UTF8 }
    throw
}
