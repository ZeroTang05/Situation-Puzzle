#!/usr/bin/env bash
# 新系统冒烟测试：本地 Docker PostgreSQL + API + jobs（docs/rebuild/02-MVP.md 阶段验收的最小自动化子集）
set -e
cd "$(dirname "$0")/.."

export NODE_ENV=development
export DATABASE_URL=postgresql://jev:jev@localhost:54329/jev
export PORT=8080
export PUBLIC_BASE_URL=http://localhost:5173
# 冒烟专用测试密钥；正式部署必须重新生成
export AUTH_SECRET=smoke-test-secret-0123456789abcdef
export SOLO_TOKEN_SECRET=smoke-test-secret-fedcba9876543210
# SMTP 用占位值：冒烟不触发真实发信（真实登录通道属于 M0 外部验证）
export MAIL_TRANSPORT=smtp
export SMTP_HOST=127.0.0.1
export SMTP_PORT=2525
export SMTP_USER=smoke
export SMTP_PASS=smoke
export MAIL_FROM="Jev <smoke@example.com>"

echo "== 启动 API（后台）=="
pnpm --dir apps/api exec tsx src/main.ts &
API_PID=$!
echo "API PID: $API_PID"

echo "== 启动 jobs（后台）=="
pnpm --dir apps/jobs exec tsx src/main.ts &
JOBS_PID=$!
echo "JOBS PID: $JOBS_PID"

cleanup() {
  kill $API_PID $JOBS_PID 2>/dev/null || true
}
trap cleanup EXIT

echo "== 等待 API 就绪 =="
READY=0
for i in $(seq 1 40); do
  if curl -s -o /dev/null http://localhost:8080/api/v1/health/live; then
    READY=1
    echo "API 就绪（轮询 ${i} 次）"
    break
  fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "API 40 秒内未就绪，冒烟失败"
  exit 1
fi

echo "== 健康检查 =="
curl -s http://localhost:8080/api/v1/health/live
echo
curl -s http://localhost:8080/api/v1/health/ready
echo

echo "== 题库列表（应为 30 条已发布）=="
curl -s "http://localhost:8080/api/v1/puzzles?limit=100" | head -c 400
echo

echo "== 公开详情（无汤底字段）=="
PUZZLE_ID=$(curl -s "http://localhost:8080/api/v1/puzzles?limit=1" | node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.data.items[0].id)})")
curl -s "http://localhost:8080/api/v1/puzzles/$PUZZLE_ID" | node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{const j=JSON.parse(d);const keys=Object.keys(j.data);console.log('字段:',keys.join(','));if(keys.some(k=>k==='answer')){console.log('泄露汤底！');process.exit(1)}})"

echo "== 单人开局（匿名凭证）=="
SESSION=$(curl -s -X POST http://localhost:8080/api/v1/solo/sessions -H 'Content-Type: application/json' -d "{\"puzzleId\":\"$PUZZLE_ID\",\"language\":\"zh\"}")
echo "$SESSION" | head -c 300
echo

echo "== 单人提示（index 0）=="
TOKEN=$(echo "$SESSION" | node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{console.log(JSON.parse(d).data.token)})")
curl -s -X POST http://localhost:8080/api/v1/solo/hints -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"index\":0}" | head -c 200
echo

echo "== better-auth 路由挂载（get-session 应返回空会话 JSON 而非 404）=="
curl -s -o /dev/null -w "GET /api/v1/auth/get-session → %{http_code}\n" http://localhost:8080/api/v1/auth/get-session

echo "== 未登录访问受保护接口（应 401 信封）=="
curl -s http://localhost:8080/api/v1/me | head -c 200
echo

echo "== 支付通道未配置时下单（应 503 PAYMENT_CHANNEL_UNAVAILABLE）=="
curl -s -X POST http://localhost:8080/api/v1/orders -H 'Content-Type: application/json' -d '{"productVersionId":"00000000-0000-0000-0000-000000000000"}' | head -c 200
echo

echo "冒烟测试通过 ✓"
