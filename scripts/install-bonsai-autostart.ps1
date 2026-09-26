#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'LumaFlow Bonsai API'

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    Write-Host 'Bonsai automatic start removed.'
    return
}

$script = Join-Path $PSScriptRoot 'start-bonsai-stack.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw 'The Bonsai stack launcher is missing.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# A missed logon trigger or a stopped proxy should not leave the public site
# disconnected until the next sign-in. The launcher exits quickly when healthy.
$retryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $retryTrigger) -Principal $principal -Settings $settings `
    -Description 'Starts the local Ternary Bonsai model, authenticated API proxy, and Tailscale Funnel after sign-in.' -Force | Out-Null
Write-Host "Bonsai automatic start installed for $user."
