/**
 * 会客厅服务（v3）：每个用户固定一个会客厅，id 永久不变。
 *
 * 模型：
 * - user_lobbies：会客厅本体，host_user_id UNIQUE 保证 1:1，id 永不被删除。
 * - lobby_members：会客厅当前座位表，kick = DELETE 本行（不留 kicked_at）。
 * - lobby_invites：会客厅邀请 token，跟 user_lobbies 同生命周期。
 *
 * start() 是会客厅 → 卧室的迁移入口，单事务内：
 *   锁 lobby 行 → 重验选题 → 建卧室 + 迁移成员 → 建局 + 事件 →
 *   UPDATE lobby 回到 closed（清临时态、删 lobby_members、revoke 旧邀请）。
 *
 * 心跳/在线判定走进程内 Map 派生（2s 一写 DB 会爆），进程重启可丢，DB 是权威。
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import {
  appendEvent,
  lobbyInvites,
  lobbyMembers,
  profiles,
  puzzleVersions,
  puzzles,
  roomMembers,
  rooms,
  roundParticipants,
  rounds,
  userLobbies,
} from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';
import { createRoomWithEntitlementTx, jevConfigVersionOf } from './room-creation.js';

/** 在线判定：30 秒内轮询过。lobby 在线状态是派生量，DB 不存。 */
const ONLINE_WINDOW_MS = 30_000;
/** 邀请 token 默认有效期 */
const INVITE_TTL = '24h';

type Tx = Parameters<Parameters<import('@jev/database').Database['transaction']>[0]>[0];

export interface LobbySnapshot {
  lobbyId: string;
  hostUserId: string;
  capacity: number;
  members: Array<{ userId: string; nickname: string; online: boolean; isHost: boolean }>;
  selectedPuzzle: { puzzleId: string; title: string; language: 'zh' | 'en' } | null;
}

/** 进程内在线缓存：lobbyId → (userId → lastSeenAt)。DB 不写，进程重启丢失。 */
const presenceCache = new Map<string, Map<string, { nickname: string; lastSeenAt: number }>>();

function touchPresence(lobbyId: string, userId: string, nickname: string): void {
  let inner = presenceCache.get(lobbyId);
  if (!inner) {
    inner = new Map();
    presenceCache.set(lobbyId, inner);
  }
  inner.set(userId, { nickname, lastSeenAt: Date.now() });
}

/** lobby 关闭/start 后清掉对应 cache，lobby_id 不再被使用时 GC */
function evictPresence(lobbyId: string): void {
  presenceCache.delete(lobbyId);
}

@Injectable()
export class LobbyService {
  private get db() {
    return app().db;
  }

  // ---------- 会客厅主入口 ----------

  /**
   * 拿我的会客厅：没有就建一个（永久 row，id 永不删）。
   * 房主单例是 host_user_id UNIQUE 物理保证的，业务层不需要 Map。
   * 同一用户连点返回同一 id；不同用户互不冲突。
   */
  async openOrGetLobby(user: SessionUser, capacity: number): Promise<{ lobbyId: string; existed: boolean }> {
    const [existing] = await this.db.db
      .select({ id: userLobbies.id })
      .from(userLobbies)
      .where(eq(userLobbies.hostUserId, user.userId))
      .limit(1);
    if (existing) {
      // 容量变更：幂等更新 capacity
      await this.db.db.update(userLobbies).set({ capacity }).where(eq(userLobbies.id, existing.id));
      return { lobbyId: existing.id, existed: true };
    }
    const [created] = await this.db.db
      .insert(userLobbies)
      .values({ hostUserId: user.userId, capacity, status: 'closed' })
      .returning({ id: userLobbies.id });
    if (!created) throw new DomainError('INTERNAL', '会客厅创建失败');
    return { lobbyId: created.id, existed: false };
  }

  // ---------- 邀请 ----------

  /**
   * 房主生成/重置会客厅邀请：旧邀请 revoke、新邀请签 token 一次性返回。
   * 同 lobby 同一时刻最多一条有效邀请。
   */
  async createInvite(user: SessionUser, lobbyId: string): Promise<{ token: string; kind: 'lobby' }> {
    const [lobby] = await this.db.db
      .select({ hostUserId: userLobbies.hostUserId })
      .from(userLobbies)
      .where(eq(userLobbies.id, lobbyId))
      .limit(1);
    if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');
    if (lobby.hostUserId !== user.userId) throw new DomainError('FORBIDDEN', '只有房主可以生成邀请');

    const now = new Date();
    // 同一 lobby 同一时刻最多一条有效邀请：旧邀请全部 revoke
    await this.db.db
      .update(lobbyInvites)
      .set({ revokedAt: now })
      .where(and(eq(lobbyInvites.lobbyId, lobbyId), isNull(lobbyInvites.revokedAt)));

    const token = randomBytes(16).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + this.inviteTtlMs());
    await this.db.db.insert(lobbyInvites).values({ lobbyId, tokenHash, expiresAt });
    return { token, kind: 'lobby' };
  }

  /** 解析邀请 token：拿 lobbyId。token 失效统一归一为 LOBBY_NOT_FOUND，不重建 lobby。 */
  async resolveInvite(token: string): Promise<{ lobbyId: string; hostUserId: string }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [row] = await this.db.db
      .select({
        lobbyId: lobbyInvites.lobbyId,
        expiresAt: lobbyInvites.expiresAt,
        revokedAt: lobbyInvites.revokedAt,
        hostUserId: userLobbies.hostUserId,
      })
      .from(lobbyInvites)
      .innerJoin(userLobbies, eq(userLobbies.id, lobbyInvites.lobbyId))
      .where(eq(lobbyInvites.tokenHash, tokenHash))
      .limit(1);
    if (!row) throw new DomainError('LOBBY_NOT_FOUND', '邀请无效或已失效');
    if (row.revokedAt !== null) throw new DomainError('LOBBY_NOT_FOUND', '邀请已被撤销');
    if (row.expiresAt.getTime() <= Date.now()) throw new DomainError('LOBBY_NOT_FOUND', '邀请已过期');
    return { lobbyId: row.lobbyId, hostUserId: row.hostUserId };
  }

  /** 邀请预览：返回最小信息（含房主昵称），不暴露完整成员表。 */
  async previewByInvite(token: string): Promise<{ lobbyId: string; hostNickname: string; memberCount: number; capacity: number }> {
    const { lobbyId } = await this.resolveInvite(token);
    return this.preview(lobbyId);
  }

  private async preview(lobbyId: string) {
    const [lobby] = await this.db.db
      .select({
        hostUserId: userLobbies.hostUserId,
        capacity: userLobbies.capacity,
      })
      .from(userLobbies)
      .where(eq(userLobbies.id, lobbyId))
      .limit(1);
    if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');
    const [cnt] = await this.db.db
      .select({ n: count() })
      .from(lobbyMembers)
      .where(eq(lobbyMembers.lobbyId, lobbyId));
    const hostPresence = presenceCache.get(lobbyId)?.get(lobby.hostUserId);
    return {
      lobbyId,
      hostUserId: lobby.hostUserId,
      hostNickname: hostPresence?.nickname ?? lobby.hostUserId,
      memberCount: cnt?.n ?? 0,
      capacity: lobby.capacity,
    };
  }

  // ---------- 邀请加入 ----------

  /**
   * 凭 token 加入：幂等；已在座位上直接返回。
   * 不查 kicked（按用户要求：被踢就是 DELETE 座位行，重新邀请时自然可加入）。
   */
  async join(user: SessionUser, token: string): Promise<{ lobbyId: string }> {
    const { lobbyId } = await this.resolveInvite(token);

    return this.db.tx(async (tx) => {
      const [lobby] = await tx.select().from(userLobbies).where(eq(userLobbies.id, lobbyId)).for('update').limit(1);
      if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');

      // 容量校验
      const [cnt] = await tx.select({ n: count() }).from(lobbyMembers).where(eq(lobbyMembers.lobbyId, lobbyId));
      const alreadyMember = await tx
        .select({ userId: lobbyMembers.userId })
        .from(lobbyMembers)
        .where(and(eq(lobbyMembers.lobbyId, lobbyId), eq(lobbyMembers.userId, user.userId)))
        .limit(1);
      if (!alreadyMember[0] && (cnt?.n ?? 0) >= lobby.capacity) {
        throw new DomainError('LOBBY_FULL', '会客厅已经满了');
      }

      if (!alreadyMember[0]) {
        await tx.insert(lobbyMembers).values({ lobbyId, userId: user.userId });
      }
      if (lobby.status === 'closed') {
        await tx.update(userLobbies).set({ status: 'open', openedAt: new Date() }).where(eq(userLobbies.id, lobbyId));
      }
      touchPresence(lobbyId, user.userId, user.nickname);
      return { lobbyId };
    });
  }

  // ---------- 快照 ----------

  /**
   * 成员轮询快照：在线状态由进程内 cache 派生（DB 不写 last_seen_at）。
   * 校验当前用户是房主或座位成员；status='closed' 时房主也能轮询预览。
   * 让前端跳卧室。
   */
  async snapshot(user: SessionUser, lobbyId: string): Promise<LobbySnapshot> {
    const [lobby] = await this.db.db
      .select({
        id: userLobbies.id,
        hostUserId: userLobbies.hostUserId,
        capacity: userLobbies.capacity,
        selectedPuzzleId: userLobbies.selectedPuzzleId,
        selectedPuzzleLang: userLobbies.selectedPuzzleLang,
        selectedPuzzleTitle: userLobbies.selectedPuzzleTitle,
        selectedPuzzleSurface: userLobbies.selectedPuzzleSurface,
        status: userLobbies.status,
      })
      .from(userLobbies)
      .where(eq(userLobbies.id, lobbyId))
      .limit(1);
    if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');

    const members = await this.db.db
      .select({ userId: lobbyMembers.userId, joinedAt: lobbyMembers.joinedAt })
      .from(lobbyMembers)
      .where(eq(lobbyMembers.lobbyId, lobbyId));
    const isMember = members.some((m) => m.userId === user.userId);
    // 房主永远在成员列表里（无需 lobby_members 行）。客人是 members 中的非房主用户。
    const isHost = lobby.hostUserId === user.userId;
    if (!isHost && !isMember) {
      throw new DomainError('FORBIDDEN', '你不在这个会客厅里');
    }

    // 心跳：刷新自己在 cache 中的在线时间（房主也要心跳）
    touchPresence(lobbyId, user.userId, user.nickname);

    // 房主轮询：标记 lobby 为 open（开始组队），让后续 GET 都走 open 路径
    if (isHost && lobby.status === 'closed') {
      await this.db.db
        .update(userLobbies)
        .set({ status: 'open', openedAt: new Date() })
        .where(eq(userLobbies.id, lobbyId));
    }

    const now = Date.now();
    const cache = presenceCache.get(lobbyId);
    let hostCached = cache?.get(lobby.hostUserId);
    // 进程内 cache 没有房主昵称时，从 profiles 兜底查一次（仅一次，后续 cache 命中）
    if (!hostCached) {
      const [hostProfile] = await this.db.db
        .select({ nickname: profiles.nickname })
        .from(profiles)
        .where(eq(profiles.userId, lobby.hostUserId))
        .limit(1);
      const nickname = hostProfile?.nickname ?? lobby.hostUserId;
      hostCached = { nickname, lastSeenAt: 0 };
      cache?.set(lobby.hostUserId, hostCached);
    }
    const hostEntry = {
      userId: lobby.hostUserId,
      nickname: hostCached?.nickname ?? lobby.hostUserId,
      online: hostCached !== undefined && hostCached.lastSeenAt > 0 && now - hostCached.lastSeenAt < ONLINE_WINDOW_MS,
      isHost: true,
      joinedAt: 0, // 房主最先生成会客厅，排序最前
    };
    const guestEntries = members
      .filter((m) => m.userId !== lobby.hostUserId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
      .map((m) => {
        const cached = cache?.get(m.userId);
        return {
          userId: m.userId,
          nickname: cached?.nickname ?? m.userId,
          online: cached !== undefined && now - cached.lastSeenAt < ONLINE_WINDOW_MS,
          isHost: false,
          joinedAt: m.joinedAt.getTime(),
        };
      });
    const memberList = [hostEntry, ...guestEntries];

    return {
      lobbyId: lobby.id,
      hostUserId: lobby.hostUserId,
      capacity: lobby.capacity,
      members: memberList,
      selectedPuzzle:
        lobby.selectedPuzzleId && lobby.selectedPuzzleLang && lobby.selectedPuzzleTitle
          ? {
              puzzleId: lobby.selectedPuzzleId,
              title: lobby.selectedPuzzleTitle,
              language: lobby.selectedPuzzleLang as 'zh' | 'en',
            }
          : null,
    };
  }

  // ---------- 选题 / 离开 / 踢人 / 解散 ----------

  /** 房主选题：写 DB 行（不是只写内存）。
   * 允许随时选题：lobby 是会客厅，与房间生命周期独立——房主可以在 lobby 里选下一局的题，
   * 即便上一局还在进行。房间无限制，房主能同时拥有多个 active 房间。 */
  async select(user: SessionUser, lobbyId: string, puzzleId: string, language: 'zh' | 'en'): Promise<void> {
    return this.db.tx(async (rawTx) => {
      const tx = rawTx as Tx;
      const [lobby] = await tx.select().from(userLobbies).where(eq(userLobbies.id, lobbyId)).for('update').limit(1);
      if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');
      if (lobby.hostUserId !== user.userId) throw new DomainError('FORBIDDEN', '只有房主可以选题');

      const [version] = await tx
        .select({
          puzzleId: puzzles.id,
          versionId: puzzleVersions.id,
          title: puzzleVersions.title,
          surface: puzzleVersions.surface,
          language: puzzleVersions.language,
        })
        .from(puzzleVersions)
        .innerJoin(puzzles, eq(puzzles.id, puzzleVersions.puzzleId))
        .where(
          and(
            eq(puzzleVersions.puzzleId, puzzleId),
            eq(puzzleVersions.moderationStatus, 'published'),
            eq(puzzleVersions.language, language),
            eq(puzzles.unavailable, false),
          ),
        )
        .orderBy(desc(puzzleVersions.versionNo))
        .limit(1);
      if (!version) throw new DomainError('PUZZLE_UNPUBLISHED', '题目不可用或未发布');

      await tx
        .update(userLobbies)
        .set({
          selectedPuzzleId: version.puzzleId,
          selectedPuzzleLang: language,
          selectedPuzzleTitle: version.title,
          selectedPuzzleSurface: version.surface,
          status: 'open',
          openedAt: lobby.openedAt ?? new Date(),
        })
        .where(eq(userLobbies.id, lobbyId));
    });
  }

  /** 非房主离开：DELETE 座位行。 */
  async leave(user: SessionUser, lobbyId: string): Promise<void> {
    return this.db.tx(async (rawTx) => {
      const tx = rawTx as Tx;
      const [lobby] = await tx.select().from(userLobbies).where(eq(userLobbies.id, lobbyId)).for('update').limit(1);
      if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');
      if (lobby.hostUserId === user.userId) {
        throw new DomainError('STATE_CONFLICT', '房主离开请直接解散会客厅');
      }
      await tx
        .delete(lobbyMembers)
        .where(and(eq(lobbyMembers.lobbyId, lobbyId), eq(lobbyMembers.userId, user.userId)));
      // 座位空了 → 回到 closed（保留 id）
      const [remaining] = await tx.select({ n: count() }).from(lobbyMembers).where(eq(lobbyMembers.lobbyId, lobbyId));
      if ((remaining?.n ?? 0) === 0) {
        await tx
          .update(userLobbies)
          .set({ status: 'closed', closedAt: new Date() })
          .where(eq(userLobbies.id, lobbyId));
      }
    });
  }

  /** 房主踢人：DELETE 座位行，无 kicked 软标记。 */
  async kick(user: SessionUser, lobbyId: string, targetUserId: string): Promise<void> {
    return this.db.tx(async (rawTx) => {
      const tx = rawTx as Tx;
      const [lobby] = await tx.select().from(userLobbies).where(eq(userLobbies.id, lobbyId)).for('update').limit(1);
      if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');
      if (lobby.hostUserId !== user.userId) throw new DomainError('FORBIDDEN', '只有房主可以踢人');
      if (targetUserId === lobby.hostUserId) throw new DomainError('STATE_CONFLICT', '不能移出房主');
      await tx
        .delete(lobbyMembers)
        .where(and(eq(lobbyMembers.lobbyId, lobbyId), eq(lobbyMembers.userId, targetUserId)));
      const [remaining] = await tx.select({ n: count() }).from(lobbyMembers).where(eq(lobbyMembers.lobbyId, lobbyId));
      if ((remaining?.n ?? 0) === 0) {
        await tx
          .update(userLobbies)
          .set({ status: 'closed', closedAt: new Date() })
          .where(eq(userLobbies.id, lobbyId));
      }
    });
  }

  /**
   * 房主解散：清空 lobby_members + revoke 所有邀请，但保留 lobby 行
   * （status='closed'、临时态清空）。id 仍可访问，host_user_id UNIQUE 继续
   * 保证单例；下次 start 同一用户拿到的还是这同一个 id。
   */
  async dismiss(user: SessionUser, lobbyId: string): Promise<void> {
    await this.db.tx(async (rawTx) => {
      const tx = rawTx as Tx;
      const [lobby] = await tx.select().from(userLobbies).where(eq(userLobbies.id, lobbyId)).for('update').limit(1);
      if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');
      if (lobby.hostUserId !== user.userId) throw new DomainError('FORBIDDEN', '只有房主可以解散会客厅');

      await tx.delete(lobbyMembers).where(eq(lobbyMembers.lobbyId, lobbyId));
      const now = new Date();
      await tx
        .update(lobbyInvites)
        .set({ revokedAt: now })
        .where(and(eq(lobbyInvites.lobbyId, lobbyId), isNull(lobbyInvites.revokedAt)));
      await tx
        .update(userLobbies)
        .set({
          status: 'closed',
          closedAt: now,
          selectedPuzzleId: null,
          selectedPuzzleLang: null,
          selectedPuzzleTitle: null,
          selectedPuzzleSurface: null,
        })
        .where(eq(userLobbies.id, lobbyId));
    });
    evictPresence(lobbyId);
  }

  // ---------- 开局（会客厅 → 卧室）----------

  /**
   * start：单事务。
   * 锁 lobby 行 → 校验选题 → createRoomWithEntitlementTx →
   * 把 lobby_members 全员 INSERT 到 room_members → 建 rounds / round_participants →
   * appendEvent(round.started) → UPDATE lobby 回到 closed 清临时态。
   */
  async start(user: SessionUser, lobbyId: string): Promise<{ roomId: string; inviteToken: string }> {
    const inviteToken = randomBytes(16).toString('hex');
    const inviteTokenHash = createHash('sha256').update(inviteToken).digest('hex');

    const roomId = await this.db.tx(async (rawTx) => {
      const tx = rawTx as Tx;

      const [lobby] = await tx.select().from(userLobbies).where(eq(userLobbies.id, lobbyId)).for('update').limit(1);
      if (!lobby) throw new DomainError('NOT_FOUND', '会客厅不存在');
      if (lobby.hostUserId !== user.userId) throw new DomainError('FORBIDDEN', '只有房主可以开始本局');
      if (!lobby.selectedPuzzleId || !lobby.selectedPuzzleLang) {
        throw new DomainError('STATE_CONFLICT', '请先选题再开始本局');
      }

      // 开局前重验选题
      const [version] = await tx
        .select()
        .from(puzzleVersions)
        .innerJoin(puzzles, eq(puzzles.id, puzzleVersions.puzzleId))
        .where(
          and(
            eq(puzzleVersions.puzzleId, lobby.selectedPuzzleId),
            eq(puzzleVersions.moderationStatus, 'published'),
            eq(puzzleVersions.language, lobby.selectedPuzzleLang as 'zh' | 'en'),
            eq(puzzles.unavailable, false),
          ),
        )
        .orderBy(desc(puzzleVersions.versionNo))
        .limit(1);
      if (!version) throw new DomainError('PUZZLE_UNPUBLISHED', '题目不可用或未发布');

      // 拉当前会客厅成员（房主已在建房时加入，所以只迁非房主）
      const seatRows = await tx
        .select({ userId: lobbyMembers.userId })
        .from(lobbyMembers)
        .where(eq(lobbyMembers.lobbyId, lobbyId));
      const guestIds = seatRows.map((r) => r.userId).filter((uid) => uid !== lobby.hostUserId);

      const now = new Date();
      const newRoomId = await createRoomWithEntitlementTx(tx, {
        creatorUserId: lobby.hostUserId,
        capacity: lobby.capacity,
        inviteTokenHash,
        now,
      });

      for (const uid of guestIds) {
        await tx.insert(roomMembers).values({ roomId: newRoomId, userId: uid, status: 'joined' });
      }

      const [round] = await tx
        .insert(rounds)
        .values({
          roomId: newRoomId,
          roundNo: 1,
          puzzleVersionId: version.puzzle_versions.id,
          language: version.puzzle_versions.language,
          jevConfigVersion: jevConfigVersionOf(),
        })
        .returning();
      if (!round) throw new DomainError('INTERNAL', '创建本局失败');
      // round_participants 包含房主 + 客人：房主不在 lobby_members(永远虚拟在场),
      // 但作为 host 同样拥有本局历史阅读权与提问权。
      const allParticipantIds = new Set<string>([lobby.hostUserId, ...seatRows.map((r) => r.userId)]);
      for (const uid of allParticipantIds) {
        await tx.insert(roundParticipants).values({ roundId: round.id, userId: uid }).onConflictDoNothing();
      }
      await tx.update(rooms).set({ status: 'playing', lastActivityAt: now }).where(eq(rooms.id, newRoomId));
      await appendEvent(tx, {
        roomId: newRoomId,
        roundId: round.id,
        type: 'round.started',
        payload: {
          roundId: round.id,
          roundNo: 1,
          puzzleId: version.puzzles.id,
          title: version.puzzle_versions.title,
          surface: version.puzzle_versions.surface,
          language: version.puzzle_versions.language,
          hintsTotal: version.puzzle_versions.hints.length,
        },
      });

      // 会客厅回到 closed：清临时态、删座位、撤销旧邀请
      await tx
        .update(userLobbies)
        .set({
          status: 'closed',
          closedAt: now,
          selectedPuzzleId: null,
          selectedPuzzleLang: null,
          selectedPuzzleTitle: null,
          selectedPuzzleSurface: null,
        })
        .where(eq(userLobbies.id, lobbyId));
      await tx.delete(lobbyMembers).where(eq(lobbyMembers.lobbyId, lobbyId));
      await tx
        .update(lobbyInvites)
        .set({ revokedAt: now })
        .where(and(eq(lobbyInvites.lobbyId, lobbyId), isNull(lobbyInvites.revokedAt)));

      return newRoomId;
    });

    evictPresence(lobbyId);
    // 事务已提交，向 lobby 内在线订阅者推送 lobby.started；
    // 没有订阅者就走前端轮询兜底（轮询 snapshot 看到 lobby 已 closed 但 selectedPuzzle 已清，
    // 此时前端应保留最近一次 roomId 直接导航，本任务由前端组件完成）。
    app().realtime?.broadcastLobbyStarted(lobbyId, roomId, inviteToken);
    return { roomId, inviteToken };
  }

  /** 解析 INVITE_TTL 常量为毫秒数。 */
  private inviteTtlMs(): number {
    const m = /^(\d+)h$/.exec(INVITE_TTL);
    return m && m[1] ? Number(m[1]) * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  }
}
