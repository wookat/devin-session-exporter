# Devin Session Exporter - Windows uninstaller (no administrator required).
# Removes the HKCU Chrome force-install policy for this extension.

$ErrorActionPreference = "Stop"

$ExtId = "mdahidnfandbmeaoegfkiajhjaoehldl"

$key = "HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionSettings\$ExtId"
if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }

Write-Host ""
Write-Host "Uninstalled (current user). Restart Google Chrome to remove it." -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close"
