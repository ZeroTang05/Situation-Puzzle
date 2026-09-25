<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Jev 海龟汤 — 项目导览

移动优先的海龟汤（情境猜谜）网页：玩家提问，AI「Jev」回答 是/否/无关，并判断是否还原汤底。前端 Next.js（Turbopack）部署在 Vercel（https://puzzle.xiaobaozi.cn），后端 Cloudflare Worker + D1（https://situation-puzzle-api.xiaobaozi.cn），AI 判题走 OpenCode Zen 的 SystemOne 接口（模型 `jev-1.13-free`）。本文档面向开发与维护，用户视角的宣传页在 `README.md`。

## 目录结构

```
jev-turtle-soup/
├─ app/                    前端（Next.js App Router）
│  ├─ page.tsx             单页游戏主体：开局（题目卡+对话+底部输入）、题库、出题、还原真相临时面板、提示卡、公布答案二次确认
│  ├─ admin/page.tsx       审核后台页面；admin/api/* 为同源转发接口（服务端持管理密钥，浏览器拿不到）
│  ├─ api/judge、api/solve  仅本地开发用的判题路由（读 .env.local 密钥）
│  ├─ layout.tsx、icon.svg
│  └─ globals.css          全部样式（设计变量在 :root，深色海洋风、小圆角）
├─ lib/                    前端共享模块
│  ├─ jev.ts               Jev 判题核心：模型请求、失败重试（最多额外 2 次）、选项与置信度校验；审核/提问/还原共用
│  ├─ i18n.ts              中英双语文案
│  ├─ browser-progress.ts  网页访客的本地答题进度（localStorage）
│  ├─ admin-auth.ts        admin 请求鉴权
│  └─ api-url.ts           worker 地址解析
├─ data/                   题库数据（唯一数据源）
│  ├─ library.json         中文题库（约 30 题 × 3 条提示）
│  ├─ library.en.json      英文题库（与中文共用题目 ID）
│  └─ library-sources.md   题源与改写说明
├─ worker/                 后端（Cloudflare Worker + D1），部署细节见 worker/README.md
│  ├─ src/index.ts         全部后端逻辑：CORS、公开题库、判题/结局、投稿审核
│  ├─ migrations/0001_initial.sql  唯一表结构迁移（soups/moderation_logs/stats），末尾含内置题种子块（pnpm sync:seed 生成）
│  ├─ wrangler.jsonc       D1 绑定、ALLOWED_ORIGIN、JEV_CONFIDENCE_THRESHOLD 等配置
│  └─ .dev.vars            本地密钥（OPENCODE_API_KEY、ADMIN_TOKEN 等），不入库
├─ scripts/build-toy.mjs   B站 Toy 静态包构建：裁剪副本构建（无 admin/api/proxy、题库无汤底），校验后打 ZIP 到 toy-dist/
├─ proxy.ts                /admin 路由入口的 HTTP Basic 验证（用户名 admin，密码为 ADMIN_TOKEN）
├─ docs/                   截图与外宣素材
├─ .github/                Issue / PR 模板
├─ .env.local              前端密钥与 NEXT_PUBLIC_API_URL，不入库；.env.example 为空模板
└─ README.md、CONTRIBUTING.md、CODE_OF_CONDUCT.md、LICENSE(GPL-3.0)
```

## 常用命令

```
pnpm build:toy situation-puzzle            # 构建 B站 Toy 静态包，ZIP 输出到 toy-dist/
pnpm --dir worker dev                      # 本地起 worker（8787，本地模拟 D1）
pnpm --dir worker exec wrangler deploy     # 部署后端到 Cloudflare
```

## 本地开发

两个终端并行：`pnpm dev`（前端 3000）+ `pnpm --dir worker dev`（worker 8787，本地 D1 由 wrangler 模拟，无需安装数据库）。`.env.local` 的 `NEXT_PUBLIC_API_URL` 指向 `http://localhost:8787`；留空则是纯前端离线模式（用 `data/library.json` + `app/api` 本地判题）。

- 换题库：编辑 `data/library.json` 后运行 `pnpm sync:seed` 重新生成 0001_initial.sql 末尾的种子块，然后重建数据库（本地删 `worker/.wrangler/state` 后 `db:migrate:local`）。内置题只在迁移时种入，worker 运行期对种子行零写入。
- 发布 B站 Toy：`pnpm build:toy <slug>`（slug 与 Toy 上传页的自定义路径一致；`--preview` 起本地 4173 子路径预览）。脚本在 `.toy-workspace/` 组装裁剪副本后构建，源码树零改动；产物 `out/`、ZIP 在 `toy-dist/`。前端配置了 `NEXT_PUBLIC_API_URL` 时判题一律走 worker（含内置种子题），汤底不进浏览器。

## 部署

- 后端：`pnpm --dir worker exec wrangler deploy`（密钥用 `wrangler secret put` 设置；远端库迁移 `pnpm --dir worker run db:migrate:remote`）。首次部署清单见 worker/README.md。
- 前端：Vercel，环境变量 `NEXT_PUBLIC_API_URL=https://situation-puzzle-api.xiaobaozi.cn`。改环境变量后需要 Redeploy 才生效（编译期内联）。
- 线上 D1 与本地模拟 D1 完全独立，迁移分别执行。
- **省额度**：D1 按「扫描行数」计费。内置题在迁移时一次性种入，worker 运行期对种子行零写入（已删除旧的冷启动重复播种逻辑）；汤数量读 stats 计数表不扫 soups 表。

## 关键约定

- **CORS**：`worker/src/index.ts` 的 `corsOrigin()` 放行 `ALLOWED_ORIGIN` 列表（wrangler.jsonc 里逗号分隔的字符串；Worker 环境变量只认纯文本，不能写数组）加回环/内网地址（本地各种主机名和端口），其余来源返回列表第一个让浏览器拒绝。改来源逻辑先看这里。
- **汤底保密**：公开题库接口绝不返回 `answer`；判题在服务端对照数据库完成；玩家点「公布答案」确认后，前端才调 `GET /api/soups/:id/answer` 单独取汤底。离线模式的前端内置题是例外（汤底在 bundle 里）。
- **hints**：三条不同角度提示，DB 以 JSON 文本存储；worker 读出经 `parseHints()` 解析。前端用固定在对话区与操作行之间的提示卡单条展示，提示按钮依次解锁，左右箭头在已解锁的提示间切换、给完禁用。
- **判题模块**：`lib/jev.ts` 集中模型请求、重试与结果校验；投稿审核、提问判断、还原真相三处共用，Worker 与本地网页接口判断规则一致。
- **投稿审核**：玩家投稿先经 Jev「通过 / 不通过」二元审核（检查色情和政治内容），通过即 `published` 进公开题库，失败保存 `rejected` 并提示原因，可重试；管理员后台仍可复核、下架、删除，操作记录进 `moderation_logs`。
- **判题阈值**：`JEV_CONFIDENCE_THRESHOLD`（wrangler.jsonc 配置，当前 0.5），置信度低于它统一返回「无法确定」。
- **还原真相**：点击后用临时面板盖住对话区（汤面和输入框保持可见），复用底部发送框但路由到 solve 接口；还原对话在独立线程 `solveThread`，退出即回到主对话。
- **身份与进度**：不做用户体系，服务端不存任何个人身份数据。所有访客（网页 / B站 Toy / 小程序 WebView）答题进度一律存浏览器 localStorage（`lib/browser-progress.ts`），换设备或清缓存后不同步；投稿匿名，创建者凭响应下发的 `creator_token` 编辑自己的题目。
- **双语**：`?lang=zh|en` 贯穿题库列表、详情、判题、汤底、进度接口；内置题中英共用 ID（`data/library.en.json`），玩家投稿按提交语言保存，不自动翻译。
- **分享**：链接用 `?soup=题目ID`，前端调 `GET /api/soups/:id` 读公开汤面（不带汤底）。
- **统计计数**：汤数量走 `GET /api/stats`——读 stats 计数表（每语言 1 行，随迁移建表）加内置题常量，不扫 soups 表。计数在投稿通过（+1，与题目 INSERT 同 batch 原子）和后台状态跨越 published 边界（±1）时增量维护。
- **admin**：访问 `/admin` 先过 `proxy.ts` 的浏览器原生账号密码验证（admin / ADMIN_TOKEN），审核请求由 `app/admin/api/*` 在 Next.js 服务端转发给 Worker，浏览器页面拿不到管理密钥。
- **题库合并**：前端把线上题库按标题去重，同名保留线上版本（汤底不进浏览器）。

## 踩坑点

- **Worker 环境变量只认字符串**：wrangler.jsonc 里写数组会被序列化成拼接文本（2026-09-24 上线首日 `ALLOWED_ORIGIN` 写数组导致 CORS 报 "contains multiple values"）。多值一律用逗号分隔字符串，`corsOrigin()` 已按列表解析。
- **NEXT_PUBLIC_ 变量编译期内联**：改 `.env.local` 后页面行为没变，重启 `pnpm dev`（Turbopack 偶尔端着旧编译）；Vercel 上同理要 Redeploy。
- **换 database_id 后本地库变空库**：本地模拟 D1 按 database_id 存放，wrangler.jsonc 换成真实 ID 后本地是全新空库，要重跑 `pnpm --dir worker run db:migrate:local`。
- **判题走 OpenCode Zen**：`lib/jev.ts` 请求 `https://opencode.ai/zen/v1/systemone`，密钥为 `OPENCODE_API_KEY`（opencode.ai 获取）。判题批量失败先 curl 该接口确认，别急着查代码。
- **React StrictMode 开发期 effect 双触发**：所有合并/追加逻辑必须幂等（题库合并曾因此翻倍）。
- **迁移文件**：表结构统一在 `0001_initial.sql`，不追加补丁式迁移；改表直接改这份并按需重建本地库。

## 验证

- 类型：`pnpm --recursive exec tsc --noEmit`
- 后端：`curl http://localhost:8787/health`、`curl http://localhost:8787/api/soups`
- 前端：浏览器实测（问一句、给提示、公布答案、切题、还原真相）
