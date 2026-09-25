/**
 * PostgreSQL 连接客户端。
 *
 * 用 node-postgres 驱动（pg-boss 同驱动，共享连接参数）；
 * DATABASE_URL 缺失时立即抛错——配置缺失不允许带病启动。
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: Pool;
  /** 事务辅助：回调拿到绑定 schema 的 client，异常自动回滚。 */
  tx: <T>(fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  if (!databaseUrl) {
    throw new Error('缺少 DATABASE_URL：数据库地址未配置，拒绝启动');
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    tx: (fn) => db.transaction(fn as never) as never,
    close: () => pool.end(),
  };
}

/** 直接取一条原始连接（pg-boss 事务适配、导入工具等场景使用）。 */
export async function withClient(pool: Pool, fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await fn(client);
  } finally {
    client.release();
  }
}

export type { schema };
