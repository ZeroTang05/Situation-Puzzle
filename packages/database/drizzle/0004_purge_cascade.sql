-- Schema 变更：把 rounds / jev_calls 引用 puzzle_versions 的两条外键改为
-- ON DELETE CASCADE。
--
-- 原因：import-library.ts --purge-stale 路径会 delete puzzles，
-- puzzle_versions 通过已有的 cascade 自动删除。但 rounds.puzzle_version_id
-- 和 jev_calls.review_version_id 默认是 NO ACTION，会挡住 cascade 链
-- （PostgreSQL ri_ReportViolation）。补上 cascade 后，硬删才能完整清掉
-- 所有依赖数据。
--
-- 职责分离（重要）：
-- - 本迁移**只改 FK 行为**，不删任何数据，是一次性 schema 变更。
-- - 数据清理由 import-library.ts 完成：每次执行都按当前 data/library.json
--   重新计算 "消失的 legacyId"，可重复运行，不依赖 migration 状态。
-- - 硬删命令：SEED_PURGE_STALE=1 docker compose --profile seed run --rm seed
--
-- 业务影响：rounds.ts:216 "开局固定的题目版本：旧局不受题目更新影响"
-- 仍然成立——正常内容更新走 "新增 puzzle_versions 行 + 切换
-- currentPublishedVersionId"，旧版与历史局完整保留；本迁移只影响
-- --purge-stale 显式触发硬删的极端清理路径。

-- IF EXISTS 让 SQL 幂等：migrator 跳过时手动重跑也安全，重复执行结果一致。

ALTER TABLE "rounds"
  DROP CONSTRAINT IF EXISTS "rounds_puzzle_version_id_puzzle_versions_id_fk",
  ADD CONSTRAINT "rounds_puzzle_version_id_puzzle_versions_id_fk"
    FOREIGN KEY ("puzzle_version_id") REFERENCES "puzzle_versions"("id") ON DELETE CASCADE;

ALTER TABLE "jev_calls"
  DROP CONSTRAINT IF EXISTS "jev_calls_review_version_id_puzzle_versions_id_fk",
  ADD CONSTRAINT "jev_calls_review_version_id_puzzle_versions_id_fk"
    FOREIGN KEY ("review_version_id") REFERENCES "puzzle_versions"("id") ON DELETE CASCADE;

