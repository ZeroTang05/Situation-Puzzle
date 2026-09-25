/** 迁移执行入口：pnpm --dir packages/database db:migrate（NODE_ENV 环境用 DATABASE_URL）。 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ 的上一级是包根：packages/database/drizzle
const migrationsFolder = path.resolve(here, '../drizzle');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('缺少 DATABASE_URL');

const pool = new Pool({ connectionString: url });
const db = drizzle(pool);
try {
  await migrate(db, { migrationsFolder });
  console.log(`迁移完成：${migrationsFolder}`);
} finally {
  await pool.end();
}
