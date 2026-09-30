@echo off
powershell.exe -NoProfile -File "%~dp0Start-Local.ps1" %*
if errorlevel 1 pause
