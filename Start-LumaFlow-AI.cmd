@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-portable.ps1" -StartBonsai
if errorlevel 1 pause
