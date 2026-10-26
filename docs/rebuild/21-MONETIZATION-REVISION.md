# 21 — 变现方式修订：广告与邀请奖励、作品奖励、内测畅玩、通道收敛

状态：已拍板并落地（2026-10-24）。决策人是运营方本人，本文档是决策记录 + 实现口径。
基线：feat/app-version（含 App 壳 M2、微信小程序 M2）。

## 0. 一句话结论

web 端保留「打赏支持」（在线支付 + 兑换码）；小程序与 App 壳**关闭付费入口**，
免费额度之外用**看激励视频广告（+2 次）**、**邀请好友（+5 次）**和**投稿作品通过
人工复核发布（+10 次）**补量；上线前设**内测期**（环境变量一开关，所有人开房
不占次数）作为拉新手段；兑换码全端保留，作为运营手控的免费福利通道。

## 1. 决策记录（2026-10-24，运营方原话归纳）

1. **广告按次数制**：看完一条激励视频 +2 次开房额度（否决了限时制提案）。
2. **邀请好友注册**：每成功邀请一人，邀请人 +5 次开房额度。
3. **免费额度保留**（10 次注册礼不变）；新增 `BETA_OPEN_ROOM` 环境变量标识
   内测期/上线期，内测期所有人畅玩，作为前期积累用户的手段。
4. **web 端会员保留**；小程序用邮箱登录、与 web 同账号体系，会员状态天然同步
  （同一个人登录谁都看得到自己的会员），不需要「绑定」动作；未来若接入微信
   授权登录，再做账号绑定。
5. **App 与小程序一致**：关闭付费入口；广告入口先写好完整接入方案，
   广告服务商由运营方后续选定（App 侧见 §6 AdMob 预留）。
6. **兑换码入口保留**，主要作为免费福利机制，由运营方手控（发码通道不变，
   见 14-REDEEM-CODE-CHANNEL.md）。
7. **作品奖励（同日追加）**：用户投稿的作品**通过人工复核**发布后，
   作者 +10 次开房额度，一道作品只发一次。

## 2. 奖励额度模型

### 2.1 为什么直接加免费池（没有第二个额度池）

奖励直接 `freeRoomAccounts.total += N`：

- 免费池的 CHECK（`consumed + reserved <= total`）与全部消费逻辑直接复用；
- 奖励到账即可开房，不需要「奖励额度/免费额度」两套余额与扣减优先级；
- 「我的」页、开房判定、账本对账看到的都是同一个数。

流水单独落 `room_bonus_ledger`（幂等键唯一 + 用户索引）：

| 字段 | 说明 |
|---|---|
| `kind` | `ad_bonus`（广告）/ `invite_bonus`（邀请）/ `creation_bonus`（作品发布） |
| `amount` | 一次发放的次数（2 / 5 / 10） |
| `detail` | jsonb：广告记 transId/rewardAmount；邀请记 claimantUserId/code；作品记 puzzleId |
| `idempotency_key` | 广告 `ad:<trans_id>`（微信交易号，天然防重放）；邀请 `invite-claim:<claimantUserId>`（一账号终身一次）；作品 `creation-bonus:<puzzleId>`（一道作品终身一次） |

### 2.2 常量（`packages/domain/src/room-bonus.ts`，纯函数可单测）

| 常量 | 值 | 说明 |
|---|---|---|
| `AD_REWARD_ROOMS` | 2 | 看完一条激励视频 |
| `INVITE_REWARD_ROOMS` | 5 | 一位好友通过邀请注册 |
| `CREATION_REWARD_ROOMS` | 10 | 一道投稿作品通过人工复核发布 |
| `DAILY_AD_BONUS_LIMIT` | 10 | 单用户每日广告奖励上限（东八区自然日） |
| `DAILY_INVITE_BONUS_LIMIT` | 10 | 单用户（邀请人）每日邀请奖励上限 |
| `INVITE_CODE_LENGTH` | 8 | 邀请码长度；字符表去 0/O/1/I/L |

防刷口径：广告靠微信验签 + trans_id 幂等 + 日额度；邀请靠「claimant 终身一次」
幂等键 + 邀请人日额度 + 邮箱注册成本。刷邀请的边际收益极低——新注册账号本来就有
注册礼（一个月会员），批量注册的账号自身权益已封顶，邀请奖励只是锦上添花。
作品奖励不设日上限——发放的门是管理员逐篇人工复核本身（投稿侧每天最多 5 篇
的限流也挡了一层），没有无成本刷量的路径。

## 3. 广告链路（微信激励视频 + 服务端验证 SSV）

```
小程序                API 服务                      微信流量主
  │ POST /ads/intent    │                              │
  │◀── 5 分钟意图令牌 ──│                              │
  │ createRewardedVideoAd(adUnitId + ?out_return_no=token) │
  │─────────────────────看完整个视频────────────────────▶│
  │                     │   GET /ads/wechat/notify      │
  │                     │◀─ signature=SHA256(secret:trans_id)
  │                     │   + out_return_no + trans_id ─│
  │                     │ 验签 → 换令牌得 userId        │
  │                     │ 事务：锁免费账户 → 数日额度    │
  │                     │ → 插流水(ad:transId 幂等)     │
  │                     │ → total += 2 ────────────────▶│ {errcode:0}
  │  onClose(isEnded) 后延迟 5s 刷新 /me                │
```

- **意图令牌**（jose HS256，5 分钟，签发与验签都用 `AUTH_SECRET`）解决
  「回调里怎么知道奖励该发给谁」：客户端把令牌透传给微信，微信回调带回来，
  服务端验签换回 userId。伪造回调过不了 `WECHAT_AD_CALLBACK_SECRET` 验签。
- **应答约定**：验签失败/缺参数返回 `errcode≠0`（微信会重试）；验签通过后的
  业务性拒绝（日上限、重复通知）返回 `errcode: 0` 不入账——重试不会有不同
  结果，让微信停止重试才是正确应答。
- **echostr**：流量主后台首次保存回调地址时微信 GET 一次，原样返回。
- **回调端点**：`GET /api/v1/ads/wechat/notify`（`@Public()`，理由与支付回调
  相同，public-routes.test.ts 已钉死）。
- **开通前置**：小程序 UV ≥ 1000 才能开流量主 → 创建激励视频广告位 →
  后台「服务端验证」填回调地址与密钥（= 部署的 `WECHAT_AD_CALLBACK_SECRET`）。
  代码里 `apps/miniprogram/src/ads/rewarded-ad.ts` 的 `AD_UNIT_ID` 占位为空，
  开通后填入即可，其余代码不动。
- **真机验证点**（开通后必做）：`adUnitId` 追加 `?out_return_no=` 参数的透传
  行为以真机为准；若微信小程序侧不透传该参数，需改为 close 回调主动上报的模式
 （届时在 §7 补记录）。

## 4. 邀请链路

- **邀请码**：`profiles.invite_code`（唯一索引），首次读 `/me` 时懒生成
 （8 位易混字符表，碰撞换码重试）。
- **分发**：web 端「我的」页展示邀请链接 `https://sp.xiaobaozi.cn/?ref=CODE` 可复制；
  小程序「我的」页主入口是转发小程序卡片（`useShareAppMessage` 路径带 `?ref=`），
  次入口复制网页链接（站外渠道）。
- **领取**：新用户从链接进站 → web `/?ref=` 存 localStorage / 小程序启动参数存
  Taro storage → **登录后静默** `POST /invites/claim`（结果不打扰被邀请人，
  奖励本来就发给邀请人）。
- **入账**：服务端事务锁邀请人免费账户行 → 数邀请人日额度 → 插流水
  （幂等键 `invite-claim:<claimantUserId>`，冲突 = 已领过，返回 already_claimed）
  → 邀请人 `total += 5`。自邀（用自己的码）直接拒绝。

## 4.5 作品奖励（人工复核发布）

- **触发点**：后台 `POST /admin/puzzle-versions/:id/approve`（人工复核通过、
  版本发布的事务内）——与发布**同一事务**：发布成功与奖励到账要么都发生要么
  都不发生（与赞助码「码核销与授权发放同事务」同一条铁律）。
- **发放范围**：`puzzles.source === 'community'` 且有作者的用户投稿。官方题库
  与导入题不走人工复核、不参与奖励。
- **只发一次**：幂等键 `creation-bonus:<puzzleId>`——修订版再次发布、下架再
  上架都不重发；同一作品加英文翻译（新语言版本）发布也不重发。
- **边界（与决策口径一致）**：Jev AI 初审直接通过（review_pass）的作品走自动
  发布（11 号文档既有规则），**没有经过人工复核，不发奖励**；只有进入
  `pending_review` 人工队列、由管理员批准发布的才发。若运营方日后想让 AI
  自动通过的也发，在 jobs 的 review-puzzle `published` 分支加同款入账即可。
- **不设日上限**：发放的门是人工复核本身（投稿侧每天最多 5 篇限流兜底）。
- **前端告知**：web 创作列表页标题下一行提示「作品通过人工复核发布后，奖励
  10 次开房次数」（创作文案在 `apps/web/src/creations/copy.ts`）。

## 5. 内测期（beta 来源）

- 环境变量 `BETA_OPEN_ROOM=true|false`（默认 false），`.env` 一改重启即生效。
- 开房判定 `resolveEntitlementSource(grants, free, now, { betaOpen })`：
  beta 优先于赞助与免费——授权来源记 `beta`（`entitlement_source` 枚举新增值），
  **不占免费次数、不建免费预留流水、不看赞助**。
- 前端回显：`/me` 返回 `betaOpen`，「我的」页额度卡显示「内测畅玩中」徽标
 （替代具体数字），小程序与 web 同款。
- 正式上线：改 `BETA_OPEN_ROOM=false` 重启即可；期间开过的房授权记录仍是
  `beta`，对账时按来源可区分（拉新期数据天然可统计）。

## 6. 通道收敛（各端付费入口现状）

| 端 | 打赏支持（在线支付） | 兑换码 | 看广告 | 邀请 |
|---|---|---|---|---|
| web | ✅ 保留 | ✅ 设置页 | —（无广告 SDK 通道） | ✅ 我的页 |
| App 壳 | ❌ 隐藏（`isAppShell` 判定，SponsorPanel 不渲染） | ✅ 设置页 | 预留（见下） | ✅ 我的页（同 web） |
| 小程序 | ❌ 本就没有 | ✅ 设置页 | ✅ 已实现，等流量主开通 | ✅ 我的页 + 转发卡片 |

**App 壳广告预留（AdMob 方案，供运营方选服务商时参考）**：Google AdMob 的
激励视频有官方服务端验证（SSV 回调带自定义数据 + 签名，与微信同构），接入时
只需新增 `GET /ads/admob/notify` 验签端点 + 客户端换 Google Mobile Ads SDK。
**限制**：AdMob 依赖 Google Play Services，国内直装 APK 上跑不起来——App 壳
若走国内直装分发，广告通道需要换国内聚合平台（穿山甲/优量汇，均有服务端回调），
接口形态同样是「验签 + 幂等 + 加免费池」，服务端这层不用重写。

## 7. 数据库与接口清单（速查）

- 迁移 `0016_ad_bonus_invite_beta.sql`：`room_bonus_kind` 枚举、`room_bonus_ledger`
  表、`profiles.invite_code` 列、`entitlement_source` 枚举加 `beta` 值
  （ALTER TYPE 单独断点，PG12+ 事务内加枚举值）。
- 迁移 `0017_creation_bonus.sql`：`room_bonus_kind` 枚举加 `creation_bonus` 值
  （单语句，同 0006 的 ALTER TYPE 形态）。
- 接口：`POST /ads/intent`（会话）、`GET /ads/wechat/notify`（@Public）、
  `POST /invites/claim`（会话）；作品奖励无独立接口（挂在 admin approve 事务内，
  响应带 `creationBonus` 布尔回显）；`GET /me` 扩展 `invite{code,invitedCount}` 与
  `betaOpen`。限流清单见 16-CONCURRENCY-LIMITS.md §5.2。
- 锁序不变：奖励发放只触碰免费账户（业务链最后一层锁），与开房事务并发安全。

## 8. 验证状态（2026-10-24）

- 全仓 `pnpm typecheck` 绿；domain 单测（含 room-bonus 奖励常量锁定）；
  api 单测（含 public-routes 钉死广告回调 @Public）；web 单测；
  `build:weapp` 无警告（585K）。
- 真实链路（微信流量主回调、邀请端到端入账、内测期开房、作品奖励入账）
  需部署后人工验收：
  ① 设 `BETA_OPEN_ROOM=true` 开房不扣次数；② 两个真实账号走邀请链接注册，
  验证邀请人 +5；③ 流量主开通后按 §3 清单配置并真机看一条广告验证 +2
  （重点：out_return_no 是否出现在回调 query）；④ 投一篇让 Jev 拿不准的作品
  （进人工复核队列），后台批准发布后作者额度 +10，再批准修订版确认不重发。
