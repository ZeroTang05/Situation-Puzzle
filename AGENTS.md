<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Jev 海龟汤 — 项目导览

移动优先的海龟汤（情境猜谜）网页：玩家提问，AI「Jev」回答 是/否/无关，并判断是否还原汤底。前端 Next.js（Turbopack），后端 Cloudflare Worker + D1，AI 判题走 Vercel AI Gateway（模型 `typesafe-ai/jev` 的 evaluation 接口）。

## 目录结构

```
jev-turtle-soup/
├─ app/                    前端（Next.js App Router）
│  ├─ page.tsx             单页游戏主体：开局（题目卡+对话+底部输入）、题库、出题、还原真相临时面板、公布答案二次确认弹窗
│  ├─ admin/page.tsx       审核后台：输入 ADMIN_TOKEN 发布/驳回/删除投稿
│  ├─ api/judge、api/solve  仅本地开发用的判题路由（服务端读密钥，浏览器拿不到）
│  └─ globals.css          全部样式（设计变量在 :root，深色海洋风、小圆角）
├─ data/library.json       初始题库唯一数据源（12 题 × 3 条提示）；worker 启动整体覆盖库内 seed- 行，前端离线兜底同源
├─ worker/                 后端（Cloudflare Worker）
│  ├─ src/index.ts         全部后端逻辑：CORS、文件播种、公开题库、匿名/B站身份、判题/结局、投稿、审核
│  ├─ migrations/0001_initial.sql  唯一表结构迁移（soups/users/user_identities/user_sessions/moderation_logs）
│  ├─ wrangler.jsonc       D1 绑定、ALLOWED_ORIGIN、JEV_CONFIDENCE_THRESHOLD 等配置
│  └─ .dev.vars            本地密钥（AI Gateway、ADMIN_TOKEN），不入库
├─ .env.local              前端密钥与 NEXT_PUBLIC_API_URL，不入库
└─ .env.example、worker/.dev.vars.example  空模板，入库
```

## 本地开发

两个终端并行：`pnpm dev`（前端 3000）+ `pnpm --dir worker dev`（worker 8787，本地 D1 由 wrangler 模拟，无需安装数据库）。`.env.local` 的 `NEXT_PUBLIC_API_URL` 指向 `http://localhost:8787`；留空则是纯前端离线模式（用 `data/library.json` + `app/api` 本地判题）。

- 换题库：编辑 `data/library.json` 保存即重播种（dev 下 wrangler 监听文件自动重载）；种子行按 `creator_token='seed'` 或 `seed-` 前缀识别清理，id 命名风格不限。
- `NEXT_PUBLIC_` 变量在编译期内联进前端代码：改 `.env.local` 后若页面行为没变，重启 `pnpm dev`（Turbopack 偶尔端着旧编译）。

## 关键约定

- **CORS**：`worker/src/index.ts` 的 `corsOrigin()` 放行 `ALLOWED_ORIGIN` 加回环/内网地址（本地各种主机名和端口），其余来源返回 ALLOWED_ORIGIN 让浏览器拒绝。改来源逻辑先看这里。
- **汤底保密**：公开题库接口绝不返回 `answer`；判题在服务端对照数据库完成；玩家点「公布答案」确认后，前端才调 `GET /api/soups/:id/answer` 单独取汤底。离线模式的前端内置题是例外（汤底在 bundle 里）。
- **hints**：三条不同角度提示，DB 以 JSON 文本存储；worker 读出经 `parseHints()` 解析。前端用对话区顶部的悬浮卡单条展示，提示按钮依次解锁，左右箭头在已解锁的提示间切换、给完禁用。
- **判题阈值**：`JEV_CONFIDENCE_THRESHOLD`（0.4），置信度低于它统一返回「无法确定」。
- **还原真相**：点击后用临时面板盖住对话区（汤面和输入框保持可见），复用底部发送框但路由到 solve 接口；还原对话在独立线程 `solveThread`，退出即回到主对话。
- **AI Gateway**：Vercel 账号必须绑信用卡，否则判题 403（`customer_verification_required`）。
- **题库合并**：前端把线上题库按标题去重，同名保留线上版本（汤底不进浏览器）。

## 验证

- 类型：`pnpm --recursive exec tsc --noEmit`
- 后端：`curl http://localhost:8787/health`、`curl http://localhost:8787/api/soups`
- 前端：浏览器实测（问一句、给提示、公布答案、切题）

## Git

首次提交前 `git init`（主分支 main）。`.gitignore` 已就绪：密钥（`.env*.local`、`.dev.vars`）、wrangler 本地状态、构建产物不入库。
