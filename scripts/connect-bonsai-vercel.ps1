#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$FunnelUrl,
    [switch]$Deploy
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $projectRoot '.local-runtime\bonsai\proxy-token.txt'
if (-not (Test-Path -LiteralPath $secretPath)) { throw 'The local Bonsai proxy token is missing.' }
$token = (Get-Content -LiteralPath $secretPath -Raw).Trim()
if ($token.Length -lt 32) { throw 'The local Bonsai proxy token is invalid.' }

try { $funnel = [Uri]$FunnelUrl } catch { throw 'FunnelUrl must be an HTTPS URL.' }
if ($funnel.Scheme -ne 'https' -or $funnel.AbsolutePath -ne '/' -or $funnel.Query -or $funnel.Fragment) {
    throw 'FunnelUrl must be the HTTPS origin shown by Tailscale Funnel, without a path or query.'
}
$tailscale = & tailscale status --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $tailscale.BackendState -ne 'Running') { throw 'Tailscale is not running.' }
$ownHost = $tailscale.Self.DNSName.TrimEnd('.')
if ($funnel.Host -ne $ownHost -or -not $funnel.Host.EndsWith('.ts.net')) {
    throw 'FunnelUrl must match the HTTPS hostname of this Tailscale device.'
}

$baseUrl = $funnel.GetLeftPart([UriPartial]::Authority).TrimEnd('/') + '/v1'
try {
    $advertised = Invoke-RestMethod -Uri "$baseUrl/models" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20
} catch { throw 'The authenticated Funnel endpoint is not reachable; Vercel variables were not changed.' }
if ('ternary-bonsai-2-27b' -notin @($advertised.data.id)) {
    throw 'The Funnel endpoint does not advertise the expected Bonsai model; Vercel variables were not changed.'
}

function Set-ProductionVariable([string]$name, [string]$value, [bool]$sensitive) {
    if ($name -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Invalid variable name: $name" }
    $arguments = "/d /c vercel env add $name production --force"
    if ($sensitive) { $arguments += ' --sensitive' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = 'cmd.exe'
    $info.Arguments = $arguments
    $info.WorkingDirectory = $projectRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($value)
        $process.StandardInput.Close()
        $process.WaitForExit()
        $null = $stdout.Result
        $null = $stderr.Result
        if ($process.ExitCode -ne 0) { throw "Could not update Vercel variable $name (exit $($process.ExitCode))." }
    } finally { $process.Dispose() }
    Write-Host "Updated Vercel Production variable: $name"
}

$settings = [ordered]@{
    LLM_BACKEND = 'openai-compatible'
    LLM_BASE_URL = $baseUrl
    LLM_MODEL = 'ternary-bonsai-2-27b'
    LLM_TIMEOUT_MS = '290000'
    LLM_MAX_OUTPUT_TOKENS = '4096'
    LLM_DEFAULT_PROFILE = 'configured'
    LLM_VISIBLE_PROFILES = 'configured'
    LLM_DISPLAY_NAME = 'Ternary Bonsai 2 27B'
    LLM_DESCRIPTION = '本机电脑运行的 Bonsai 模型，支持文字和图片；电脑离线时不可用。'
    LLM_FAMILY = 'Ternary Bonsai 2'
    LLM_PARAMETER_SIZE_B = '27'
    LLM_CONTEXT_TOKENS = '8192'
    LLM_SUPPORTED_MODES = 'light,medium,ultra'
}
foreach ($entry in $settings.GetEnumerator()) {
    Set-ProductionVariable $entry.Key $entry.Value $false
}
Set-ProductionVariable 'LLM_API_KEY' $token $true

if ($Deploy) {
    Push-Location $projectRoot
    try {
        & vercel deploy --prod --yes
        if ($LASTEXITCODE -ne 0) { throw 'Vercel production deployment failed.' }
    } finally { Pop-Location }
}
