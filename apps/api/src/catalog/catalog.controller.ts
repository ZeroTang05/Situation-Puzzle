/**
 * 题库公开检索：只返回已发布版本与公开元数据，绝不含汤底与未解锁提示。
 * 投票计数与受欢迎排序（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §3）：
 * 得分 = 赞 − 踩；popular 依次按得分降序、赞数降序、首次发布时间降序、作品 ID 升序。
 * 公开署名投影：signature 显示已批准展示名，anonymous 只给「匿名作者」（name=null），
 * 内部 authorUserId 不出现在任何公开响应里。
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { and, asc, eq, isNotNull, lt, ne, or, sql, desc } from 'drizzle-orm';
import { randomPuzzleQuerySchema } from '@jev/contracts';
import { puzzles, puzzleVersions, ratings } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { Public } from '../common/public.js';
import { ZodValidationPipe } from '../common/http.js';
import { z } from 'zod';
import { publishedLanguageJoin } from './published-language.js';

const listQuerySchema = z.object({
  language: z.enum(['zh', 'en']).default('zh'),
  difficulty: z.string().optional(),
  sort: z.enum(['latest', 'popular']).default('latest'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** 每作品投票聚合（子查询联入列表；无投票为 0）。 */
function ratingsAggregate() {
  return app()
    .db.db.select({
      puzzleId: ratings.puzzleId,
      upCount: sql<number>`count(*) filter (where ${ratings.value} = 'up')::int`.as('up_count'),
      downCount: sql<number>`count(*) filter (where ${ratings.value} = 'down')::int`.as('down_count'),
    })
    .from(ratings)
    .groupBy(ratings.puzzleId)
    .as('ratings_agg');
}

/** 公开署名投影（含内部归属都不外泄；匿名时 name=null）。 */
function authorDisplayOf(mode: 'anonymous' | 'signature', name: string | null) {
  return { mode, name: mode === 'signature' ? name : null };
}

/** popular 排序的游标载荷：得分、赞数、首次发布时间、作品 ID。 */
function popularCursorOf(score: number, upCount: number, createdAt: Date, id: string): string {
  return `p:${score}:${upCount}:${createdAt.getTime()}:${id}`;
}

@Controller('puzzles')
export class CatalogController {
  /** 公开题库列表：latest 按作品 ID 游标；popular 按排序元组游标（排序字段 + 作品 ID）。 */
  @Public()
  @Get()
  async list(@Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    const agg = ratingsAggregate();
    const conditions = [
      eq(puzzles.unavailable, false),
      eq(puzzleVersions.language, query.language),
      isNotNull(puzzles.currentPublishedVersionId),
      eq(puzzleVersions.moderationStatus, 'published'),
    ];
    if (query.difficulty) conditions.push(eq(puzzleVersions.difficulty, query.difficulty));

    const scoreExpr = sql<number>`coalesce(${agg.upCount}, 0) - coalesce(${agg.downCount}, 0)`;
    const upExpr = sql<number>`coalesce(${agg.upCount}, 0)::int`;
    const downExpr = sql<number>`coalesce(${agg.downCount}, 0)::int`;

    let orderBy: ReturnType<typeof desc>[];
    if (query.sort === 'popular') {
      orderBy = [desc(scoreExpr), desc(upExpr), desc(puzzles.createdAt), asc(puzzles.id)];
      if (query.cursor) {
        const parts = query.cursor.split(':');
        if (parts[0] === 'p' && parts.length === 5 && parts.every((x) => x.length > 0)) {
          const [, score, upCount, createdAtMs, id] = parts;
          // 混合方向（DESC,DESC,DESC,ASC）的 keyset 谓词
          conditions.push(
            sql`(${scoreExpr} < ${Number(score)} or (${scoreExpr} = ${Number(score)} and (${upExpr} < ${Number(upCount)} or (${upExpr} = ${Number(upCount)} and (${puzzles.createdAt} < ${new Date(Number(createdAtMs))} or (${puzzles.createdAt} = ${new Date(Number(createdAtMs))} and ${puzzles.id} > ${id}))))))`,
          );
        } else {
          throw new DomainError('VALIDATION_FAILED', '游标格式不合法，请刷新列表');
        }
      }
    } else {
      // 最新发布：首次发布时间降序（UUID 无时序，不能当排序键）
      orderBy = [desc(puzzles.createdAt), desc(puzzles.id)];
      if (query.cursor) {
        const parts = query.cursor.split(':');
        if (parts[0] === 'l' && parts.length === 3) {
          const [, createdAtMs, id] = parts;
          conditions.push(
            sql`(${puzzles.createdAt} < ${new Date(Number(createdAtMs))} or (${puzzles.createdAt} = ${new Date(Number(createdAtMs))} and ${puzzles.id} < ${id}))`,
          );
        } else {
          throw new DomainError('VALIDATION_FAILED', '游标格式不合法，请刷新列表');
        }
      }
    }

    const rows = await app().db.db
      .select({
        id: puzzles.id,
        legacyId: puzzles.legacyId,
        title: puzzleVersions.title,
        surface: puzzleVersions.surface,
        difficulty: puzzleVersions.difficulty,
        durationMinutes: puzzleVersions.durationMinutes,
        contentWarnings: puzzleVersions.contentWarnings,
        language: puzzleVersions.language,
        versionId: puzzleVersions.id,
        authorMode: puzzles.authorDisplayMode,
        authorName: puzzles.authorDisplayName,
        createdAt: puzzles.createdAt,
        upCount: upExpr,
        downCount: downExpr,
      })
      .from(puzzles)
      .innerJoin(
        puzzleVersions,
        publishedLanguageJoin(),
      )
      .leftJoin(agg, eq(agg.puzzleId, puzzles.id))
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? query.sort === 'popular'
        ? popularCursorOf(last.upCount - last.downCount, last.upCount, last.createdAt, last.id)
        : `l:${last.createdAt.getTime()}:${last.id}`
      : null;
    return {
      items: items.map((row) => ({
        id: row.id,
        legacyId: row.legacyId,
        title: row.title,
        surface: row.surface,
        difficulty: row.difficulty,
        durationMinutes: row.durationMinutes,
        contentWarnings: row.contentWarnings,
        language: row.language,
        versionId: row.versionId,
        authorDisplay: authorDisplayOf(row.authorMode, row.authorName),
        upCount: row.upCount,
        downCount: row.downCount,
      })),
      nextCursor,
    };
  }

  /** 随机选取可游玩的当前语言作品，排除当前题目；与题库列表共用发布条件。 */
  @Public()
  @Get('random')
  async random(@Query(new ZodValidationPipe(randomPuzzleQuerySchema)) query: z.infer<typeof randomPuzzleQuerySchema>) {
    const conditions = [eq(puzzles.unavailable, false), eq(puzzleVersions.language, query.language)];
    if (query.exclude) conditions.push(ne(puzzles.id, query.exclude));
    const [selected] = await app().db.db
      .select({ puzzleId: puzzles.id })
      .from(puzzles)
      .innerJoin(puzzleVersions, publishedLanguageJoin())
      .where(and(...conditions))
      .orderBy(sql`random()`)
      .limit(1);
    if (!selected) throw new DomainError('NOT_FOUND', '暂无其他可游玩的题目');
    return selected;
  }

  /** 公开详情：公开题面与元数据、投票总数、公开署名；汤底与提示不在响应里。 */
  @Public()
  @Get(':id')
  async detail(@Param('id') id: string, @Query('language') language = 'zh') {
    if (!/^[0-9a-f-]{36}$/i.test(id) && !id.startsWith('seed-')) {
      throw new DomainError('NOT_FOUND', '题目不存在');
    }
    // 支持 legacyId（旧分享链接 ?soup=ID 兼容）与 uuid 两种查找
    const agg = ratingsAggregate();
    const row = await app().db.db
      .select({
        id: puzzles.id,
        legacyId: puzzles.legacyId,
        title: puzzleVersions.title,
        surface: puzzleVersions.surface,
        difficulty: puzzleVersions.difficulty,
        durationMinutes: puzzleVersions.durationMinutes,
        contentWarnings: puzzleVersions.contentWarnings,
        language: puzzleVersions.language,
        versionId: puzzleVersions.id,
        authorMode: puzzles.authorDisplayMode,
        authorName: puzzles.authorDisplayName,
        upCount: sql<number>`coalesce(${agg.upCount}, 0)::int`,
        downCount: sql<number>`coalesce(${agg.downCount}, 0)::int`,
      })
      .from(puzzles)
      .innerJoin(
        puzzleVersions,
        publishedLanguageJoin(),
      )
      .leftJoin(agg, eq(agg.puzzleId, puzzles.id))
      .where(
        and(
          eq(puzzles.unavailable, false),
          eq(puzzleVersions.moderationStatus, 'published'),
          sql`(${puzzles.id}::text = ${id} or ${puzzles.legacyId} = ${id})`,
          eq(puzzleVersions.language, language === 'en' ? 'en' : 'zh'),
        ),
      )
      .limit(1);

    if (row.length === 0) throw new DomainError('NOT_FOUND', '题目不存在或未发布');
    const item = row[0]!;
    return {
      id: item.id,
      legacyId: item.legacyId,
      title: item.title,
      surface: item.surface,
      difficulty: item.difficulty,
      durationMinutes: item.durationMinutes,
      contentWarnings: item.contentWarnings,
      language: item.language,
      versionId: item.versionId,
      authorDisplay: authorDisplayOf(item.authorMode, item.authorName),
      upCount: item.upCount,
      downCount: item.downCount,
    };
  }
}
