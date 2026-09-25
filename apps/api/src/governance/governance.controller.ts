/** 举报与评价：满足参与条件的用户可评价，每用户每题一条可修改。 */
import { Body, Controller, Param, Put, Post } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { puzzleVersions, ratings, reports, roundParticipants, rounds } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { z } from 'zod';

const reportSchema = z.object({
  objectType: z.enum(['turn', 'puzzle', 'room', 'discussion', 'user']),
  objectId: z.string().uuid(),
  reason: z.enum(['wrong_verdict', 'inappropriate_content', 'copyright', 'other']),
  detail: z.string().max(1000).optional(),
});

const ratingSchema = z.object({
  value: z.enum(['good', 'hard', 'bad']),
  review: z.string().max(500).optional(),
});

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

  /** 评价：需参与过该题的局——本局至少 1 次有效判题，或参与满 5 分钟。 */
  @Put('ratings/:puzzleId')
  async rate(
    @CurrentUser() user: SessionUser,
    @Param('puzzleId') puzzleId: string,
    @Body(new ZodValidationPipe(ratingSchema)) body: z.infer<typeof ratingSchema>,
  ) {
    const db = app().db;
    const rows = await db.db
      .select({
        roundId: rounds.id,
        joinedAt: roundParticipants.joinedAt,
        effectiveTurns: sql<number>`(
          select count(*)::int from turns t
          where t.round_id = rounds.id and t.user_id = ${user.userId} and t.status = 'succeeded'
        )`,
      })
      .from(roundParticipants)
      .innerJoin(rounds, eq(rounds.id, roundParticipants.roundId))
      .innerJoin(puzzleVersions, eq(puzzleVersions.id, rounds.puzzleVersionId))
      .where(and(eq(roundParticipants.userId, user.userId), eq(puzzleVersions.puzzleId, puzzleId)))
      .limit(1);

    const participation = rows[0];
    if (!participation) throw new DomainError('RATING_NOT_ALLOWED', '参与一局推理后才能评价这道题。');
    const fiveMinutesIn = participation.joinedAt.getTime() <= Date.now() - 5 * 60_000;
    if ((participation.effectiveTurns ?? 0) < 1 && !fiveMinutesIn) {
      throw new DomainError('RATING_NOT_ALLOWED', '本局至少提交 1 次有效提问，或参与满 5 分钟。');
    }

    await db.db
      .insert(ratings)
      .values({
        userId: user.userId,
        puzzleId,
        value: body.value,
        review: body.review ?? null,
        roundId: participation.roundId,
      })
      .onConflictDoUpdate({
        target: [ratings.userId, ratings.puzzleId],
        set: { value: body.value, review: body.review ?? null, updatedAt: new Date() },
      });
    return { ok: true };
  }
}
