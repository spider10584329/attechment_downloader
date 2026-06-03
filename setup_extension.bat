@echo off
setlocal

set "PYTHON=python"
set "INSTALLER=d:\My_Projects\z_testing\blockchain\downloader\extension_auto_installer.py"

echo Gmail downloader - automatic Chrome extension setup
echo.
%PYTHON% "%INSTALLER%"
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" exit /b %EXITCODE%

echo.
echo Setup complete. Run run_downloader.bat when Chrome is open with your Gmail profile.
endlocal & exit /b %EXITCODE%
