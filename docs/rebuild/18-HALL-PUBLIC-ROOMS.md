# 18 · 大厅与公开房间

版本：v1；更新日期：2026-10-22；基线：分支 `dev`。

## 一、要解决的问题

现在的多人房间只有一条进屋路径：**房主发邀请链接**。这带来两个问题：

1. 房主想组一局陌生人局，得一个个发链接；
2. 想玩的人只能等被邀请，没有「现在有哪局在玩」的入口。

大厅（Hall）就是给这件事的：房主把房间设为**公开**，房间出现在大厅列表里，任何人看到就能直接进去。

## 二、核心概念

| 概念 | 含义 | 落点 |
| --- | --- | --- |
| 公开房间 | 出现在大厅列表、允许陌生人直接加入的房间 | `rooms.is_public`（boolean，默认 false） |
| 私人房间 | 默认状态，只有邀请链接能进 | 同上，`is_public = false` |
| 会客厅公开偏好 | 房主在等待室打开的开关，**决定下一局**是否公开 | `user_lobbies.is_public`（boolean，默认 false） |

两个作用域各持一份开关，因为它们的生命周期不同：

- **会客厅**是「下一局的准备间」，id 永久不变，开关是房主的持久偏好（与 `capacity` 同性质），开局时复制进新房间，之后不清空；
- **房间**是「正在玩的那一局」，房主可以在游戏中途随时切换。

### 2.1 语义矩阵

| 动作 | 结果 |
| --- | --- |
| 等待室打开开关 → 开局 | 新建的房间是公开房间，直接出现在大厅 |
| 等待室打开开关 → 不开局 | 只是偏好，不会产生任何大厅条目（会客厅本身不是房间） |
| 房间内打开开关 | 房间立刻出现在大厅 |
| 房间内关掉开关 | 房间立刻从大厅消失；**已在房内的人不受影响**，邀请链接照旧有效 |
| 房间归档（破解 / 公布答案 / 解散） | 房间从大厅消失，不会出现「点进去发现已结束」 |
| 房主自己开的公开房间 | 同样出现在大厅里，别人可以加入 |
| 房间满员 | 仍在大厅里显示，但「加入」按钮禁用 |

## 三、接口

### 3.1 会客厅：切换公开状态

```
POST /lobbies/:id/visibility
{ "isPublic": true }  →  { "isPublic": true }
```

- 只有房主能改（非房主 → `FORBIDDEN`）；
- 幂等：重复设同一个值不写库、不报错，直接回显当前状态；
- 会客厅没有事件流与命令通道（见 [10-ROOM-LIFECYCLE-REVISION](10-ROOM-LIFECYCLE-REVISION.md)），所以单独一个 HTTP 端点，不走 `POST /rooms/:id/commands`。

### 3.2 房间：切换公开状态（命令）

```
POST /rooms/:id/commands
{ "clientRequestId": "<uuid>", "type": "set_visibility", "payload": { "isPublic": true } }
```

- 走既有的房间命令通道：幂等（`clientRequestId` 唯一）、host-only 校验、控制版本乐观并发；
- 状态真的变了才写库、才广播 `room.visibility_changed` 事件、才推进控制版本（没变就是空操作）；
- 事件 payload 只有 `{ isPublic: boolean }`，不含汤底与任何私有数据。

> 为什么房间侧要挂到命令通道上：房间的所有写操作本来就统一走命令接口（AGENTS.md 的硬约定），另开一个 `POST /rooms/:id/visibility` 会让「谁能改房间状态」出现第二条路径，权限与并发校验就容易漏。

### 3.3 大厅列表

```
GET /hall
{ "rooms": [{ roomId, title, language, hostNickname, memberCount, capacity, full, status, createdAt }] }
```

- 只返回**公开且未归档**的房间，按创建时间倒序，最多 50 条（`HALL_LIMIT`）；
- 题目取当前这一局的题面标题与语言（一房一题，`rounds.room_id` 唯一，左连接即可）；
- 人数只算 `room_members.status = 'joined'`；
- 满员房间照常返回，用 `full: true` 标记，前端据此禁用「加入」。

### 3.4 直接加入公开房间

```
POST /rooms/:id/join-public
→ { "roomId": "<uuid>", "joined": true }
```

- 不需要邀请 token，按房间 id 进；
- 幂等：已经是成员 → `joined: false`，不重复写成员行；
- 拒绝顺序固定（domain 层同一口径）：不是公开房 → `FORBIDDEN`；房间已关闭 → `ROOM_CLOSED`；已满 → `ROOM_FULL`；
- 被踢过的人不能靠大厅重进，需要房主解除限制（与邀请加入同一口径）；
- 成功加入后成为当前局的参与者（阅读权 + 提问权），并广播 `room.member_joined`。

## 四、状态一致性

三层保证「谁在大厅里」不会各说各话：

1. **DB 是唯一权威**：`rooms.is_public` 一列说了算，前端不缓存这个状态；
2. **事件广播**：房间内切换开关后写 `room.visibility_changed` 事件，房内所有人（含房主的其他标签页）同步看到新状态；快照也带 `isPublic`，刷新页面不会看到旧值；
3. **domain 层统一判定**：`shouldListInHall` / `publicJoinBlockReason` 是纯函数，服务端与前端共用同一套口径，不会出现「大厅里能点进、点进去却被拒」。

### 4.1 幂等与并发

| 场景 | 处理 |
| --- | --- |
| 房主连点两次开关 | 第二次发现值没变 → 空操作，不写库、不广播、不推进控制版本 |
| 命令重投（网络抖动） | `commands` 表 `clientRequestId` 唯一 → 返回原结果 |
| 两个标签页同时切 | 都是房主，后写覆盖先写（单一权威字段，最后一次生效） |
| 切换时另一个控制命令在途 | 控制版本乐观并发兜底：后者拿到 `STATE_CONFLICT`，前端提示刷新后重试 |

### 4.2 锁序

`join-public` 沿用既有锁序：**房间 → 局**（先锁 `rooms` 行，再查成员与局）。不涉及赞助账户与免费账户，因此不触碰 `房间 → 局 → 赞助账户 → 免费账户 → 任务` 的后半段。

## 五、前端

| 位置 | 表现 |
| --- | --- |
| 首页 | 次要入口加一个「大厅」按钮 |
| `/hall` | 大厅页：5 秒轮询 `GET /hall`，一行一个房间（题目 / 房主 / 人数 / 状态），「加入」直接进房 |
| 等待室 `/lobbies/:id` | 房主区一个「公开房间」拨杆，改的是**下一局**的偏好 |
| 房间 `/rooms/:id` | 右上角玩家列表 → 管理面板里一个「公开房间」拨杆，改的是**当前这局** |

拨杆组件 `apps/web/src/rooms/visibility-toggle.tsx` 两处共用，样式与站内已有的「大模型判题」拨杆一致（自绘 `<input type="checkbox" role="switch">`）。

## 六、限流

大厅是全局视图，前端 5 秒轮询一次，所以：

| 接口 | 维度 | 限额 | 作用域 |
| --- | --- | --- | --- |
| `GET /hall` | 用户 | 每分钟 60 次 | `hall.list` |
| `POST /rooms/:id/join-public` | 用户 | 每分钟 20 次 | `hall.join` |

两条规则由 `apps/api/src/common/rate-limit-policies.test.ts` 钉死。房间命令本身仍然不加 HTTP 限流（沿用既有口径，见 [16-CONCURRENCY-LIMITS §5.3](16-CONCURRENCY-LIMITS.md)）。

## 七、数据迁移

`0013_public_rooms.sql`：

```sql
ALTER TABLE "rooms"       ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
ALTER TABLE "user_lobbies" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "rooms_public_idx" ON "rooms" ("is_public") WHERE "is_public" = true;
```

存量数据全部落在 `false`，等价于「全是私人房间」，**无需回填**，行为与改动前完全一致。

## 八、边界与已知取舍

- **大厅不做匿名访问**：房间本身就要登录，大厅同样走会话守卫；未登录点「大厅」会被引导去登录。
- **大厅只列房间，不列会客厅**：会客厅是组队准备间，没有题目也没有对外入口语义（用户要求里的「当前汤题目」「直接进入」指向的是正在进行的房间）。
- **公开房间没有人数下限**：一个人也能开公开房间，房主自己看着办。
- **大厅列表只给 50 条**：公开房间数量不可控，必须封顶；排序按创建时间倒序（新的在前）。
- **不做「房间广场」的推荐排序**：先按创建时间倒序，等有了真实使用数据再谈热度排序。
- **被踢的人不能从大厅重进**：与邀请加入同口径，避免「被踢 → 从大厅又进来」。
