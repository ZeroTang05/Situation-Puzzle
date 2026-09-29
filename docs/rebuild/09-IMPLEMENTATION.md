# 新系统实施记录（M1～M2 阶段交付）

> 本文记录 2026-09-26 的旧实现及当时验证结果。房间规则已由 [10-ROOM-LIFECYCLE-REVISION.md](10-ROOM-LIFECYCLE-REVISION.md) 修订：一房一题、换题新房、离线不归档、单人不限流。本文关于同房第二局及相关测试的“完成”状态不代表新规则已实现。

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
| 认证（05-OPERATIONS §2） | Better Auth 1.7：邮箱/密码 + Email OTP + Google OAuth、注册钩子初始化档案/免费账户 | 完成；真实邮件与 Google 回调待 M0 外部验证 |
| 部署（03-SPEC §8） | `infra/`：Web/Admin/API/Jobs/PostgreSQL 各容器独立构建，宿主 Nginx 终结 TLS | 完成；本机 compose 全栈实测通过（见 §2.2），目标服务器部署待 M0 |

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
- web/admin 容器各自 200；`/api/v1/health/live` 与题库列表经前端容器内置 nginx 反代返回 JSON；WebSocket 升级经前端容器反代转发成功（探针实测 25ms 升级、未认证连接 5 秒被服务端关闭）。
- `docker compose --profile seed run --rm seed` 灌入 30 题，公开列表即有数据。
- 只有 edge 发布端口（80/443），postgres/api/jobs 仅内网可达。

实测发现并修复的四个问题：

1. 容器内 tsx 报 decorators 错误：镜像缺少根 `tsconfig.base.json`（apps 的 tsconfig 经 extends 链上溯找不到）→ Dockerfile 补 COPY。
2. jobs 启动 `ERR_MODULE_NOT_FOUND: zod`：代码 import 了 zod 但未在 `apps/jobs/package.json` 声明，pnpm 严格 node_modules 下不可见 → 补声明（本地靠提升侥幸通过）。
3. 前端容器内 nginx `location` 优先级：静态资源 / `try_files` 兜底若先于 `proxy_pass /api/v1/*` 命中，会把 API 路径当 SPA 返回 index.html；将 `proxy_pass` 单独写到 `location ^~ /api/v1/` 与 `location ^~ /ws` 块，按最长前缀匹配即可。
4. 实时网关未强制「5 秒内 auth 帧」：未认证连接可无限挂起 → `handleConnection` 补 5 秒鉴权时限。

以下为待人工/外部验证项（文档明确不自动视作完成）：真实第三方邮箱投递与 Google OAuth 回调（本地已用真实 SMTP 协议收信台验证登录链路）、真实微信支付（商户凭据）、目标服务器部署。

### 登录通道对齐内部基础设施（2026-09-26 完成）

参考 Open-GoWith 的登录系统实现两件事：

1. **验证码邮件改走 Resend**（`MAIL_TRANSPORT=resend`，官方 SDK、发件 `noreply@xiaobaozi.cn`，
   与内部其他项目共用账号）。实测：真实发信返回 Resend 邮件 ID（`scripts/probe-mail-and-proxy.mjs`）。
   保留 `smtp` 通道供本地联调（dev-mailsink 收信台 + 全量 E2E 读码）。
2. **Google OAuth 服务端请求走出站中继**（`apps/api/src/auth/google-proxy.ts`）：境内服务器
   无法直连 `*.googleapis.com`，配置 `GOOGLE_OAUTH_PROXY_BASE_URL` +
   `GOOGLE_OAUTH_PROXY_SHARED_SECRET` 后在启动时把 token 兑换与 userinfo 改写到独立部署的
   oauth-relay（Deno Deploy，仓库 `E:\tzy\github\oauth-relay`）的专用路径
   （`/oauth/google/token|userinfo`），并携带 `X-Relay-Token: <RELAY_SHARED_SECRET>`
   （Better Auth 的 google provider 端点硬编码，故采用全局改写；单测 4 项覆盖改写形状）。
   实测：中继 healthz 200；假凭据 token 兑换收到 Google 的 400 响应、假 Bearer userinfo
   收到 Google 的 401 invalid_request——两段链路真实到达 Google
   （`scripts/probe-mail-and-proxy.mjs`）。授权跳转仍由用户浏览器直连 accounts.google.com
   （与 Open-GoWith 相同）。部署环境文件 `.env` 已配好中继地址与密钥。

**待外部凭据**：Google 登录端到端可用只差 `GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET`
（Google Cloud OAuth 客户端，回调地址填 `<PUBLIC_BASE_URL>/api/v1/auth/callback/google`）。

### 房间生命周期修订落地（2026-09-27 完成）

按 [10-ROOM-LIFECYCLE-REVISION.md](10-ROOM-LIFECYCLE-REVISION.md) 完成 R01～R09、R11（R10 收费闭环后置；R12 创作中心的后续实现见 §4）：

- **R11 旧数据统计**：`scripts/stats-multi-round-rooms.mjs` 在迁移前统计多局房间；实测 0（尚无生产数据），`rounds(room_id)` 唯一索引（迁移 0001）安全应用。
- **R01 一房一题**：房间状态机改为 waiting→playing→closed 单向（局结束即归档）；`select_puzzle` 拒绝已玩过题的房间；破解/公布/放弃都经共享 `archiveRoomTx` 归档（close_reason 新增 `round_ended`），旧房只读。
- **R02 一键迁移**：新表 `room_followups`（source 唯一，重复请求返回同一目标房）；`POST /rooms/followup` 在同一事务内建房、授权、迁移合格成员（被踢/退出不迁移、已在他房明确显示未迁入）并直接开局；旧房事件流推送 `room.followup_created` 新房入口；首页「开房间」入口兼容被迁入成员。
- **R03 独立计费**：建房授权逻辑抽为 `createRoomTx` 供普通建房与续玩共用；每个新 roomId 独立预留与消费；无资格时新房创建失败、旧房不受影响。
- **R04/R05**：删除全员离线关闭、等待室闲置关闭、房主离线自动转让、连续模型故障关房；presence 清理与队列兜底巡检保留。
- **R06**：踢人命令提交后立即断开被移除者的实时订阅（网关 `dropUserFromRoom`）；每 5 秒巡检复核订阅成员资格；被踢者写接口、补齐接口、快照全部 403。
- **R07**：新成员可从订阅握手补齐加入前全部公开事件并取得当前局快照；汤底与未解锁提示仍受权限控制。
- **R08**：移除单人按题目版本的 30 次/分钟限流；保留每进程 Jev 并发闸门（JEV_BUSY）。
- **R09**：契约新增 followup 请求/响应与 `room.followup_created` 事件；E2E 重写为 63 项断言。当时 emailOTP 发码限流调整为 10 次/分钟；当前已由下文“验证码发送额度”的持久化规则替代。

验证：`pnpm typecheck` 全绿；单测 25 项通过；`pnpm smoke` 通过（冒烟脚本补上自含一次性 PostgreSQL，不再依赖手工预启动的库）；`pnpm e2e:multiplayer` **63/63 断言通过**（4 用户、真实 SMTP + 真实 Jev ×3 调用：双人判题、还原、新房首判）；web/admin 构建通过。

### 题目投票与作者署名（2026-09-27 完成）

按 [11-VOTES-AND-AUTHORSHIP.md](11-VOTES-AND-AUTHORSHIP.md) 完成 U01～U06：

- **U01/U02**：`ratings` 表重做为赞踩投票（`vote_value` up/down、记录投票时版本、取消即删行），删除游玩资格依赖与 `review`/`roundId` 列（迁移 0002）；`GET/PUT/DELETE /ratings/:puzzleId` 明确设置或取消，唯一约束保证同值重试不累加；作者自投（含匿名作者按内部归属）403；本人选择接口 `Cache-Control: no-store`。
- **U03**：题库列表/详情聚合 upCount/downCount；`sort=latest|popular`，popular 得分 = 赞 − 踩，依次按得分、赞数、首次发布时间降序、作品 ID 升序；latest 修正为发布时间降序（原先按无时序的 UUID 排序）；两种排序均为混合方向 keyset 游标（排序字段 + 作品 ID），客户端按作品 ID 去重。
- **U04**：作品级署名（anonymous/signature + 已批准展示名 + 待审名三字段）；新稿默认匿名，署名/改名进待审、随发布批准或后台单独审核生效；改回匿名立即生效；公开投影只含 `authorDisplay {mode, name}`，匿名与署名响应都不含内部作者归属；管理端列表显示归属与署名并提供批准/拒绝动作（审计留痕）。
- **U05**：题库列表显示署名与计数并提供排序切换；单人页（题目详情 + 结算）与多人结算页有赞踩按钮——未登录点击跳登录并回原题，乐观更新失败回滚；创作中心的反馈展示随 R12 接入（见 §4）。
- **U06**：E2E 共享工具库抽出（`scripts/e2e-lib.mjs`），新增 `pnpm e2e:votes`（25 项断言：两账号赞→重复→切换→取消、未登录 401、自投 403、署名审核全流程、popular/latest 排序与游标翻页、服务端无单人业务表）。

验证：`pnpm typecheck` 全绿；`pnpm e2e:votes` **25/25**；`pnpm e2e:multiplayer` **64/64** 回归通过；`pnpm smoke` 通过；web/admin 构建通过。

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

## 4. 近期代码更新

### 多语言审核与房间命令契约（2026-09-29）

- 管理端列表按最新版号展示各语言记录，记录编号使用语言版本编号；详情调用版本接口，展示同版各语言内容。
- 审核支持当前语言批准与“批准同版全部语言”。服务端检查授权和各语言审核状态，在同一事务中发布并逐语言审计；补发同版语言保留现有发布指针。
- 公开题库按当前发布版号和请求语言读取已发布内容；中文与英文都有发布入口。规则及接口见 [技术规格 §5.1](03-SPEC.md#51-身份与内容) 和 [内容运营 §7](05-OPERATIONS.md#7-ugc-与题库运营)。
- 房间无参数命令允许省略参数对象，玩家端发送入口补齐空对象；共享契约复用按命令类型的字段校验。
- 本次未运行测试、未部署。生产已有的待审核英文版本仍需由审核人员批准。

### R12 用户创作与发布（2026-09-29）

- 玩家端已接入 `/creations` 作品列表、`/creations/new` 新稿、`/creations/:id` 编辑与反馈、`/creations/:id/preview` 私人试题。首页和“我的”提供入口，中英文界面均可用。
- 草稿可分次保存，投稿要求完整材料和明确授权同意；版本条件避免旧页面覆盖。提交后内容固定，撤回、退回修改及已发布修改通过复制新稿完成。
- 私人试题接入真实单人接口，问答和置信度仅保存在浏览器；作品内容变化使旧试题凭证失效。
- 任务进程执行内容审核与标准用例判定；撤回后的迟到结果不会更新审核状态。后台展示作者材料，单独审核授权，再批准内容并公开发布，审核理由返回作者页面。
- 已补充投稿契约和内容摘要单元测试，以及真实创作、权限隔离、撤回、授权门槛与发布流程的浏览器端到端测试。端到端发布验收需配置已有审核员角色的 `E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD`，并启动真实 API、任务进程和 Jev。
- 本轮对涉及的玩家端、管理端、API 和任务进程进行了类型检查，新增测试文件也完成类型检查。投稿契约和内容摘要的 7 项单元测试已随全量单元测试通过；端到端测试未运行，未部署、未提交；人工体验验收待完成。

### 验证码发送额度（2026-09-29）

- 邮箱 60 秒一次、IP 滚动一小时三次，登录与注册共享 PostgreSQL 预占记录；追加迁移 `0003_otp_send_quota.sql`。明确未投递时退回，接受或未知时保留，被限制的请求不生成验证码。
- 登录页发送按钮按返回秒数倒计时，刷新及切换登录/注册后保留等待；验证码输入和验证操作继续可用。注册共用 `sign-in` 验证码用途，通过检查接口验证后再创建账号。
- 代理来源按 `TRUSTED_PROXY_CIDRS` 校验；Compose 和容器 nginx 已配置转发，宿主入口必须写入真实客户端地址。
- 已补充额度与邮件结果单元测试、真实 TCP 代理单元测试、真实 PostgreSQL 并发测试及浏览器端到端测试。PostgreSQL 测试需 `OTP_TEST_DATABASE_URL`，在独立测试 schema（数据表命名空间）中运行并清理；浏览器测试需独立服务和 `E2E_MAILSINK_PATH`（真实收信台文件路径）。
- 相关类型检查通过；新增的 12 项定向单元测试及后续全量单元测试均通过。本机 PostgreSQL 连接超时，数据库并发测试未运行；端到端测试未运行，未部署、未提交，新增数据库迁移尚未执行。

### 全量单元测试（2026-09-29）

统一命令 `pnpm test` 覆盖 domain（业务规则）、jev（模型适配）、web（玩家端）和 api（服务端），显式排除 `*.integration.test.ts`（数据库集成测试）。玩家端仅收集 `test/` 下的单元测试，不运行 `e2e/` 下的 Playwright 浏览器测试。

| 模块 | 通过文件数 | 通过测试数 |
| --- | --- | --- |
| domain | 2 | 19 |
| jev | 1 | 6 |
| web | 6 | 45 |
| api | 5 | 19 |
| 合计 | 14 | 89 |

本次命令退出码为 0，全部单元测试通过，无失败或跳过的单元测试。数据库集成测试、端到端测试和 Playwright 测试均未运行。

## 5. 已知边界与下一步

- **M0 外部通道**（阻塞真实登录/判题/支付）：SMTP 发信、Google 凭据、OPENCODE_API_KEY、微信商户。代码就绪，凭据就绪后即可联调。
- **多人房间人工体验**：按 02-MVP A01～A12 场景在双浏览器验证后合并代码。
- **D1 旧数据导入工具**：需要旧库导出文件后实现（06-MIGRATION §3），当前完成 JSON 题库导入。
- **单人隐私核查**（A24～A26）：上线前按 08-SOLO §7 做数据库与日志对照检查。
- 队列任务在 API 进程内通过 pg-boss 事务适配创建；多副本部署前需把实时票据的 jti 去重改为共享存储（代码内已注明）。
