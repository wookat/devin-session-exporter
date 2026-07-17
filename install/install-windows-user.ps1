# Devin Session Exporter - Windows installer (no administrator required).
# Writes the Chrome force-install policy under HKCU, so it applies to the
# current Windows user's Chrome profiles without admin rights. Chrome then
# auto-updates the extension from the GitHub release.
#
# Run: right-click -> "Run with PowerShell", or:
#   powershell -ExecutionPolicy Bypass -File .\install-windows-user.ps1

$ErrorActionPreference = "Stop"

$ExtId     = "mdahidnfandbmeaoegfkiajhjaoehldl"
$UpdateUrl = "https://github.com/wookat/devin-session-exporter/releases/latest/download/updates.xml"

$key = "HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionSettings\$ExtId"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "installation_mode" -Value "force_installed" -Type String
Set-ItemProperty -Path $key -Name "update_url"        -Value $UpdateUrl        -Type String

Write-Host ""
Write-Host "Installed (current user, no admin). Extension ID: $ExtId" -ForegroundColor Green
Write-Host "Fully restart Google Chrome (close ALL windows) to apply."
Write-Host "It will appear in your profiles and auto-update from GitHub."
Write-Host ""
Read-Host "Press Enter to close"
