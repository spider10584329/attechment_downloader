@echo off
setlocal

set "PYTHON=python"
set "LAUNCHER=d:\My_Projects\z_testing\blockchain\downloader\chrome_launcher.py"

echo Starting launcher (extension setup + background relocate/move services)...
%PYTHON% "%LAUNCHER%"
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
