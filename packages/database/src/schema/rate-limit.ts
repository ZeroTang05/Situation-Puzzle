/**
 * 限流计数桶：固定窗口内按桶键累计次数。
 *
 * 计数存在数据库而不是进程内存里，多副本部署时上限不会被放大
 * （docs/rebuild/16-CONCURRENCY-LIMITS.md）。写入用单条 upsert 完成
 * 「读窗口计数 + 写新计数」，不依赖事务隔离级别。
 */
import { pgTable, text, timestamp, integer, index, primaryKey } from 'drizzle-orm/pg-core';

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    /** 桶键：scope + 维度 + 主体，见 apps/api/src/common/rate-limit.ts */
    bucketKey: text('bucket_key').notNull(),
    /** 窗口起点：日/小时按东八区自然边界，其余按 epoch 对齐 */
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    /** 当前窗口内已累计次数 */
    count: integer('count').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.bucketKey, table.windowStart] }),
    index('rate_limit_window_idx').on(table.windowStart),
  ],
);
