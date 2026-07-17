# Devin Session Exporter - Windows uninstaller.
# Removes the Chrome force-install policy for this extension (all profiles).

$ErrorActionPreference = "Stop"

$ExtId = "mdahidnfandbmeaoegfkiajhjaoehldl"

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting administrator privileges..."
    Start-Process powershell -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
    )
    exit
}

foreach ($root in @(
    "HKLM:\SOFTWARE\Policies\Google\Chrome",
    "HKLM:\SOFTWARE\Policies\Google\Chrome\Beta"
)) {
    $key = "$root\ExtensionSettings\$ExtId"
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
}

Write-Host ""
Write-Host "Uninstalled. Restart Google Chrome to remove it from all profiles." -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close"
