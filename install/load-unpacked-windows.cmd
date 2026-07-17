@echo off
setlocal
rem Devin Session Exporter - load-unpacked helper (no store, no admin).
rem Downloads the latest extension to a fixed folder, then you click
rem "Load unpacked" once per Chrome profile. Updating = run
rem update-unpacked-windows.cmd and restart Chrome (no re-adding).

set "DEST=%LOCALAPPDATA%\DevinSessionExporter"
set "ZIPURL=https://github.com/wookat/devin-session-exporter/releases/latest/download/devin-session-exporter.zip"
set "ZIP=%TEMP%\devin-session-exporter.zip"

echo Downloading latest extension...
curl -L -o "%ZIP%" "%ZIPURL%"
if errorlevel 1 ( echo Download failed. Check your internet. & pause & exit /b 1 )

if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%"
tar -xf "%ZIP%" -C "%DEST%"
if errorlevel 1 ( echo Extract failed. & pause & exit /b 1 )
del "%ZIP%" >nul 2>&1

rem Put the folder path on the clipboard for easy pasting in the file picker.
echo %DEST%| clip

echo.
echo ============================================================
echo Extension files are ready at:
echo   %DEST%
echo (This path is copied to your clipboard.)
echo.
echo In EACH Chrome profile you want the extension:
echo   1) Open chrome://extensions
echo   2) Turn ON "Developer mode" (top-right)
echo   3) Click "Load unpacked" and pick the folder above
echo.
echo To UPDATE later: run update-unpacked-windows.cmd, then restart Chrome.
echo ============================================================
echo.

rem Open the folder and the extensions page to make it easy.
start "" explorer "%DEST%"
start "" chrome "chrome://extensions" 2>nul

pause
