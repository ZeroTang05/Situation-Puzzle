-- 限流计数桶：固定窗口 + 原子 upsert 计数，跨进程共享。
--
-- 为什么放数据库而不是进程内存：
--   1) 多副本部署时进程内计数会被放大（副本数 × 每副本上限）；
--   2) 计数需要与「已发生的业务动作」对齐（例：投稿提交要挡住 Jev 机器审核的烧钱口子），
--      进程重启后计数丢失会让限额被绕过。
-- 计数与业务写入不是同一个事务：限流是「尽力而为的准入控制」，
-- 宁可偶尔多放行一次，也不能因为计数失败而让正常请求整体不可用。
--
-- bucket_key 形如 scope:维度:主体（如 creations:user:<userId>）。
-- 复合主键 (bucket_key, window_start) 让「同一桶同一窗口」只能有一行，
-- upsert 冲突时计数 +1 是原子的。

CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "bucket_key" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("bucket_key", "window_start")
);

-- 过期桶清理按 window_start 扫描
CREATE INDEX IF NOT EXISTS "rate_limit_window_idx" ON "rate_limit_buckets" ("window_start");
