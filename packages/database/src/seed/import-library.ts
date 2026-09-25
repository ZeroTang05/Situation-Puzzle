/**
 * 题库 JSON 导入：data/library.json + data/library.en.json → puzzles + puzzle_versions。
 *
 * - 幂等：按 (source, legacyId, language, sourceHash) 去重，重复导入跳过或报警
 * - 默认导入为待审核状态（moderation_status=pending_review、权利 pending），不得直接公开：
 *   旧题目的来源说明缺少商业授权确认（docs/rebuild/06-MIGRATION.md §3）
 * - --publish 仅用于本地开发测试：标记权利 DEV-ONLY 并发布，禁止在正式库执行
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { createDb } from '../client.js';
import { puzzles, puzzleVersions, puzzleRights } from '../schema/content.js';

const IMPORT_SOURCE = 'imported' as const;

interface LibraryEntry {
  id: string;
  title: string;
  story: string;
  answer: string;
  hints: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../../../../data');
const publish = process.argv.includes('--publish');

const zh = JSON.parse(readFileSync(path.join(dataDir, 'library.json'), 'utf8')) as LibraryEntry[];
const en = JSON.parse(readFileSync(path.join(dataDir, 'library.en.json'), 'utf8')) as LibraryEntry[];

if (zh.length !== en.length || zh.some((e, i) => e.id !== en[i]?.id)) {
  throw new Error('中英题库 ID 顺序不一致，拒绝导入');
}

function contentHash(entry: LibraryEntry): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('缺少 DATABASE_URL');

const { db, pool, close } = createDb(url);

let created = 0;
let skipped = 0;
let published = 0;

for (const entry of zh) {
  const hash = contentHash(entry);
  const enEntry = en.find((e) => e.id === entry.id);
  if (!enEntry) throw new Error(`缺少英文条目：${entry.id}`);

  // 已有作品（按 source+legacyId 查）
  const existing = await db
    .select()
    .from(puzzles)
    .where(and(eq(puzzles.source, IMPORT_SOURCE), eq(puzzles.legacyId, entry.id)))
    .limit(1);

  let puzzleId: string;
  if (existing.length > 0) {
    puzzleId = existing[0]!.id;
    const versions = await db.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId));
    const zhSame = versions.some((v) => v.language === 'zh' && v.sourceHash === hash);
    const enSame = versions.some((v) => v.language === 'en' && v.sourceHash === contentHash(enEntry));
    if (zhSame && enSame) {
      skipped += 1;
      continue;
    }
  } else {
    const inserted = await db
      .insert(puzzles)
      .values({ source: IMPORT_SOURCE, legacyId: entry.id })
      .returning({ id: puzzles.id });
    puzzleId = inserted[0]!.id;
    await db.insert(puzzleRights).values({
      puzzleId,
      status: 'pending',
      licenseBasis: '旧题库来源说明见 data/library-sources.md，商业授权待核实',
      agreementVersion: 'pending-review',
    });
  }

  await db.insert(puzzleVersions).values([
    {
      puzzleId,
      versionNo: 1,
      language: 'zh',
      title: entry.title,
      surface: entry.story,
      answer: entry.answer,
      hints: entry.hints,
      moderationStatus: 'pending_review',
      sourceHash: hash,
    },
    {
      puzzleId,
      versionNo: 1,
      language: 'en',
      title: enEntry.title,
      surface: enEntry.story,
      answer: enEntry.answer,
      hints: enEntry.hints,
      moderationStatus: 'pending_review',
      sourceHash: contentHash(enEntry),
    },
  ]);
  created += 1;
}

// --publish：本地开发用，把导入的题标记为可玩（正式库禁止）
if (publish) {
  const pendingRights = await db
    .select()
    .from(puzzleRights)
    .where(and(eq(puzzleRights.status, 'pending'), isNull(puzzleRights.confirmedAt)));
  for (const right of pendingRights) {
    await db
      .update(puzzleRights)
      .set({
        status: 'approved',
        licenseBasis: 'DEV-ONLY 本地开发授权，禁止用于生产',
        agreementVersion: 'dev-local',
        confirmedAt: new Date(),
      })
      .where(eq(puzzleRights.id, right.id));
    const versions = await db.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, right.puzzleId));
    const zhVersion = versions.find((v) => v.language === 'zh');
    if (!zhVersion) continue;
    await db.update(puzzleVersions).set({ moderationStatus: 'published' }).where(eq(puzzleVersions.id, zhVersion.id));
    await db
      .update(puzzles)
      .set({ currentPublishedVersionId: zhVersion.id, updatedAt: new Date() })
      .where(eq(puzzles.id, right.puzzleId));
    published += 1;
  }
}

console.log(`导入完成：新建 ${created} 题，跳过 ${skipped} 题${publish ? `，本地发布 ${published} 题` : '（未发布，等待权利审核）'}`);
await close();
