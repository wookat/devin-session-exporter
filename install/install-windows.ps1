# Devin Session Exporter - Windows one-click installer.
# Installs the extension for ALL Chrome profiles on this machine via Chrome
# enterprise policy (force-installed, self-hosted). Chrome then keeps it
# up to date automatically from the GitHub release.
#
# Run: right-click -> "Run with PowerShell", or in an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1

$ErrorActionPreference = "Stop"

$ExtId     = "mdahidnfandbmeaoegfkiajhjaoehldl"
$UpdateUrl = "https://github.com/wookat/devin-session-exporter/releases/latest/download/updates.xml"

# Re-launch elevated if not already administrator.
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting administrator privileges..."
    Start-Process powershell -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
    )
    exit
}

function Set-ForceInstall($root) {
    $key = "$root\ExtensionSettings\$ExtId"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "installation_mode" -Value "force_installed" -Type String
    Set-ItemProperty -Path $key -Name "update_url"        -Value $UpdateUrl        -Type String
}

# Apply to both Chrome and Chrome Beta policy roots (harmless if a channel is absent).
Set-ForceInstall "HKLM:\SOFTWARE\Policies\Google\Chrome"
Set-ForceInstall "HKLM:\SOFTWARE\Policies\Google\Chrome\Beta"

Write-Host ""
Write-Host "Installed. Extension ID: $ExtId" -ForegroundColor Green
Write-Host "Fully restart Google Chrome (close ALL windows) to apply."
Write-Host "It will appear in every profile and auto-update from GitHub."
Write-Host ""
Read-Host "Press Enter to close"
