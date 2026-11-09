# Installs or updates the Deck lights bridge on Windows. Run from an elevated PowerShell
# in this folder:  powershell -ExecutionPolicy Bypass -File install.ps1 [-User name]
# The bridge runs as -User (default: you) from a startup task, because Bluetooth needs a
# user context that Deck's Local Service account lacks.
param(
    [string]$User = $env:USERNAME,
    [string]$Python = (Get-Command python -ErrorAction Stop).Source,
    [string]$Devices = (Join-Path $PSScriptRoot 'devices.json')
)
$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\Deck\lights-bridge'
$TaskName = 'Deck Lights bridge'

# Stop a running bridge before replacing its files.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like '*lights-bridge\bridge.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
for ($i = 0; $i -lt 20 -and (Get-NetTCPConnection -LocalPort 8183 -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }

New-Item -ItemType Directory -Path $Root -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'bridge.py'), (Join-Path $PSScriptRoot 'run-bridge.ps1'), (Join-Path $PSScriptRoot 'devices.example.json') -Destination $Root -Force
# Deck adds and edits bulbs in the installed devices.json, so a newer installed copy is kept.
$Installed = Join-Path $Root 'devices.json'
if ((Test-Path $Devices) -and (Test-Path $Installed) -and (Get-Item $Installed).LastWriteTime -gt (Get-Item $Devices).LastWriteTime) {
    Write-Host "Keeping the installed devices.json: it was changed from Deck after $Devices. Copy it back to edit it here."
}
elseif (Test-Path $Devices) { Copy-Item $Devices $Installed -Force }
elseif (!(Test-Path $Installed)) { throw "No devices.json. Copy devices.example.json to devices.json, list your lights, and run this again." }
if (!(Test-Path "$Root\.venv\Scripts\python.exe")) {
    & $Python -m venv "$Root\.venv"
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
& "$Root\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check --quiet 'bleak==3.0.2'
if ($LASTEXITCODE -ne 0) { throw 'Could not install the Bluetooth library (bleak).' }

# The task runs with the user's non-elevated token, which needs to write state and logs here.
icacls $Root /grant "${User}:(OI)(CI)M" /T /Q | Out-Null

# WiZ bulbs push their changes, and announce themselves when they power up, to UDP 38900.
$Rule = 'Deck Lights bridge (WiZ updates)'
Remove-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $Rule -Direction Inbound -Protocol UDP -LocalPort 38900 -Profile Private, Domain -Action Allow | Out-Null

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Root\run-bridge.ps1`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Description 'Local API for the neon strip (Bluetooth) and WiZ bulbs, used by Deck.' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try { $health = Invoke-RestMethod 'http://127.0.0.1:8183/health' -TimeoutSec 2; break } catch { }
}
if (!$health) { throw "The lights bridge did not start. See $Root\bridge.log." }
Write-Host "Deck lights bridge $($health.version) is running on 127.0.0.1:8183"
