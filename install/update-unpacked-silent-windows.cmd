@echo off
setlocal
rem Devin Session Exporter - silent in-place update.
rem Downloads the latest extension to the Downloads folder and extracts it.
rem Does NOT open Explorer, does NOT open Chrome, does NOT pause.
rem After it runs, click the refresh icon on the extension card in
rem chrome://extensions (or restart Chrome) to apply.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders').'{374DE290-123F-4565-9164-39C4925E467B}'; if(-not $d){$d=\"$env:USERPROFILE\Downloads\"}; $dest=\"$d\DevinSessionExporter\"; $zip=\"$env:TEMP\dse.zip\"; Invoke-WebRequest 'https://github.com/wookat/devin-session-exporter/releases/latest/download/devin-session-exporter.zip' -OutFile $zip; Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive $zip $dest -Force; Remove-Item $zip -Force; Write-Host ('Updated: '+$dest)"
