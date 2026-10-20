/**
 * 限流计数存储：单条 upsert 完成「读窗口计数 + 写新计数」。
 *
 * 为什么不用事务：计数与业务写入不是同一件事，限流是准入控制。
 * ON CONFLICT DO UPDATE 本身是原子的，靠数据库唯一约束保证并发下不丢计数。
 *
 * 计数失败时放行（fail open）：限流本身不能成为新的故障源——
 * 数据库不可用时业务写入本来也会失败，没有必要再叠一层拒绝。
 */
import { sql } from 'drizzle-orm';
import { rateLimitBuckets } from '@jev/database';
import { app } from '../context.js';

export interface RateLimitVerdict {
  /** 是否放行 */
  allowed: boolean;
  /** 当前窗口内累计次数（含本次） */
  count: number;
  /** 允许的上限 */
  limit: number;
  /** 计数是否真的落库了（false 表示存储故障后放行） */
  counted: boolean;
}

/** 消费一次额度：返回是否放行。 */
export async function consumeRateLimit(
  bucketKey: string,
  windowStart: Date,
  limit: number,
): Promise<RateLimitVerdict> {
  try {
    const rows = await app().db.db
      .insert(rateLimitBuckets)
      .values({ bucketKey, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.bucketKey, rateLimitBuckets.windowStart],
        // 冲突时用表里的现值 +1；PG 允许在 ON CONFLICT 里用表名限定旧行
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      })
      .returning({ count: rateLimitBuckets.count });
    const count = rows[0]?.count ?? 1;
    return { allowed: count <= limit, count, limit, counted: true };
  } catch (error) {
    console.error('[rate-limit] 计数写入失败，本次放行', error);
    return { allowed: true, count: 0, limit, counted: false };
  }
}
