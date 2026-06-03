@echo off
setlocal
python "%~dp0list_chrome_profiles.py"
endlocal & exit /b %ERRORLEVEL%
