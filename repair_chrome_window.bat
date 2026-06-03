@echo off
setlocal
python "%~dp0repair_chrome_window.py"
endlocal & exit /b %ERRORLEVEL%
