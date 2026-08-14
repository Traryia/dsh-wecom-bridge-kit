# Install Windows scheduled tasks for the dsh scheduler.
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File install-windows-tasks.ps1
# Creates two tasks (launched via wscript.exe run-hidden.vbs, so NO console window appears):
#   dsh-scheduler-daemon    start daemon at logon
#   dsh-scheduler-heartbeat every 5 min, restart daemon if dead
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scheduler = Join-Path $here "scheduler.mjs"
$vbs = Join-Path $here "run-hidden.vbs"
$node = (Get-Command node).Source
if (-not $node) { throw "node not found in PATH" }
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"

function New-HiddenTask($taskName, $extraArgs, $trigger) {
    $arg = "`"$vbs`" `"$node`" `"$scheduler`" $extraArgs"
    $action = New-ScheduledTaskAction -Execute $wscript -Argument $arg
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "[OK] $taskName"
}

try {
    New-HiddenTask "dsh-scheduler-daemon" "--daemon" (New-ScheduledTaskTrigger -AtLogOn)
    New-HiddenTask "dsh-scheduler-heartbeat" "--ensure-daemon" (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
    Write-Host ""
    Write-Host "Registered. Both tasks launch windowless via wscript."
    Write-Host "Log: $here\scheduler.log"
} catch {
    Write-Host "[!] Registration failed: $($_.Exception.Message)"
    Write-Host "    Run this script as Administrator."
}
