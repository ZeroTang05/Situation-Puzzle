# 本地开发用 API 启动脚本（读根目录 .env，叠加本地覆盖项）
# 用法：powershell -File scripts/dev-api-local.ps1
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

pnpm --dir apps/api dev
