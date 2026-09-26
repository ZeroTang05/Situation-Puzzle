#!/usr/bin/env bash
# 一键端到端验证：起本地 PostgreSQL + SMTP 收信台 + API + jobs，跑双用户多人房间 E2E 后清理。
# 前置：Docker 可用；OPENCODE_API_KEY 在 .env.local（真实 Jev 判定）。
# 用法：pnpm e2e:multiplayer
set -e
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f scripts/e2e-compose.yml"

echo "== 1. 启动 PostgreSQL =="
$COMPOSE up -d --wait postgres

export DATABASE_URL=postgresql://jev:jev@localhost:54339/jev
# E2E 脚本直连数据库做断言时读 E2E_DATABASE_URL
export E2E_DATABASE_URL=$DATABASE_URL
# E2E 直打 API（Origin 为 8080），better-auth trustedOrigins 需与之匹配
export PUBLIC_BASE_URL=http://localhost:8080
echo "== 2. 迁移 + 题库导入（本地发布）=="
DATABASE_URL=$DATABASE_URL pnpm --dir packages/database run db:migrate > /dev/null
DATABASE_URL=$DATABASE_URL pnpm --dir packages/database run db:import-library -- --publish

echo "== 3. 启动 SMTP 收信台 / API / jobs =="
SINK_OUT="$(pwd)/mailsink.json" node scripts/dev-mailsink.mjs &
SINK_PID=$!
OPENCODE_API_KEY=$(grep '^OPENCODE_API_KEY=' .env.local | cut -d= -f2- | tr -d '"' | tr -d '\r') \
  bash scripts/dev-env.sh api & API_WRAPPER=$!
sleep 12
OPENCODE_API_KEY=$(grep '^OPENCODE_API_KEY=' .env.local | cut -d= -f2- | tr -d '"' | tr -d '\r') \
  bash scripts/dev-env.sh jobs & JOBS_WRAPPER=$!

cleanup() {
  # //T 连子进程一起杀（pnpm 包装下 tsx 是独立进程，普通 kill 会漏）
  taskkill //F //T //PID $API_WRAPPER //PID $JOBS_WRAPPER //PID $SINK_PID > /dev/null 2>&1 || true
  kill $SINK_PID $API_WRAPPER $JOBS_WRAPPER > /dev/null 2>&1 || true
  $COMPOSE down -v > /dev/null 2>&1 || true
  rm -f mailsink.json
}
trap cleanup EXIT

for i in $(seq 1 40); do
  curl -s -o /dev/null http://localhost:8080/api/v1/health/live && break || sleep 2
  if [ "$i" = "40" ]; then echo "API 未就绪"; exit 1; fi
done

echo "== 4. 双用户多人房间 E2E =="
(cd apps/api && node ../../scripts/e2e-multiplayer.mjs)
echo "端到端验证通过 ✓"
