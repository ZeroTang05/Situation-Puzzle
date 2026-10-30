# AI 海龟汤 — 项目导览

移动优先的多人海龟汤（情境猜谜）网页：玩家提问，AI「Jev」回答 是/否/无关/无法确定。
房间新规则见 `docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md`（v3）：会客厅（lobby）与房间（room）生命周期彻底解耦。每个用户固定一个会客厅 id（`user_lobbies.host_user_id UNIQUE` 物理保证 1:1，永久不变），房主可以同时拥有任意多个 active 房间；同一用户也可以同时是别的 lobby 的成员；踢人 = DELETE 座位行不留 kicked 软标记；邀请 URL 路径区分 `/lobby/invite/<hex>` 与 `/room/invite/<hex>`，后端两条独立 endpoint 无 fallback；先选题后开局，start 单事务建房+迁成员+建局+撤销旧邀请；start 事务提交后通过实时网关向新房当前成员中会话有效的 lobby 订阅者推送 `lobby.started` 帧（携带 roomId+inviteToken），客户端收到后立即 navigate 到房间，避免客人因轮询延迟被误报"等待室已解散"；一房一题（局结束即归档）；单人无业务限流。
单人模式无需登录、永久免费、对话只存浏览器；多人房间（容量由 `ROOM_CAPACITY` 环境变量配置，默认 8）、服务端保存并实时同步；
未赞助账号累计可开 10 个房间，月度赞助 6 元 / 永久 20 元不限开房。
**收款通道有三条**：微信支付 v3 Native（扫码，需商户资质，未配置凭据时前台显示「支付通道开通中」）、
**支付宝开放平台**（当面付扫码 / 电脑网站支付跳转，凭据清单见 `docs/rebuild/15-PAYMENT-CHANNELS.md`）
与**赞助码**（零实名通道：运营方用个人收款码收款后发码，用户在「我的」页兑换，站内自动核销并发授权；见 `docs/rebuild/14-REDEEM-CODE-CHANNEL.md`）。
**免费额度的补量与内测期**（`docs/rebuild/21-MONETIZATION-REVISION.md`）：看激励视频广告 +2 次（小程序端，流量主开通前显示「开通中」）、邀请好友注册 +5 次（邀请人得，全端）；`BETA_OPEN_ROOM=true` 时内测畅玩（开房记 `beta` 来源，不占免费次数）。打赏购买只在 web 端，App 壳隐藏入口，小程序与 App 靠广告/邀请补量；兑换码全端保留。
本文档面向开发与维护；用户视角的宣传页在 `README.md`。

**用户主持人模式**（`docs/rebuild/17-USER-HOST-MODE.md`）：除 AI「Jev」外，玩家也能自己当主持人。房间与会客厅各持一份主持人状态：`rooms.host_mode`（ai/user）+ `rooms.user_host_id`（谁在主持）+ `room_members.role`（成员身份镜像）/ `host_requested_at`（待审申请），会客厅同理。成员在会客厅或房间右上角玩家列表申请，房主审核（房主自申请直接通过）；房主也可**撤销**他人已有的主持身份（降级为玩家，房间回到 Jev 主持）。用户主持模式下，玩家的**提问与还原都挂起等主持人判定**（不进 AI 队列、`deadline_at` 置空不参与排队超时）：主持人在「问 Jev」页给「是/否/无关」，在「查看汤底」页（主持视角下「还原真相」页签改名）给「破解成功/接近真相/还没猜对」，判定为破解成功即终局归档；退出或被撤销即回到 Jev 主持。汤底只走 `GET /rounds/:id/host-view` 单独下发（仅本房间用户主持人可读），不进快照与事件。

**大厅与公开房间**（`docs/rebuild/18-HALL-PUBLIC-ROOMS.md`）：房主可把房间设为**公开**，公开房间出现在大厅（`GET /hall`），其他人可直接加入（`POST /rooms/:id/join-public`，不需要邀请 token）。房间与会客厅各持一份开关：`rooms.is_public` / `user_lobbies.is_public`（默认 false＝全部是私人房间）。等待室的开关是「**下一局**」的偏好（与 `capacity` 同性质，start 事务复制进新房后不清空）；房间内的开关走**房间命令通道** `set_visibility`（host-only + 幂等 + 控制版本乐观并发 + 广播 `room.visibility_changed`）。切回私人只影响大厅可见性，已在房内的人不受影响、邀请链接照旧有效；房间归档（closed）必须从大厅消失。

**加好友 + 私聊 + 快捷开局 + 通知**（`docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md`）：按邮箱**精确**搜索（不做前缀模糊搜索，避免枚举站内邮箱）→ 发好友申请 → 对方同意才成为好友（申请-同意制）。申请按 `user_low`/`user_high` 规范化，A→B 与 B→A 互斥，数据库部分唯一索引 `friend_requests_pending_pair_uq` 兜底。好友之间有私聊会话（同意申请时同事务建），消息按**会话内序号** `dm_messages.seq` 排序，已读水位 `conversation_reads.last_read_seq` **只前进不后退**（不用时间戳：同毫秒发消息会丢）。私聊里可「来一局」发起一局（`POST /conversations/:id/start-room`）：**对方不被自动拉进房间**，卡片上的「进入房间」是邀请链接（`/room/invite/<token>`，令牌明文随卡片落在 `dm_messages.invite_token`），对方点了才进房；卡片按钮按房间当前状态变化（归档后变「房间已结束」）。**没有会话列表页**：`/chat` 不存在，好友列表是唯一入口，点好友名整行直达 `/chat/:conversationId`（站内没有「消息」按钮，全站不再提供该入口）。私聊消息 / 好友申请 / 开局邀请 / 站内信统一进通知中心（`notifications`），铃铛角标 10 秒轮询、聊天页 3 秒轮询——**本轮不走 WebSocket**，实时网关留作后续扩展点。通知标题**不落库**：读取时按 `X-Jev-Language` 即时拼装（站内信用公告原文）。

**项目备份（后台）**：管理员在后台「项目备份」页把整个数据库做逻辑快照、存进 **S3 兼容对象存储**，并可从任一备份还原。实现走**纯 Node**（`apps/api/src/backup/`），不依赖 `pg_dump` 等外部二进制：导出时每列在 SQL 侧 `::text` 文本化（bytea/jsonb/数组/numeric/enum 都靠「文本 → 目标类型」cast 无损往返，NULL 原样保留），还原在**单个事务**里完成（`TRUNCATE … RESTART IDENTITY CASCADE` → 按外键拓扑序写回 → 重置序列），任一步失败整体回滚。归档表与字段类型必须与目标库元数据严格匹配，SQL 类型只取目标库，否则抛 `BACKUP_INVALID_ARCHIVE`。对象存储未配置（缺 `S3_BUCKET`）时整体降级为「未接入」，后台只显示提示、不做任何写操作。还原是不可逆操作：请求体必须带固定确认口令 `RESTORE` + 操作理由，写操作全部留审计（`audit_logs`，objectType=`backup`）；**还原的审计写在提交之后**——还原会 TRUNCATE `audit_logs` 自己。

## 目录结构

```
apps/web        玩家端（React 19 + Vite）：首页、题库、单人、会客厅、房间、邀请、创作、我的、设置、登录、找回密码、好友、私聊、通知中心
apps/admin      管理端（React-admin）：题库审核、用户、房间调查、举报、订单、赞助码（发码/对账/作废）、项目备份（备份/还原/下载）、站内信群发、总览；所有列表表头可点排序（后端列名白名单，见 admin-sort-columns.ts）
apps/api        NestJS 服务：认证 auth、题库 catalog、单人 solo、房间与会客厅 rooms、实时网关 realtime、赞助订单 billing、创作 creations、治理 governance、后台 admin、备份 backup、社交 social（好友/私聊/通知/站内信）
apps/jobs       pg-boss 任务进程：dispatch-room / process-turn / review-puzzle / maintenance
apps/app        Android 壳工程（Capacitor 8，包名 cn.xiaobaozi.sp，App 名「AI 海龟汤」（2026-10-24 更名，原「Jev 海龟汤」））：apps/web 构建产物打进 WebView；插件 @capacitor/app browser clipboard keyboard（OAuth 回流系统浏览器、深链事件、剪贴板邀请过渡、键盘避让）；OAuth 回流端点 `/api/v1/app-session/handoff|exchange`（60 秒随机单次 code + 本机 verifier 校验后换 Bearer 令牌）；M3 交付：签名密钥 `keystores/sp-upload.jks`（gitignored，`keystore.properties` 存在时 gradle 才启用 release 签名，备份要求见 keystores/README.md）、品牌图标与启动屏（scripts/app-icons.mjs + core-splashscreen）、App Links（manifest autoVerify + `apps/web/public/.well-known/assetlinks.json` 域名认领 + 壳内 https 邀请直达）、官网 `/app` 下载页与 `/privacy` 隐私政策；计划与认证适配方案见 docs/rebuild/13-APP-VERSION.md
apps/miniprogram 微信小程序端（Taro 4.3 + React 18，只编译 weapp，docs/rebuild/20-MINIPROGRAM.md）：功能一比一复刻、界面层按小程序运行时重写；**登录只走微信一键登录**（wx.login code → `POST /auth/wechat-mini/login` code2session 建号/建会话，令牌在响应体；邮箱登录/找回密码已移除，`WECHAT_MINI_APPID/SECRET` 配齐才注册端点，微信账号与 web 邮箱账号相互独立）；复用 @jev/contracts + @jev/i18n 与 App 版 Bearer 令牌链路（api/client.ts + Taro storage），设计变量与基础控件类从 @jev/ui theme.css 平移进 src/app.css；designWidth 375 使 px 值与 web 一致；主体=个体工商户+商户号，AI 类目按深度合成申报（以 MiniMax 名义）；提审内容风险与预案见 20 号文档 §1/§7
packages/contracts   跨端 Zod 契约：HTTP 请求响应、WS 事件、稳定错误码（客户端只准引用这里）
packages/domain      纯业务规则：房间状态机、排队容量、赞助自然月算法、授权来源判定、好友申请与私聊权限（配单测）
packages/database    Drizzle 表结构（49 张表）、追加式迁移（drizzle/）、房间事务封装（rooms-tx）、题库导入
packages/jev         Jev SystemOne 适配：20s 超时、错误分类、缺概率=协议错误、阈值 0.5、配置版本号；MiniMax 大模型补判（置信度不足自动补判，还原可手动切换，提示词版本 v4-2026-10）；判题输入带最近几轮问答（`JEV_RECENT_QA_LIMIT` 环境变量，默认 6；多人查 turns 表、单人客户端回传最多 10 条由服务端裁剪），评测脚本 scripts/eval-context.ts
packages/i18n        稳定枚举/错误码 → 中英文案
packages/ui          设计变量（深海色系、16px 正文、44px 触控）
infra/               web/admin/api/jobs 各自 Dockerfile（apps/web+apps/admin 静态烘进 nginx，api 容器启动自动跑迁移）、web.nginx.conf / admin.nginx.conf
dl/                  App 安装包服务器分发目录（web 容器只读挂载、nginx /dl/ 直链；APK 不入库，放包步骤见 dl/README.md）
scripts/             冒烟与端到端联调脚本（smoke-new-system.sh、e2e-run.sh、e2e-node-run.mjs 跨平台编排器、e2e-multiplayer/e2e-host-mode/e2e-votes 剧本、dev-env.sh、dev-mailsink.mjs）
data/                题库 JSON 导入源：根 library.json / library.en.json 同 ID 配套（顺序须一致，当前 446 题 = 天堂精选 93 置顶 + 首发 7 + 扩展 10 + 小小耶精选 240 + 许二木精选 96，许二木批 2026-10-15 入库追加于库尾；zh 条目 category 本格/变格由导入映射为 puzzle_category 枚举 honkaku/henkaku；第一题固定「终点线」，各批次保持批内原序；seed 导入统一署名「初始题库」（signature 模式，前端按语言本地化））；sources.md 全库来源总览与逐题对照（编号=现役库位置 1–446）；scoring/ 打分口径与全部批次评分（编号 1–493 连续续写，与 sources.md 编号相互独立）；curated/ 各 UP 主批逐篇评审与存档（天堂/小小耶/许二木三批普通题均已并入根库，特殊玩法与未采用稿留存于各自目录）；reference/ 真实游玩素材（group 原始字幕 → real 抽取稿，按 UP 主分目录）
docs/rebuild/        产品与架构设计文档（01~21：10 房间生命周期修订、11 赞踩署名、12 连接体验、13 App 版本计划、14 赞助码通道、15 支付通道凭据清单、16 并发与限流盘点、17 用户主持人模式、18 大厅与公开房间、19 加好友/私聊/通知、20 小程序版本计划、21 变现方式修订）
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
pnpm db:seed            # 导入 data/library.json 全部题目（当前 446 题），平台自有内容入库即发布（--purge-stale 硬删消失题，生产禁用）
pnpm smoke              # 冒烟：一次性 PostgreSQL + API + jobs + 接口断言
pnpm e2e:multiplayer    # 双用户多人 E2E：60 项断言（真实 SMTP 登录 + 真实 Jev）
pnpm e2e:votes          # 赞踩与署名 E2E：25 项断言（真实 SMTP，不调 Jev）
pnpm e2e:host           # 用户主持人 E2E：40 项断言（真实 SMTP + 真实 Jev）
pnpm e2e:local <剧本>    # 跨平台编排（不依赖 bash/docker）：multiplayer | host | votes | playwright
pnpm build:app          # 网页产物打进 Android 壳（--mode app：接口指向生产域名）；出 APK 在 apps/app/android 跑 gradlew assembleDebug 或用 Android Studio 打开
pnpm dev:mp             # 小程序开发构建（watch）；微信开发者工具导入 apps/miniprogram 目录预览
pnpm build:mp           # 小程序生产构建（weapp）
```

部署（服务器上）：`cp .env.example .env && docker compose up -d --build`；
API 容器启动自动跑迁移；演示题库 `docker compose --profile seed run --rm seed`。

## 关键约定

- **包边界**：`apps/web`、`apps/admin` 只准依赖 `@jev/contracts`、`@jev/i18n`、`@jev/ui`；
  `apps/miniprogram` 只准依赖 `@jev/contracts`、`@jev/i18n`（`@jev/ui` 是 Radix/DOM 实现，小程序跑不了）；
  全部 app 禁止引用 `@jev/database`、`@jev/jev`（构建与 code review 双重把关）
- **汤底保密**：公开接口、快照、事件 payload 都不含汤底与未解锁提示；答案只在
  `GET /rounds/:id/answer`（揭晓后 + 有阅读权）与单人主动揭晓返回
- **房间一致性**：写操作统一 HTTP 命令（`POST /rooms/:id/commands`），命令幂等
  (`clientRequestId` 唯一) + 控制版本乐观并发；事件按 `seq` 广播，客户端去重补齐；
  四条不变量靠数据库唯一索引兜底（见 `packages/database/src/schema/rooms.ts`）
- **大厅可见性**：`rooms.is_public` 是房间是否进大厅的唯一权威；「谁能进、什么房间上大厅」
  的判定在 `packages/domain/src/public-rooms.ts`（纯函数，服务端与前端共用口径）；
  房间内的公开开关走房间命令 `set_visibility`（不能另开 HTTP 端点），会客厅没有命令通道
  才单独用 `POST /lobbies/:id/visibility`
- **社交不变量**：① 同一对用户同时最多一条待审好友申请（部分唯一索引，双向互斥）；
  ② 好友关系是双向两行，删好友要删两行；③ 两个用户之间最多一个会话（规范化一对唯一）；
  ④ 同一会话内消息序号唯一；⑤ 通知未读走 `(user_id, read_at IS NULL)` 部分索引。
  判定口径在 `packages/domain/src/social.ts`（纯函数），表结构在
  `packages/database/src/schema/social.ts`。邮箱只做精确匹配（不做前缀模糊搜索）
- **社交送达走轮询**：私聊 3 秒、铃铛 10 秒。实时网关只服务房间事件流，本轮不动它；
  消息表已有 `seq`，后续接网关时可直接复用房间事件流的补齐逻辑
- **计费不变量**：免费开房 `(room_id, action)` 唯一流水；首次有效判定或公布答案即消费；
  一房一题，换题新建房间并重新授权；CHECK 约束禁止负余额；赞助检查与扣减同事务同锁
- **奖励额度**（21 号修订）：广告/邀请/作品奖励直接加 `freeRoomAccounts.total`（复用免费池
  CHECK 与消费逻辑，没有第二个额度池），流水落 `room_bonus_ledger` 且幂等键唯一
  （广告 `ad:<trans_id>` 防微信重放、邀请 `invite-claim:<claimant>` 一账号终身一次、
  作品 `creation-bonus:<puzzleId>` 一道作品终身一次）；
  广告/邀请发放入账事务锁免费账户行（锁序最后一层）先数日上限再插入，东八区自然日各 10 次；
  作品奖励（+10）**不设日上限**，挂在 admin approve 事务内与发布同生共死，只发
  community 投稿、AI 初审自动发布的不发（人工复核是发放的门）；
  广告回调 `GET /ads/wechat/notify` 验签 `SHA256(secret:trans_id)`，业务性拒绝（日上限/
  重复通知）回 `errcode:0` 不入账让微信停止重试，验签失败才回非 0 让其重试；
  内测期 `BETA_OPEN_ROOM=true` 开房记 `beta` 来源（不占免费次数、不看赞助）
- **赞助码通道**：`redeem_codes` 一码一权（`code_key` 唯一）；核销时对码行 `FOR UPDATE`，
  码状态流转与授权发放/订单核销/流水/审计**同事务**提交（`orders.service.ts:confirmPaidTx`
  为此把核销主体拆成可传入事务的版本）；码格式规则在 `packages/domain/src/redeem-codes.ts`，
  API、后台与离线 CLI 三处共用；运营发码用 `apps/api/src/cli/issue-redeem-codes.ts`
- **在线收款通道**：微信 v3 与支付宝各一个适配器，共用 `billing/pay-adapter.ts` 的接口；
  通道差异（通知格式、验签、应答体、金额单位）**只允许在适配器内抹平**，业务层只认
  `PayChannel`。三铁律：① 权益只由服务端**验签通过**的异步通知发放，浏览器回跳不发权；
  ② 通知里的金额必须与订单金额一致，不一致拒绝入账；③ 支付宝同步应答**必须验签**
  （`qr_code` 决定用户付给谁）；站内金额一律用**分**，支付宝的「元」在适配器里换算。
  通道凭据未配齐 → 适配器返回 null → 该通道不显示入口
- **单人隐私**：`/solo/*` 匿名凭证（jose）、不落任何业务表；新规则不按 IP 或题目做业务限流；
  客户端 `credentials: 'omit'`
- **判题**：阈值只能服务端读；`uncertain` 是有效判定；缺概率是协议错误不编造；
  每局固定 `jevConfigVersion`；置信度不足自动用 MiniMax 大模型补判，多人还原可
  手动指定大模型（`turns.use_large_model` 随提交落库，任务按提交时选择执行）
- **语言**：没有全局语言环境变量，也不落库。判题语言按题目/本局/投稿自身的语言走
  （`JevClient.ask/solve/review(input, language)`，同一部署可同时判中英文题）；
  用户界面语言只存本地（`localStorage['jev.language']`），前端每个请求带
  `X-Jev-Language` 头显式上报，服务端按请求分流（事务邮件发中文还是英文）；
  头缺失时回落中文。**界面语言切换只有两个入口**：登录/注册页（`/login`，含注册模式）
  与设置页（`/settings`）；首页、找回密码页等都不再放切换按钮
- **设置页**（`/settings`）：昵称修改、语言修改、兑换码、隐私政策入口、退出登录都收在这里，
  「我的」页（`/me`）只留账号卡、赞助面板与多人历史，并提供设置页入口；
  昵称写入走 `PATCH /me/nickname`
- **认证错误也要 i18n**：better-auth 直接回英文原文（如 `Invalid email or password`），
  前端一律用 `displayAuthError(code, language, fallback)`（`packages/i18n`）按 code 翻译，
  **不透传** better-auth 的 message
- **认证**：Better Auth（邮箱/密码 + Email OTP + Google + LINUX DO）；`trustedOrigins` 来自 `PUBLIC_BASE_URL` +
  `APP_EXTRA_ORIGINS`（App 壳 WebView 来源 `https://localhost`），改来源先看 `apps/api/src/auth/auth.instance.ts`；
  整站 CORS 在 `bootstrap.ts` 挂 express 层（better-auth 路由先于 Nest 注册，enableCors 盖不到它）；
  App 壳令牌登录走 better-auth `bearer()` 插件（`Authorization: Bearer` ↔ 会话 Cookie 换算，`set-auth-token` 头下发），
  web 侧适配层在 `apps/web/src/app-runtime.ts`
- **邮件通道**：`MAIL_TRANSPORT` 显式二选一（`apps/api/src/auth/mailer.ts`）——
  `resend` 生产通道（官方 SDK，与内部其他项目共用 Resend 账号，发件地址由 `MAIL_FROM` 配置，生产用 `noreply@xiaobaozi.cn`）；
  `smtp` 本地联调通道（投递给 dev-mailsink）。通道与配置的对应关系在 `env.ts` 跨字段校验
- **OAuth 出站中继**：境内服务器配 `GOOGLE_OAUTH_PROXY_BASE_URL` +
  `GOOGLE_OAUTH_PROXY_SHARED_SECRET` 后，Google 与 LINUX DO 的服务端请求（token 兑换 POST、
  userinfo GET）在启动时改写到内部 oauth-relay（Deno Deploy，仓库
  `E:\tzy\github\oauth-relay`）的专用路径并带 `X-Relay-Token`（`google-proxy.ts`，
  单测覆盖改写形状）；授权跳转仍由用户浏览器直连 accounts.google.com / connect.linux.do
- **锁序**：房间 → 局 → 赞助账户 → 免费账户 → 任务（跨 api/jobs 统一）
- **SessionGuard 是全局 APP_GUARD**（`app.module.ts:46`）：任何无会话接口都必须标
  `@Public()`（只跳过会话读取）/ `@Anonymous()`（匿名凭证）；这两个装饰器**不做频控**。
  支付异步通知曾因漏标 `@Public()` 被守卫 401 掉——两个通道的钱都收了，权益却发不出去，
  且集成测试直调 service 绕过了守卫层查不出来。公开路由清单钉在
  `apps/api/src/billing/public-routes.test.ts`，新增无会话接口必须同步改
  （清单见 `docs/rebuild/16-CONCURRENCY-LIMITS.md`）
- **没有全局 HTTP 限流中间件**：`bootstrap.ts` 只有 CORS + 256KB body。限流用**拦截器 +
  `@RateLimit()` 元数据**按接口标注（`apps/api/src/common/rate-limit.ts`），
  计数落 PG 表 `rate_limit_buckets`（跨进程共享）。已生效：投稿每天 5 篇、
  创作每分钟 20 次、举报每小时 5 条、后台每分钟 120 次、支付通知每 IP 每分钟 120 次、
  WebSocket 每用户 5 条连接。清单见 `docs/rebuild/16-CONCURRENCY-LIMITS.md`
- **备份不变量**：① 只备份 `public` schema 的普通表（分区子表按父表、生成列不入档）；
  ② 备份 / 还原同一时刻只允许一个任务在跑（`BACKUP_IN_PROGRESS`）；
  ③ 还原必须带确认口令 `RESTORE` + 理由，key 只能落在 `S3_BACKUP_PREFIX` 前缀内；
  ④ 还原是全局独占写操作，期间的其它写事务会等待或锁超时（锁序约定对它不适用）；
  ⑤ 归档表与列类型必须匹配目标库元数据；还原 SQL 只使用目标库类型，禁止插入归档类型串

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
- **bigint 聚合经 pg 驱动返回字符串**：`sql`max(${col})``（col 是 bigint）拿到的是字符串，
  `'1' + 1` 会变成 `'11'`。要么聚合上 `::int`，要么显式 `Number()` 转换
  （`dm_messages.seq` 分配序号踩过这个坑）
- **exactOptionalPropertyTypes 开启**：可选属性赋 `undefined` 要用条件展开
- **Windows CRLF**：shell 脚本入库加 `.gitattributes`；容器内执行前 `sed -i 's/\r$//'`（Dockerfile 已处理）
- **开发期邮箱**：本地联调用 `scripts/dev-mailsink.mjs`（真实 SMTP 协议收信台）+
  `MAIL_TRANSPORT=smtp`，不要把控制台打印验证码当已接入邮箱
- **两个出站节点别混用**：`ai-proxy.xiaobaozi.cn` 是通用反代
  （`<代理>/<上游域名>/<路径>` 形状，对 `*.googleapis.com` 的 POST 会崩 500）；
  Jev 判题默认也走它（`JEV_BASE_URL` 默认
  `ai-proxy.xiaobaozi.cn/opencode.ai/zen/v1/systemone`，可用环境变量指回官方源）；
  OAuth 走的是独立部署的 `oauth-relay.xiaobaozi.cn`（专用路径
  `/oauth/google/token|userinfo` + `X-Relay-Token`，无 JWKS 路由）。
  本地到 Deno 节点的链路偶发抖动，探针脚本已带重试
- **Android 构建被墙两处**：命令行 Gradle 直连 dl.google.com TLS 握手被重置——阿里云镜像
  已注入 apps/app/android/build.gradle（root buildscript 与 allprojects.buildscript 两层，
  node_modules 里 :capacitor-android 的仓库写死 google()，靠后者在子工程脚本求值前把镜像排在前面）；
  platform / build-tools 无 maven 通道，版本对齐本机已装（compileSdk 37 / buildTools 36.0.0）；
  本机新旧两个 adb 抢 5037 端口会致模拟器 unauthorized，统一用 SDK 的 platform-tools/adb.exe
- **Capacitor 桥的 addListener 同步返回句柄**：`window.Capacitor.Plugins.<插件>.addListener(...)`
  在 Android 返回普通对象 `{ remove }`，只有 `@capacitor/*` 包的 web 代理才返回 Promise；
  兼容写法见 `apps/web/src/app-runtime.ts` 的 `bindNativeListener`（Promise.resolve 归一化）
- **WebView 的 env() 安全区可能虚高**：模拟器 WebView 145 实测 `env(safe-area-inset-top)` 报
  80px（真实状态栏 24px）；App 壳安全区一律 `var(--safe-area-inset-*, env(...))`，
  Capacitor SystemBars（insetsHandling 'css'）注入的变量按真实 insets 计算

## 验证

- 类型：`pnpm typecheck`；单测：`pnpm test`
- 冒烟：`pnpm smoke`（Docker 一次性库 + 接口断言）
- 双人 E2E：`pnpm e2e:multiplayer`（真实 SMTP 登录 + 真实 Jev + 账本断言）
- 用户主持人 E2E：`pnpm e2e:host`（`scripts/e2e-node-run.mjs` 自建临时库 + 收信台 + API + jobs，40 项断言）
- 跨平台编排：`pnpm e2e:local <multiplayer|host|votes|playwright>`（不依赖 bash/docker，只要有一个可连的 PostgreSQL）
- 真实库集成测试：设 `HOST_MODE_TEST_DATABASE_URL` 后跑 `apps/api/src/rooms/host-mode.integration.test.ts`；
  社交域设 `SOCIAL_TEST_DATABASE_URL` 后跑 `apps/api/src/social/social.integration.test.ts`（16 项断言）；
  备份域设 `BACKUP_TEST_DATABASE_URL` 后跑 `apps/api/src/backup/backup.integration.test.ts`
  （5 项断言；自建临时库、结束整库删除）
- 浏览器套件：`pnpm --filter @jev/web test:e2e`（真实 Chromium；房间相关用例已迁到会客厅流程）
- 浏览器实测：登录、建房、邀请、提问、提示、公布答案、切题、解散；用户主持模式另测申请/审批/主持判定/汤底可见性/退出；
  设置页另测昵称保存、语言切换、退出登录；后台另测备份/还原/下载（需先配好 `S3_*` 环境变量）
