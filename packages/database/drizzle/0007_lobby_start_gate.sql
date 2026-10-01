-- v2 等待室改造（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md §四 L02）：
-- 枚举加值与数据迁移分两个文件：PG 不允许在同一事务里使用刚加的枚举值。
ALTER TYPE "close_reason" ADD VALUE IF NOT EXISTS 'never_started';--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN IF EXISTS "selected_puzzle_version_id";
