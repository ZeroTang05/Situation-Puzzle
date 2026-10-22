/**
 * 大厅服务（docs/rebuild/18-HALL-PUBLIC-ROOMS.md）。
 *
 * 大厅 = 公开且未归档的房间的聚合视图：
 *  - 房主把房间设为公开 → 房间出现在大厅列表，其他玩家可以直接加入；
 *  - 房主切回私人 → 房间立刻从大厅消失，但已在房内的人不受影响；
 *  - 房间归档（closed）→ 同样从大厅消失，不会出现「点进去发现已结束」。
 *
 * 判定口径（谁能进、什么房间会上大厅）在 @jev/domain 的 public-rooms.ts 里，
 * 这里只负责取数与落库。
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  appendEvent,
  notifyRoomChange,
  profiles,
  puzzleVersions,
  roomMembers,
  rooms,
  roundParticipants,
  rounds,
} from '@jev/database';
import { DomainError, HALL_LIMIT, publicJoinBlockError, publicJoinBlockReason, shouldListInHall } from '@jev/domain';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';

/** 大厅列表里的一条公开房间（只含公开信息，不含汤底与未解锁提示） */
export interface HallRoom {
  roomId: string;
  /** 当前这一局的题目（还没开局时为 null） */
  title: string | null;
  language: 'zh' | 'en' | null;
  hostNickname: string;
  memberCount: number;
  capacity: number;
  /** 已满员：仍显示，但不可加入 */
  full: boolean;
  status: 'waiting' | 'playing';
  createdAt: string;
}

@Injectable()
export class HallService {
  private get db() {
    return app().db;
  }

  /**
   * 大厅列表：公开 + 未归档的房间，按创建时间倒序，最多 HALL_LIMIT 条。
   * 一个房间至多一局（rounds.room_id 唯一），左连接即可拿到当前题目。
   */
  async list(): Promise<{ rooms: HallRoom[] }> {
    const db = this.db;
    const rows = await db.db
      .select({
        roomId: rooms.id,
        status: rooms.status,
        capacity: rooms.capacity,
        isPublic: rooms.isPublic,
        hostUserId: rooms.hostUserId,
        createdAt: rooms.createdAt,
        title: puzzleVersions.title,
        language: rounds.language,
      })
      .from(rooms)
      .leftJoin(rounds, eq(rounds.roomId, rooms.id))
      .leftJoin(puzzleVersions, eq(puzzleVersions.id, rounds.puzzleVersionId))
      .where(and(eq(rooms.isPublic, true), ne(rooms.status, 'closed')))
      .orderBy(desc(rooms.createdAt))
      .limit(HALL_LIMIT);

    const visible = rows.filter((row) => shouldListInHall({ isPublic: row.isPublic, status: row.status }));
    if (visible.length === 0) return { rooms: [] };

    const roomIds = visible.map((row) => row.roomId);
    const [countRows, nicknameRows] = await Promise.all([
      db.db
        .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)::int` })
        .from(roomMembers)
        .where(and(eq(roomMembers.status, 'joined'), inArray(roomMembers.roomId, roomIds)))
        .groupBy(roomMembers.roomId),
      db.db
        .select({ userId: profiles.userId, nickname: profiles.nickname })
        .from(profiles)
        .where(inArray(profiles.userId, visible.map((row) => row.hostUserId))),
    ]);
    const counts = new Map(countRows.map((row) => [row.roomId, row.n]));
    const nicknames = new Map(nicknameRows.map((row) => [row.userId, row.nickname]));

    return {
      rooms: visible.map((row) => {
        const memberCount = counts.get(row.roomId) ?? 0;
        return {
          roomId: row.roomId,
          title: row.title ?? null,
          language: row.language === 'en' ? 'en' : row.language === 'zh' ? 'zh' : null,
          hostNickname: nicknames.get(row.hostUserId) ?? row.hostUserId,
          memberCount,
          capacity: row.capacity,
          full: memberCount >= row.capacity,
          status: row.status === 'waiting' ? 'waiting' : 'playing',
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }

  /**
   * 直接加入公开房间（不需要邀请 token）。
   *
   * 幂等：已经在房里 → joined=false 直接返回，不重复写成员行。
   * 拒绝顺序固定：不是公开房 → 房间已关闭 → 房间已满（domain 层同一口径）。
   * 被踢过的人不能靠大厅重进，需要房主解除限制。
   */
  async joinPublicRoom(user: SessionUser, roomId: string): Promise<{ roomId: string; joined: boolean }> {
    const db = this.db;

    const result = await db.tx(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update').limit(1);
      if (!room) throw new DomainError('NOT_FOUND', '房间不存在');

      const [member] = await tx
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.userId)))
        .limit(1);
      if (member?.status === 'kicked') {
        throw new DomainError('MEMBER_RESTRICTED', '你已被移出该房间，需要房主解除限制。');
      }
      // 已经是成员：幂等返回。房主切回私人后，老成员依然能正常回到房间。
      if (member?.status === 'joined') return { roomId: room.id, joined: false };

      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, 'joined')));
      const block = publicJoinBlockReason({
        isPublic: room.isPublic,
        status: room.status,
        memberCount: countRow?.count ?? 0,
        capacity: room.capacity,
      });
      if (block) {
        const { code, message } = publicJoinBlockError(block);
        throw new DomainError(code, message);
      }

      if (member) {
        // left → 重入
        await tx.update(roomMembers).set({ status: 'joined', leftAt: null }).where(eq(roomMembers.id, member.id));
      } else {
        await tx.insert(roomMembers).values({ roomId: room.id, userId: user.userId, status: 'joined' });
      }

      // 进行中的局：新成员成为本局参与者（阅读权与提问权）
      const [currentRound] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.roomId, room.id), eq(rounds.status, 'active')))
        .limit(1);
      if (currentRound) {
        await tx.insert(roundParticipants).values({ roundId: currentRound.id, userId: user.userId }).onConflictDoNothing();
      }

      await appendEvent(tx, {
        roomId: room.id,
        roundId: currentRound?.id ?? null,
        type: 'room.member_joined',
        payload: { userId: user.userId, nickname: user.nickname },
      });
      return { roomId: room.id, joined: true };
    });

    await notifyRoomChange(db.pool, result.roomId);
    return result;
  }
}
