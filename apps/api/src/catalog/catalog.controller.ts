/** 题库公开检索：只返回已发布版本与公开元数据，绝不含汤底与未解锁提示。 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { and, eq, isNotNull, lt, or, sql, desc } from 'drizzle-orm';
import { puzzles, puzzleVersions } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { Public } from '../common/public.js';
import { ZodValidationPipe } from '../common/http.js';
import { z } from 'zod';

const listQuerySchema = z.object({
  language: z.enum(['zh', 'en']).default('zh'),
  difficulty: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

@Controller('puzzles')
export class CatalogController {
  /** 公开题库列表：稳定排序（id 游标），已玩标记由前端本地合并。 */
  @Public()
  @Get()
  async list(@Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    const conditions = [
      eq(puzzles.unavailable, false),
      eq(puzzleVersions.language, query.language),
      isNotNull(puzzles.currentPublishedVersionId),
      eq(puzzleVersions.moderationStatus, 'published'),
    ];
    if (query.difficulty) conditions.push(eq(puzzleVersions.difficulty, query.difficulty));
    if (query.cursor) conditions.push(or(lt(puzzles.id, query.cursor))!);

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
      })
      .from(puzzles)
      .innerJoin(
        puzzleVersions,
        and(eq(puzzleVersions.puzzleId, puzzles.id), eq(puzzleVersions.id, puzzles.currentPublishedVersionId)),
      )
      .where(and(...conditions))
      .orderBy(desc(puzzles.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  /** 公开详情：公开题面与元数据；汤底与提示不在响应里。 */
  @Public()
  @Get(':id')
  async detail(@Param('id') id: string, @Query('language') language = 'zh') {
    if (!/^[0-9a-f-]{36}$/i.test(id) && !id.startsWith('seed-')) {
      throw new DomainError('NOT_FOUND', '题目不存在');
    }
    // 支持 legacyId（旧分享链接 ?soup=ID 兼容）与 uuid 两种查找
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
      })
      .from(puzzles)
      .innerJoin(
        puzzleVersions,
        and(eq(puzzleVersions.puzzleId, puzzles.id), eq(puzzleVersions.id, puzzles.currentPublishedVersionId)),
      )
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
    return row[0];
  }
}
