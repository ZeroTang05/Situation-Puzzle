-- 加好友 + 私聊 + 快捷开局 + 通知系统（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）
--
-- 目标：
--   friend_requests     好友申请（申请-同意制）：按 user_low/user_high 规范化，双向互斥
--   friendships         好友关系：双向两行（user_id → friend_user_id）
--   conversations       私聊会话：两个好友之间一个会话（规范化一对唯一）
--   dm_messages         私聊消息：text 普通文本 / room_invite 「来一局」开局卡片
--   conversation_reads  每人在每个会话的已读水位
--   announcements       站内信：管理员群发公告
--   notifications       统一通知：私聊提醒 / 好友申请 / 站内信，统一未读计数
--
-- 存量数据为空表，无需回填。

CREATE TYPE "friend_request_status" AS ENUM ('pending', 'accepted', 'rejected', 'canceled');
CREATE TYPE "dm_message_kind" AS ENUM ('text', 'room_invite');
CREATE TYPE "notification_type" AS ENUM (
  'dm', 'friend_request', 'friend_accepted', 'room_invite', 'announcement', 'system'
);

-- ---------- 好友申请 ----------

CREATE TABLE IF NOT EXISTS "friend_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_low" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "user_high" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "requester_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "status" "friend_request_status" NOT NULL DEFAULT 'pending',
  "message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "responded_at" timestamp with time zone
);

-- 不变量 1：同一对用户同时最多一条待审申请（A→B 与 B→A 互相冲突）
CREATE UNIQUE INDEX IF NOT EXISTS "friend_requests_pending_pair_uq"
  ON "friend_requests" ("user_low", "user_high") WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "friend_requests_requester_idx" ON "friend_requests" ("requester_user_id");
CREATE INDEX IF NOT EXISTS "friend_requests_low_idx" ON "friend_requests" ("user_low");
CREATE INDEX IF NOT EXISTS "friend_requests_high_idx" ON "friend_requests" ("user_high");

ALTER TABLE "friend_requests"
  DROP CONSTRAINT IF EXISTS "friend_requests_pair_distinct";
ALTER TABLE "friend_requests"
  ADD CONSTRAINT "friend_requests_pair_distinct" CHECK ("user_low" <> "user_high");

-- ---------- 好友关系 ----------

CREATE TABLE IF NOT EXISTS "friendships" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "friend_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "friendships_pkey" PRIMARY KEY ("user_id", "friend_user_id")
);

ALTER TABLE "friendships"
  DROP CONSTRAINT IF EXISTS "friendships_not_self";
ALTER TABLE "friendships"
  ADD CONSTRAINT "friendships_not_self" CHECK ("user_id" <> "friend_user_id");

-- ---------- 私聊会话与消息 ----------

CREATE TABLE IF NOT EXISTS "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_low" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "user_high" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- 不变量 2：两个用户之间最多一个会话
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_pair_uq" ON "conversations" ("user_low", "user_high");

ALTER TABLE "conversations"
  DROP CONSTRAINT IF EXISTS "conversations_pair_distinct";
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_pair_distinct" CHECK ("user_low" <> "user_high");

CREATE TABLE IF NOT EXISTS "dm_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "sender_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "seq" bigint NOT NULL,
  "kind" "dm_message_kind" NOT NULL DEFAULT 'text',
  "text" text NOT NULL,
  "room_id" uuid REFERENCES "rooms"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "dm_messages_conversation_idx" ON "dm_messages" ("conversation_id", "created_at");

-- 不变量 3：同一会话内消息序号唯一（已读水位按序号，不按时间戳）
CREATE UNIQUE INDEX IF NOT EXISTS "dm_messages_conversation_seq_uq"
  ON "dm_messages" ("conversation_id", "seq");

CREATE TABLE IF NOT EXISTS "conversation_reads" (
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "last_read_seq" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("conversation_id", "user_id")
);

-- ---------- 站内信与通知 ----------

CREATE TABLE IF NOT EXISTS "announcements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_by" text NOT NULL REFERENCES "user"("id"),
  "published_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "announcements_published_idx" ON "announcements" ("published_at");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "type" "notification_type" NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE CASCADE,
  "room_id" uuid REFERENCES "rooms"("id") ON DELETE SET NULL,
  "announcement_id" uuid REFERENCES "announcements"("id") ON DELETE CASCADE,
  "link" text,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" ("user_id", "created_at");

-- 不变量 4：未读统计走部分索引
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" ("user_id") WHERE "read_at" IS NULL;
