# Windows 任务计划安装脚本 —— 让调度器开机自启 + 自愈
# 用法：powershell -ExecutionPolicy Bypass -File install-windows-tasks.ps1
# 需要管理员权限（右键 PowerShell 以管理员运行），会创建两个计划任务：
#   dsh-scheduler-daemon    登录时启动（隐藏窗口） scheduler.mjs --daemon
#   dsh-scheduler-heartbeat 每5分钟检查 daemon，挂了自动拉起
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
    # 1. 登录时启动常驻 daemon
    New-HiddenTask "dsh-scheduler-daemon" "--daemon" (New-ScheduledTaskTrigger -AtLogOn)
    # 2. 每5分钟自愈检查
    New-HiddenTask "dsh-scheduler-heartbeat" "--ensure-daemon" (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
    Write-Host ""
    Write-Host "已注册两个计划任务。立即测试 daemon："
    Write-Host "  & '$node' '$scheduler' --daemon"
    Write-Host "日志：$here\scheduler.log"
} catch {
    Write-Host "[!] 注册失败：$($_.Exception.Message)"
    Write-Host "    请用管理员身份运行本脚本，或手动启动：& '$node' '$scheduler' --daemon"
}
