/** 当前账号：身份、赞助有效期、免费开房余量、多人历史。 */
import { Controller, Get } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  freeRoomAccounts,
  orders,
  roomMembers,
  rooms,
  rounds,
  sponsorGrants,
  productVersions,
  puzzleVersions,
  puzzles,
} from '@jev/database';
import { freeRoomsRemaining, hasActiveSponsorship, hasLifetimeGrant } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser } from '../common/http.js';
import { meResponseSchema } from '@jev/contracts';
import { z } from 'zod';

@Controller('me')
export class MeController {
  @Get()
  async me(@CurrentUser() user: SessionUser): Promise<z.infer<typeof meResponseSchema>> {
    const context = app();
    const now = new Date();
    const [grants, freeRows] = await Promise.all([
      context.db.db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, user.userId)),
      context.db.db.select().from(freeRoomAccounts).where(eq(freeRoomAccounts.userId, user.userId)).limit(1),
    ]);
    const monthlyActive = grants
      .filter((g) => g.type === 'monthly' && g.status === 'active' && g.effectiveUntil && g.effectiveUntil > now)
      .sort((a, b) => (a.effectiveUntil!.getTime() > b.effectiveUntil!.getTime() ? -1 : 1))[0];
    const free = freeRows[0] ?? { total: 10, consumed: 0, reserved: 0 };

    return {
      userId: user.userId,
      nickname: user.nickname,
      email: user.email,
      emailVerified: user.emailVerified,
      roles: user.roles,
      sponsorship: {
        monthlyUntil: monthlyActive?.effectiveUntil?.toISOString() ?? null,
        lifetime: hasLifetimeGrant(grants) && hasActiveSponsorship(grants, now),
      },
      freeRooms: {
        total: free.total,
        consumed: free.consumed,
        reserved: free.reserved,
      },
    };
  }

  /** 免费余量（便于前端直接展示） */
  @Get('free-rooms')
  async freeRooms(@CurrentUser() user: SessionUser) {
    const rows = await app().db.db
      .select()
      .from(freeRoomAccounts)
      .where(eq(freeRoomAccounts.userId, user.userId))
      .limit(1);
    const free = rows[0];
    return { remaining: free ? freeRoomsRemaining(free) : 0, total: free?.total ?? 10 };
  }

  /** 多人历史：按成员关系查房间，含每局的题目与结局 */
  @Get('history')
  async history(@CurrentUser() user: SessionUser) {
    const context = app();
    const memberRows = await context.db.db
      .select({
        roomId: rooms.id,
        roomStatus: rooms.status,
        createdAt: rooms.createdAt,
        closedAt: rooms.closedAt,
        myStatus: roomMembers.status,
        joinedAt: roomMembers.joinedAt,
      })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(eq(roomMembers.userId, user.userId))
      .orderBy(desc(rooms.createdAt))
      .limit(50);

    const roomIds = memberRows.map((r) => r.roomId);
    const roundsRows = roomIds.length
      ? await context.db.db.select().from(rounds).where(inArray(rounds.roomId, roomIds))
      : [];

    // 每局的题目标题（固定版本）
    const versionIds = [...new Set(roundsRows.map((r) => r.puzzleVersionId))];
    const versions = versionIds.length
      ? await context.db.db
          .select({ versionId: puzzleVersions.id, title: puzzleVersions.title, puzzleId: puzzles.id })
          .from(puzzleVersions)
          .innerJoin(puzzles, eq(puzzles.id, puzzleVersions.puzzleId))
          .where(inArray(puzzleVersions.id, versionIds))
      : [];
    const titleById = new Map(versions.map((v) => [v.versionId, v.title]));

    return {
      rooms: memberRows.map((room) => ({
        ...room,
        rounds: roundsRows
          .filter((r) => r.roomId === room.roomId)
          .map((r) => ({
            roundId: r.id,
            roundNo: r.roundNo,
            status: r.status,
            title: titleById.get(r.puzzleVersionId) ?? null,
            endedAt: r.endedAt?.toISOString() ?? null,
          })),
      })),
    };
  }

  /** 我的订单（仅本人可见） */
  @Get('orders')
  async myOrders(@CurrentUser() user: SessionUser) {
    const context = app();
    const rows = await context.db.db
      .select({
        orderId: orders.id,
        status: orders.status,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        title: productVersions.title,
        createdAt: orders.createdAt,
        paidAt: orders.paidAt,
      })
      .from(orders)
      .innerJoin(productVersions, eq(productVersions.id, orders.productVersionId))
      .where(eq(orders.userId, user.userId))
      .orderBy(desc(orders.createdAt))
      .limit(50);
    return { items: rows };
  }
}
