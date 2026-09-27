/**
 * 创作中心：草稿、提交审核、撤回、私人试题凭证、署名与作品反馈（docs/rebuild/01-PRD.md §4、11-VOTES-AND-AUTHORSHIP.md §4/§5）。
 * 作者不能直接发布；提交后内容不可变（修改产生新版本）。试题对话只存浏览器。
 * 署名：作品级设置，新稿默认匿名；改为署名或修改展示名进入审核（pendingName），
 * 改回匿名立即生效。匿名只影响公开投影，作者归属始终在服务端。
 */
import { Body, Controller, Get, Param, Post, Patch } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { SignJWT } from 'jose';
import { and, desc, eq, sql } from 'drizzle-orm';
import { puzzleRights, puzzleVersions, puzzles, moderationReviews, ratings } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { authorDisplaySettingSchema } from '@jev/contracts';
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
  /** 署名设置（可选）：signature 时 name 必填 1～30 字符，进审核后生效 */
  authorDisplay: z.object({ mode: z.enum(['anonymous', 'signature']), name: z.string().optional() }).optional(),
});

const AGREE_VERSION = 'ugc-license-v1';

/** 应用署名设置：匿名立即生效；署名/改名写入待审（作品保存时由内容审核一并批准）。 */
function applyAuthorDisplay(
  mode: 'anonymous' | 'signature',
  name: string | undefined,
): { authorDisplayMode: 'anonymous' | 'signature'; authorDisplayName: string | null; authorPendingName: string | null } {
  if (mode === 'anonymous') {
    return { authorDisplayMode: 'anonymous', authorDisplayName: null, authorPendingName: null };
  }
  const trimmed = name?.trim() ?? '';
  if (trimmed.length < 1 || trimmed.length > 30) {
    throw new DomainError('VALIDATION_FAILED', '署名展示名需要 1～30 个字符');
  }
  // 待审名字独立保存；当前公开状态保持不变，等审核通过后切换
  return { authorDisplayMode: 'anonymous', authorDisplayName: null, authorPendingName: trimmed };
}

@Controller('creations')
@UseGuards(SessionGuard)
export class CreationsController {
  /** 创建草稿：作品 + v1 草稿版本 + 授权声明记录；署名默认匿名，可主动开启（进审核）。 */
  @Post()
  async create(@CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(draftSchema)) body: z.infer<typeof draftSchema>) {
    const db = app().db;
    return db.tx(async (tx) => {
      const display = body.authorDisplay
        ? applyAuthorDisplay(body.authorDisplay.mode, body.authorDisplay.name)
        : { authorDisplayMode: 'anonymous' as const, authorDisplayName: null, authorPendingName: null };
      const [puzzle] = await tx
        .insert(puzzles)
        .values({ authorUserId: user.userId, source: 'community', ...display })
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
        authorMode: puzzles.authorDisplayMode,
        authorName: puzzles.authorDisplayName,
        pendingName: puzzles.authorPendingName,
        upCount: sql<number>`(select count(*) filter (where r.value = 'up')::int from ratings r where r.puzzle_id = ${puzzles.id})`,
        downCount: sql<number>`(select count(*) filter (where r.value = 'down')::int from ratings r where r.puzzle_id = ${puzzles.id})`,
      })
      .from(puzzles)
      .innerJoin(puzzleVersions, eq(puzzleVersions.puzzleId, puzzles.id))
      .where(eq(puzzles.authorUserId, user.userId))
      .orderBy(desc(puzzles.updatedAt))
      .limit(100);
    // 每个作品取最新版本（列表按作品聚合，旧版本行丢弃）
    const latestByPuzzle = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = latestByPuzzle.get(row.puzzleId);
      if (!existing || row.versionNo > existing.versionNo) latestByPuzzle.set(row.puzzleId, row);
    }
    return {
      items: [...latestByPuzzle.values()].map((row) => ({
        puzzleId: row.puzzleId,
        versionId: row.versionId,
        versionNo: row.versionNo,
        title: row.title,
        language: row.language,
        status: row.status,
        updatedAt: row.updatedAt,
        authorDisplay: { mode: row.authorMode, name: row.authorMode === 'signature' ? row.authorName : null },
        pendingName: row.pendingName,
        upCount: row.upCount,
        downCount: row.downCount,
        popularityScore: row.upCount - row.downCount,
      })),
    };
  }

  /** 署名设置：匿名立即生效；署名或改名写入待审，经后台审核后公开。 */
  @Patch(':puzzleId/author-display')
  async setAuthorDisplay(
    @CurrentUser() user: SessionUser,
    @Param('puzzleId') puzzleId: string,
    @Body(new ZodValidationPipe(authorDisplaySettingSchema)) body: z.infer<typeof authorDisplaySettingSchema>,
  ) {
    const db = app().db;
    const [puzzle] = await db.db
      .select({ id: puzzles.id })
      .from(puzzles)
      .where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId)))
      .limit(1);
    if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');

    if (body.mode === 'anonymous') {
      // 已发布作品改为匿名立即生效；同时清掉未决的署名申请
      await db.db
        .update(puzzles)
        .set({ authorDisplayMode: 'anonymous', authorDisplayName: null, authorPendingName: null, updatedAt: new Date() })
        .where(eq(puzzles.id, puzzleId));
      return { mode: 'anonymous' as const, name: null, pendingName: null };
    }
    const trimmed = body.name?.trim() ?? '';
    if (trimmed.length < 1 || trimmed.length > 30) {
      throw new DomainError('VALIDATION_FAILED', '署名展示名需要 1～30 个字符');
    }
    // 首次署名请求（当前匿名且无已批准名）：等待审核期间保留匿名公开状态
    await db.db
      .update(puzzles)
      .set({ authorPendingName: trimmed, updatedAt: new Date() })
      .where(eq(puzzles.id, puzzleId));
    const [fresh] = await db.db
      .select({ mode: puzzles.authorDisplayMode, name: puzzles.authorDisplayName })
      .from(puzzles)
      .where(eq(puzzles.id, puzzleId))
      .limit(1);
    return { mode: fresh!.mode, name: fresh!.mode === 'signature' ? fresh!.name : null, pendingName: trimmed };
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

      // 署名设置随草稿保存：匿名立即生效；署名写入待审
      if (body.authorDisplay) {
        await tx.update(puzzles).set(applyAuthorDisplay(body.authorDisplay.mode, body.authorDisplay.name)).where(eq(puzzles.id, puzzleId));
      }

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
