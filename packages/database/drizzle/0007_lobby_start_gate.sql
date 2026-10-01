-- v2 等待室改造（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md §四 L02）：
-- 「ALTER TYPE close_reason ADD VALUE 'never_started'」单独放在 packages/database/src/migrate.ts
-- 的预迁移步骤里执行，因为 drizzle migrator 把所有迁移文件包在同一个事务中，ADD VALUE 与后
-- 续引用 0008 的 UPDATE 会触发 PG 55P04 'unsafe use of new value'，整个事务回滚后枚举值也
-- 不会落地。
ALTER TABLE "rooms" DROP COLUMN IF EXISTS "selected_puzzle_version_id";