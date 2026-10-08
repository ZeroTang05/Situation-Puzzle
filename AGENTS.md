# AI海龟汤 — 项目导览

移动优先的多人海龟汤（情境猜谜）网页：玩家提问，AI「Jev」回答 是/否/无关/无法确定。
房间新规则见 `docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md`（v3）：会客厅（lobby）与房间（room）生命周期彻底解耦。每个用户固定一个会客厅 id（`user_lobbies.host_user_id UNIQUE` 物理保证 1:1，永久不变），房主可以同时拥有任意多个 active 房间；同一用户也可以同时是别的 lobby 的成员；踢人 = DELETE 座位行不留 kicked 软标记；邀请 URL 路径区分 `/lobby/invite/<hex>` 与 `/room/invite/<hex>`，后端两条独立 endpoint 无 fallback；先选题后开局，start 单事务建房+迁成员+建局+撤销旧邀请；start 事务提交后通过实时网关向所有 lobby 订阅者推送 `lobby.started` 帧（携带 roomId+inviteToken），客户端收到后立即 navigate 到房间，避免客人因轮询延迟被误报"等待室已解散"；一房一题（局结束即归档）；单人无业务限流。
单人模式无需登录、永久免费、对话只存浏览器；多人房间 1–8 人、服务端保存并实时同步；
未赞助账号累计可开 10 个房间，月度赞助 6 元 / 永久 20 元不限开房（微信商户开通前收费入口关闭）。
本文档面向开发与维护；用户视角的宣传页在 `README.md`。

## 目录结构

```
apps/web        玩家端（React 19 + Vite）：首页、题库、单人、会客厅、房间、邀请、创作、我的、登录、找回密码
apps/admin      管理端（React-admin）：题库审核、用户、房间调查、举报、订单
apps/api        NestJS 服务：认证 auth、题库 catalog、单人 solo、房间与会客厅 rooms、实时网关 realtime、赞助订单 billing、创作 creations、治理 governance、后台 admin
apps/jobs       pg-boss 任务进程：dispatch-room / process-turn / review-puzzle / maintenance
packages/contracts   跨端 Zod 契约：HTTP 请求响应、WS 事件、稳定错误码（客户端只准引用这里）
packages/domain      纯业务规则：房间状态机、排队容量、赞助自然月算法、授权来源判定（配单测）
packages/database    Drizzle 表结构（40 张表）、追加式迁移（drizzle/）、房间事务封装（rooms-tx）、题库导入
packages/jev         Jev SystemOne 适配：20s 超时、错误分类、缺概率=协议错误、阈值 0.5、配置版本号
packages/i18n        稳定枚举/错误码 → 中英文案
packages/ui          设计变量（深海色系、16px 正文、44px 触控）
infra/               web/admin/api/jobs 各自 Dockerfile（apps/web+apps/admin 静态烘进 nginx，api 容器启动自动跑迁移）、web.nginx.conf / admin.nginx.conf
scripts/             冒烟与端到端联调脚本（smoke-new-system.sh、e2e-run.sh、dev-env.sh、dev-mailsink.mjs）
data/                题库 JSON 导入源（library.json / library.en.json 各 100 题同 ID 配套，顺序须一致；zh 条目 category 本格/变格由导入映射为 puzzle_category 枚举 honkaku/henkaku）
docs/rebuild/        产品与架构设计文档（01~12：10 房间生命周期修订、11 赞踩署名、12 连接体验）
```

## 常用命令

```
pnpm typecheck          # 全部工作区 tsc --noEmit
pnpm test               # domain + jev + web + api 全量单测，不含数据库集成和端到端测试
pnpm dev:api            # API :8080（需 .env.local，缺配置直接启动失败）
pnpm dev:jobs           # 任务进程
pnpm dev:web            # 玩家端 :5173（Vite 代理 /api/v1 与 /ws）
pnpm dev:admin          # 管理端 :5174
pnpm db:migrate         # 追加式迁移（可重复执行）
pnpm db:seed            # 导入 data/library.json 全部题目（当前 100 题），平台自有内容入库即发布（--purge-stale 硬删消失题，生产禁用）
pnpm smoke              # 冒烟：一次性 PostgreSQL + API + jobs + 接口断言
pnpm e2e:multiplayer    # 双用户多人 E2E：36 项断言（真实 SMTP 登录 + 真实 Jev）
pnpm e2e:votes          # 赞踩与署名 E2E（真实 SMTP + 真实 Jev）
```

部署（服务器上）：`cp .env.example .env && docker compose up -d --build`；
API 容器启动自动跑迁移；演示题库 `docker compose --profile seed run --rm seed`。

## 关键约定

- **包边界**：`apps/web`、`apps/admin` 只准依赖 `@jev/contracts`、`@jev/i18n`、`@jev/ui`；
  禁止引用 `@jev/database`、`@jev/jev`（构建与 code review 双重把关）
- **汤底保密**：公开接口、快照、事件 payload 都不含汤底与未解锁提示；答案只在
  `GET /rounds/:id/answer`（揭晓后 + 有阅读权）与单人主动揭晓返回
- **房间一致性**：写操作统一 HTTP 命令（`POST /rooms/:id/commands`），命令幂等
  (`clientRequestId` 唯一) + 控制版本乐观并发；事件按 `seq` 广播，客户端去重补齐；
  四条不变量靠数据库唯一索引兜底（见 `packages/database/src/schema/rooms.ts`）
- **计费不变量**：免费开房 `(room_id, action)` 唯一流水；首次有效判定或公布答案即消费；
  一房一题，换题新建房间并重新授权；CHECK 约束禁止负余额；赞助检查与扣减同事务同锁
- **单人隐私**：`/solo/*` 匿名凭证（jose）、不落任何业务表；新规则不按 IP 或题目做业务限流；
  客户端 `credentials: 'omit'`
- **判题**：阈值只能服务端读；`uncertain` 是有效判定；缺概率是协议错误不编造；
  每局固定 `jevConfigVersion`
- **认证**：Better Auth（邮箱/密码 + Email OTP + Google + LINUX DO）；`trustedOrigins` 来自 `PUBLIC_BASE_URL`，
  改来源先看 `apps/api/src/auth/auth.instance.ts`
- **邮件通道**：`MAIL_TRANSPORT` 显式二选一（`apps/api/src/auth/mailer.ts`）——
  `resend` 生产通道（官方 SDK，与内部其他项目共用 Resend 账号，发件地址由 `MAIL_FROM` 配置，生产用 `noreply@xiaobaozi.cn`）；
  `smtp` 本地联调通道（投递给 dev-mailsink）。通道与配置的对应关系在 `env.ts` 跨字段校验
- **OAuth 出站中继**：境内服务器配 `GOOGLE_OAUTH_PROXY_BASE_URL` +
  `GOOGLE_OAUTH_PROXY_SHARED_SECRET` 后，Google 与 LINUX DO 的服务端请求（token 兑换 POST、
  userinfo GET）在启动时改写到内部 oauth-relay（Deno Deploy，仓库
  `E:\tzy\github\oauth-relay`）的专用路径并带 `X-Relay-Token`（`google-proxy.ts`，
  单测覆盖改写形状）；授权跳转仍由用户浏览器直连 accounts.google.com / connect.linux.do
- **锁序**：房间 → 局 → 赞助账户 → 免费账户 → 任务（跨 api/jobs 统一）

## 踩坑点

- **tsx(esbuild) 不生成构造参数元数据**：Nest 依赖注入必须显式 `@Inject(Token)`，
  否则运行时 `this.service` 为 undefined
- **Nest WsAdapter 在 tsx 下挂载不稳**：实时网关直接用 `ws` 库挂 upgrade（`realtime.gateway.ts`）
- **pg-boss 事务投递**：`sendInTx(tx, ...)` 从 drizzle 事务提取底层 pg client
  （`bootstrap.ts` 的 `poolClientOf`，运行时校验）
- **compose 插值只读根 `.env`**：部署环境文件就叫 `.env`（模板 `.env.example`），
  `env_file` 与变量插值共用它
- **better-auth Origin 校验**：浏览器 Origin 必须在 `trustedOrigins`（= `PUBLIC_BASE_URL`），
  本地前端跑 5173 就把 `PUBLIC_BASE_URL` 设为 `http://localhost:5173`
- **zod v4 改名**：`z.number().nonnegative()`（不是 nonneg）；`z.record` 两参
- **exactOptionalPropertyTypes 开启**：可选属性赋 `undefined` 要用条件展开
- **Windows CRLF**：shell 脚本入库加 `.gitattributes`；容器内执行前 `sed -i 's/\r$//'`（Dockerfile 已处理）
- **开发期邮箱**：本地联调用 `scripts/dev-mailsink.mjs`（真实 SMTP 协议收信台）+
  `MAIL_TRANSPORT=smtp`，不要把控制台打印验证码当已接入邮箱
- **两个出站节点别混用**：`ai-proxy.xiaobaozi.cn` 是 Groq/OpenAI 通用反代
  （`<代理>/<上游域名>/<路径>` 形状，对 `*.googleapis.com` 的 POST 会崩 500）；
  OAuth 走的是独立部署的 `oauth-relay.xiaobaozi.cn`（专用路径
  `/oauth/google/token|userinfo` + `X-Relay-Token`，无 JWKS 路由）。
  本地到 Deno 节点的链路偶发抖动，探针脚本已带重试

## 验证

- 类型：`pnpm typecheck`；单测：`pnpm test`
- 冒烟：`pnpm smoke`（Docker 一次性库 + 接口断言）
- 双人 E2E：`pnpm e2e:multiplayer`（真实 SMTP 登录 + 真实 Jev + 账本断言）
- 浏览器实测：登录、建房、邀请、提问、提示、公布答案、切题、解散
