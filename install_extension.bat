@echo off
setlocal

set "PYTHON=python"
set "INSTALLER=d:\My_Projects\z_testing\blockchain\downloader\extension_auto_installer.py"

echo Closing Chrome is required. The installer will enable Developer mode, install the extension, and force-close chrome.exe if it is still running.
echo.

%PYTHON% "%INSTALLER%"
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
