@echo off
setlocal
rem Devin Session Exporter - load-unpacked helper (no store, no admin).
rem Downloads the latest extension to a fixed folder, then you click
rem "Load unpacked" once per Chrome profile. Updating = run
rem update-unpacked-windows.cmd and restart Chrome (no re-adding).

rem Install into the system Downloads folder (reads its real path from the
rem registry in case it was moved; falls back to %USERPROFILE%\Downloads).
set "DL=%USERPROFILE%\Downloads"
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" /v "{374DE290-123F-4565-9164-39C4925E467B}" 2^>nul') do set "DL=%%b"
set "DEST=%DL%\DevinSessionExporter"
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
