@echo off
rem Start chatThree. Double-click this file, or run it from a command prompt.
rem Arguments are passed to start.ps1 (for example --port 4000 or --no-open).
setlocal
where pwsh >nul 2>nul
if errorlevel 1 (
    echo PowerShell 7 ^(pwsh^) was not found. Install it from https://aka.ms/powershell and run this again.
    pause
    exit /b 1
)
pwsh -NoProfile -File "%~dp0start.ps1" %*
set "code=%errorlevel%"
if not "%code%"=="0" pause
exit /b %code%
