/**
 * 房间服务：建房授权事务、邀请加入、快照握手、事件补齐、历史与答案读取。
 * 锁序遵守：房间 → 局 → 赞助账户 → 免费账户 → 任务（docs/rebuild/03-SPEC.md §7）。
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  activeRoomUsers,
  appendEvent,
  earliestSeqTx,
  notifyRoomChange,
  presence,
  profiles,
  puzzleVersions,
  roomMembers,
  roomEvents,
  rooms,
  roundParticipants,
  rounds,
  sponsorGrants,
  turns,
  freeRoomAccounts,
  roomEntitlements,
  roomCreditLedger,
} from '@jev/database';
import { DomainError, resolveEntitlementSource } from '@jev/domain';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';

const ONLINE_WINDOW_MS = 45_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type Tx = Parameters<Parameters<import('@jev/database').Database['transaction']>[0]>[0];

@Injectable()
export class RoomsService {
  private get db() {
    return app().db;
  }

  /** 批量查昵称（profiles 表）。 */
  private async nicknamesOf(exec: Tx | import('@jev/database').Database, userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const rows = await exec
      .select({ userId: profiles.userId, nickname: profiles.nickname })
      .from(profiles)
      .where(inArray(profiles.userId, unique));
    return new Map(rows.map((r) => [r.userId, r.nickname]));
  }

  /**
   * 创建等待室：同一创建者已有未关闭房间时直接返回原房间入口。
   * 授权判定：先赞助后免费；免费来源在创建事务中预留一次机会。
   */
  async createRoom(
    user: SessionUser,
    capacity: number,
  ): Promise<{ roomId: string; inviteToken: string | null; existing: boolean }> {
    const db = this.db;
    const now = new Date();

    const existing = await db.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.creatorUserId, user.userId), sql`status <> 'closed'`))
      .limit(1);
    if (existing.length > 0) {
      return { roomId: existing[0]!.id, inviteToken: null, existing: true };
    }

    const inviteToken = randomBytes(16).toString('hex');
    const created = await db.tx(async (tx) => {
      // 锁授权账户：赞助检查与免费扣减在同一把锁下完成
      const grants = await tx.select().from(sponsorGrants).where(eq(sponsorGrants.userId, user.userId));
      const freeRows = await tx.select().from(freeRoomAccounts).where(eq(freeRoomAccounts.userId, user.userId)).for('update');
      const free = freeRows[0];
      if (!free) throw new DomainError('UNAUTHORIZED', '账号未初始化免费次数账户');

      const { source, grantId } = resolveEntitlementSource(grants, free, now);

      const inserted = await tx
        .insert(rooms)
        .values({
          creatorUserId: user.userId,
          hostUserId: user.userId,
          capacity,
          inviteTokenHash: hashToken(inviteToken),
        })
        .returning({ id: rooms.id });
      const roomId = inserted[0]!.id;

      await tx.insert(roomMembers).values({ roomId, userId: user.userId, status: 'joined' });
      await tx.insert(activeRoomUsers).values({ userId: user.userId, roomId });

      const entitlement = await tx
        .insert(roomEntitlements)
        .values({ roomId, creatorUserId: user.userId, source, sponsorGrantId: grantId ?? null, status: 'reserved' })
        .returning({ id: roomEntitlements.id });
      await tx.update(rooms).set({ entitlementId: entitlement[0]!.id }).where(eq(rooms.id, roomId));

      if (source === 'free') {
        const reservedRows = await tx
          .update(freeRoomAccounts)
          .set({ reserved: sql`${freeRoomAccounts.reserved} + 1`, updatedAt: now })
          .where(
            and(
              eq(freeRoomAccounts.userId, user.userId),
              sql`${freeRoomAccounts.consumed} + ${freeRoomAccounts.reserved} < ${freeRoomAccounts.total}`,
            ),
          )
          .returning({ userId: freeRoomAccounts.userId });
        if (reservedRows.length === 0) throw new DomainError('FREE_ROOMS_EXHAUSTED', '免费开房次数已用完');
        await tx.insert(roomCreditLedger).values({ roomId, userId: user.userId, action: 'reserve', amount: 1 });
      }
      return { roomId };
    });

    await notifyRoomChange(db.pool, created.roomId);
    return { roomId: created.roomId, inviteToken, existing: false };
  }

  /** 邀请预览：只给最小信息，不给成员资料。 */
  async invitePreview(token: string) {
    const db = this.db;
    const rows = await db.db
      .select({
        roomId: rooms.id,
        status: rooms.status,
        capacity: rooms.capacity,
        hostUserId: rooms.hostUserId,
      })
      .from(rooms)
      .where(eq(rooms.inviteTokenHash, hashToken(token)))
      .limit(1);
    const room = rows[0];
    if (!room) throw new DomainError('NOT_FOUND', '邀请无效或已失效');

    const [countRow] = await db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.roomId), eq(roomMembers.status, 'joined')));
    const nicknames = await this.nicknamesOf(db.db, [room.hostUserId]);

    const round = await db.db
      .select({ title: puzzleVersions.title })
      .from(rounds)
      .innerJoin(puzzleVersions, eq(puzzleVersions.id, rounds.puzzleVersionId))
      .where(and(eq(rounds.roomId, room.roomId), eq(rounds.status, 'active')))
      .limit(1);

    return {
      roomId: room.roomId,
      status: room.status,
      capacity: room.capacity,
      memberCount: countRow?.count ?? 0,
      hostNickname: nicknames.get(room.hostUserId) ?? room.hostUserId,
      currentPuzzleTitle: round[0]?.title ?? null,
    };
  }

  /** 用邀请令牌加入房间；进行中的房间允许晚加入。 */
  async joinRoom(user: SessionUser, token: string): Promise<{ roomId: string; rejoined: boolean }> {
    const db = this.db;

    const joined = await db.tx(async (tx) => {
      const roomRows = await tx
        .select()
        .from(rooms)
        .where(eq(rooms.inviteTokenHash, hashToken(token)))
        .for('update')
        .limit(1);
      const room = roomRows[0];
      if (!room) throw new DomainError('NOT_FOUND', '邀请无效或已失效');
      if (room.status === 'closed') throw new DomainError('ROOM_CLOSED', '房间已关闭');

      const [active] = await tx.select().from(activeRoomUsers).where(eq(activeRoomUsers.userId, user.userId)).limit(1);
      if (active && active.roomId !== room.id) {
        throw new DomainError('ALREADY_IN_ROOM', '你已在一个房间里，先退出再加入新的。');
      }

      const [member] = await tx
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, user.userId)))
        .limit(1);

      if (member?.status === 'kicked') {
        throw new DomainError('MEMBER_RESTRICTED', '你已被移出该房间，需要房主解除限制。');
      }

      let rejoined = false;
      if (member?.status === 'joined') {
        return { roomId: room.id, rejoined: true };
      }

      if (member) {
        // left → 重入
        await tx.update(roomMembers).set({ status: 'joined', leftAt: null }).where(eq(roomMembers.id, member.id));
        rejoined = true;
      } else {
        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.status, 'joined')));
        if ((countRow?.count ?? 0) >= room.capacity) throw new DomainError('ROOM_FULL', '房间已经满了。');
        await tx.insert(roomMembers).values({ roomId: room.id, userId: user.userId, status: 'joined' });
      }

      if (!active) {
        await tx.insert(activeRoomUsers).values({ userId: user.userId, roomId: room.id });
      }

      // 进行中的局：新成员成为本局参与者
      const [currentRound] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.roomId, room.id), eq(rounds.status, 'active')))
        .limit(1);
      if (currentRound) {
        await tx.insert(roundParticipants).values({ roundId: currentRound.id, userId: user.userId }).onConflictDoNothing();
      }

      await tx.update(presence).set({ roomId: room.id, lastSeenAt: new Date() }).where(eq(presence.userId, user.userId));

      await appendEvent(tx, {
        roomId: room.id,
        roundId: currentRound?.id ?? null,
        type: 'room.member_joined',
        payload: { userId: user.userId, nickname: user.nickname },
      });
      return { roomId: room.id, rejoined };
    });

    await notifyRoomChange(db.pool, joined.roomId);
    return joined;
  }

  /** 一致性快照：事务读取房间全量首屏 + lastSeq（docs/rebuild/04-ROOM-JEV.md §5）。 */
  async snapshot(user: SessionUser, roomId: string) {
    const db = this.db;
    return db.tx(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
      if (!room) throw new DomainError('NOT_FOUND', '房间不存在');

      const [membership] = await tx
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.userId)))
        .limit(1);
      if (!membership || membership.status === 'kicked') {
        throw new DomainError('FORBIDDEN', '你不在这个房间里');
      }

      const memberRows = await tx
        .select({ userId: roomMembers.userId })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, 'joined')))
        .orderBy(asc(roomMembers.joinedAt));

      const memberIds = memberRows.map((m) => m.userId);
      const onlineRows = memberIds.length
        ? await tx
            .select({ userId: presence.userId })
            .from(presence)
            .where(and(inArray(presence.userId, memberIds), gt(presence.lastSeenAt, new Date(Date.now() - ONLINE_WINDOW_MS))))
        : [];
      const onlineSet = new Set(onlineRows.map((r) => r.userId));

      // 最新一局（含已结束的最后一局：结算页用）
      const [round] = await tx.select().from(rounds).where(eq(rounds.roomId, roomId)).orderBy(desc(rounds.roundNo)).limit(1);

      let roundInfo: {
        roundId: string;
        roundNo: number;
        puzzleId: string;
        versionId: string;
        language: 'zh' | 'en';
        title: string;
        surface: string;
        hintsRevealed: number;
        hints: string[];
        status: 'active' | 'solved' | 'revealed' | 'abandoned' | 'aborted';
        answer: string | null;
      } | null = null;
      if (round) {
        const [version] = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.id, round.puzzleVersionId)).limit(1);
        const canReadAnswer =
          round.status === 'solved' || round.status === 'revealed'
            ? await tx
                .select({ id: roundParticipants.id })
                .from(roundParticipants)
                .where(
                  and(
                    eq(roundParticipants.roundId, round.id),
                    eq(roundParticipants.userId, user.userId),
                    eq(roundParticipants.canRead, true),
                  ),
                )
                .limit(1)
            : [];

        roundInfo = {
          roundId: round.id,
          roundNo: round.roundNo,
          puzzleId: version?.puzzleId ?? '',
          versionId: round.puzzleVersionId,
          language: round.language === 'en' ? 'en' : 'zh',
          title: version?.title ?? '',
          surface: version?.surface ?? '',
          hintsRevealed: round.hintsRevealed,
          hints: (version?.hints ?? []).slice(0, round.hintsRevealed),
          status: round.status,
          answer: canReadAnswer.length > 0 ? version?.answer ?? null : null,
        };
      }

      const turnRows = round
        ? await tx.select().from(turns).where(eq(turns.roundId, round.id)).orderBy(asc(turns.acceptedSeq))
        : [];
      const nicknameMap = await this.nicknamesOf(tx, [...memberIds, ...turnRows.map((t) => t.userId)]);

      return {
        roomId: room.id,
        roomStatus: room.status,
        hostUserId: room.hostUserId,
        controlVersion: room.controlVersion,
        capacity: room.capacity,
        round: roundInfo,
        members: memberRows.map((m) => ({
          userId: m.userId,
          nickname: nicknameMap.get(m.userId) ?? m.userId,
          online: onlineSet.has(m.userId),
          isHost: m.userId === room.hostUserId,
          status: 'joined' as const,
        })),
        turns: turnRows.map((t) => ({
          turnId: t.id,
          seq: t.acceptedSeq,
          userId: t.userId,
          nickname: nicknameMap.get(t.userId) ?? t.userId,
          kind: t.kind,
          text: t.text,
          status: t.status,
          result: t.result,
        })),
        lastSeq: room.lastSeq,
      };
    });
  }

  /** 事件补齐：验证成员身份后按 seq 升序返回；超出保留范围要求重新快照。 */
  async eventsAfter(user: SessionUser, roomId: string, afterSeq: number) {
    const db = this.db;
    const [membership] = await db.db
      .select({ id: roomMembers.id })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.userId), eq(roomMembers.status, 'joined')))
      .limit(1);
    if (!membership) throw new DomainError('FORBIDDEN', '你不在这个房间里');

    return db.tx(async (tx) => {
      const [room] = await tx.select({ lastSeq: rooms.lastSeq }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
      if (!room) throw new DomainError('NOT_FOUND', '房间不存在');
      if (afterSeq > room.lastSeq) {
        throw new DomainError('STATE_CONFLICT', '客户端序号超过服务端，请重新快照');
      }

      const earliest = await earliestSeqTx(tx, roomId);
      if (earliest !== null && afterSeq + 1 < earliest) {
        throw new DomainError('EVENT_GAP', '记录已超出可补齐范围');
      }

      const rows = await tx
        .select()
        .from(roomEvents)
        .where(and(eq(roomEvents.roomId, roomId), gt(roomEvents.seq, afterSeq)))
        .orderBy(asc(roomEvents.seq))
        .limit(200);
      return { events: rows, watermark: room.lastSeq };
    });
  }

  /** 本局问答历史：有阅读权的参与者分页读取（按 acceptedSeq 游标）。 */
  async roundHistory(user: SessionUser, roundId: string, cursor: number | null) {
    const db = this.db;
    const [participant] = await db.db
      .select()
      .from(roundParticipants)
      .where(and(eq(roundParticipants.roundId, roundId), eq(roundParticipants.userId, user.userId)))
      .limit(1);
    if (!participant || !participant.canRead) throw new DomainError('FORBIDDEN', '没有这一局的历史阅读权');

    const rows = await db.db
      .select()
      .from(turns)
      .where(cursor ? and(eq(turns.roundId, roundId), sql`${turns.acceptedSeq} < ${cursor}`) : eq(turns.roundId, roundId))
      .orderBy(desc(turns.acceptedSeq))
      .limit(51);
    const page = rows.slice(0, 50);
    const nicknameMap = await this.nicknamesOf(db.db, page.map((t) => t.userId));

    return {
      items: page.map((t) => ({
        turnId: t.id,
        seq: t.acceptedSeq,
        userId: t.userId,
        nickname: nicknameMap.get(t.userId) ?? t.userId,
        kind: t.kind,
        text: t.text,
        status: t.status,
        result: t.result,
        createdAt: t.acceptedAt.toISOString(),
      })),
      nextCursor: rows.length > 50 ? page.at(-1)?.acceptedSeq ?? null : null,
    };
  }

  /** 答案读取：仅正常揭晓（revealed）或破解（solved）结束后、有阅读权的参与者。 */
  async roundAnswer(user: SessionUser, roundId: string) {
    const db = this.db;
    const [round] = await db.db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
    if (!round) throw new DomainError('NOT_FOUND', '局不存在');
    if (round.status !== 'solved' && round.status !== 'revealed') {
      throw new DomainError('FORBIDDEN', '答案尚未揭晓');
    }
    const [participant] = await db.db
      .select()
      .from(roundParticipants)
      .where(
        and(
          eq(roundParticipants.roundId, roundId),
          eq(roundParticipants.userId, user.userId),
          eq(roundParticipants.canRead, true),
        ),
      )
      .limit(1);
    if (!participant) throw new DomainError('FORBIDDEN', '没有这一局的答案阅读权');

    const [version] = await db.db.select().from(puzzleVersions).where(eq(puzzleVersions.id, round.puzzleVersionId)).limit(1);
    if (!version) throw new DomainError('CONTENT_UNAVAILABLE', '题目内容缺失');
    return { answer: version.answer, hints: version.hints };
  }
}
