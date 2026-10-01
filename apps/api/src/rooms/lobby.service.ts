/**
 * 等待室服务（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md v2 §三）。
 *
 * 开局前的组队阶段只存本进程内存：创建/加入/选题/踢人/解散均不写数据库；
 * start 是唯一写库入口（授权预留 → 建房 → 建局）。等待页 2 秒轮询即心跳。
 * 部署边界：API 单实例（与实时网关同前提）；多实例时需迁移到共享存储。
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { and, desc, eq } from 'drizzle-orm';
import { appendEvent, puzzleVersions, puzzles, roomMembers, rooms, roundParticipants, rounds } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';
import { createRoomWithEntitlementTx, jevConfigVersionOf } from './room-creation.js';

/** 在线 = 30 秒内轮询过 */
const ONLINE_WINDOW_MS = 30_000;
/** 未开局等待室闲置回收：2 小时无任何成员心跳 */
const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** 开局去向（tombstone）保留：成员轮询到即跳转 */
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
/** 邀请令牌有效期 */
const INVITE_TTL = '24h';
const GC_INTERVAL_MS = 60_000;

interface LobbyMember {
  nickname: string;
  joinedAt: number;
  lastSeenAt: number;
}

interface LobbyState {
  id: string;
  hostUserId: string;
  capacity: number;
  createdAt: number;
  /** userId → 成员信息；房主创建时即加入 */
  members: Map<string, LobbyMember>;
  kicked: Set<string>;
  selectedPuzzle: { puzzleId: string; language: 'zh' | 'en'; title: string; surface: string } | null;
  /** 开局去向：非空后等待室只读，轮询方拿它跳正式房间 */
  startedRoomId: string | null;
  startedAt: number | null;
  /** start 事务进行中：防止房主连点开两个房间 */
  starting: boolean;
}

function hashlessTokenSecret(): Uint8Array {
  return new TextEncoder().encode(`${app().env.AUTH_SECRET}:lobby`);
}

@Injectable()
export class LobbyService implements OnModuleInit, OnModuleDestroy {
  private readonly lobbies = new Map<string, LobbyState>();
  /** 房主单例索引：hostUserId → 未开局的等待室 */
  private readonly hostIndex = new Map<string, string>();
  private gcTimer: NodeJS.Timeout | null = null;
  /** 邀请令牌签名密钥：生产取 AUTH_SECRET，单测注入固定密钥（真 JWT 往返） */
  private readonly inviteSecret: () => Uint8Array;

  constructor(inviteSecret?: () => Uint8Array) {
    this.inviteSecret = inviteSecret ?? hashlessTokenSecret;
  }

  onModuleInit(): void {
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }

  /** 闲置回收：未开局 2 小时无人心跳、或 tombstone 超期。 */
  gc(now = Date.now()): void {
    for (const [id, lobby] of this.lobbies) {
      if (lobby.startedRoomId) {
        if (lobby.startedAt !== null && now - lobby.startedAt > TOMBSTONE_TTL_MS) this.dispose(lobby);
        continue;
      }
      const lastSeen = Math.max(lobby.createdAt, ...[...lobby.members.values()].map((m) => m.lastSeenAt));
      if (now - lastSeen > IDLE_TTL_MS) this.dispose(lobby);
    }
  }

  private dispose(lobby: LobbyState): void {
    this.lobbies.delete(lobby.id);
    if (this.hostIndex.get(lobby.hostUserId) === lobby.id) this.hostIndex.delete(lobby.hostUserId);
  }

  private lobbyOf(lobbyId: string): LobbyState {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new DomainError('LOBBY_NOT_FOUND', '等待室不存在或已解散');
    return lobby;
  }

  /** 成员视角取等待室：被踢提示需房主解除（等待室由房主解散，重进须重新受邀）。 */
  private memberLobbyOf(user: SessionUser, lobbyId: string): LobbyState {
    const lobby = this.lobbyOf(lobbyId);
    if (lobby.kicked.has(user.userId)) throw new DomainError('MEMBER_RESTRICTED', '你已被移出该等待室');
    const member = lobby.members.get(user.userId);
    if (!member) throw new DomainError('FORBIDDEN', '你不在这个等待室里');
    // 心跳刷新顺带同步昵称（改名后无需重进）
    member.lastSeenAt = Date.now();
    if (member.nickname !== user.nickname) member.nickname = user.nickname;
    return lobby;
  }

  private requireHost(lobby: LobbyState, user: SessionUser): void {
    if (lobby.hostUserId !== user.userId) throw new DomainError('FORBIDDEN', '只有房主可以执行这个操作');
  }

  // ---------- 创建与邀请 ----------

  /** 建等待室：房主单例——已有未开局等待室时返回同一实例（成员与已选题保留）。 */
  async create(user: SessionUser, capacity: number): Promise<{ lobbyId: string; inviteToken: string; existing: boolean }> {
    const existingId = this.hostIndex.get(user.userId);
    if (existingId) {
      const existing = this.lobbies.get(existingId);
      if (existing && !existing.startedRoomId) {
        return { lobbyId: existing.id, inviteToken: await this.signInvite(existing.id), existing: true };
      }
      this.hostIndex.delete(user.userId);
    }

    const lobby: LobbyState = {
      id: randomUUID(),
      hostUserId: user.userId,
      capacity,
      createdAt: Date.now(),
      members: new Map([[user.userId, { nickname: user.nickname, joinedAt: Date.now(), lastSeenAt: Date.now() }]]),
      kicked: new Set(),
      selectedPuzzle: null,
      startedRoomId: null,
      startedAt: null,
      starting: false,
    };
    this.lobbies.set(lobby.id, lobby);
    this.hostIndex.set(user.userId, lobby.id);
    return { lobbyId: lobby.id, inviteToken: await this.signInvite(lobby.id), existing: false };
  }

  private async signInvite(lobbyId: string): Promise<string> {
    return new SignJWT({ purpose: 'lobby', lobbyId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(INVITE_TTL)
      .sign(this.inviteSecret());
  }

  private async lobbyIdOfInvite(token: string): Promise<string> {
    let lobbyId: string | null = null;
    try {
      const { payload } = await jwtVerify(token, this.inviteSecret());
      if (payload.purpose === 'lobby' && typeof payload.lobbyId === 'string') lobbyId = payload.lobbyId;
    } catch {
      // 落到统一的 NOT_FOUND
    }
    if (!lobbyId) throw new DomainError('LOBBY_NOT_FOUND', '邀请无效或已失效');
    return lobbyId;
  }

  /** 邀请预览：最小信息，不给成员资料。 */
  async previewByInvite(token: string): Promise<{ lobbyId: string; hostNickname: string; memberCount: number; capacity: number }> {
    const lobby = this.lobbyOf(await this.lobbyIdOfInvite(token));
    const host = lobby.members.get(lobby.hostUserId);
    return {
      lobbyId: lobby.id,
      hostNickname: host?.nickname ?? lobby.hostUserId,
      memberCount: lobby.members.size,
      capacity: lobby.capacity,
    };
  }

  /** 凭邀请加入：已在成员表幂等；等待室已开局时直接给去向。 */
  async join(user: SessionUser, token: string): Promise<{ lobbyId: string; startedRoomId: string | null }> {
    const lobby = this.lobbyOf(await this.lobbyIdOfInvite(token));
    if (lobby.startedRoomId) return { lobbyId: lobby.id, startedRoomId: lobby.startedRoomId };
    if (lobby.kicked.has(user.userId)) throw new DomainError('MEMBER_RESTRICTED', '你已被移出该等待室，需要房主重新邀请');

    const now = Date.now();
    const member = lobby.members.get(user.userId);
    if (member) {
      member.lastSeenAt = now;
      member.nickname = user.nickname;
      return { lobbyId: lobby.id, startedRoomId: null };
    }
    if (lobby.members.size >= lobby.capacity) throw new DomainError('LOBBY_FULL', '等待室已经满了');
    lobby.members.set(user.userId, { nickname: user.nickname, joinedAt: now, lastSeenAt: now });
    return { lobbyId: lobby.id, startedRoomId: null };
  }

  // ---------- 等待室状态 ----------

  /** 快照：成员列表（在线 = 30 秒内轮询过）、已选题、开局去向。 */
  snapshot(user: SessionUser, lobbyId: string) {
    const lobby = this.memberLobbyOf(user, lobbyId);
    const now = Date.now();
    return {
      lobbyId: lobby.id,
      hostUserId: lobby.hostUserId,
      capacity: lobby.capacity,
      members: [...lobby.members.entries()]
        .sort(([, a], [, b]) => a.joinedAt - b.joinedAt)
        .map(([userId, m]) => ({
          userId,
          nickname: m.nickname,
          online: now - m.lastSeenAt < ONLINE_WINDOW_MS,
          isHost: userId === lobby.hostUserId,
        })),
      selectedPuzzle: lobby.selectedPuzzle,
      startedRoomId: lobby.startedRoomId,
    };
  }

  /** 房主选题：记在内存，开局事务内会重新校验已发布。 */
  async select(user: SessionUser, lobbyId: string, puzzleId: string, language: 'zh' | 'en'): Promise<void> {
    const lobby = this.memberLobbyOf(user, lobbyId);
    this.requireHost(lobby, user);
    if (lobby.startedRoomId) throw new DomainError('STATE_CONFLICT', '这一局已经开始了');

    const [version] = await app().db.db
      .select({ puzzleId: puzzles.id, versionId: puzzleVersions.id, title: puzzleVersions.title, surface: puzzleVersions.surface, language: puzzleVersions.language })
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

    lobby.selectedPuzzle = { puzzleId: version.puzzleId, language, title: version.title, surface: version.surface };
  }

  /** 非房主成员离开；房主请走解散。 */
  leave(user: SessionUser, lobbyId: string): void {
    const lobby = this.memberLobbyOf(user, lobbyId);
    if (lobby.hostUserId === user.userId) throw new DomainError('STATE_CONFLICT', '房主离开请直接解散等待室');
    lobby.members.delete(user.userId);
  }

  kick(user: SessionUser, lobbyId: string, targetUserId: string): void {
    const lobby = this.memberLobbyOf(user, lobbyId);
    this.requireHost(lobby, user);
    if (targetUserId === lobby.hostUserId) throw new DomainError('STATE_CONFLICT', '不能移出房主');
    if (!lobby.members.has(targetUserId)) throw new DomainError('NOT_FOUND', '成员不存在');
    lobby.members.delete(targetUserId);
    lobby.kicked.add(targetUserId);
  }

  /** 房主解散：删除内存对象，成员下次轮询得到 LOBBY_NOT_FOUND。 */
  dismiss(user: SessionUser, lobbyId: string): void {
    const lobby = this.memberLobbyOf(user, lobbyId);
    this.requireHost(lobby, user);
    this.dispose(lobby);
  }

  // ---------- 开局（唯一写库入口） ----------

  /**
   * 开始本轮：单事务内重验题目 → 授权预留（先赞助后免费）→ 建房 → 全体成员 → 建局 → round.started 事件。
   * 失败（如免费次数用尽）整事务回滚、等待室原样保留。成功后留下 tombstone 供成员跳转。
   */
  async start(user: SessionUser, lobbyId: string): Promise<{ roomId: string; inviteToken: string }> {
    const lobby = this.memberLobbyOf(user, lobbyId);
    this.requireHost(lobby, user);

    if (lobby.startedRoomId) {
      // 已开局：返回既有房间（轮询重试/连点幂等）；邀请令牌需房主在正式房间重置获取
      throw new DomainError('STATE_CONFLICT', '这一局已经开始了');
    }
    if (lobby.starting) throw new DomainError('STATE_CONFLICT', '正在开局，请稍候');
    if (!lobby.selectedPuzzle) throw new DomainError('STATE_CONFLICT', '请先选题再开始本局');

    lobby.starting = true;
    try {
      const db = app().db;
      const now = new Date();
      const inviteToken = randomBytes(16).toString('hex');
      const inviteTokenHash = createHash('sha256').update(inviteToken).digest('hex');
      const selected = lobby.selectedPuzzle;

      const roomId = await db.tx(async (tx) => {
        // 开局前重验：选题后题目可能被下架或退回
        const [version] = await tx
          .select()
          .from(puzzleVersions)
          .innerJoin(puzzles, eq(puzzles.id, puzzleVersions.puzzleId))
          .where(
            and(
              eq(puzzleVersions.puzzleId, selected.puzzleId),
              eq(puzzleVersions.moderationStatus, 'published'),
              eq(puzzleVersions.language, selected.language),
              eq(puzzles.unavailable, false),
            ),
          )
          .orderBy(desc(puzzleVersions.versionNo))
          .limit(1);
        if (!version) throw new DomainError('PUZZLE_UNPUBLISHED', '题目不可用或未发布');

        const newRoomId = await createRoomWithEntitlementTx(tx, {
          creatorUserId: lobby.hostUserId,
          capacity: lobby.capacity,
          inviteTokenHash,
          now,
        });

        for (const userId of lobby.members.keys()) {
          if (userId === lobby.hostUserId) continue; // 房主已随建房加入
          await tx.insert(roomMembers).values({ roomId: newRoomId, userId, status: 'joined' });
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
        for (const userId of lobby.members.keys()) {
          await tx.insert(roundParticipants).values({ roundId: round!.id, userId }).onConflictDoNothing();
        }
        await tx.update(rooms).set({ status: 'playing', lastActivityAt: now }).where(eq(rooms.id, newRoomId));
        await appendEvent(tx, {
          roomId: newRoomId,
          roundId: round!.id,
          type: 'round.started',
          payload: {
            roundId: round!.id,
            roundNo: 1,
            puzzleId: version.puzzles.id,
            title: version.puzzle_versions.title,
            surface: version.puzzle_versions.surface,
            language: version.puzzle_versions.language,
            hintsTotal: version.puzzle_versions.hints.length,
          },
        });
        return newRoomId;
      });

      lobby.startedRoomId = roomId;
      lobby.startedAt = Date.now();
      this.hostIndex.delete(lobby.hostUserId); // 开局即完成使命，释放房主单例名额
      return { roomId, inviteToken };
    } finally {
      lobby.starting = false;
    }
  }
}
