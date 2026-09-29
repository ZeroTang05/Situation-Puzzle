/** 创作中心：作者保存、试题和提交独立版本，后台分别审核授权与内容后公开发布。 */
import { Body, Controller, Get, Param, Post, Patch, UseGuards } from '@nestjs/common';
import { SignJWT } from 'jose';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { puzzleRights, puzzleVersions, puzzles, moderationReviews, puzzleTestCases, type Database } from '@jev/database';
import { DomainError } from '@jev/domain';
import { authorDisplaySettingSchema, creationDraftSchema, creationSaveRequestSchema, creationCompleteSchema, creationSubmitRequestSchema, creationRevisionRequestSchema, creationLicenseVersion, type CreationDraft } from '@jev/contracts';
import { z } from 'zod';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { previewContentHash } from './preview-content.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Version = typeof puzzleVersions.$inferSelect;
type Condition = z.infer<typeof creationRevisionRequestSchema>;

/** 署名申请保留已批准的公开名字；匿名选项立即生效。 */
function authorSetting(display: CreationDraft['authorDisplay'], approvedName: string | null = null) {
  return display.mode === 'anonymous' ? { authorDisplayMode: 'anonymous' as const, authorDisplayName: null, authorPendingName: null } : { authorPendingName: display.name === approvedName ? null : display.name };
}
/** 题目正文与授权、署名分开保存。 */
function content(body: CreationDraft) {
  return { title: body.title, surface: body.surface, answer: body.answer, hints: body.hints, language: body.language, coreFacts: body.coreFacts, causalChain: body.causalChain, difficulty: body.difficulty };
}
/** 先锁作品再锁版本，版本条件避免旧页面覆盖新编辑。 */
async function lockCreation(tx: Tx, userId: string, puzzleId: string, condition: Condition) {
  const [puzzle] = await tx.select().from(puzzles).where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, userId))).for('update').limit(1);
  if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');
  const [latest] = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId)).orderBy(desc(puzzleVersions.versionNo), asc(puzzleVersions.language)).for('update').limit(1);
  if (!latest) throw new DomainError('NOT_FOUND', '作品版本缺失');
  if (latest.id !== condition.expectedVersionId || puzzle.updatedAt.getTime() !== new Date(condition.expectedUpdatedAt).getTime()) throw new DomainError('STATE_CONFLICT', '作品已在其它页面更新，请重新载入后编辑');
  return { puzzle, latest };
}
/** 只保存作者明确填写的标准用例，不保存私人试题对话。 */
async function saveCases(tx: Tx, versionId: string, cases: CreationDraft['testCases']) {
  await tx.delete(puzzleTestCases).where(eq(puzzleTestCases.versionId, versionId));
  if (cases.length) await tx.insert(puzzleTestCases).values(cases.map((item) => ({ versionId, ...item })));
}
/** 已提交版本的内容保留，修改通过复制新草稿完成。 */
async function forkDraft(tx: Tx, latest: Version) {
  const [next] = await tx.insert(puzzleVersions).values({ puzzleId: latest.puzzleId, versionNo: latest.versionNo + 1, language: latest.language, title: latest.title, surface: latest.surface, answer: latest.answer, hints: latest.hints, coreFacts: latest.coreFacts, causalChain: latest.causalChain, difficulty: latest.difficulty, contentWarnings: latest.contentWarnings, durationMinutes: latest.durationMinutes, moderationStatus: 'draft' }).returning();
  if (!next) throw new Error('创建新草稿失败');
  const cases = await tx.select().from(puzzleTestCases).where(eq(puzzleTestCases.versionId, latest.id));
  if (cases.length) await tx.insert(puzzleTestCases).values(cases.map((item) => ({ versionId: next.id, kind: item.kind, input: item.input, expected: item.expected, reason: item.reason, criticality: item.criticality })));
  await tx.update(puzzles).set({ updatedAt: new Date() }).where(eq(puzzles.id, latest.puzzleId));
  return { versionId: next.id, status: 'draft' as const };
}

@Controller('creations')
@UseGuards(SessionGuard)
export class CreationsController {
  /** 新建私有草稿；授权同意时间在正式提交时记录。 */
  @Post()
  async create(@CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(creationDraftSchema)) body: CreationDraft) {
    return app().db.tx(async (tx) => {
      const [puzzle] = await tx.insert(puzzles).values({ authorUserId: user.userId, source: 'community', ...authorSetting(body.authorDisplay) }).returning();
      if (!puzzle) throw new Error('创建作品失败');
      const [version] = await tx.insert(puzzleVersions).values({ puzzleId: puzzle.id, versionNo: 1, ...content(body), moderationStatus: 'draft' }).returning();
      if (!version) throw new Error('创建草稿失败');
      await saveCases(tx, version.id, body.testCases);
      await tx.insert(puzzleRights).values({ puzzleId: puzzle.id, status: 'pending', licenseBasis: body.licenseBasis, sourceUrl: body.sourceUrl || null, agreementVersion: creationLicenseVersion });
      return { puzzleId: puzzle.id, versionId: version.id };
    });
  }
  /** 先取每个作品的最新版本，再限制列表条数，保留真实赞踩反馈。 */
  @Get()
  async list(@CurrentUser() user: SessionUser) {
    const rows = await app().db.db.select({ puzzleId: puzzles.id, versionId: puzzleVersions.id, versionNo: puzzleVersions.versionNo, title: puzzleVersions.title, language: puzzleVersions.language, status: puzzleVersions.moderationStatus, updatedAt: puzzles.updatedAt, published: sql<boolean>`${puzzles.currentPublishedVersionId} is not null and not ${puzzles.unavailable}`, publishedLanguage: sql<string | null>`(select language from puzzle_versions where id = ${puzzles.currentPublishedVersionId})`, authorMode: puzzles.authorDisplayMode, authorName: puzzles.authorDisplayName, pendingName: puzzles.authorPendingName,
      upCount: sql<number>`(select count(*) filter (where r.value = 'up')::int from ratings r where r.puzzle_id = ${puzzles.id})`, downCount: sql<number>`(select count(*) filter (where r.value = 'down')::int from ratings r where r.puzzle_id = ${puzzles.id})`,
    }).from(puzzles).innerJoin(puzzleVersions, and(eq(puzzleVersions.puzzleId, puzzles.id), sql`${puzzleVersions.id} = (select v.id from puzzle_versions v where v.puzzle_id = ${puzzles.id} order by v.version_no desc, v.language asc limit 1)`)).where(eq(puzzles.authorUserId, user.userId)).orderBy(desc(puzzles.updatedAt), desc(puzzles.id)).limit(100);
    return { items: rows.map(({ authorMode, authorName, ...row }) => ({ ...row, authorDisplay: { mode: authorMode, name: authorMode === 'signature' ? authorName : null }, popularityScore: row.upCount - row.downCount })) };
  }
  /** 作者详情提供私有正文、版本材料及全部审核理由。 */
  @Get(':puzzleId')
  async detail(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string) {
    return app().db.tx(async (tx) => {
      const [puzzle] = await tx.select().from(puzzles).where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId))).limit(1);
      if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');
      const versions = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId)).orderBy(desc(puzzleVersions.versionNo), asc(puzzleVersions.language));
      const latest = versions[0];
      if (!latest) throw new DomainError('NOT_FOUND', '作品版本缺失');
      const [rights] = await tx.select().from(puzzleRights).where(eq(puzzleRights.puzzleId, puzzleId)).limit(1);
      if (!rights) throw new DomainError('NOT_FOUND', '授权记录缺失');
      const cases = await tx.select().from(puzzleTestCases).where(eq(puzzleTestCases.versionId, latest.id)).orderBy(asc(puzzleTestCases.createdAt), asc(puzzleTestCases.id));
      const reviews = await tx.select({ versionId: moderationReviews.versionId, stage: moderationReviews.stage, conclusion: moderationReviews.conclusion, reason: moderationReviews.reason, createdAt: moderationReviews.createdAt }).from(moderationReviews).where(inArray(moderationReviews.versionId, versions.map((version) => version.id))).orderBy(desc(moderationReviews.createdAt));
      const requestedName = puzzle.authorPendingName ?? puzzle.authorDisplayName;
      return { puzzleId, versionId: latest.id, versionNo: latest.versionNo, status: latest.moderationStatus, updatedAt: puzzle.updatedAt,
        draft: { title: latest.title, surface: latest.surface, answer: latest.answer, hints: latest.hints, language: latest.language, difficulty: latest.difficulty, coreFacts: latest.coreFacts, causalChain: latest.causalChain ?? '', licenseBasis: rights.licenseBasis, sourceUrl: rights.sourceUrl ?? '', testCases: cases.map((item) => ({ kind: item.kind, input: item.input, expected: item.expected, reason: item.reason ?? '', criticality: item.criticality })), authorDisplay: requestedName ? { mode: 'signature', name: requestedName } : { mode: 'anonymous' } },
        rights: { status: rights.status, agreementVersion: rights.agreementVersion, agreedAt: rights.agreedAt }, authorDisplay: { mode: puzzle.authorDisplayMode, name: puzzle.authorDisplayName, pendingName: puzzle.authorPendingName }, reviews,
        versions: versions.map((version) => ({ versionId: version.id, versionNo: version.versionNo, language: version.language, status: version.moderationStatus })),
      };
    });
  }
  /** 草稿保存检查版本条件；其它状态先复制新版本再编辑。 */
  @Patch(':puzzleId')
  async update(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string, @Body(new ZodValidationPipe(creationSaveRequestSchema)) body: z.infer<typeof creationSaveRequestSchema>) {
    return app().db.tx(async (tx) => {
      const { latest, puzzle } = await lockCreation(tx, user.userId, puzzleId, body);
      if (latest.moderationStatus !== 'draft') throw new DomainError('STATE_CONFLICT', '请先创建新草稿再编辑');
      await tx.update(puzzleVersions).set(content(body)).where(eq(puzzleVersions.id, latest.id));
      await saveCases(tx, latest.id, body.testCases);
      const [rights] = await tx.select().from(puzzleRights).where(eq(puzzleRights.puzzleId, puzzleId)).for('update').limit(1);
      if (!rights) throw new DomainError('NOT_FOUND', '授权记录缺失');
      if (rights.licenseBasis !== body.licenseBasis || (rights.sourceUrl ?? '') !== body.sourceUrl) await tx.update(puzzleRights).set({ licenseBasis: body.licenseBasis, sourceUrl: body.sourceUrl || null, status: 'pending', agreedAt: null, confirmedAt: null, confirmedBy: null }).where(eq(puzzleRights.id, rights.id));
      await tx.update(puzzles).set({ ...authorSetting(body.authorDisplay, puzzle.authorDisplayName), updatedAt: new Date() }).where(eq(puzzles.id, puzzleId));
      return { versionId: latest.id, status: 'draft' as const };
    });
  }
  /** 退回、发布和下架后的修改生成新版本，保留现有线上内容。 */
  @Post(':puzzleId/revise')
  async revise(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string, @Body(new ZodValidationPipe(creationRevisionRequestSchema)) body: Condition) {
    return app().db.tx(async (tx) => { const { latest } = await lockCreation(tx, user.userId, puzzleId, body); if (!['changes_requested', 'published', 'taken_down'].includes(latest.moderationStatus)) throw new DomainError('STATE_CONFLICT', '当前状态不能创建新草稿'); return forkDraft(tx, latest); });
  }
  /** 提交不可变版本及明确授权同意，完整性校验通过后才投递机器检查。 */
  @Post(':puzzleId/submit')
  async submit(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string, @Body(new ZodValidationPipe(creationSubmitRequestSchema)) body: z.infer<typeof creationSubmitRequestSchema>) {
    return app().db.tx(async (tx) => {
      const { puzzle, latest } = await lockCreation(tx, user.userId, puzzleId, body);
      if (latest.moderationStatus !== 'draft') throw new DomainError('STATE_CONFLICT', '只有草稿可以提交');
      const [rights] = await tx.select().from(puzzleRights).where(eq(puzzleRights.puzzleId, puzzleId)).for('update').limit(1);
      if (!rights) throw new DomainError('NOT_FOUND', '授权记录缺失');
      const cases = await tx.select().from(puzzleTestCases).where(eq(puzzleTestCases.versionId, latest.id));
      new ZodValidationPipe(creationCompleteSchema).transform({ ...latest, causalChain: latest.causalChain ?? '', testCases: cases, sourceUrl: rights.sourceUrl ?? '', licenseBasis: rights.licenseBasis, authorDisplay: puzzle.authorPendingName ? { mode: 'signature', name: puzzle.authorPendingName } : { mode: 'anonymous' } }, { type: 'body' });
      await tx.update(puzzleRights).set({ agreedAt: new Date(), agreementVersion: body.agreementVersion }).where(eq(puzzleRights.id, rights.id));
      await tx.update(puzzleVersions).set({ moderationStatus: 'submitted' }).where(eq(puzzleVersions.id, latest.id));
      await tx.update(puzzles).set({ updatedAt: new Date() }).where(eq(puzzles.id, puzzleId));
      await tx.insert(moderationReviews).values({ versionId: latest.id, stage: 'submit', conclusion: 'submitted', operatorUserId: user.userId });
      await app().queue.sendInTx(tx, 'review-puzzle', { versionId: latest.id });
      return { versionId: latest.id, status: 'submitted' as const };
    });
  }
  /** 撤回任一待审阶段，保留提交内容并复制可编辑的新草稿。 */
  @Post(':puzzleId/withdraw')
  async withdraw(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string, @Body(new ZodValidationPipe(creationRevisionRequestSchema)) body: Condition) {
    return app().db.tx(async (tx) => {
      const { latest } = await lockCreation(tx, user.userId, puzzleId, body);
      if (!['submitted', 'checking', 'pending_review'].includes(latest.moderationStatus)) throw new DomainError('STATE_CONFLICT', '只有待审核版本可以撤回');
      await tx.update(puzzleVersions).set({ moderationStatus: 'changes_requested' }).where(eq(puzzleVersions.id, latest.id));
      await tx.insert(moderationReviews).values({ versionId: latest.id, stage: 'withdraw', conclusion: 'withdrawn', reason: '作者撤回投稿', operatorUserId: user.userId });
      return forkDraft(tx, latest);
    });
  }
  /** 署名单独修改：匿名立即生效，展示名经审核后公开。 */
  @Patch(':puzzleId/author-display')
  async setAuthorDisplay(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string, @Body(new ZodValidationPipe(authorDisplaySettingSchema)) body: z.infer<typeof authorDisplaySettingSchema>) {
    const display = new ZodValidationPipe(creationDraftSchema.shape.authorDisplay).transform(body, { type: 'body' });
    return app().db.tx(async (tx) => {
      const [puzzle] = await tx.select().from(puzzles).where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId))).for('update').limit(1);
      if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在');
      const [fresh] = await tx.update(puzzles).set({ ...authorSetting(display, puzzle.authorDisplayName), updatedAt: new Date() }).where(eq(puzzles.id, puzzleId)).returning();
      if (!fresh) throw new Error('保存署名失败');
      return { mode: fresh.authorDisplayMode, name: fresh.authorDisplayName, pendingName: fresh.authorPendingName };
    });
  }
  /** 私人试题仅使用作者已保存内容，内容摘要使修改前的草稿凭证失效。 */
  @Post(':puzzleId/test-session')
  async testSession(@CurrentUser() user: SessionUser, @Param('puzzleId') puzzleId: string) {
    return app().db.tx(async (tx) => {
      const [puzzle] = await tx.select().from(puzzles).where(and(eq(puzzles.id, puzzleId), eq(puzzles.authorUserId, user.userId), eq(puzzles.unavailable, false))).for('share').limit(1);
      if (!puzzle) throw new DomainError('NOT_FOUND', '作品不存在或已停用');
      const [latest] = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.puzzleId, puzzleId)).orderBy(desc(puzzleVersions.versionNo), asc(puzzleVersions.language)).limit(1);
      if (!latest || !latest.surface.trim() || !latest.answer.trim()) throw new DomainError('VALIDATION_FAILED', '请先保存汤面和汤底再试题');
      const context = app(); const contentHash = previewContentHash(latest); const configVersion = `${context.jev.model}@${context.jev.promptVersion}@t${context.jev.threshold}`;
      const token = await new SignJWT({ purpose: 'solo_preview', pv: latest.id, lang: latest.language, cfg: configVersion, contentHash }).setProtectedHeader({ alg: 'HS256' }).setIssuer('jev-solo').setIssuedAt().setExpirationTime('2h').sign(new TextEncoder().encode(context.env.SOLO_TOKEN_SECRET));
      return { token, versionId: latest.id, language: latest.language, title: latest.title, surface: latest.surface, hintsTotal: latest.hints.length, configVersion, contentHash };
    });
  }
}
