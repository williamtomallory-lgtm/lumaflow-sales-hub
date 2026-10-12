@echo off
setlocal
call "%~dp0Start-LumaFlow.cmd" -StartBonsai %*
exit /b %ERRORLEVEL%
