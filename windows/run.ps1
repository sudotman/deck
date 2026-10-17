$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
while ($true) {
    & "$PSScriptRoot\runtime\node.exe" "$PSScriptRoot\server.mjs" *>> "$PSScriptRoot\logs\deck.log"
    Start-Sleep -Seconds 5
    if ((Get-Item "$PSScriptRoot\logs\deck.log" -ErrorAction SilentlyContinue).Length -gt 5242880) {
        Move-Item "$PSScriptRoot\logs\deck.log" "$PSScriptRoot\logs\deck.previous.log" -Force
    }
}
