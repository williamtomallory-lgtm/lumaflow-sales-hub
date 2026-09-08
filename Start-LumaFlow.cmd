@echo off
setlocal

rem This file is safe to double-click from any current directory, including
rem a project path containing spaces. The PowerShell script owns all setup,
rem downloads, health checks, and process-scope safety decisions.
set "LUMAFLOW_SCRIPT=%~dp0scripts\bootstrap.ps1"

where pwsh.exe >nul 2>&1
if not errorlevel 1 (
    pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LUMAFLOW_SCRIPT%" %*
) else (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LUMAFLOW_SCRIPT%" %*
)

set "LUMAFLOW_EXIT=%ERRORLEVEL%"
if not "%LUMAFLOW_EXIT%"=="0" echo LumaFlow did not start. Review .local-data\logs\bootstrap.log.
exit /b %LUMAFLOW_EXIT%
