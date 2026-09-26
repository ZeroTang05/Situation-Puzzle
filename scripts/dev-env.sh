#!/usr/bin/env bash
# 联调环境启动：SMTP 收信台 + API + jobs（真实 Jev 密钥从 .env.local 读取，不回显）
set -e
cd "$(dirname "$0")/.."

# 默认端口 54329；e2e-run.sh 会先导出一次性库地址（54339），已有值不覆盖
export DATABASE_URL=${DATABASE_URL:-postgresql://jev:jev@localhost:54329/jev}
export PORT=8080
# PUBLIC_BASE_URL 是「对外站点」的来源（better-auth trustedOrigins 用它校验前端 Origin）；
# 默认 Vite 前端 5173；e2e-run.sh 会导出 8080（E2E 直打 API），已有值不覆盖
export PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:5173}
export AUTH_SECRET=e2e-dev-secret-0123456789abcdef
export SOLO_TOKEN_SECRET=e2e-dev-secret-fedcba9876543210
export SMTP_HOST=127.0.0.1
export SMTP_PORT=2526
export SMTP_USER=dev
export SMTP_PASS=dev
# 本地联调用 SMTP 收信台；生产用 Resend（默认）
export MAIL_TRANSPORT=smtp
export MAIL_FROM="Jev <dev@localhost>"
export OPENCODE_API_KEY=$(grep '^OPENCODE_API_KEY=' .env.local | cut -d= -f2- | tr -d '"' | tr -d '\r')
export SINK_OUT="$(pwd)/mailsink.json"

if [ -z "$OPENCODE_API_KEY" ]; then
  echo "未找到 OPENCODE_API_KEY（.env.local）" >&2
  exit 1
fi
echo "OPENCODE_API_KEY 已加载（长度 ${#OPENCODE_API_KEY}）"

case "${1:-all}" in
  sink)  exec node scripts/dev-mailsink.mjs ;;
  api)   exec pnpm --dir apps/api exec tsx src/main.ts ;;
  jobs)  exec pnpm --dir apps/jobs exec tsx src/main.ts ;;
  all)   node scripts/dev-mailsink.mjs & SINK=$!
         pnpm --dir apps/api exec tsx src/main.ts & API=$!
         pnpm --dir apps/jobs exec tsx src/main.ts & JOBS=$!
         trap 'kill $SINK $API $JOBS 2>/dev/null' EXIT
         echo "sink=$SINK api=$API jobs=$JOBS"
         wait ;;
esac
