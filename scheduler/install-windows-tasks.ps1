# Install Windows scheduled tasks for the dsh scheduler.
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File install-windows-tasks.ps1
# Creates two tasks:
#   dsh-scheduler-daemon    start daemon (hidden) at logon
#   dsh-scheduler-heartbeat every 5 min, restart daemon if dead
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scheduler = Join-Path $here "scheduler.mjs"
$node = (Get-Command node).Source
if (-not $node) { throw "node not found in PATH" }

function New-HiddenTask($taskName, $extraArgs, $trigger) {
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$node' '$scheduler' $extraArgs`""
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "[OK] $taskName"
}

try {
    New-HiddenTask "dsh-scheduler-daemon" "--daemon" (New-ScheduledTaskTrigger -AtLogOn)
    New-HiddenTask "dsh-scheduler-heartbeat" "--ensure-daemon" (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
    Write-Host ""
    Write-Host "Registered. Manual start test:"
    Write-Host "  node `"$scheduler`" --daemon"
    Write-Host "Log: $here\scheduler.log"
} catch {
    Write-Host "[!] Registration failed: $($_.Exception.Message)"
    Write-Host "    Run this script as Administrator, or start the daemon manually:"
    Write-Host "  node `"$scheduler`" --daemon"
}
