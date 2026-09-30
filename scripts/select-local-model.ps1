#Requires -Version 5.1
# Compatibility entry point: all switching uses one guarded runtime manager.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('configured', 'naive-n05-flash-int4-experimental')]
    [string]$Profile,
    [int]$TimeoutSeconds = 90,
    [switch]$NoWait,
    [switch]$KeepOther
)
$ErrorActionPreference = 'Stop'
if ($KeepOther) { throw 'This host loads one selected model at a time. KeepOther is no longer supported.' }
& (Join-Path $PSScriptRoot 'manage-local-model.ps1') -Profile $Profile -TimeoutSeconds $TimeoutSeconds
