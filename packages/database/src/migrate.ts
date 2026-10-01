/**
 * 迁移执行入口：pnpm --dir packages/database db:migrate（NODE_ENV 环境用 DATABASE_URL）。
 *
 * drizzle 的 migrator 把所有迁移文件包在同一个事务里执行（pg-core/dialect.js migrate()）。
 * 因此新增 PostgreSQL 枚举值这种必须在事务外 commit 后才能被引用的 DDL，不能直接放在 SQL
 * 迁移里，否则后续引用会在同一事务触发 55P04 'unsafe use of new value'，事务整体回滚后枚举值
 * 也没了。下面在交给 drizzle 之前先用独立连接把跨事务的 ADD VALUE 提交掉。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type ClientConfig } from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ 的上一级是包根：packages/database/drizzle
const migrationsFolder = path.resolve(here, '../drizzle');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('缺少 DATABASE_URL');

// 需要在 drizzle 事务外先 commit 的枚举值。每个条目对应一次独立的 ALTER TYPE ADD VALUE，
// 必须按依赖关系排序；执行时各自一个短事务并 COMMIT，确保后续 drizzle 迁移能立即引用。
const preDrizzleEnumAdditions: Array<{ type: string; values: string[] }> = [
  { type: 'close_reason', values: ['never_started'] },
];

async function runPreDrizzleEnumAdditions(config: ClientConfig): Promise<void> {
  for (const { type, values } of preDrizzleEnumAdditions) {
    for (const value of values) {
      const pool = new Pool(config);
      try {
        // 独立连接、独立事务，确保 ADD VALUE 在本次调用结束前已经 COMMIT，下一次 drizzle
        // 启动事务就能直接使用。
        await pool.query('BEGIN');
        await pool.query(`ALTER TYPE "${type}" ADD VALUE IF NOT EXISTS '${value.replace(/'/g, "''")}'`);
        await pool.query('COMMIT');
      } catch (error) {
        // 枚举值已存在（IF NOT EXISTS 兜底）之外的失败要重置并向上抛，避免半成品状态。
        try {
          await pool.query('ROLLBACK');
        } catch {
          // 忽略 rollback 自身的错误
        }
        throw error;
      } finally {
        await pool.end();
      }
    }
  }
}

await runPreDrizzleEnumAdditions({ connectionString: url });

const pool = new Pool({ connectionString: url });
const db = drizzle(pool);
try {
  await migrate(db, { migrationsFolder });
  console.log(`迁移完成：${migrationsFolder}`);
} finally {
  await pool.end();
}