@echo off
setlocal
rem Devin Session Exporter - Windows uninstaller (double-click to run).
rem Removes the global Chrome force-install policy (all profiles).

set "EXTID=mdahidnfandbmeaoegfkiajhjaoehldl"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

reg delete "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionSettings\%EXTID%" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Policies\Google\Chrome\Beta\ExtensionSettings\%EXTID%" /f >nul 2>&1

echo.
echo Uninstalled. Restart Google Chrome to remove it from all profiles.
echo.
pause
