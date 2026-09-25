/**
 * 管理后台接口：全部经角色守卫与审计（docs/rebuild/05-OPERATIONS.md §8）。
 * 操作必须带理由并留审计记录；禁止绕过业务状态直接改数据。
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  activeRoomUsers,
  auditLogs,
  jevCalls,
  orders,
  puzzleRights,
  puzzleVersions,
  puzzles,
  profiles,
  reports,
  refunds,
  roomEvents,
  rooms,
  rounds,
  releaseEntitlementIfReservedTx,
  sponsorGrants,
  sponsorLedger,
  turns,
  user,
} from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, RequireRoles, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { z } from 'zod';

const reasonSchema = z.object({ reason: z.string().min(2).max(500) });
const grantSchema = z.object({ months: z.number().int().min(1).max(12), reason: z.string().min(2).max(500) });

@Controller('admin')
@UseGuards(SessionGuard)
export class AdminController {
  /** 审计：操作留痕（docs/rebuild/03-SPEC.md §5.2）。 */
  private async audit(operator: SessionUser, action: string, objectType: string, objectId: string | null, reason: string, after?: Record<string, unknown>) {
    await app().db.db.insert(auditLogs).values({
      operatorUserId: operator.userId,
      action,
      objectType,
      objectId,
      reason,
      afterSummary: after,
    });
  }

  // ---------- 题库与投稿审核 ----------

  @Get('puzzles')
  @RequireRoles('admin', 'moderator')
  async listPuzzles(@Query('status') status?: string) {
    const conditions = [eq(puzzles.unavailable, false)];
    if (status) conditions.push(eq(puzzleVersions.moderationStatus, status as never));
    const rows = await app().db.db
      .select({
        puzzleId: puzzles.id,
        versionId: puzzleVersions.id,
        versionNo: puzzleVersions.versionNo,
        language: puzzleVersions.language,
        title: puzzleVersions.title,
        surface: puzzleVersions.surface,
        status: puzzleVersions.moderationStatus,
        authorUserId: puzzles.authorUserId,
        rightsStatus: puzzleRights.status,
        createdAt: puzzleVersions.createdAt,
      })
      .from(puzzles)
      .innerJoin(
        puzzleVersions,
        and(eq(puzzleVersions.puzzleId, puzzles.id), sql`puzzle_versions.id = (select id from puzzle_versions v where v.puzzle_id = puzzles.id order by v.version_no desc limit 1)`),
      )
      .leftJoin(puzzleRights, eq(puzzleRights.puzzleId, puzzles.id))
      .where(and(...conditions))
      .orderBy(desc(puzzleVersions.createdAt))
      .limit(100);
    return { items: rows };
  }

  @Get('puzzle-versions/:id')
  @RequireRoles('admin', 'moderator')
  async versionDetail(@Param('id') id: string) {
    const rows = await app().db.db.select().from(puzzleVersions).where(eq(puzzleVersions.id, id)).limit(1);
    if (rows.length === 0) throw new DomainError('NOT_FOUND', '版本不存在');
    const rights = await app().db.db.select().from(puzzleRights).where(eq(puzzleRights.puzzleId, rows[0]!.puzzleId)).limit(1);
    return { version: rows[0], rights: rights[0] ?? null };
  }

  /** 批准发布：商业授权与质量审核均需通过；同事务设置发布指针。 */
  @Post('puzzle-versions/:id/approve')
  @RequireRoles('admin', 'moderator')
  async approve(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    const db = app().db;
    const result = await db.tx(async (tx) => {
      const [version] = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.id, id)).for('update').limit(1);
      if (!version) throw new DomainError('NOT_FOUND', '版本不存在');
      const [rights] = await tx.select().from(puzzleRights).where(eq(puzzleRights.puzzleId, version.puzzleId)).for('update').limit(1);
      if (!rights || rights.status !== 'approved') {
        throw new DomainError('STATE_CONFLICT', '商业授权未通过，不能发布');
      }
      await tx.update(puzzleVersions).set({ moderationStatus: 'published' }).where(eq(puzzleVersions.id, id));
      await tx.update(puzzles).set({ currentPublishedVersionId: id, updatedAt: new Date() }).where(eq(puzzles.id, version.puzzleId));
      await tx.insert(auditLogs).values({ operatorUserId: operator.userId, action: 'puzzle.approve', objectType: 'puzzle_version', objectId: id, reason: body.reason });
      return { puzzleId: version.puzzleId };
    });
    return result;
  }

  @Post('puzzle-versions/:id/reject')
  @RequireRoles('admin', 'moderator')
  async reject(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    const db = app().db;
    const [version] = await db.db.select().from(puzzleVersions).where(eq(puzzleVersions.id, id)).limit(1);
    if (!version) throw new DomainError('NOT_FOUND', '版本不存在');
    await db.db.update(puzzleVersions).set({ moderationStatus: 'changes_requested' }).where(eq(puzzleVersions.id, id));
    await this.audit(operator, 'puzzle.reject', 'puzzle_version', id, body.reason);
    return { ok: true };
  }

  /** 下架：只影响新开局；进行中的局可用固定版本完成。 */
  @Post('puzzles/:id/takedown')
  @RequireRoles('admin', 'moderator')
  async takedown(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    await app().db.db.update(puzzles).set({ unavailable: true, updatedAt: new Date() }).where(eq(puzzles.id, id));
    await this.audit(operator, 'puzzle.takedown', 'puzzle', id, body.reason);
    return { ok: true };
  }

  // ---------- 用户 ----------

  @Get('users')
  @RequireRoles('admin', 'support')
  async listUsers(@Query('q') q?: string) {
    const conditions = q ? [sql`email ilike ${'%' + q + '%'} or nickname ilike ${'%' + q + '%'}`] : [];
    const rows = await app().db.db
      .select({
        userId: user.id,
        email: user.email,
        nickname: profiles.nickname,
        status: profiles.status,
        createdAt: profiles.createdAt,
      })
      .from(user)
      .innerJoin(profiles, eq(profiles.userId, user.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(profiles.createdAt))
      .limit(50);
    return { items: rows };
  }

  @Post('users/:id/suspend')
  @RequireRoles('admin')
  async suspend(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    await app().db.db.update(profiles).set({ status: 'suspended', updatedAt: new Date() }).where(eq(profiles.userId, id));
    await this.audit(operator, 'user.suspend', 'user', id, body.reason);
    return { ok: true };
  }

  @Post('users/:id/unsuspend')
  @RequireRoles('admin')
  async unsuspend(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    await app().db.db.update(profiles).set({ status: 'active', updatedAt: new Date() }).where(eq(profiles.userId, id));
    await this.audit(operator, 'user.unsuspend', 'user', id, body.reason);
    return { ok: true };
  }

  /** 测试赞助授权：明确标记 test 类型，与正式订单分开；不发正式授权。 */
  @Post('users/:id/test-grant')
  @RequireRoles('admin')
  async testGrant(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(grantSchema)) body: z.infer<typeof grantSchema>) {
    const db = app().db;
    const result = await db.tx(async (tx) => {
      const now = new Date();
      const until = new Date(now.getTime() + body.months * 30 * 24 * 3600_000);
      const [grant] = await tx
        .insert(sponsorGrants)
        .values({ userId: id, type: 'test', status: 'active', effectiveFrom: now, effectiveUntil: until })
        .returning({ id: sponsorGrants.id });
      await tx.insert(sponsorLedger).values({
        userId: id,
        action: 'grant',
        grantId: grant!.id,
        detail: { test: true, months: body.months, operator: operator.userId },
        idempotencyKey: `test-grant:${grant!.id}`,
      });
      await tx.insert(auditLogs).values({ operatorUserId: operator.userId, action: 'sponsor.test_grant', objectType: 'user', objectId: id, reason: body.reason });
      return { grantId: grant!.id, until: until.toISOString() };
    });
    return result;
  }

  // ---------- 房间 ----------

  @Get('rooms')
  @RequireRoles('admin', 'support')
  async listRooms(@Query('status') status?: string) {
    const rows = await app().db.db
      .select({
        roomId: rooms.id,
        status: rooms.status,
        creatorUserId: rooms.creatorUserId,
        hostUserId: rooms.hostUserId,
        capacity: rooms.capacity,
        createdAt: rooms.createdAt,
        closedAt: rooms.closedAt,
        closeReason: rooms.closeReason,
        memberCount: sql<number>`(select count(*)::int from room_members m where m.room_id = rooms.id and m.status = 'joined')`,
        activeRoundId: sql<string | null>`(select r.id from rounds r where r.room_id = rooms.id and r.status = 'active' limit 1)`,
      })
      .from(rooms)
      .where(status ? eq(rooms.status, status as never) : undefined)
      .orderBy(desc(rooms.createdAt))
      .limit(100);
    return { items: rows };
  }

  @Get('rooms/:id/timeline')
  @RequireRoles('admin', 'support')
  async roomTimeline(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Query('reason') reason: string) {
    if (!reason || reason.length < 2) throw new DomainError('VALIDATION_FAILED', '查看房间内容必须填写调查理由');
    const [room] = await app().db.db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
    if (!room) throw new DomainError('NOT_FOUND', '房间不存在');
    const events = await app().db.db.select().from(roomEvents).where(eq(roomEvents.roomId, id)).orderBy(roomEvents.seq).limit(500);
    const roundRows = await app().db.db.select().from(rounds).where(eq(rounds.roomId, id));
    await this.audit(operator, 'room.investigate', 'room', id, reason, { events: events.length });
    return { room, rounds: roundRows, events };
  }

  /** 运营强制结束：按系统中止规则处理（aborted + 释放/退回由关闭逻辑统一处理）。 */
  @Post('rooms/:id/force-close')
  @RequireRoles('admin')
  async forceClose(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    const db = app().db;
    await db.tx(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, id)).for('update').limit(1);
      if (!room) throw new DomainError('NOT_FOUND', '房间不存在');
      if (room.status === 'closed') throw new DomainError('ROOM_CLOSED', '房间已关闭');
      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.roomId, id), eq(rounds.status, 'active')))
        .limit(1);
      const now = new Date();
      if (round) {
        await tx.update(rounds).set({ status: 'aborted', endedAt: now, endReason: 'moderation' }).where(eq(rounds.id, round.id));
        await tx.update(rounds).set({ cancelGeneration: sql`${rounds.cancelGeneration} + 1` }).where(eq(rounds.id, round.id));
        await tx
          .update(turns)
          .set({ status: 'cancelled', completedAt: now })
          .where(and(eq(turns.roundId, round.id), sql`status in ('queued','processing')`));
      }
      await releaseEntitlementIfReservedTx(tx, id);
      await tx.update(rooms).set({ status: 'closed', closedAt: now, closeReason: 'moderation' }).where(eq(rooms.id, id));
      await tx.delete(activeRoomUsers).where(eq(activeRoomUsers.roomId, id));
      await tx.insert(auditLogs).values({ operatorUserId: operator.userId, action: 'room.force_close', objectType: 'room', objectId: id, reason: body.reason });
    });
    return { ok: true };
  }

  // ---------- 举报 ----------

  @Get('reports')
  @RequireRoles('admin', 'moderator', 'support')
  async listReports(@Query('status') status?: string) {
    const rows = await app().db.db
      .select()
      .from(reports)
      .where(status ? eq(reports.status, status as never) : undefined)
      .orderBy(desc(reports.createdAt))
      .limit(100);
    return { items: rows };
  }

  @Post('reports/:id/resolve')
  @RequireRoles('admin', 'moderator')
  async resolveReport(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    await app().db.db.update(reports).set({ status: 'resolved', resolution: body.reason, handledBy: operator.userId, updatedAt: new Date() }).where(eq(reports.id, id));
    await this.audit(operator, 'report.resolve', 'report', id, body.reason);
    return { ok: true };
  }

  // ---------- 订单与退款 ----------

  @Get('orders')
  @RequireRoles('admin', 'finance', 'support')
  async listOrders(@Query('status') status?: string) {
    const rows = await app().db.db
      .select({
        orderId: orders.id,
        userId: orders.userId,
        status: orders.status,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        channel: orders.channel,
        merchantOrderNo: orders.merchantOrderNo,
        createdAt: orders.createdAt,
        paidAt: orders.paidAt,
      })
      .from(orders)
      .where(status ? eq(orders.status, status as never) : undefined)
      .orderBy(desc(orders.createdAt))
      .limit(100);
    return { items: rows };
  }

  /** 审核退款：冻结授权 → 通道退款（M4 联调）→ 撤销授权；此处先完成冻结与登记。 */
  @Post('orders/:id/refund')
  @RequireRoles('admin', 'finance')
  async approveRefund(@CurrentUser() operator: SessionUser, @Param('id') id: string, @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    const db = app().db;
    const result = await db.tx(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for('update').limit(1);
      if (!order) throw new DomainError('NOT_FOUND', '订单不存在');
      if (order.status !== 'paid') throw new DomainError('ORDER_STATE_CONFLICT', '只有已支付订单可以退款');

      const refundNo = `RF${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const [refund] = await tx
        .insert(refunds)
        .values({ orderId: id, refundNo, amountMinor: order.amountMinor, reason: body.reason, status: 'pending', entitlementStatus: 'frozen', approvedBy: operator.userId })
        .returning({ id: refunds.id });
      await tx.update(orders).set({ status: 'refund_pending', updatedAt: new Date() }).where(eq(orders.id, id));
      // 冻结该订单授权：不再用于新开房
      await tx
        .update(sponsorGrants)
        .set({ status: 'frozen' })
        .where(and(eq(sponsorGrants.orderId, id), eq(sponsorGrants.status, 'active')));
      await tx.insert(sponsorLedger).values({
        userId: order.userId,
        action: 'freeze',
        orderId: id,
        detail: { refundNo },
        idempotencyKey: `freeze:${refundNo}`,
      });
      await tx.insert(auditLogs).values({ operatorUserId: operator.userId, action: 'order.refund_approve', objectType: 'order', objectId: id, reason: body.reason });
      return { refundId: refund!.id, refundNo };
    });

    // 通道退款在事务外执行；结果未知时保持 pending + 冻结，由查单任务跟进（M4 联调后启用）
    return result;
  }

  // ---------- 运营总览 ----------

  @Get('overview')
  @RequireRoles('admin', 'moderator', 'support', 'finance')
  async overview() {
    const db = app().db.db;
    const [activeRooms] = await db.select({ count: sql<number>`count(*)::int` }).from(rooms).where(eq(rooms.status, 'playing'));
    const [activeRounds] = await db.select({ count: sql<number>`count(*)::int` }).from(rounds).where(eq(rounds.status, 'active'));
    const [paidOrders] = await db.select({ count: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(amount_minor),0)::int` }).from(orders).where(eq(orders.status, 'paid'));
    const [jevStats] = await db
      .select({
        calls: sql<number>`count(*)::int`,
        failures: sql<number>`count(*) filter (where status = 'failed')::int`,
        avgMs: sql<number>`coalesce(avg(extract(epoch from (ended_at - started_at)) * 1000), 0)::int`,
      })
      .from(jevCalls);
    return {
      activeRooms: activeRooms?.count ?? 0,
      activeRounds: activeRounds?.count ?? 0,
      paidOrders: paidOrders?.count ?? 0,
      paidAmountMinor: paidOrders?.amount ?? 0,
      jev: jevStats ?? { calls: 0, failures: 0, avgMs: 0 },
    };
  }
}

