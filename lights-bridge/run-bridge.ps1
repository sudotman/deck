# Keeps the Deck lights bridge running. Started at boot by the "Deck Lights bridge" task.
# The bridge writes its own log (bridge.log, rotated at 256 KB).
Set-Location $PSScriptRoot
while ($true) {
    & "$PSScriptRoot\.venv\Scripts\python.exe" "$PSScriptRoot\bridge.py" *> $null
    Start-Sleep -Seconds 5
}
