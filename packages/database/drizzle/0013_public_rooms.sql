-- 大厅与公开房间（docs/rebuild/18-HALL-PUBLIC-ROOMS.md）
--
-- 目标：房主可以随时把房间设为公开，公开房间出现在大厅列表，其他玩家可直接加入。
--   rooms.is_public       房间是否出现在大厅（false = 私人房间，只有邀请链接能进）
--   user_lobbies.is_public 会客厅的持久公开偏好：start 事务复制进新建房间
--
-- 存量数据全部落在默认 false，等价于「全是私人房间」，无需回填。

ALTER TABLE "rooms"
  ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;

ALTER TABLE "user_lobbies"
  ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;

-- 大厅列表只扫公开房间
CREATE INDEX IF NOT EXISTS "rooms_public_idx"
  ON "rooms" ("is_public") WHERE "is_public" = true;
