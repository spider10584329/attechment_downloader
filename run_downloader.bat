@echo off
setlocal

set "PYTHON=python"
set "LAUNCHER=%~dp0chrome_launcher.py"

echo Starting launcher (extension setup + native download host)...
%PYTHON% "%LAUNCHER%"
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
