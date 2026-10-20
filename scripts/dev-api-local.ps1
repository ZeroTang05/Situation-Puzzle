# 本地开发用 API 启动脚本（读根目录 .env，叠加本地覆盖项）
# 用法：powershell -File scripts/dev-api-local.ps1
# 想让它脱离终端常驻：Start-Process powershell -ArgumentList '-File','<本脚本路径>' -WindowStyle Hidden
# 停掉它：taskkill /T /F /PID (Get-Content scripts/../data/xhs/tmp/api.pid)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

Get-Content '.env' -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)=(.*)$') {
    $k = $Matches[1]; $v = $Matches[2].Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) { $v = $v.Substring(1, $v.Length - 2) }
    [Environment]::SetEnvironmentVariable($k, $v, 'Process')
  }
}
# 本地覆盖：测试库在本机 55440 端口；前端跑 5173
$env:DATABASE_URL = 'postgresql://jev:jev@localhost:55440/jev'
$env:PORT = '8080'
$env:PUBLIC_BASE_URL = 'http://localhost:5173'

# 记录 PID：脱离终端常驻时没有任务句柄可停，靠这个文件找进程
# 用 cmd.exe 包一层：Start-Process -NoNewWindow 会走 CreateProcess，直接执行 .cmd 会失败
$tmpDir = Join-Path $PSScriptRoot '..\data\xhs\tmp'
if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null }
$pidFile = Join-Path $tmpDir 'api.pid'
$logFile = Join-Path $tmpDir 'api.log'
$errFile = Join-Path $tmpDir 'api.err.log'
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','pnpm --dir apps/api dev' `
  -NoNewWindow -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $errFile
$proc.Id | Set-Content -Path $pidFile -Encoding ascii
Write-Host "API 启动中（pid $($proc.Id)），日志：$logFile"
try {
  $proc.WaitForExit()
} finally {
  Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
}
