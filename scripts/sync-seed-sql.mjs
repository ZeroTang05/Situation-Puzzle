/** 从中文题库生成新库种子与已有 D1 的题库更新文件；运行 pnpm sync:seed 只生成文件，不连接数据库。 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const library = JSON.parse(await readFile(join(root, 'data', 'library.json'), 'utf8'));
if (!Array.isArray(library) || library.length === 0) throw new Error('data/library.json 为空，拒绝生成空种子');

/** SQL 单引号转义：字符串里的 ' 翻倍。 */
const esc = (value) => String(value).replace(/'/g, "''");
// 固定时间戳：重复生成不产生无意义 diff；所有种子行相同，题库内部顺序由 worker 按文件顺序排列。
const BUILT_AT = '2026-09-24T00:00:00.000Z';

const rows = library.map((soup) => `  ('${esc(soup.id)}','${esc(soup.title)}','${esc(soup.story)}','${esc(soup.answer)}','${esc(JSON.stringify(soup.hints))}','Jev 题库','published','${BUILT_AT}','${BUILT_AT}','zh','seed')`);
const insert = `INSERT INTO soups (id,title,story,answer,hints,author_name,status,created_at,published_at,language,creator_token) VALUES\n${rows.join(',\n')};`;

const migrationPath = join(root, 'worker', 'migrations', '0001_initial.sql');
const BEGIN = '-- >>> seed-data（由 scripts/sync-seed-sql.mjs 生成，勿手改）';
const END = '-- <<< seed-data';
const migration = await readFile(migrationPath, 'utf8');
const start = migration.indexOf(BEGIN);
const end = migration.indexOf(END);
if (start < 0 || end < 0 || end < start) throw new Error('0001_initial.sql 缺少 seed-data 标记块，无法写入种子');
await writeFile(migrationPath, `${migration.slice(0, start)}${BEGIN}\n${insert}\n${END}${migration.slice(end + END.length)}`);
console.log(`种子块已更新：${library.length} 道内置题`);

// 旧题软删除保留审核日志的外键；更新已有题时保留管理员设定的状态，只替换题目内容。
const ids = library.map((soup) => `'${esc(soup.id)}'`).join(',');
const refresh = `-- 由 pnpm sync:seed 生成，仅更新 creator_token='seed' 的内置题，不修改玩家投稿或统计表。
-- 旧内置题标记 deleted，保留数据与审核记录；同 ID 题目保留原有审核状态。
UPDATE soups SET status='deleted' WHERE creator_token='seed' AND id NOT IN (${ids}) AND status<>'deleted';
${insert.slice(0, -1)}
ON CONFLICT(id) DO UPDATE SET
  title=excluded.title, story=excluded.story, answer=excluded.answer, hints=excluded.hints
WHERE soups.creator_token='seed';
`;
await writeFile(join(root, 'worker', 'refresh-seeds.sql'), refresh);
console.log('已有数据库更新文件已生成：worker/refresh-seeds.sql（尚未执行）');
