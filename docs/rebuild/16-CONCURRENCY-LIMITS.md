# 16 · 并发与限流盘点

> 状态：已完成一轮全量盘点（2026-10-20），并按结论落地了限流改造。
> 本文记录**现状**（哪些接口有闸门、闸门是全局还是分用户）、
> 盘点中发现并已修复的两个真实缺陷，以及已落地的限流规则与仍然开放的缺口。
> 凡是写「已修复」「已落地」的，都有对应测试兜底；凡是写「仍然开放」的，都还没动手。

## 1. 一句话结论

项目**没有全局 HTTP 限流中间件**。`apps/api/src/bootstrap.ts` 只挂了 CORS 与 256KB body 限制，
没有任何 throttle / rateLimit 全局拦截。现有保护是 5 个各自为政的局部机制，
覆盖不到「会烧钱」和「会占资源」的两类关键口子。

| 机制 | 位置 | 维度 | 跨进程 |
|---|---|---|---|
| 单人 Jev 并发闸门 | `solo.controller.ts:39-55` | **全局**（每进程） | 否（多进程会放大） |
| 验证码发送额度 | `auth/otp-send-quota.ts` | 分邮箱 + 分 IP | 是（PG + 事务级 advisory lock） |
| better-auth 限流 | `auth/auth.instance.ts:175` | 分 IP，**仅** `/api/v1/auth/*` | 否（内存） |
| 多人判题排队 | `commands.service.ts` + jobs | 分人（每人 1）+ 分房（每房 8）+ 全局串行 | 部分（队列在 PG） |
| 讨论发言限速 | `commands.service.ts:272` | 分房间 + 分用户（30 条/分） | 是（查库） |

## 2. 逐项细节

### 2.1 单人 Jev 并发闸门（全局，挡并发不挡速率）

```ts
// apps/api/src/solo/solo.controller.ts:40
class ConcurrencyGate {
  constructor(private readonly limit: number) {}  // SOLO_JEV_CONCURRENCY，默认 2
}
```

- 粒度：**整个进程**共享一个计数器，不区分用户、不区分题目。
- 语义：只挡**同时在飞**的判题数；一个用户可以无限快地问完再问。
- 限制：进程内计数。多副本部署时上限 = `副本数 × 2`。
- 用途是保护下游 Jev 不被打爆，不是防刷。

> 单人模式是产品明确定义的「永久免费、不做业务限流」，本项目**刻意**不按 IP / 题目加业务限流
> （见 `08-SOLO.md`）。并发闸门是容量保护，与业务限流是两回事，不要混为一谈。

### 2.2 验证码发送额度（分邮箱 + 分 IP，跨进程）

- 邮箱：60 秒冷却，**1 次 / 60 秒**。
- IP：最近 60 分钟内最多 3 次，第 4 次要等最早那次满 60 分钟。
- 额度预占与判定在**同一事务**里，用 `pg_advisory_xact_lock` 串行化，跨进程安全。
- 被拒绝的请求**不写计数**，不污染额度。

### 2.3 better-auth 限流（分 IP，仅认证路由）

```ts
// apps/api/src/auth/auth.instance.ts:175
rateLimit: { enabled: true, window: 60, max: 20, customRules: ... }
```

- 60 秒 / 20 次，**只作用于 better-auth 自己的路由**（`/api/v1/auth/*`）。
- 走 OTP 发送的路径被 `customRules` 豁免（因为有自己的额度体系）。
- 内存计数，多进程不共享。

### 2.4 多人判题排队

三层同时生效：

1. **每人 1 个未完成**（`PER_USER_QUEUE_LIMIT`）——`packages/domain/src/rooms.ts:12`。
2. **每房 8 个未完成**（`ROUND_QUEUE_LIMIT`）——同上 `:10`。
3. **全局串行执行**：`apps/jobs/src/main.ts:97` 的 `process-turn` 配 `batchSize: 1`，
   单个 jobs 进程内一次只处理一个判题；`dispatch-room` 保证每个房间同时只有 1 个 processing。

第 1 条曾经**从未生效**（见 §4.2），现在已修。

### 2.5 讨论发言限速

```ts
// apps/api/src/rooms/commands.service.ts:272
if ((recent?.count ?? 0) >= DISCUSSION_PER_MINUTE) throw new DomainError('RATE_LIMITED', ...)
```

按「房间 + 用户」统计最近 60 秒的 `discussion.created` 事件数，30 条/分。
阈值取自 `@jev/domain` 的 `DISCUSSION_PER_MINUTE`（原先在 api 侧另抄了一份 `30`，
已改为直接引用 domain 常量，避免两边漂移）。

## 3. 盘点时没有保护的高危接口

盘点当时的原样，按「被刷了会怎样」排序。**状态**列是 2026-10-20 整改后的结果：

| 接口 | 缺什么 | 后果 | 状态 |
|---|---|---|---|
| `POST /creations/:puzzleId/submit` | 频率 / 每日篇数上限 | **直接烧钱**：每提交一次就投递一次 `review-puzzle`，Jev 机器初审 | ✅ 已加：每人每天 5 篇 |
| `POST /payments/:channel/notify` | 频率上限 | 每次都做一次 RSA2 验签（支付宝）/ 平台公钥解密（微信），CPU 可被打满 | ✅ 已加：每 IP 每分钟 120 次 |
| WebSocket `/ws` | 连接数上限 | `realtime.gateway.ts:30` 的 `clients` 是**无界 Map**，同一用户可开任意条连接 | ✅ 已加：每用户 5 条 |
| `POST /reports` | 频率上限 | 无限写举报表，后台调查面板被淹没 | ✅ 已加：每人每小时 5 条 |
| 后台 12 个接口 | 频率上限 | 有角色校验（admin），但**无频控**；被拿到 token 即可高频操作 | ✅ 已加：每管理员每分钟 120 次 |
| `POST /solo/sessions` / `hints` / `reveal` | 频率上限 | 匿名凭证可无限申请；按产品设定不拦，但缺失上限 = 可被脚本刷 | ⛔ 按产品既定不做 |
| `GET /puzzles`（公开题库） | 频率上限 | 无限读公开数据（数据量有限，风险最低） | ⛔ 暂不处理 |

`POST /orders/redeem`（赞助码）不在此列：码格式是 `JEV-XXXX-XXXX-XXXX`（base-32 共 16 位，
约 1.15×10²⁴ 组合），不可暴力。
`POST /app-session/exchange` 同样安全：需要 60 秒有效期的签名 code。

## 4. 盘点中发现并已修复的两个真实缺陷

### 4.1 支付异步通知被守卫 401（会导致「收了钱不发权益」）

`SessionGuard` 是**全局** `APP_GUARD`（`apps/api/src/app.module.ts:46`），
而 `BillingController` 类上还有一层 `@UseGuards(SessionGuard)`。
`notify` 漏标 `@Public()` → 守卫在进 handler **之前**就返回 401，
微信和支付宝的异步通知**两个通道都会收不到**。用户付了钱，权益永远发不出去。

集成测试直接调 service，**绕过了守卫层**，所以查不出来——这正是它需要元数据层断言的原因。

修复：

- `apps/api/src/billing/billing.controller.ts:100` 补 `@Public()`（带「曾真实发生过，勿删」注释）。
- 新增 `apps/api/src/billing/public-routes.test.ts`：在**元数据层**钉死公开路由清单，
  断言 `notify` 是 `public`、`createOrder` / `redeem` / `channels` 仍是 `session`。

实测：修复前 `status=401`；修复后 `status=200 body=fail`（凭据未配时的正确行为），
同时 `/me` 仍 401（无误放行）、`/puzzles` 200。

### 4.2 「每人未完成判题上限」从未生效

`commands.service.ts:214` 把 `assertCanEnqueue(..., false)` **写死**成 `false`，
查库得到的 `userActive.count` 被丢弃，`PER_USER_QUEUE_LIMIT = 1` 成了死常量。

这条规则在 `12-CONNECTION-EXPERIENCE.md:26` 与 `04-ROOM-JEV.md:60` 都写着，
有 `TURN_PENDING` 错误码、有 i18n 文案、还有 domain 单测——
但单测直接传 `true` 调函数，**绕过了调用点**，所以一直是绿的。

修复（两层）：

- `packages/domain/src/rooms.ts:62` 改为 `userIdActive || usage.userActiveCount >= PER_USER_QUEUE_LIMIT`（domain 兜底）。
- `apps/api/src/rooms/commands.service.ts:214` 改为传 `(userActive?.count ?? 0) > 0`。
- `packages/domain/test/rooms.test.ts` 补一条「即使调用方漏传布尔值也会拦下」。

## 5. 已落地的限流（2026-10-20 实施）

### 5.1 通用组件

| 文件 | 职责 |
|---|---|
| `packages/database/src/schema/rate-limit.ts` | `rate_limit_buckets` 表：`(bucket_key, window_start)` 复合主键 |
| `packages/database/drizzle/0011_rate_limit_buckets.sql` | 建表 + 窗口索引迁移 |
| `apps/api/src/common/rate-limit.ts` | `@RateLimit()` 装饰器、窗口对齐、桶键、重试时间、提示文案（纯函数） |
| `apps/api/src/common/rate-limit.store.ts` | 单条 upsert 完成「读计数 + 写计数」 |
| `apps/api/src/common/rate-limit.interceptor.ts` | 全局拦截器：读元数据 → 算桶键 → 消费额度 → 超限抛 `RATE_LIMITED` |

**为什么用拦截器而不是中间件**：拦截器在守卫之后执行，能拿到 `SessionGuard` 写入的
`request.sessionUser`，于是「按用户」的限额才是真的按用户。中间件阶段还没有会话。

**为什么计数放数据库**：多副本部署时进程内计数会被放大（副本数 × 每副本上限），
进程重启也会把限额清零。落库后多副本共享同一份额度。

**为什么是元数据驱动而不是按路由前缀一刀切**：每个受保护的接口显式声明规则，
没标注的接口零开销（不查库）。前缀匹配容易误伤正常路径。

**窗口对齐**：固定窗口。起点由服务端时钟算出——
- 86400 秒 → **东八区自然日**（不是 UTC 日，差 8 小时会让「每天 5 篇」变成「每 32 小时 5 篇」）
- 3600 秒 → 东八区自然小时
- 其它 → 按窗口长度对齐 epoch（分钟对齐在整点时区偏移下等于自然分钟）

**失败模式**：计数写入失败时**放行**（fail open）。限流是准入控制，不该成为新的故障源；
数据库不可用时业务写入本来也会失败。

### 5.2 生效的规则清单

规则挂在元数据上，由 `apps/api/src/common/rate-limit-policies.test.ts` 钉死。

| 接口 | 维度 | 限额 | 作用域 |
|---|---|---|---|
| `POST /creations/:puzzleId/submit` | 用户 | **每天 5 篇**（东八区自然日） | `creations.submit` |
| 创作中心其余写接口 | 用户 | 每分钟 20 次 | `creations` |
| `POST /reports` | 用户 | 每小时 5 条 | `reports` |
| 后台 `/api/v1/admin/*` | 用户（管理员） | 每分钟 120 次 | `admin` |
| `POST /payments/:channel/notify` | **客户端 IP** | 每分钟 120 次 | `payments.notify` |
| `POST /ads/intent`（广告意图令牌） | 用户 | 每小时 30 次 | `ads.intent` |
| `GET /ads/wechat/notify`（激励视频服务端验证回调） | **客户端 IP** | 每分钟 120 次 | `ads.notify` |
| `POST /invites/claim`（领取邀请奖励） | 用户 | 每小时 10 次 | `invites.claim` |
| `GET /hall`（大厅列表） | 用户 | 每分钟 60 次 | `hall.list` |
| `POST /rooms/:id/join-public`（直接加入公开房） | 用户 | 每分钟 20 次 | `hall.join` |
| WebSocket `/ws` | 用户 | 同时 **5 条**连接（`WS_MAX_CONNECTIONS_PER_USER`） | — |

关于投稿日额度：每次提交都会真的调一次 Jev 机器审核（有真实成本），
这是创作侧唯一直接烧钱的口子。

关于支付通知：平台不会带会话 Cookie，只能按 IP 计数。每次通知都要做一次验签
（支付宝 RSA2 / 微信平台公钥解密），这是通知接口唯一的 CPU 开销，必须挡住刷量。
超限返回 **429**，两个平台都会按失败重试，不会丢通知。

关于奖励额度三件套（21-MONETIZATION-REVISION.md）：广告回调与支付通知同理
（微信服务器 GET、无会话、验签即全部 CPU 开销），按 IP 每分钟 120 次；
意图令牌按用户每小时 30 次——真正的发放上限是**服务端日额度**
（广告/邀请各 10 次/东八区自然日，锁免费账户行计数），HTTP 限流只挡无意义刷量；
邀请领取按用户每小时 10 次，幂等键（一账号终身一次）在数据库层兜底。

关于大厅（18-HALL-PUBLIC-ROOMS）：大厅是全局视图，前端 5 秒轮询一次，
每分钟 60 次的额度相当于「每秒 1 次」，留了一倍余量；直接加入是写操作，
收紧到每分钟 20 次。两条规则都按用户计数——大厅本身要登录。

关于 WebSocket：连接表是无界 `Map`，不设闸门等于把服务端内存交给客户端。
闸门在**认领身份之后**检查（此时才知道这条连接属于谁），超限直接断开（`4429` + `RATE_LIMITED`）。

### 5.3 明确不加限流的地方

- **单人模式**（`/solo/*`）：产品既定「永久免费、不做业务限流」。
  并发闸门只挡并发，不挡速率。
- **房间命令**：排队（每人 1 个未完成 / 每房 8 个）与讨论限速（30 条/分）已在 domain 层管，
  不再叠一层 HTTP 限流。
- **兑换码核销**：`JEV-XXXX-XXXX-XXXX` 是 16 位 base-32（约 1.15×10²⁴ 组合），不可暴力。
- **用户主持人相关接口**（`POST /rooms/:id/commands` 的 `request_host`/`approve_host`/
  `reject_host`/`resign_host`/`host_answer`，以及 `POST /lobbies/:id/host/*`）：
  全部走会话守卫（`SessionGuard`）且只对房间/会客厅成员生效，天然被「每房 8 人」与
  「成员资格」约束住；写操作是幂等命令（同编号重投返回原结果），不构成资源放大面。
  主持人判定只是把一个已在库里的 turn 从 queued 改成 succeeded，不产生外部调用与成本，
  因此不额外加 HTTP 限流——与「房间命令不再叠一层限流」的既有口径保持一致。

### 5.4 清理

过期桶由 jobs 的 maintenance 任务清理（`window_start` 早于两天即删）。
日/小时窗口过期即失效，保留两天足够覆盖。

### 5.5 仍然开放的缺口

- **进程内计数的放大问题仍在**：WebSocket 连接数上限是**每进程**计数，
  多副本部署时实际上限 = 副本数 × 5。要精确得挪到 PG/Redis。
- **公开只读接口不限流**（题库、随机题、健康检查）：数据量有限，风险最低，暂不处理。
- **匿名单人接口不限流**：产品既定。
- **没有全局 HTTP 限流中间件**：本次是「按接口标注」而不是「所有接口一刀切」。
  真要防爬虫级别的洪泛，仍需在反代层做。

## 6. 踩坑点

- **`SessionGuard` 是全局 APP_GUARD**：任何无会话接口都必须标 `@Public()` / `@Anonymous()`。
  这两类装饰器**只跳过会话读取，不做频控**，别以为标了就有保护。
- **多副本部署会放大进程内计数**：单人并发闸门、better-auth 限流、WebSocket 连接数上限
  都是进程内状态。真要精确，得挪到 PG 或 Redis。
- **查库型频控天然跨进程**：`otp_send_reservations`、讨论发言计数、`rate_limit_buckets`
  都是查 PG，语义一致。
- **排队限流查的是「未完成」不是「历史」**：`userActive.count` 统计的是 queued + processing，
  判题完成即释放。
- **限流用拦截器不用中间件**：中间件在守卫之前跑，拿不到会话，「按用户」的限额就落空了。
- **`Reflect.getMetadata` 不会从方法走到类**：方法上没标注时必须自己再查一次类
  （`Reflect.getMetadata(KEY, klass)`），Nest 不会自动回退——`SessionGuard` 也是这么写的。
- **日/小时窗口必须按东八区对齐**：用 UTC 日的话，「每天 5 篇」实际是「每 32 小时 5 篇」，
  差 8 小时。`windowStartOf` 里单独特判了 86400 与 3600。
- **ON CONFLICT 里要给旧行加表名限定**：`set: { count: sql`${rateLimitBuckets.count} + 1` }`
  渲染成 `"rate_limit_buckets"."count" + 1`，PG 才认得出那是冲突行的现值。
- **测试限流要保持连接不断**：测 WebSocket 连接上限时，发完 ack 就关连接等于把名额还回去了，
  上限永远测不到（写测试时真踩过）。
- **计数失败要放行**：限流是准入控制，不能自己变成新的故障源。
