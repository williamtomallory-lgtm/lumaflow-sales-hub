@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-portable.ps1" %*
set "LUMAFLOW_EXIT=%ERRORLEVEL%"
if not "%LUMAFLOW_EXIT%"=="0" echo Setup incomplete. Review the message above and rerun to resume.
exit /b %LUMAFLOW_EXIT%
