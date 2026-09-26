@echo off
setlocal
title LumaFlow Work Connector
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-work.ps1"
if errorlevel 1 pause
