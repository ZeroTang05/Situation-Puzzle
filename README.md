# Jev 海龟汤

AI 主持的海龟汤（情境猜谜）游戏。玩家围绕一道悬疑故事提问，AI 主持人「Jev」只回答
**是 / 否 / 无关 / 无法确定**，全员共享推理过程，最终共同还原真相。

- **单人模式**：无需登录、永久免费、不限次数；对话与进度只保存在你自己的浏览器里
- **多人房间**：创建最多 8 人的私密房间，邀请朋友一起推理；服务端保存并实时同步每一局
- **赞助制**：未赞助账号累计可开 10 个多人房间；月度赞助 6 元 / 永久赞助 20 元，有效期内不限开房；加入朋友的房间永远免费

> 支付说明：微信支付商户开通前，产品的收费入口保持关闭，代码与订单体系已就绪。

## 快速开始（本地开发）

前置：Node.js 22+、pnpm 10、Docker（本地数据库）、一个真实 SMTP 邮箱服务（登录验证码用）。

```bash
pnpm install
cp .env.example .env.local        # 填写数据库与密钥（见文件内注释）
docker run -d --name jev-pg -e POSTGRES_USER=jev -e POSTGRES_PASSWORD=jev \
  -e POSTGRES_DB=jev -p 5432:5432 postgres:17

pnpm db:migrate                   # 建表（追加式迁移，可重复执行）
pnpm db:seed                      # 导入 30 道经典题（--publish 仅限本地开发）

pnpm dev:api & pnpm dev:jobs & pnpm dev:web   # 三个进程并行
```

打开 http://localhost:5173 。管理端在 http://localhost:5174/admin （首个管理员需向
`role_assignments` 表插入一行 user_id + role）。

## 服务器部署（一行命令）

前置：一台服务器、Docker 与 Docker Compose、一个解析到服务器的域名。

```bash
cp .env.example .env   # 填写域名、数据库密码、SMTP、Jev 密钥等
docker compose up -d --build
```

这一条命令会构建并启动全部四个服务：Caddy 入口（自动 HTTPS）+ 玩家端/管理端静态站 +
API + 任务进程 + PostgreSQL，并且 API 容器启动时自动执行数据库迁移。首次体验可再执行
`docker compose --profile seed run --rm seed` 导入演示题库（正式环境须走内容权利审核）。

升级版本：`git pull && docker compose up -d --build`。

## 部署形态

```
浏览器 ──> Caddy（自动 HTTPS）
            ├─ /            玩家端静态文件（apps/web 构建）
            ├─ /admin       管理端静态文件（apps/admin 构建）
            ├─ /api/v1/*    NestJS API
            └─ /ws          标准 WebSocket（房间实时同步）
                              │
                    PostgreSQL（业务数据 + pg-boss 任务队列）
                              │
              Jev 判题（OpenCode Zen）／ SMTP 邮件 ／ 微信支付（商户开通后）
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 玩家端 | React 19 + Vite + React Router + TanStack Query；单人记录存 IndexedDB（idb） |
| 管理端 | React-admin |
| API | NestJS 11（HTTP + 标准 WebSocket）、Better Auth（邮箱验证码 + Google 登录） |
| 数据 | PostgreSQL 17 + Drizzle ORM；pg-boss 持久任务队列 |
| 判题 | OpenCode Zen SystemOne（模型 `jev-1.13`），置信度阈值 0.5 |
| 部署 | Docker Compose + Caddy |

## 项目结构

```
apps/web        玩家端（单人、题库、多人房间、创作、赞助）
apps/admin      管理端（内容审核、用户、房间、订单、举报）
apps/api        后端服务（认证、题库、单人、房间、实时、赞助、治理、后台接口）
apps/jobs       任务进程（判题执行、房间调度、投稿机审、巡检）
packages/*      共享包：契约(Zod)、领域规则、数据库表结构、Jev 适配、文案、样式
infra           Dockerfile 与 Caddy 配置
data            题库 JSON（导入源）
docs/rebuild    产品与架构设计文档
```

## 开源

- 许可：[GPL-3.0](LICENSE)
- 贡献：见 [CONTRIBUTING.md](CONTRIBUTING.md)；行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 题库内容与代码许可分开：`data/library-sources.md` 记录题目来源，商业授权逐题审核
- 设计与架构文档：[docs/rebuild/](docs/rebuild/README.md)
