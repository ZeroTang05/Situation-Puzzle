# 新系统实施记录（M1～M2 阶段交付）

版本：1.0；日期：2026-09-26；基线：docs/rebuild 设计文档 v1.0。

本文记录按设计文档完成的第一批可运行代码：monorepo、数据层、判题适配、API 服务、任务进程、玩家端、管理端与部署编排。旧系统（Next.js 单页 + Cloudflare Worker）已按用户决定提前删除（06-MIGRATION.md），旧代码保存在 main 分支。

## 1. 已交付内容与设计对应

| 设计要求 | 落点 | 状态 |
| --- | --- | --- |
| monorepo 目录边界（03-SPEC §3） | `apps/{web,admin,api,jobs}` + `packages/{contracts,domain,database,jev,ui,i18n}` | 完成；web 构建边界由包依赖声明保证（web/admin 不引用 database、jev） |
| 数据模型（03-SPEC §5） | `packages/database/src/schema/*`，36 张表，4 条部分唯一索引不变量 | 完成；迁移 `packages/database/drizzle/0000_*.sql` |
| Jev 适配（04-ROOM-JEV §7） | `packages/jev`：20s 单次超时、45s 总期限、错误分类、缺概率=协议错误、阈值统一 0.5、配置版本号 | 完成；6 项单测覆盖协议分支 |
| 领域规则 | `packages/domain`：状态机、排队容量、上海时区自然月锚点（1/31→2/28→3/31）、授权来源判定 | 完成；18 项单测 |
| 房间协议（04-ROOM-JEV §3-5） | `apps/api/src/rooms/*`：命令幂等、控制版本、事件 seq、快照握手、 Lease 与取消代次 | 完成主体 |
| 判题任务（04-ROOM-JEV §4） | `apps/jobs`：dispatch-room / process-turn / review-puzzle / maintenance（5 秒巡检） | 完成主体 |
| 免费开房账本（05-OPERATIONS §4） | `room_entitlements` + `room_credit_ledger`（(room_id,action) 唯一）：建房预留 → 首次有效判定消费 → 故障整房退回一次 | 完成 |
| 赞助订单（05-OPERATIONS §3/§5） | 订单状态机、微信支付 v3 适配器（签名/验签/AES-GCM）、月度锚点续期算法、重复永久购买登记 | 订单与授权逻辑完成；微信通道需商户凭据后联调（M4） |
| 单人隐私（08-SOLO） | 匿名签名凭证（jose）、无持久化接口、IndexedDB 本地会话、内存限速（IP 不落盘）、credentials omit | 完成 |
| 认证（05-OPERATIONS §2） | Better Auth 1.7：Email OTP + Google OAuth、注册钩子初始化档案/免费账户 | 完成；真实邮件与 Google 回调待 M0 外部验证 |
| 部署（03-SPEC §8） | `infra/`：Caddy + API + jobs + PostgreSQL 的 Docker Compose、Dockerfile、Caddyfile | 完成；本机 compose 全栈实测通过（见 §2.2），目标服务器部署待 M0 |

## 2. 验证证据

- 类型：全部 10 个工作区 `tsc --noEmit` 通过（`pnpm typecheck`）。
- 单测：24 项通过（`pnpm test`），含一次真实缺陷修复（ask 低置信度映射错误，由测试发现）。
- 冒烟（`pnpm smoke`，本地 Docker PostgreSQL）：健康检查、30 题公开列表（响应无 answer 字段）、匿名单人开局与凭证、提示读取、better-auth 路由挂载、未登录 401 信封、jobs 进程启动。
- 前端构建：web 与 admin `vite build` 通过。

### 双用户多人房间端到端联调（2026-09-26 完成）

真实进程 + 真实 PostgreSQL + 真实 SMTP 收信台 + 真实 WebSocket + 真实 Jev（OPENCODE_API_KEY 取自 .env.local）：

- **脚本化 E2E（`scripts/e2e-multiplayer.mjs`）：36/36 断言通过**。覆盖：双用户邮箱验证码登录（真实 SMTP 协议投递验证码）、建房预留免费次数、选题/开局控制版本、客人凭邀请晚加入并补齐事件、双端 WS 同步（同一条判定的同一编号）、**真实 Jev 提问与还原判定**、jev_calls 落库、首次有效判定消费免费次数（账本恰好 reserve+consume 各一条）、同房第二局不重复扣次、未揭晓答案 403 / 揭晓后参与者可读、关闭房间终态。
- **浏览器 UI 联调**：房主在真实浏览器完成验证码登录 → 开房间 → 等待室（成员 2/8、在线状态点、房主徽标）→ 题库选题 → 开局；客人以第二客户端（独立 WS）加入并提问，房主页面实时显示提问与真实判定「是」；房主从浏览器 UI 提问，客人端实时收到并完成判定；提示解锁横幅、公布答案后结算页（汤底 + 提示回顾 + 下一局）均正常呈现。

联调发现并修复的三个真实缺陷（均已回归验证）：

1. web 客户端缺少应用层心跳：presence 45 秒后被巡检清除，成员显示离线 → 补 15 秒 ping。
2. 巡检的房主转让阈值误写为 20 秒（设计为 90 秒），标签页短暂挂起即触发房主来回转让 → 改为 90 秒并复核继任者在线判定。
3. web 客户端缺「重新可见立即补同步」：标签页被浏览器节流暂停后心跳停止、连接被服务端按 45 秒超时关闭，回前台后未即时补齐 → 补 visibilitychange 处理（补 subscribe 或立即重连）。

自动化环境注意（非产品缺陷）：in-app 浏览器标签页失焦时网络被挂起，页面内 fetch 停滞而外部 curl 正常；把标签页置前后立即恢复。

### Docker 一行部署实测（2026-09-26 完成）

`cp .env.example .env && docker compose up -d --build` 起全栈，实测通过：

- 三镜像构建成功；API 容器启动自动执行迁移后再起服务；postgres 健康；jobs 正常轮询。
- edge（Caddy）服务 web（200）、admin（200）；`/api/v1/health/live` 与题库列表经反代返回 JSON；WebSocket 升级经 edge 转发成功（探针实测 25ms 升级、未认证连接 5 秒被服务端关闭）。
- `docker compose --profile seed run --rm seed` 灌入 30 题，公开列表即有数据。
- 只有 edge 发布端口（80/443），postgres/api/jobs 仅内网可达。

实测发现并修复的四个问题：

1. 容器内 tsx 报 decorators 错误：镜像缺少根 `tsconfig.base.json`（apps 的 tsconfig 经 extends 链上溯找不到）→ Dockerfile 补 COPY。
2. jobs 启动 `ERR_MODULE_NOT_FOUND: zod`：代码 import 了 zod 但未在 `apps/jobs/package.json` 声明，pnpm 严格 node_modules 下不可见 → 补声明（本地靠提升侥幸通过）。
3. Caddyfile 中 `handle`（含静态兜底）先于 `reverse_proxy` 执行，API 路径被静态兜底吞掉返回 index.html → 反代改写进 `handle` 块，按 Caddy 路径最长优先匹配。
4. 实时网关未强制「5 秒内 auth 帧」：未认证连接可无限挂起 → `handleConnection` 补 5 秒鉴权时限。

以下为待人工/外部验证项（文档明确不自动视作完成）：真实第三方邮箱投递与 Google OAuth 回调（本地已用真实 SMTP 协议收信台验证登录链路）、真实微信支付（商户凭据）、目标服务器部署。

### 登录通道对齐内部基础设施（2026-09-26 完成）

参考 Open-GoWith 的登录系统实现两件事：

1. **验证码邮件改走 Resend**（`MAIL_TRANSPORT=resend`，官方 SDK、发件 `noreply@xiaobaozi.cn`，
   与内部其他项目共用账号）。实测：真实发信返回 Resend 邮件 ID（`scripts/probe-mail-and-proxy.mjs`）。
   保留 `smtp` 通道供本地联调（dev-mailsink 收信台 + 全量 E2E 读码）。
2. **Google OAuth 服务端请求走出站代理**（`apps/api/src/auth/google-proxy.ts`）：境内服务器
   无法直连 `*.googleapis.com`，配置 `GOOGLE_OAUTH_PROXY_BASE_URL` 后在启动时把 fetch 改写为
   `<代理>/<原域名>/<路径>`（与 ai-proxy 节点转发 Groq/OpenAI 的形状一致）；Better Auth 的
   token 兑换端点无覆盖口子，故采用全局改写（单测 4 项覆盖改写形状与非 Google 放行）。
   授权跳转仍由用户浏览器直连 accounts.google.com（与 Open-GoWith 相同）。

**遗留阻塞（外部依赖）**：Google 登录的 token 兑换是 POST，实测 ai-proxy 节点（Deno Deploy
通用反代）当前对 `*.googleapis.com` 上游的 POST 一律崩溃（500），专用 `/oauth/google/*`
路径上游 fetch 失败（502），GET 正常——节点需修复后 Google 登录方可端到端可用；
`GOOGLE_CLIENT_ID/SECRET` 也尚未申请。节点修复与本项目的改写逻辑无关（形状已对齐）。

## 3. 本地运行

```bash
# 1. 数据库（任选一种）
docker run -d --name jev-pg -e POSTGRES_USER=jev -e POSTGRES_PASSWORD=jev -e POSTGRES_DB=jev -p 5432:5432 postgres:17

# 2. 配置环境：复制 .env.example 为 .env.local，填 DATABASE_URL 与密钥
#    （邮件通道见模板：生产 resend + RESEND_API_KEY；本地联调 smtp 投递给 dev-mailsink）

# 3. 迁移 + 题库导入（--publish 仅限本地开发；正式库必须走权利审核）
pnpm db:migrate
pnpm db:seed

# 4. 三个进程并行
pnpm dev:api    # http://localhost:8080
pnpm dev:jobs   # 任务进程
pnpm dev:web    # http://localhost:5173（Vite 代理 /api/v1 与 /ws）

# 5. 管理端（可选）
pnpm dev:admin  # http://localhost:5174/admin
```

管理员角色首次授予：直接向 `role_assignments` 插入一行（user_id, role）——后台界面只能由已有管理员操作，首个管理员用 SQL 初始化。

服务器部署用 Docker 一行命令（详见根 README）：

```bash
cp .env.example .env   # 填好域名、数据库口令与密钥
docker compose up -d --build
```

## 4. 已知边界与下一步

- **M0 外部通道**（阻塞真实登录/判题/支付）：SMTP 发信、Google 凭据、OPENCODE_API_KEY、微信商户。代码就绪，凭据就绪后即可联调。
- **多人房间人工体验**：按 02-MVP A01～A12 场景在双浏览器验证后合并代码。
- **D1 旧数据导入工具**：需要旧库导出文件后实现（06-MIGRATION §3），当前完成 JSON 题库导入。
- **单人隐私核查**（A24～A26）：上线前按 08-SOLO §7 做数据库与日志对照检查。
- 队列任务在 API 进程内通过 pg-boss 事务适配创建；多副本部署前需把实时票据的 jti 去重改为共享存储（代码内已注明）。
