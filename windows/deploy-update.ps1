# Installs a Deck package (zip + manifest from scripts/package.mjs) over an existing
# C:\ProgramData\Deck install: verifies checksums, runs the tests with Deck's own Node,
# waits for running tasks, backs up, swaps the app files and rolls back on failure.
# Keeps config.json, runtime, logs and data.
param([string]$ArchivePath = '', [string]$Source = '')
$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\Deck'
$TaskName = 'Deck Media Dashboard'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Stage = Join-Path $env:TEMP "deck-update-$Stamp"
$Backup = Join-Path $Root "backups\app-$Stamp"
$Node = Join-Path $Root 'runtime\node.exe'
$Changed = $false
$Stopped = $false
$Result = [ordered]@{ version = ''; success = $false; backup = $Backup }
$Components = @('server.mjs','lib','public','test','package.json','README.md','config.example.json')
function Stop-Deck {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -eq $Node } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
try {
    if (!(Test-Path $Node) -or !(Test-Path (Join-Path $Root 'config.json'))) { throw 'The existing Deck installation was not found.' }
    if (!$ArchivePath -and !$Source) { throw 'Pass -ArchivePath (a local deck zip) or -Source (a URL serving deck.zip).' }
    $Config = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
    $BindHost = if ($Config.bind -and $Config.bind -ne '0.0.0.0') { $Config.bind } else { '127.0.0.1' }
    $Port = if ($Config.port) { $Config.port } else { 8181 }
    $Base = "http://${BindHost}:$Port"
    Get-ScheduledTask -TaskName $TaskName | Out-Null
    New-Item -ItemType Directory -Path $Stage -Force | Out-Null
    $Archive = Join-Path $Stage 'deck.zip'
    if ($ArchivePath) { Copy-Item -LiteralPath $ArchivePath -Destination $Archive } else { Invoke-WebRequest "$Source/deck.zip" -OutFile $Archive -UseBasicParsing }
    $Payload = Join-Path $Stage 'source'
    Expand-Archive -Path $Archive -DestinationPath $Payload
    $Manifest = Get-Content (Join-Path $Payload 'manifest.json') -Raw | ConvertFrom-Json
    $Result.version = $Manifest.version
    foreach ($File in $Manifest.files) {
        $Candidate = Join-Path $Payload $File.path
        if ((Get-FileHash $Candidate -Algorithm SHA256).Hash.ToLowerInvariant() -ne $File.sha256) { throw "Package checksum failed: $($File.path)" }
    }
    Push-Location $Payload
    try { & $Node --test; if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed. The installed app has not been changed.' } } finally { Pop-Location }
    $ConfigHash = (Get-FileHash (Join-Path $Root 'config.json')).Hash
    $Deadline = (Get-Date).AddMinutes(30)
    do {
        $Jobs = Invoke-RestMethod "$Base/hub/api/jobs"
        $Active = @($Jobs | Where-Object { $_.status -in @('running','queued') })
        if ($Active.Count -eq 0) { break }
        if ((Get-Date) -gt $Deadline) { throw 'Deck still has active tasks; update deferred without changing the installed app.' }
        Write-Host "Waiting for $($Active.Count) Deck tasks to finish..."
        Start-Sleep -Seconds 10
    } while ($true)
    New-Item -ItemType Directory -Path $Backup -Force | Out-Null
    foreach ($Component in $Components) { $Existing = Join-Path $Root $Component; if (Test-Path $Existing) { Copy-Item $Existing -Destination $Backup -Recurse -Force } }
    Stop-Deck
    $Stopped = $true
    $Changed = $true
    foreach ($Component in $Components) { Copy-Item (Join-Path $Payload $Component) -Destination $Root -Recurse -Force }
    foreach ($File in $Manifest.files) {
        if ($File.path -eq 'run.ps1') { continue }
        if ((Get-FileHash (Join-Path $Root $File.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $File.sha256) { throw "Installed checksum failed: $($File.path)" }
    }
    if ((Get-FileHash (Join-Path $Root 'config.json')).Hash -ne $ConfigHash) { throw 'The private configuration changed unexpectedly.' }
    Start-ScheduledTask -TaskName $TaskName
    $Overview = $null
    for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
        Start-Sleep -Seconds 2
        try { $Overview = Invoke-RestMethod "$Base/hub/api/overview"; break } catch { }
    }
    if (!$Overview) { throw 'Deck did not become available after update.' }
    foreach ($Endpoint in @('imports','watch-users','alerts','configuration?service=radarr','bazarr-configuration','subtitle-library','requests?filter=all','lights','lights-scenes')) { Invoke-RestMethod "$Base/hub/api/$Endpoint" | Out-Null }
    $Result.success = $true
    $Result.services = @($Overview.services | Select-Object id,online,version)
    $Result.healthWarnings = @($Overview.health).Count
    $Result.dataErrors = @($Overview.dataErrors).Count
    Write-Host "Deck $($Manifest.version) is running at $Base"
} catch {
    $Result.error = $_.Exception.Message
    Write-Host "Update failed: $($Result.error)"
    if ($Changed) {
        Stop-Deck
        foreach ($Component in $Components) { $Saved = Join-Path $Backup $Component; if (Test-Path $Saved) { Copy-Item $Saved -Destination $Root -Recurse -Force } }
        $Result.rolledBack = $true
    }
    if ($Stopped) { Start-ScheduledTask -TaskName $TaskName }
} finally {
    $Json = $Result | ConvertTo-Json -Depth 8
    $Json | Set-Content (Join-Path $Root 'logs\update-result.json') -Encoding UTF8
    if (!$ArchivePath) { try { Invoke-RestMethod "$Source/result" -Method Post -ContentType 'application/json' -Body $Json | Out-Null } catch { } }
}
if (!$Result.success) { exit 1 }
