-- 用户主持人模式（docs/rebuild/17-USER-HOST-MODE.md）
--
-- 目标：让玩家可以自己当主持人。房间与会客厅各自持有主持人状态：
--   host_mode        ai = Jev 主持；user = 用户主持
--   user_host_id     当前用户主持人（null = 无用户主持人）
--   <scope>_members.role          成员身份镜像：player / user_host
--   <scope>_members.host_requested_at  待审的主持人申请时间
--
-- 存量数据全部落在默认 host_mode='ai' + role='player'，无需回填。

CREATE TYPE "host_mode" AS ENUM ('ai', 'user');
CREATE TYPE "room_member_role" AS ENUM ('player', 'user_host');

-- 房间：主持人形态与当前用户主持人
ALTER TABLE "rooms"
  ADD COLUMN IF NOT EXISTS "host_mode" "host_mode" NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS "user_host_id" text REFERENCES "user"("id") ON DELETE SET NULL;

-- 房间成员：身份镜像与待审申请
ALTER TABLE "room_members"
  ADD COLUMN IF NOT EXISTS "role" "room_member_role" NOT NULL DEFAULT 'player',
  ADD COLUMN IF NOT EXISTS "host_requested_at" timestamp with time zone;

-- 不变量：一个房间至多一名用户主持人
CREATE UNIQUE INDEX IF NOT EXISTS "room_members_one_user_host_uq"
  ON "room_members" ("room_id") WHERE "role" = 'user_host';

-- 自愈巡检要扫描处于用户主持模式的房间
CREATE INDEX IF NOT EXISTS "rooms_user_host_mode_idx"
  ON "rooms" ("host_mode") WHERE "host_mode" = 'user';

-- 判定来源：ai = Jev；host = 用户主持人
ALTER TABLE "turns"
  ADD COLUMN IF NOT EXISTS "judged_by" text;

-- 会客厅：与房间同构的主持人状态（start 事务迁移进新房）
ALTER TABLE "user_lobbies"
  ADD COLUMN IF NOT EXISTS "host_mode" "host_mode" NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS "user_host_id" text REFERENCES "user"("id") ON DELETE SET NULL;

ALTER TABLE "lobby_members"
  ADD COLUMN IF NOT EXISTS "role" "room_member_role" NOT NULL DEFAULT 'player',
  ADD COLUMN IF NOT EXISTS "host_requested_at" timestamp with time zone;

CREATE UNIQUE INDEX IF NOT EXISTS "lobby_members_one_user_host_uq"
  ON "lobby_members" ("lobby_id") WHERE "role" = 'user_host';
