# 19 · 加好友、私聊、快捷开局与通知系统

版本：v1；更新日期：2026-10-23；基线：分支 `dev`。

## 一、要解决的问题

现在的多人房间只有一条进屋路径：**房主发邀请链接**。这带来三个问题：

1. 想跟某个朋友玩，得先加游戏好友、再发链接、再等他进来，中间任何一步断了这局就开不起来；
2. 站内没有「我认识谁」的入口，熟人局完全靠线下关系 + 链接传递；
3. 站内只有「房间事件」一套实时通道，私聊与站内信这类一对一提醒无处安放。

这一版补上社交层：

- **加好友**：按邮箱搜索 → 发申请 → 对方同意 → 成为好友；
- **私聊**：好友之间一对一聊天，消息落到服务端并实时同步（轮询）；
- **快捷开局**：私聊里一键建房直接开局，双方直接进同一个房间；
- **通知**：私聊消息、好友申请、快捷开局邀请、站内信统一进通知中心，铃铛角标提示。

## 二、核心概念

| 概念 | 含义 | 落点 |
| --- | --- | --- |
| 好友申请 | A 想加 B 为好友，等 B 同意 | `friend_requests` |
| 好友关系 | 双方确认后的好友关系（双向两行） | `friendships` |
| 私聊会话 | 两个好友之间的一个聊天窗口 | `conversations` |
| 私聊消息 | 会话内的一条消息（文本或开局卡片） | `dm_messages` |
| 已读水位 | 某人读到某个会话的第几条消息 | `conversation_reads` |
| 站内信 | 管理员群发给全站的公告 | `announcements` |
| 通知 | 统一提醒入口（私聊 / 申请 / 开局邀请 / 站内信） | `notifications` |

### 2.1 申请-同意制

好友不是「搜到就能加」，而是**申请-同意制**：A 发申请，B 同意后才成为好友。

- 申请按 `user_low` / `user_high` 规范化（字典序），所以 **A→B 与 B→A 落在同一对上**，同一对用户同时最多一条待审申请；
- 数据库用部分唯一索引 `friend_requests_pending_pair_uq`（`where status = 'pending'`）兜底，业务层绕不过去；
- 对方已申请我时，我再反向发会被拒（`FRIEND_REQUEST_EXISTS`），引导用户先去处理那条申请，而不是让两条申请互相顶掉。

### 2.2 邮箱只做精确匹配

搜索只支持**完整邮箱精确匹配**，不做前缀模糊搜索。站内邮箱是准身份凭证，前缀搜索等于开一个枚举接口：输入 `a` 就能把站内邮箱试出来。

### 2.3 私聊只在好友之间

会话在「对方同意好友申请」时随事务一起建立（`conversations` 按规范化的一对唯一）。非好友之间没有会话，也就没有私聊入口。

## 三、数据模型

七张表，迁移 `0014_friends_dm_notifications.sql`：

```
friend_requests      好友申请：user_low / user_high / requester_user_id / status / message
friendships          好友关系：user_id → friend_user_id（双向各一行）
conversations        私聊会话：user_low / user_high（规范化一对唯一）
dm_messages          私聊消息：conversation_id / sender_user_id / seq / kind / text / room_id
conversation_reads   已读水位：conversation_id + user_id → last_read_seq
announcements        站内信：title / body / created_by / published_at
notifications        通知：user_id / type / title / body / actor / link / read_at
```

### 3.1 数据库不变量

| # | 不变量 | 兜底方式 |
| --- | --- | --- |
| 1 | 同一对用户同时最多一条待审申请 | 部分唯一索引 `friend_requests_pending_pair_uq` |
| 2 | 好友关系不重复、不能指向自己 | 主键 `(user_id, friend_user_id)` + `CHECK` |
| 3 | 两个用户之间最多一个会话 | 唯一索引 `conversations_pair_uq` |
| 4 | 同一会话内消息序号唯一 | 唯一索引 `dm_messages_conversation_seq_uq` |
| 5 | 未读统计走部分索引 | `notifications_unread_idx`（`where read_at is null`） |

### 3.2 为什么已读水位用序号不用时间戳

会话内每条消息有递增 `seq`（分配时锁会话行），已读水位存 `last_read_seq`。

用时间戳会在「同一毫秒内连发两条」时丢消息：水位落在 `12:00:00.500`，另一条也是 `12:00:00.500`，`created_at > last_read_at` 判不出来。序号没有这个歧义，代价只是每会话多一列 bigint。

水位**只前进不后退**（`nextReadSeq` 取两者较大值），避免多标签页互相把水位打回去。

## 四、接口

### 4.1 好友

```
GET    /friends                 → { friends: [{ userId, nickname, since }] }
GET    /friends/search?email=   → { found, userId, nickname, relation }
POST   /friends/requests        { email, message? } → { requestId, status: "pending" }
GET    /friends/requests        → { requests: [{ requestId, direction, userId, nickname, message, status, createdAt }] }
POST   /friends/requests/:id/review  { accept } → { requestId, status }
DELETE /friends/requests/:id    → { ok: true }
DELETE /friends/:userId         → { ok: true }
```

`relation` 取值：`self` / `friends` / `pending_outgoing` / `pending_incoming` / `none`，前端据此决定按钮形态。

同意申请时同一事务里做三件事：建双向好友关系 → 建会话 → 给发起方落一条 `friend_accepted` 通知。

### 4.2 私聊

```
GET  /conversations                → { conversations: [{ conversationId, peerUserId, peerNickname, lastMessage, unreadCount }] }
GET  /conversations/:id            → { conversation: { conversationId, peerUserId, peerNickname } }
GET  /conversations/:id/messages   → { messages: [...] }
POST /conversations/:id/messages   { text } → { message }
POST /conversations/:id/read       { lastReadSeq? } → { lastReadSeq, unreadCount }
```

- `POST .../messages`：锁会话行 → 分配 `seq`（当前最大 + 1）→ 落消息 → 给对方落一条 `dm` 通知（正文是截断后的摘录）；
- `POST .../read`：`lastReadSeq` 省略时表示「整段会话已读」（取会话当前最大序号）；
- 未读数 = 该会话中 `seq > 我的 last_read_seq` 的消息条数；
- 聊天页顶栏显示对方昵称，取自 `GET /conversations/:id`；会话详情与消息轮询是两个接口，前端各拉一次。

### 4.3 快捷开局（来一局）

```
POST /conversations/:id/start-room  { puzzleId?, language } → { roomId, inviteToken, message }
```

单事务内完成：

1. 选题（指定 `puzzleId` 就取它的当前发布版，没指定就随机挑一道该语言的已发布题）；
2. `createRoomWithEntitlementTx` 建房间（容量固定 2，私人房间，开房额度记在发起人头上）；
3. 建 `rounds`（第 1 局）与发起人的 `round_participants`（对方点了邀请链接进房时由 `joinRoom` 补上参与者）；
4. 房间置 `playing`，广播 `round.started` 事件；
5. 私聊里落一条 `kind = 'room_invite'` 的消息（带 `room_id` 与 `invite_token` 明文），并给对方落一条 `room_invite` 通知。

**对方不会被自动拉进房间**：「来一局」= 发起一局并发出邀请，卡片上的「进入房间」是邀请链接
（`/room/invite/<token>`），对方点了才通过令牌进房。

- 房间表只存邀请令牌散列，明文令牌随卡片消息落在 `dm_messages.invite_token`（只有会话双方能读到）；
- 卡片按钮按房间当前状态渲染：进行中显示「进入房间」，房间归档（`closed`）或被删除后显示「房间已结束」；
- 通知里的 `link` 也是邀请链接（对方此时还不是成员，`/rooms/:roomId` 进不去）。

### 4.4 通知与站内信

```
GET  /notifications               → { notifications: [...] }
GET  /notifications/unread-count → { unread }
POST /notifications/read          { ids? | all? } → { updated }
POST /admin/announcements         { title, body } → { id, recipientCount }
GET  /admin/announcements         → { items, total }
```

通知类型：`dm` / `friend_request` / `friend_accepted` / `room_invite` / `announcement` / `system`。

- **站内信**：管理员群发，发布时给每个 `profiles.status = 'active'` 的用户落一条 `announcement` 通知（`insert ... select` 一条语句完成，事务内提交）；
- **群发留痕**：发布动作写 `audit_logs`（`action = 'announcement.publish'`），群发影响全站，必须可追溯；
- **后台列表可排序**：排序列白名单 `ANNOUNCEMENT_SORT`（见 `apps/api/src/admin/admin-sort-columns.ts`），与其它后台列表同一套机制。

### 4.5 通知标题不落库

通知标题是**展示文案**，而本项目的硬约定是「语言不落库」（用户界面语言只存本地 `localStorage`）。所以：

- 库里只存 `type` 与正文投影（私聊摘录 / 申请附言 / 站内信正文）；
- 标题在**读取时**按阅读者当前上报的 `X-Jev-Language` 即时拼装（`notificationTitle`）；
- 站内信例外：管理员写什么就是什么，标题正文原样落库。

## 五、状态一致性

| 场景 | 处理 |
| --- | --- |
| 双方同时互相发申请 | 部分唯一索引挡住一条，另一条回 `FRIEND_REQUEST_EXISTS` |
| 同一申请被同时同意两次 | 事务内 `for update` 锁申请行，第二次拿到「已处理」并回 `STATE_CONFLICT` |
| 同意后重复同意 | 好友关系 `on conflict do nothing`，不产生重复行 |
| 删好友 | 双向两行一起删（`or` 条件同时覆盖两个方向） |
| 多标签页同时推进已读水位 | `nextReadSeq` 取较大值，水位只前进不后退 |
| 消息与通知不一致 | 消息与通知在同一事务内提交，业务回滚时通知一起回滚 |
| 房间归档后点开局卡片 | `dm_messages.room_id` 是 `on delete set null`，卡片仍在但不再可点进去 |

### 5.1 锁序

社交域不新增锁序分支：

- 好友申请 / 好友关系：只锁 `friend_requests` 行；
- 私聊发消息：锁 `conversations` 行（分配序号需要串行），不碰房间与账户；
- 快捷开局：先锁 `conversations` 行，再走既有的**房间 → 局 → 赞助账户 → 免费账户 → 任务**锁序（`createRoomWithEntitlementTx` 内已按此顺序加锁）。

## 六、送达方式：轮询，不动 WebSocket

本版私聊与通知**走轮询**：

| 场景 | 轮询间隔 | 接口 |
| --- | --- | --- |
| 聊天页消息 | 3 秒 | `GET /conversations/:id/messages` |
| 会话列表 | 3 秒 | `GET /conversations` |
| 铃铛角标 | 10 秒 | `GET /notifications/unread-count` |

**为什么不动实时网关**：网关现在是房间事件流专用（`jev_room_events` NOTIFY + `seq` 补齐 + 房间订阅握手），私聊另起一套订阅要牵动握手、鉴权与补发语义。先用轮询把功能跑通，轮询间隔与服务端限额一一对齐（见第七节），后续要把私聊接进网关时，消息表已有 `seq`，可以直接照房间事件流那套补齐逻辑搬。

## 七、限流

| 接口 | 维度 | 限额 | 作用域 |
| --- | --- | --- | --- |
| `GET /friends` | 用户 | 每分钟 60 次 | `friends.list` |
| `GET /friends/search` | 用户 | 每分钟 30 次 | `friends.search` |
| `POST /friends/requests` | 用户 | 每分钟 10 次 | `friends.request.create` |
| `GET /friends/requests` | 用户 | 每分钟 60 次 | `friends.request.list` |
| `POST /friends/requests/:id/review` | 用户 | 每分钟 30 次 | `friends.request.review` |
| `DELETE /friends/requests/:id` | 用户 | 每分钟 30 次 | `friends.request.cancel` |
| `DELETE /friends/:userId` | 用户 | 每分钟 30 次 | `friends.remove` |
| `GET /conversations` | 用户 | 每分钟 60 次 | `chat.conversations` |
| `GET /conversations/:id` | 用户 | 每分钟 60 次 | `chat.conversation` |
| `GET /conversations/:id/messages` | 用户 | 每分钟 120 次 | `chat.messages` |
| `POST /conversations/:id/messages` | 用户 | 每分钟 60 次 | `chat.send` |
| `POST /conversations/:id/read` | 用户 | 每分钟 120 次 | `chat.read` |
| `POST /conversations/:id/start-room` | 用户 | 每分钟 10 次 | `chat.quickRoom` |
| `GET /notifications` | 用户 | 每分钟 60 次 | `notifications.list` |
| `GET /notifications/unread-count` | 用户 | 每分钟 120 次 | `notifications.unread` |
| `POST /notifications/read` | 用户 | 每分钟 120 次 | `notifications.read` |
| `POST /admin/announcements` | 用户 | 每分钟 120 次 | `admin` |

`GET /conversations/:id/messages` 是 3 秒一次（每分钟 20 次），限额给到 120 次留足余量；`start-room` 会消耗开房额度，限得紧（每分钟 10 次）。

所有社交接口都**要求会话**（SessionGuard 全局守卫，未标 `@Public()` 一律拦截），不新增公开路由。

## 八、前端

| 位置 | 表现 |
| --- | --- |
| 首页 | 次要入口加「好友」「消息」；顶栏加铃铛角标 |
| 「我的」页 | 账号卡下方加「好友」「消息」入口；顶栏加铃铛角标 |
| `/friends` | 搜索加好友 + 好友申请（同意 / 拒绝 / 撤回）+ 我的好友（每个好友一个「消息」按钮，直达该好友的会话） |
| `/chat/:conversationId` | 消息窗、开局卡片（邀请链接）、底部输入框；顶栏是对方昵称 + 右侧「来一局」 |
| `/notifications` | 通知列表（未读高亮、点一条即跳转并标记已读）、全部已读 |

**没有会话列表页**：`/chat` 不存在。好友列表是唯一入口——点某个好友的「消息」直接进 `/chat/:conversationId`。
首页与「我的」页的「消息」按钮进最近一条会话（一条会话都没有时进好友页）。

铃铛角标是独立组件 `apps/web/src/social/notification-bell.tsx`，10 秒轮询未读数，首页与「我的」页共用。

界面上**不写解释功能的说明文字**：只有标签、按钮与状态文案（与 18 号文档同一口径）。

## 九、数据迁移

- `0014_friends_dm_notifications.sql`：新建三张枚举类型 + 七张表 + 五个索引；
- `0015_quick_room_invite_token.sql`：`dm_messages` 加一列 `invite_token`（邀请卡片要长期当链接用，明文令牌随消息落库）。

存量数据为空表，**无需回填**，行为与改动前完全一致。

## 十、边界与已知取舍

- **不做游客私信**：单人模式（`/solo/*`）匿名且不落业务表，社交域整块要求登录。
- **不做群聊**：会话严格是两人（`user_low` / `user_high` 规范化一对唯一）。群聊要引入成员表与广播语义，先不做。
- **邮箱精确匹配不模糊**：见 §2.2。找不到时前端只提示「没找到这个邮箱对应的用户」，不回「该邮箱不存在」以外的额外信息。
- **通知会重复**：每次私聊消息都给对方落一条通知，没做「同一会话合并成一条未读」。消息多时通知列表会变长——列表按 50 条封顶，角标只算未读总数。
- **站内信给每个 active 用户落一行**：用户量小的时候没问题；量级上来后要改成「拉取时按公告表实时算未读」，现在是「发布时展开」。
- **快捷开局固定两人**：容量写死 2，不是 `ROOM_CAPACITY`。要拉第三个人进这局得走正常邀请链接。
- **快捷开局是邀请不是自动开局**：对方不会被自动拉进房间（见 §4.3）。房主点了「来一局」就消耗一次开房额度，对方一直不来这局就白建了——额度按房主算，房主自己决定要不要开。
- **快捷开局不选具体题目**：默认随机挑一道该语言的已发布题。指定题目（`puzzleId`）接口层已支持，前端暂未开放。
- **私聊暂不走 WebSocket**：见 §六，消息表已有 `seq`，后续接网关时可直接复用房间事件流的补齐逻辑。
- **删好友不删历史消息**：会话与消息保留，对方不再是好友后看不到（会话列表只列好友之间），但数据还在库里。
