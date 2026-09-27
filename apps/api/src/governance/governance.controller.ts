/**
 * 举报与题目投票（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §2/§6）。
 *
 * 投票规则：登录用户对已发布可访问作品直接投票，每账号每题一票（up/down），
 * PUT 明确设置、DELETE 取消；作者不能给自己的作品投票（匿名作者按内部归属校验）。
 * 不要求多人游玩记录，也不上传单人凭证或进度；统计由服务端按作品聚合。
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Res } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { puzzles, puzzleVersions, ratings, reports } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ratingPutRequestSchema, voteValueSchema } from '@jev/contracts';
import { z } from 'zod';

const reportSchema = z.object({
  objectType: z.enum(['turn', 'puzzle', 'room', 'discussion', 'user']),
  objectId: z.string().uuid(),
  reason: z.enum(['wrong_verdict', 'inappropriate_content', 'copyright', 'other']),
  detail: z.string().max(1000).optional(),
});

/** 从数据库聚合某作品的赞/踩计数（首发直接聚合，需要时再加统计表）。 */
async function statsOf(puzzleId: string): Promise<{ upCount: number; downCount: number }> {
  const [row] = await app().db.db
    .select({
      upCount: sql<number>`count(*) filter (where ${ratings.value} = 'up')::int`,
      downCount: sql<number>`count(*) filter (where ${ratings.value} = 'down')::int`,
    })
    .from(ratings)
    .where(eq(ratings.puzzleId, puzzleId));
  return { upCount: row?.upCount ?? 0, downCount: row?.downCount ?? 0 };
}

@Controller()
@UseGuards(SessionGuard)
export class GovernanceController {
  @Post('reports')
  async report(@CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(reportSchema)) body: z.infer<typeof reportSchema>) {
    const [row] = await app().db.db
      .insert(reports)
      .values({
        reporterUserId: user.userId,
        objectType: body.objectType,
        objectId: body.objectId,
        reason: body.reason,
        detail: body.detail ?? null,
      })
      .returning({ id: reports.id });
    return { reportId: row!.id };
  }

  /** 校验作品可投票：已发布、可访问、存在；作者（含匿名作者按内部归属）自投拒绝。 */
  private async assertVotable(userId: string, puzzleId: string): Promise<{ votedVersionId: string | null }> {
    const [puzzle] = await app().db.db
      .select({
        authorUserId: puzzles.authorUserId,
        unavailable: puzzles.unavailable,
        currentPublishedVersionId: puzzles.currentPublishedVersionId,
        moderationStatus: puzzleVersions.moderationStatus,
      })
      .from(puzzles)
      .innerJoin(
        puzzleVersions,
        and(eq(puzzleVersions.puzzleId, puzzles.id), eq(puzzleVersions.id, puzzles.currentPublishedVersionId)),
      )
      .where(eq(puzzles.id, puzzleId))
      .limit(1);
    if (!puzzle || puzzle.unavailable || puzzle.moderationStatus !== 'published') {
      throw new DomainError('NOT_FOUND', '题目不存在或不可投票');
    }
    if (puzzle.authorUserId && puzzle.authorUserId === userId) {
      throw new DomainError('FORBIDDEN', '不能给自己的作品投票');
    }
    return { votedVersionId: puzzle.currentPublishedVersionId };
  }

  /** 查询本人选择与最新统计（只向本人返回 choice，禁止公共缓存）。 */
  @Get('ratings/:puzzleId')
  async myRating(@Res({ passthrough: true }) res: Response, @CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string) {
    res.header('Cache-Control', 'no-store');
    const stats = await statsOf(puzzleId);
    const [mine] = await app().db.db
      .select({ value: ratings.value })
      .from(ratings)
      .where(and(eq(ratings.userId, user.userId), eq(ratings.puzzleId, puzzleId)))
      .limit(1);
    return { choice: mine?.value ?? null, ...stats };
  }

  /** 设置投票：同值重试不累加（唯一约束 + upsert 覆盖），并发切换以服务端最后提交为准。 */
  @Put('ratings/:puzzleId')
  async rate(
    @CurrentUser() user: SessionUser,
    @Param('puzzleId') puzzleId: string,
    @Body(new ZodValidationPipe(ratingPutRequestSchema)) body: z.infer<typeof ratingPutRequestSchema>,
  ) {
    const { votedVersionId } = await this.assertVotable(user.userId, puzzleId);
    await app().db.db
      .insert(ratings)
      .values({ userId: user.userId, puzzleId, value: body.value, votedVersionId: votedVersionId ?? null })
      .onConflictDoUpdate({
        target: [ratings.userId, ratings.puzzleId],
        set: { value: body.value, votedVersionId: votedVersionId ?? null, updatedAt: new Date() },
      });
    return { choice: body.value as z.infer<typeof voteValueSchema>, ...(await statsOf(puzzleId)) };
  }

  /** 取消投票：重复删除结果一致。 */
  @Delete('ratings/:puzzleId')
  async cancel(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string) {
    await app().db.db
      .delete(ratings)
      .where(and(eq(ratings.userId, user.userId), eq(ratings.puzzleId, puzzleId)));
    return { choice: null, ...(await statsOf(puzzleId)) };
  }
}
