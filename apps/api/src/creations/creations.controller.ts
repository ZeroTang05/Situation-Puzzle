/**
 * 创作中心：草稿、提交审核、撤回、私人试题凭证（docs/rebuild/01-PRD.md §4）。
 * 作者不能直接发布；提交后内容不可变（修改产生新版本）。试题对话只存浏览器。
 */
import { Body, Controller, Get, Param, Post, Patch } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { SignJWT } from 'jose';
import { and, desc, eq } from 'drizzle-orm';
import { puzzleRights, puzzleVersions, puzzles, moderationReviews } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { z } from 'zod';

const draftSchema = z.object({
  title: z.string().min(1).max(60),
  surface: z.string().min(1).max(2000),
  answer: z.string().min(1).max(4000),
  hints: z.array(z.string().min(1).max(500)).max(3),
  language: z.enum(['zh', 'en']).default('zh'),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  licenseBasis: z.string().min(1).max(500),
  coreFacts: z.array(z.string().max(300)).max(10).default([]),
});

const AGREE_VERSION = 'ugc-license-v1';

@Controller('creations')
@UseGuards(SessionGuard)
export class CreationsController {
  /** 创建草稿：作品 + v1 草稿版本 + 授权声明记录。 */
  @Post()
  async create(@CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(draftSchema)) body: z.infer<typeof draftSchema>) {
    const db = app().db;
    return db.tx(async (tx) => {
      const [puzzle] = await tx
        .insert(puzzles)
        .values({ authorUserId: user.userId, source: 'community' })
        .returning({ id: puzzles.id });
      const [version] = await tx
        .insert(puzzleVersions)
        .values({
          puzzleId: puzzle!.id,
          versionNo: 1,
          language: body.language,
          title: body.title,
          surface: body.surface,
          answer: body.answer,
          hints: body.hints,
          coreFacts: body.coreFacts,
          difficulty: body.difficulty ?? null,
          moderationStatus: 'draft',
        })
        .returning({ id: puzzleVersions.id });
      await tx.insert(puzzleRights).values({
        puzzleId: puzzle!.id,
        status: 'pending',
        licenseBasis: body.licenseBasis,
        agreementVersion: AGREE_VERSION,
        agreedAt: new Date(),
      });
      return { puzzleId: puzzle!.id, versionId: version!.id };
    });
  }

  @Get()
  async list(@CurrentUser() user: SessionUser) {
    const rows = await app().db.db
      .select({
        puzzleId: puzzles.id,
        versionId: puzzleVersions.id,
        versionNo: puzzleVersions.versionNo,
        title: puzzleVersions.title,
        language: puzzleVersions.language,
        status: puzzleVersions.moderationStatus,
        updatedAt: puzzles.updatedAt,
      })
      .from(puzzles)
      .innerJoin(puzzleVersions, eq(puzzleVersions.puzzleId, puzzles.id))
      .where(eq(puzzles.authorUserId, user.userId))
      .orderBy(desc(puzzles.updatedAt))
      .limit(100);
    return { items: rows };
  }

  /** 更新草稿：只有 draft / changes_requested 状态可改；提交后的版本不可变。 */
  @Patch(':puzzleId')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('puzzleId') puzzleId: string,
    @Body(new ZodValidationPipe(draftSchema)) body: z.infer<typeof draftSchema>,
  ) {
    const db = app().db;
    return db.tx(async (tx) => {
      const [puzzle] = await tx
        .select()
        .from(puzzles)
        .where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId)))
        .limit(1);
      if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');

      const versions = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId)).orderBy(desc(puzzleVersions.versionNo));
      const latest = versions[0];
      if (!latest) throw new DomainError('NOT_FOUND', '作品版本缺失');
      if (latest.moderationStatus !== 'draft' && latest.moderationStatus !== 'changes_requested') {
        throw new DomainError('STATE_CONFLICT', '当前版本在审核中或已发布，修改会产生新版本');
      }

      if (latest.moderationStatus === 'draft') {
        await tx
          .update(puzzleVersions)
          .set({
            title: body.title,
            surface: body.surface,
            answer: body.answer,
            hints: body.hints,
            coreFacts: body.coreFacts,
            difficulty: body.difficulty ?? null,
          })
          .where(eq(puzzleVersions.id, latest.id));
        return { versionId: latest.id, status: 'draft' as const };
      }

      // changes_requested → 产生新版本
      const [next] = await tx
        .insert(puzzleVersions)
        .values({
          puzzleId,
          versionNo: latest.versionNo + 1,
          language: body.language,
          title: body.title,
          surface: body.surface,
          answer: body.answer,
          hints: body.hints,
          coreFacts: body.coreFacts,
          difficulty: body.difficulty ?? null,
          moderationStatus: 'draft',
        })
        .returning({ id: puzzleVersions.id });
      return { versionId: next!.id, status: 'draft' as const };
    });
  }

  /** 提交审核：版本转 submitted（不可变），等待机器检查 + 人工审核。 */
  @Post(':puzzleId/submit')
  async submit(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string) {
    const db = app().db;
    return db.tx(async (tx) => {
      const [puzzle] = await tx
        .select()
        .from(puzzles)
        .where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId)))
        .limit(1);
      if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');

      const versions = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId)).orderBy(desc(puzzleVersions.versionNo));
      const latest = versions[0];
      if (!latest || (latest.moderationStatus !== 'draft' && latest.moderationStatus !== 'changes_requested')) {
        throw new DomainError('STATE_CONFLICT', '没有可提交的草稿版本');
      }
      await tx.update(puzzleVersions).set({ moderationStatus: 'submitted' }).where(eq(puzzleVersions.id, latest.id));
      await tx.insert(moderationReviews).values({
        versionId: latest.id,
        stage: 'submit',
        conclusion: 'submitted',
        operatorUserId: user.userId,
      });
      // 机器检查任务（jobs 进程）：Jev 辅助检查 → pending_review 或 changes_requested
      await app().queue.sendInTx(tx, 'review-puzzle', { versionId: latest.id });
      return { versionId: latest.id, status: 'submitted' as const };
    });
  }

  /** 撤回待审版本：回到草稿。 */
  @Post(':puzzleId/withdraw')
  async withdraw(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string) {
    const db = app().db;
    const [puzzle] = await db.db
      .select()
      .from(puzzles)
      .where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId)))
      .limit(1);
    if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');
    const versions = await db.db.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId)).orderBy(desc(puzzleVersions.versionNo));
    const latest = versions[0];
    if (!latest || latest.moderationStatus !== 'submitted') {
      throw new DomainError('STATE_CONFLICT', '只有待审核版本可以撤回');
    }
    await db.db.update(puzzleVersions).set({ moderationStatus: 'draft' }).where(eq(puzzleVersions.id, latest.id));
    return { versionId: latest.id, status: 'draft' as const };
  }

  /** 私人试题凭证：绑定本人草稿的短期令牌；试题判题请求不再携带账号。 */
  @Post(':puzzleId/test-session')
  async testSession(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string) {
    const db = app().db;
    const [puzzle] = await db.db
      .select()
      .from(puzzles)
      .where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId)))
      .limit(1);
    if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');
    const versions = await db.db.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId)).orderBy(desc(puzzleVersions.versionNo));
    const latest = versions[0];
    if (!latest) throw new DomainError('NOT_FOUND', '作品版本缺失');

    const context = app();
    const token = await new SignJWT({
      purpose: 'solo_preview',
      pv: latest.id,
      lang: latest.language,
      cfg: `${context.jev.model}@${context.jev.promptVersion}@t${context.jev.threshold}`,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('jev-solo')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(new TextEncoder().encode(context.env.SOLO_TOKEN_SECRET));

    return {
      token,
      versionId: latest.id,
      language: latest.language as 'zh' | 'en',
      title: latest.title,
      surface: latest.surface,
      hintsTotal: latest.hints.length,
      configVersion: `${context.jev.model}@${context.jev.promptVersion}@t${context.jev.threshold}`,
    };
  }
}
