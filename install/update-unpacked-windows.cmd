@echo off
setlocal
rem Devin Session Exporter - update the load-unpacked install in place.
rem Refreshes the files in the fixed folder; Chrome reloads the unpacked
rem extension on next restart. No need to re-add it in each profile.

rem Same Downloads-folder location used by load-unpacked-windows.cmd.
set "DL=%USERPROFILE%\Downloads"
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" /v "{374DE290-123F-4565-9164-39C4925E467B}" 2^>nul') do set "DL=%%b"
set "DEST=%DL%\DevinSessionExporter"
set "ZIPURL=https://github.com/wookat/devin-session-exporter/releases/latest/download/devin-session-exporter.zip"
set "ZIP=%TEMP%\devin-session-exporter.zip"

if not exist "%DEST%" (
    echo Not installed yet. Run load-unpacked-windows.cmd first.
    pause
    exit /b 1
)

echo Downloading latest extension...
curl -L -o "%ZIP%" "%ZIPURL%"
if errorlevel 1 ( echo Download failed. Check your internet. & pause & exit /b 1 )

rmdir /s /q "%DEST%"
mkdir "%DEST%"
tar -xf "%ZIP%" -C "%DEST%"
if errorlevel 1 ( echo Extract failed. & pause & exit /b 1 )
del "%ZIP%" >nul 2>&1

echo.
echo Updated files at %DEST%
echo Now fully restart Chrome (or click the refresh icon on the
echo extension card in chrome://extensions) to apply the update.
echo.
pause
