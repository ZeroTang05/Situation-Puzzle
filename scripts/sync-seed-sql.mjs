/** 将 data/library.json 的内置题同步为 0001_initial.sql 末尾的种子块（标记之间），改题库后运行 pnpm sync:seed。 */
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
