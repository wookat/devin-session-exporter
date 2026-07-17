@echo off
setlocal
rem Devin Session Exporter - Windows one-click installer (double-click to run).
rem Global install for ALL Chrome profiles via Chrome policy (HKLM).
rem Chrome then auto-updates the extension from the GitHub release.

set "EXTID=mdahidnfandbmeaoegfkiajhjaoehldl"
set "UPDATEURL=https://github.com/wookat/devin-session-exporter/releases/latest/download/updates.xml"

rem Elevate to administrator if not already.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "KEY=HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionSettings\%EXTID%"
reg add "%KEY%" /v installation_mode /t REG_SZ /d force_installed /f >nul
reg add "%KEY%" /v update_url /t REG_SZ /d "%UPDATEURL%" /f >nul

set "KEYB=HKLM\SOFTWARE\Policies\Google\Chrome\Beta\ExtensionSettings\%EXTID%"
reg add "%KEYB%" /v installation_mode /t REG_SZ /d force_installed /f >nul
reg add "%KEYB%" /v update_url /t REG_SZ /d "%UPDATEURL%" /f >nul

echo.
echo Installed for all Chrome profiles. Extension ID: %EXTID%
echo Fully restart Google Chrome (close ALL windows) to apply.
echo It will appear in every profile and auto-update from GitHub.
echo.
pause
