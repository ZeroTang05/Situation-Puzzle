/**
 * 题库 JSON 导入：data/library.json + data/library.en.json → puzzles + puzzle_versions。
 *
 * 以 legacyId 为单位的差量同步：
 * - library.json 里**新增**的 legacyId → 新建 puzzles (source='official') + puzzle_versions + puzzle_rights
 * - library.json 里**仍然存在**的 legacyId → 按 sourceHash 判定：
 *     - 中英 hash 都未变 → 跳过
 *     - 任一语言 hash 变化 → 新增 puzzle_versions（versionNo 累加），不覆盖旧版
 * - library.json 里**消失**的 legacyId → 默认软删（unavailable=true + 清 currentPublishedVersionId），
 *   保留所有历史数据（ratings / rounds / reviews）。硬删需要显式 --purge-stale。
 *
 * seed 题入库即发布：库文件属于平台可直接发布的内容，不像玩家投稿
 * 需要走 submitted → checking → pending_review → published 流程。puzzle_rights
 * 直接写 approved、puzzle_versions 直接写 published、puzzles.currentPublishedVersionId
 * 直接指向新增版本；改编批次按「转载」记录（origin=repost + 原作者链接），
 * 平台原创写「平台自有」，与玩家投稿的来源口径一致。
 *
 * --purge-stale 把 library.json 里消失的 legacyId 真删（清 puzzle_versions、
 * puzzle_rights、puzzle_test_cases、moderation_reviews、puzzle_ratings、rounds、
 * jev_calls 全部级联数据）。生产环境禁止（无 UNDO）。rounds / jev_calls 的 FK
 * cascade 在 0004_purge_cascade.sql 迁移里加上。
 *
 * 署名：按 ID 前缀映射真实来源（见 SOURCE_BY_PREFIX）——改编题署名原作者
 * （饭堂时刻 / 小小耶 / 许二木），平台原创统一显示「初始题库」（canonical 名，
 * 前端 AuthorLabel 按 i18n 本地化展示），不落 anonymous。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '../client.js';
import { puzzles, puzzleVersions, puzzleRights } from '../schema/content.js';

const IMPORT_SOURCE = 'official' as const;

/** 单个内置题批次的来源信息：署名 + 权利记录怎么写。 */
interface SourceAttribution {
  /** 卡片署名（DB 存 canonical 中文本，前端直接展示） */
  authorName: string;
  /** original=平台原创，repost=转载改编 */
  origin: 'original' | 'repost';
  /** 转载批次的原作者空间页链接；平台原创为 null */
  sourceUrl: string | null;
  /** 授权依据说明 */
  licenseBasis: string;
}

/**
 * ID 前缀 → 来源署名映射（批次构成见 data/sources.md「按批统计」）。
 * 转载批次必须带原作者空间页链接，为空时 attributionOf 直接报错，拒绝无出处转载入库。
 */
const SOURCE_BY_PREFIX: Record<string, SourceAttribution> = {
  'real-': {
    authorName: '饭堂时刻',
    origin: 'repost',
    sourceUrl: 'https://space.bilibili.com/216025',
    licenseBasis: '转载改编自 B 站 UP 主「尕丶天堂」饭堂时刻系列节目文字稿，逐题明细见 data/sources.md',
  },
  'xxye-': {
    authorName: '小小耶',
    origin: 'repost',
    sourceUrl: 'https://space.bilibili.com/59693163',
    licenseBasis: '转载改编自 B 站 UP 主「小小耶」海龟汤视频文字稿，逐题明细见 data/sources.md',
  },
  'xerm-': {
    authorName: '许二木',
    origin: 'repost',
    sourceUrl: 'https://www.douyin.com/user/MS4wLjABAAAAKurkOY2XLWE80yoCF6NagcyeE-FneMrIYo8oc1vMMVU',
    licenseBasis: '转载改编自抖音创作者「许二木」海龟汤系列视频字幕稿，逐题明细见 data/sources.md',
  },
  'seed-': {
    authorName: '初始题库',
    origin: 'original',
    sourceUrl: null,
    licenseBasis: '平台自有题库（data/sources.md，source=official）',
  },
};

/** ID 前缀 → 来源信息；未知前缀或转载缺链接直接报错，新批次必须先在 SOURCE_BY_PREFIX 登记来源。 */
function attributionOf(legacyId: string): SourceAttribution {
  const prefix = Object.keys(SOURCE_BY_PREFIX).find((candidate) => legacyId.startsWith(candidate));
  const attribution = prefix ? SOURCE_BY_PREFIX[prefix] : undefined;
  if (!attribution) throw new Error(`未知内置题 ID 前缀：${legacyId}（先在 SOURCE_BY_PREFIX 登记来源署名）`);
  if (attribution.origin === 'repost' && !attribution.sourceUrl) {
    throw new Error(`转载批次「${prefix}」缺少原作者链接（sourceUrl），拒绝无出处转载入库`);
  }
  return attribution;
}

interface LibraryEntry {
  id: string;
  title: string;
  /** 题目类别（中文源文件携带）：本格=现实逻辑，变格=允许超自然 */
  category?: '本格' | '变格';
  story: string;
  answer: string;
  hints: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
}

/** JSON 中文类别值 → puzzle_category 枚举；未知值直接报错（fast-fail）。 */
const CATEGORY_MAP = { 本格: 'honkaku', 变格: 'henkaku' } as const;
function categoryOf(entry: LibraryEntry): 'honkaku' | 'henkaku' | null {
  if (entry.category === undefined) return null;
  const mapped = CATEGORY_MAP[entry.category];
  if (!mapped) throw new Error(`未知题目类别：${entry.id} ${String(entry.category)}`);
  return mapped;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../../../../data');
const purgeStale = process.argv.includes('--purge-stale');

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

const { db, close } = createDb(url);

let created = 0;
let updated = 0;
let skipped = 0;
let retired = 0;
let purged = 0;

// 取出当前库里所有 seed 题的 (legacyId, id) 映射
const existingImported = await db
  .select({ id: puzzles.id, legacyId: puzzles.legacyId })
  .from(puzzles)
  .where(eq(puzzles.source, IMPORT_SOURCE));
const existingByLegacyId = new Map<string, string>();
for (const row of existingImported) {
  if (row.legacyId) existingByLegacyId.set(row.legacyId, row.id);
}

// 署名与权利记录同步：把已导入的内置题按来源刷成真实署名 / 转载记录，
// 改 SOURCE_BY_PREFIX 后重跑导入即可修正存量。分组键是 SOURCE_BY_PREFIX 里的共享对象，
// 只动映射到的 official 题，不会碰玩家投稿的署名与权利记录。
const puzzleIdsByAttribution = new Map<SourceAttribution, string[]>();
for (const legacyId of existingByLegacyId.keys()) {
  const attribution = attributionOf(legacyId);
  const group = puzzleIdsByAttribution.get(attribution);
  if (group) group.push(existingByLegacyId.get(legacyId)!);
  else puzzleIdsByAttribution.set(attribution, [existingByLegacyId.get(legacyId)!]);
}
for (const [attribution, puzzleIds] of puzzleIdsByAttribution) {
  await db
    .update(puzzles)
    .set({ authorDisplayMode: 'signature', authorDisplayName: attribution.authorName })
    .where(inArray(puzzles.id, puzzleIds));
  await db
    .update(puzzleRights)
    .set({ origin: attribution.origin, sourceUrl: attribution.sourceUrl, licenseBasis: attribution.licenseBasis })
    .where(inArray(puzzleRights.puzzleId, puzzleIds));
}

// 取出当前 JSON 里的 legacyId 集合
const desiredLegacyIds = new Set(zh.map((e) => e.id));

// ----- 第一遍：处理新增 / 更新（seed 题入库即发布）-----
for (const entry of zh) {
  const hash = contentHash(entry);
  const enEntry = en.find((e) => e.id === entry.id);
  if (!enEntry) throw new Error(`缺少英文条目：${entry.id}`);

  const existingId = existingByLegacyId.get(entry.id);

  if (existingId) {
    // 已有 legacyId：按 sourceHash 判定是否需要新版本
    const versions = await db.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, existingId));
    const zhSame = versions.some((v) => v.language === 'zh' && v.sourceHash === hash);
    const enSame = versions.some((v) => v.language === 'en' && v.sourceHash === contentHash(enEntry));
    // 类别补齐：列存在前导入的版本 hash 不变但 category 为 null，按新版本补写
    const category = categoryOf(entry);
    const categorySame = versions.some((v) => v.language === 'zh' && v.category === category);
    if (zhSame && enSame && categorySame) {
      skipped += 1;
      continue;
    }
    // 现有最大 versionNo（中文/英文共享同一编号；不存在则 0）
    const maxVersionNo = versions.reduce((m, v) => Math.max(m, v.versionNo), 0);
    const nextVersionNo = maxVersionNo + 1;
    const insertedVersions = await db
      .insert(puzzleVersions)
      .values([
        {
          puzzleId: existingId,
          versionNo: nextVersionNo,
          language: 'zh',
          title: entry.title,
          surface: entry.story,
          answer: entry.answer,
          hints: entry.hints,
          difficulty: entry.difficulty ?? null,
          category,
          moderationStatus: 'published',
          sourceHash: hash,
        },
        {
          puzzleId: existingId,
          versionNo: nextVersionNo,
          language: 'en',
          title: enEntry.title,
          surface: enEntry.story,
          answer: enEntry.answer,
          hints: enEntry.hints,
          difficulty: enEntry.difficulty ?? null,
          category,
          moderationStatus: 'published',
          sourceHash: contentHash(enEntry),
        },
      ])
      .returning({ id: puzzleVersions.id, language: puzzleVersions.language });
    // 新版本直接指为 currentPublishedVersionId（中文版）
    const newZhId = insertedVersions.find((v) => v.language === 'zh')?.id;
    if (newZhId) {
      await db
        .update(puzzles)
        .set({ currentPublishedVersionId: newZhId, updatedAt: new Date() })
        .where(eq(puzzles.id, existingId));
    }
    updated += 1;
    continue;
  }

  // 新增 legacyId：入库即发布
  const attribution = attributionOf(entry.id);
  const insertedPuzzle = await db
    .insert(puzzles)
    .values({
      source: IMPORT_SOURCE,
      legacyId: entry.id,
      authorDisplayMode: 'signature',
      authorDisplayName: attribution.authorName,
      // currentPublishedVersionId 在下方 versions insert 后回填
    })
    .returning({ id: puzzles.id });
  const puzzleId = insertedPuzzle[0]!.id;
  await db.insert(puzzleRights).values({
    puzzleId,
    status: 'approved',
    origin: attribution.origin,
    sourceUrl: attribution.sourceUrl,
    licenseBasis: attribution.licenseBasis,
    agreementVersion: 'platform-library-v1',
    confirmedAt: new Date(),
  });
  const insertedVersions = await db
    .insert(puzzleVersions)
      .values([
        {
          puzzleId,
          versionNo: 1,
          language: 'zh',
          title: entry.title,
          surface: entry.story,
          answer: entry.answer,
          hints: entry.hints,
          difficulty: entry.difficulty ?? null,
          category: categoryOf(entry),
          moderationStatus: 'published',
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
          difficulty: enEntry.difficulty ?? null,
          category: categoryOf(entry),
          moderationStatus: 'published',
          sourceHash: contentHash(enEntry),
        },
      ])
    .returning({ id: puzzleVersions.id, language: puzzleVersions.language });
  const zhVersionId = insertedVersions.find((v) => v.language === 'zh')?.id;
  if (zhVersionId) {
    await db
      .update(puzzles)
      .set({ currentPublishedVersionId: zhVersionId })
      .where(eq(puzzles.id, puzzleId));
  }
  created += 1;
}

// ----- 第二遍：处理消失的 legacyId -----
const staleIds: string[] = [];
for (const [legacyId, id] of existingByLegacyId.entries()) {
  if (!desiredLegacyIds.has(legacyId)) staleIds.push(id);
}

if (staleIds.length > 0) {
  if (purgeStale) {
    // 硬删：cascade 清掉 puzzle_versions / puzzle_rights / puzzle_test_cases /
    // moderation_reviews / puzzle_ratings / rounds / jev_calls。无法恢复。
    // rounds 与 jev_calls 的 ON DELETE CASCADE 见 drizzle/0004_purge_cascade.sql。
    await db.delete(puzzles).where(inArray(puzzles.id, staleIds));
    purged = staleIds.length;
  } else {
    // 软删：unavailable=true + 清 currentPublishedVersionId。已发布过的题从题库消失，
    // 历史数据（ratings/rounds/test cases）保留可供审计。
    await db
      .update(puzzles)
      .set({
        unavailable: true,
        currentPublishedVersionId: null,
        updatedAt: new Date(),
      })
      .where(inArray(puzzles.id, staleIds));
    retired = staleIds.length;
  }
}

// seed 题入库即发布，无第三遍——所有题在第一遍已写 published/approved。

const retireMsg = retired > 0 ? `，软删 ${retired} 题（--purge-stale 改为硬删）` : '';
const purgeMsg = purged > 0 ? `，硬删 ${purged} 题` : '';
console.log(
  `导入完成：新建 ${created} 题，更新 ${updated} 题，跳过 ${skipped} 题${retireMsg}${purgeMsg}`,
);
await close();
