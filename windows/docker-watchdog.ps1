# Restarts Docker Desktop's engine if it stays down (for example after Windows Update
# replaces WSL, which stops the engine without restarting it) and makes sure a container,
# Seerr by default, is running. Docker Desktop does not recover from this on its own.
#
# Run it every 5 minutes as the user who owns Docker Desktop, e.g. from an elevated PowerShell:
#   $a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\Deck\docker-watchdog.ps1'
#   $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
#   $p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
#   Register-ScheduledTask 'Docker watchdog' -Action $a -Trigger $t -Principal $p -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew)
param([string]$Container = 'seerr', [string]$LogDirectory = $PSScriptRoot)
$log = Join-Path $LogDirectory 'docker-watchdog.log'
$state = Join-Path $LogDirectory 'docker-watchdog.state'
$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 65536) {
    Move-Item $log "$log.previous" -Force
}
function Write-WatchdogLog([string]$message) {
    Add-Content $log ((Get-Date).ToString('o') + ' ' + $message) -Encoding UTF8
}
function Test-Engine {
    & $docker info --format '{{.ServerVersion}}' *> $null
    return $LASTEXITCODE -eq 0
}

# Leave the boot task (60-second delay) time to start Docker after a Windows restart.
$uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
if ($uptime.TotalMinutes -lt 10) { exit 0 }

if (-not (Test-Engine)) {
    $failures = 1
    if (Test-Path $state) { $failures = [int](Get-Content $state) + 1 }
    Set-Content $state $failures
    if ($failures -lt 2) {
        Write-WatchdogLog 'Docker engine not answering; restarting it if still down at the next check.'
        exit 0
    }
    Write-WatchdogLog "Docker engine down for $failures checks; restarting Docker Desktop."
    $verb = if (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) { 'restart' } else { 'start' }
    & $docker desktop $verb 2>&1 | ForEach-Object { Write-WatchdogLog "docker desktop ${verb}: $_" }
    $up = $false
    for ($i = 0; $i -lt 30 -and -not $up; $i++) {
        Start-Sleep -Seconds 10
        $up = Test-Engine
    }
    if (-not $up) {
        Write-WatchdogLog 'Docker engine still down after the restart; trying again next run.'
        exit 1
    }
    Write-WatchdogLog 'Docker engine is back.'
}
Remove-Item $state -ErrorAction SilentlyContinue

$status = & $docker inspect --format '{{.State.Status}}' $Container 2>$null
if ($status -ne 'running') {
    Write-WatchdogLog "Container '$Container' was '$status'; starting it."
    & $docker start $Container 2>&1 | ForEach-Object { Write-WatchdogLog "docker start: $_" }
}
exit 0
