# 把本机已安装的全部 Agent 实例切换到新的面板地址，并改为 HTTP 上报；Token 和其他配置不变。
# 以管理员身份打开 PowerShell 运行：
#
#   [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
#   $s = irm https://raw.githubusercontent.com/sbaliyun/esa-vps-monitor/main/agent/switch-server.ps1
#   & ([scriptblock]::Create($s)) -Server https://status.example.com
#
# 加 -DryRun 只显示将要修改的文件。兼容 Windows PowerShell 4.0（Windows Server 2012 R2）。
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$Server = $Server.TrimEnd('/')
if ($Server -notmatch '^https?://[A-Za-z0-9.:/_-]+$') {
  throw "地址格式不正确：$Server（需要 https://域名）"
}

$root = Join-Path $env:ProgramFiles 'CF VPS Monitor'
$runners = @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
  Where-Object { $_.PSIsContainer } |
  ForEach-Object { Join-Path $_.FullName 'run-agent.ps1' } |
  Where-Object { Test-Path -LiteralPath $_ } |
  ForEach-Object { Get-Item -LiteralPath $_ })
if ($runners.Count -eq 0) {
  Write-Error "没有在 $root 下找到 Agent。自定义安装目录的实例请在后台复制安装命令重装。"
  exit 1
}

foreach ($runner in $runners) {
  $content = [IO.File]::ReadAllText($runner.FullName)
  if ($content -notmatch '(?m)^\$env:CF_MONITOR_TOKEN = ') { continue }
  $old = [regex]::Match($content, '(?m)^\$env:CF_MONITOR_SERVER = ([^\r\n]*)').Groups[1].Value.Trim()
  $installDir = $runner.DirectoryName
  if ($DryRun) {
    Write-Host "[dry-run] $($runner.FullName)：$old -> $Server（mode=http）"
    continue
  }

  # 替换串里的 $$ 表示字面量 $；[^\r\n]* 保留行尾的 CRLF。
  $content = $content -replace '(?m)^\$env:CF_MONITOR_SERVER = [^\r\n]*', ('$$env:CF_MONITOR_SERVER = ''' + $Server + '''')
  if ($content -match '(?m)^\$env:CF_MONITOR_MODE = ') {
    $content = $content -replace '(?m)^\$env:CF_MONITOR_MODE = [^\r\n]*', '$$env:CF_MONITOR_MODE = ''http'''
  } else {
    $content = $content -replace '(?m)^(\$env:CF_MONITOR_TOKEN = [^\r\n]*)', ('$1' + "`r`n" + '$$env:CF_MONITOR_MODE = ''http''')
  }
  [IO.File]::WriteAllText($runner.FullName, $content, (New-Object Text.UTF8Encoding($true)))
  Write-Host "已修改 $($runner.FullName)：$old -> $Server（mode=http）"

  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    @($_.Actions | Where-Object { $_.WorkingDirectory -eq $installDir -or ($_.Arguments -and $_.Arguments.Contains($runner.FullName)) }).Count -gt 0
  })
  foreach ($task in $tasks) {
    Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
    # 计划任务停止后 agent 子进程可能还在，按路径结束它，避免旧进程继续用旧地址。
    Get-CimInstance Win32_Process -Filter "Name = 'cf-vps-monitor-agent.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath
    Write-Host "  已重启计划任务 $($task.TaskName)"
  }
  if ($tasks.Count -eq 0) {
    Write-Warning "  没找到对应的计划任务，请重启电脑或在后台复制安装命令重装。"
  }
}
Write-Host "完成。约 1 分钟内应在新面板显示在线。"
