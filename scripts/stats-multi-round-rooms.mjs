/**
 * R11 旧数据统计（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md §三 R11）：
 * 统计已有多局（>1 条 rounds）的房间，供一房一题约束迁移前评估。
 * 用法：DATABASE_URL=postgresql://... node scripts/stats-multi-round-rooms.mjs
 * 无多局房间时可直接应用 rounds(room_id) 唯一索引迁移（0001）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL ?? readFileSync(new URL('../.env.local', import.meta.url), 'utf8').match(/^DATABASE_URL=(.+)$/m)?.[1];
if (!databaseUrl) throw new Error('缺少 DATABASE_URL（环境变量或 .env.local）');

const pool = new Pool({ connectionString: databaseUrl });
const result = await pool.query(`
  select r.room_id, count(*)::int as round_count
  from rounds r
  group by r.room_id
  having count(*) > 1
`);
const [totals] = (await pool.query('select (select count(*) from rooms)::int as rooms, (select count(*) from rounds)::int as rounds')).rows;

console.log(`房间总数：${totals.rooms}，局总数：${totals.rounds}`);
if (result.rows.length === 0) {
  console.log('多局房间：0 —— 可安全应用 rounds(room_id) 唯一索引');
} else {
  console.log(`多局房间：${result.rows.length} 个（保留历史可读，迁移前需人工确认）：`);
  for (const row of result.rows) console.log(`  ${row.room_id}：${row.round_count} 局`);
}
await pool.end();
