/**
 * 房间命令服务（docs/rebuild/04-ROOM-JEV.md §3）。
 *
 * 受理事务步骤：幂等检查 → 锁房间与局 → 校验成员与状态 → 写业务与事件 → 同事务创建调度任务。
 * 客户端只发意图；顺序、终态、判题结果全部由服务端决定。
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  appendEvent,
  archiveRoomTx,
  notifyRoomChange,
  presence,
  profiles,
  puzzleVersions,
  puzzles,
  roomMembers,
  commands,
  rooms,
  roundParticipants,
  rounds,
  turns,
} from '@jev/database';
import {
  DomainError,
  assertControlVersion,
  assertCanEnqueue,
  nextHintIndex,
  pickHostSuccessor,
} from '@jev/domain';
import type { CommandType } from '@jev/contracts';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';

const DISCUSSION_RATE_PER_MINUTE = 30;

function digestOf(input: { type: string; roundId?: string; payload: unknown }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export interface CommandInput {
  clientRequestId: string;
  type: CommandType;
  roundId?: string;
  expectedControlVersion?: number;
  payload: Record<string, unknown>;
}

export interface CommandResult {
  clientRequestId: string;
  discussionId?: string;
  status: 'accepted' | 'duplicate';
  turnId?: string;
  acceptedSeq?: number;
  controlVersion: number;
  inviteToken?: string;
}

@Injectable()
export class CommandsService {
  private get db() {
    return app().db;
  }

  /** 只查询本人命令；未知结果不等于旧请求不会提交，重投必须沿用原编号。 */
  async lookup(user: SessionUser, roomId: string, clientRequestId: string) {
    const [member] = await this.db.db.select().from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.userId))).limit(1);
    if (!member || member.status === 'kicked') throw new DomainError('FORBIDDEN', '没有该房间的阅读权限');
    const [command] = await this.db.db.select().from(commands)
      .where(and(eq(commands.roomId, roomId), eq(commands.userId, user.userId), eq(commands.clientRequestId, clientRequestId))).limit(1);
    return command?.result ? { status: 'accepted' as const, result: command.result } : { status: 'not_found' as const };
  }

  async handle(user: SessionUser, roomId: string, input: CommandInput): Promise<CommandResult> {
    const db = this.db;
    const digest = digestOf(input);

    const result = await db.tx(async (tx) => {
      // 1. 幂等检查：同用户同编号相同内容返回原结果；不同内容冲突
      const inserted = await tx
        .insert(commands)
        .values({
          userId: user.userId,
          clientRequestId: input.clientRequestId,
          type: input.type,
          roomId,
          roundId: input.roundId ?? null,
          payloadDigest: digest,
        })
        .onConflictDoNothing()
        .returning({ id: commands.id });
      if (inserted.length === 0) {
        const [existing] = await tx
          .select()
          .from(commands)
          .where(and(eq(commands.userId, user.userId), eq(commands.clientRequestId, input.clientRequestId)))
          .limit(1);
        if (existing && existing.roomId === roomId && existing.payloadDigest === digest) {
          const [reader] = await tx.select().from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.userId))).limit(1);
          if (!reader || reader.status === 'kicked') throw new DomainError('FORBIDDEN', '没有该房间的阅读权限');
          const prior = (existing.result ?? {}) as Partial<CommandResult>;
          return { controlVersion: 0, ...prior, clientRequestId: input.clientRequestId, status: 'duplicate' as const };
        }
        throw new DomainError('IDEMPOTENCY_CONFLICT', '请求编号已被其他内容使用');
      }

      // 2. 锁房间并校验成员
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update').limit(1);
      if (!room) throw new DomainError('NOT_FOUND', '房间不存在');
      if (room.status === 'closed') throw new DomainError('ROOM_CLOSED', '房间已关闭');

      const [member] = await tx
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.userId)))
        .limit(1);
      if (!member || member.status !== 'joined') throw new DomainError('FORBIDDEN', '你不在这个房间里');

      // 3. 当前局（可能不存在：等待室）
      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.roomId, roomId), eq(rounds.status, 'active')))
        .limit(1);

      const isHost = room.hostUserId === user.userId;

      // 4. 按类型执行
      const outcome = await this.dispatch(tx, {
        user,
        room,
        member,
        round: round ?? null,
        isHost,
        input,
      });

      // 5. 控制命令推进控制版本
      if (outcome.controlCommand) {
        assertControlVersion(input.expectedControlVersion, room.controlVersion);
        await tx.update(rooms).set({ controlVersion: sql`${rooms.controlVersion} + 1` }).where(eq(rooms.id, roomId));
      }

      const commandResult: CommandResult = {
        clientRequestId: input.clientRequestId,
        ...(outcome.discussionId !== undefined ? { discussionId: outcome.discussionId } : {}),
        status: 'accepted',
        ...(outcome.turnId !== undefined ? { turnId: outcome.turnId } : {}),
        ...(outcome.acceptedSeq !== undefined ? { acceptedSeq: outcome.acceptedSeq } : {}),
        controlVersion: outcome.controlCommand ? room.controlVersion + 1 : room.controlVersion,
        ...(outcome.inviteToken !== undefined ? { inviteToken: outcome.inviteToken } : {}),
      };
      await tx.update(commands).set({ result: commandResult as unknown as Record<string, unknown> }).where(eq(commands.id, inserted[0]!.id));
      // droppedUserId 只在本次进程内使用（断开被踢者订阅），不写入幂等结果
      return { ...commandResult, ...(outcome.droppedUserId ? { droppedUserId: outcome.droppedUserId } : {}) };
    });

    await notifyRoomChange(db.pool, roomId);
    // 踢人后立即断开被移除者的实时订阅（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md R06）
    const dropped = (result as { droppedUserId?: string }).droppedUserId;
    if (dropped) {
      app().realtime?.dropUserFromRoom(dropped, roomId);
    }
    return result;
  }

  private async dispatch(
    tx: Parameters<Parameters<import('@jev/database').Database['transaction']>[0]>[0],
    ctx: {
      user: SessionUser;
      room: typeof rooms.$inferSelect;
      member: typeof roomMembers.$inferSelect;
      round: typeof rounds.$inferSelect | null;
      isHost: boolean;
      input: CommandInput;
    },
  ): Promise<{
    discussionId?: string;
    controlCommand: boolean;
    turnId?: string;
    acceptedSeq?: number;
    inviteToken?: string;
    /** kick 命令产出：事务提交后由调用方断开被移除者的实时订阅 */
    droppedUserId?: string;
  }> {
    const { user, room, round, isHost, input } = ctx;
    const payload = input.payload;

    switch (input.type) {
      case 'select_puzzle': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以选题');
        // 一房一题（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md §一.1）：本房玩过题就不再接受新题
        const [existingRound] = await tx.select({ id: rounds.id }).from(rounds).where(eq(rounds.roomId, room.id)).limit(1);
        if (existingRound) throw new DomainError('STATE_CONFLICT', '这个房间已经玩过一道题，下一题请创建新房间');
        const { puzzleId, language } = payload as { puzzleId: string; language: 'zh' | 'en' };
        const [version] = await tx
          .select()
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
          .update(rooms)
          .set({ selectedPuzzleVersionId: version.puzzle_versions.id, lastActivityAt: new Date() })
          .where(eq(rooms.id, room.id));
        await appendEvent(tx, {
          roomId: room.id,
          roundId: null,
          type: 'room.puzzle_selected',
          payload: { puzzleId, title: version.puzzle_versions.title, language: version.puzzle_versions.language },
        });
        return { controlCommand: true };
      }

      case 'start_round': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以开局');
        if (round) throw new DomainError('STATE_CONFLICT', '已有一局正在进行');
        if (!room.selectedPuzzleVersionId) throw new DomainError('STATE_CONFLICT', '请先选题');
        // 授权在创建房间时已确认；开局不重复预留、不重复检查赞助周期
        const [version] = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.id, room.selectedPuzzleVersionId)).limit(1);
        if (!version) throw new DomainError('CONTENT_UNAVAILABLE', '选题内容缺失');
        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(rounds)
          .where(eq(rounds.roomId, room.id));
        const roundNo = (countRow?.count ?? 0) + 1;

        const [newRound] = await tx
          .insert(rounds)
          .values({
            roomId: room.id,
            roundNo,
            puzzleVersionId: version.id,
            language: version.language,
            jevConfigVersion: `${app().jev.model}@${app().jev.promptVersion}@t${app().jev.threshold}@${app().jev.language}`,
          })
          .returning();
        const members = await tx
          .select({ userId: roomMembers.userId })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.status, 'joined')));
        for (const m of members) {
          await tx.insert(roundParticipants).values({ roundId: newRound!.id, userId: m.userId }).onConflictDoNothing();
        }
        await tx.update(rooms).set({ status: 'playing', lastActivityAt: new Date() }).where(eq(rooms.id, room.id));
        await appendEvent(tx, {
          roomId: room.id,
          roundId: newRound!.id,
          type: 'round.started',
          payload: {
            roundId: newRound!.id,
            roundNo,
            puzzleId: version.puzzleId,
            title: version.title,
            surface: version.surface,
            language: version.language,
            hintsTotal: version.hints.length,
          },
        });
        return { controlCommand: true };
      }

      case 'ask':
      case 'solve': {
        if (!round) throw new DomainError('ROUND_ENDED', '当前没有进行中的一局');
        if (input.roundId && input.roundId !== round.id) {
          throw new DomainError('ROUND_ENDED', '这一局已经结束了');
        }
        const [participant] = await tx
          .select()
          .from(roundParticipants)
          .where(and(eq(roundParticipants.roundId, round.id), eq(roundParticipants.userId, user.userId)))
          .limit(1);
        if (!participant) throw new DomainError('FORBIDDEN', '你不在这局里');

        const text = String((payload as { text: string }).text);
        const [userActive] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(turns)
          .where(and(eq(turns.roundId, round.id), eq(turns.userId, user.userId), sql`status in ('queued','processing')`));
        const [roomActive] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(turns)
          .where(and(eq(turns.roundId, round.id), sql`status in ('queued','processing')`));
        assertCanEnqueue({ activeCount: roomActive?.count ?? 0, userActiveCount: userActive?.count ?? 0 }, false);

        const turnId = crypto.randomUUID();
        const event = await appendEvent(tx, {
          roomId: room.id,
          roundId: round.id,
          type: 'turn.accepted',
          payload: {
            turnId,
            clientRequestId: input.clientRequestId,
            userId: user.userId,
            nickname: user.nickname,
            kind: input.type === 'ask' ? 'ask' : 'solve',
            text,
          },
        });

        const [turn] = await tx
          .insert(turns)
          .values({
            id: turnId,
            roundId: round.id,
            userId: user.userId,
            kind: input.type === 'ask' ? 'ask' : 'solve',
            text,
            acceptedSeq: event.seq,
            status: 'queued',
            deadlineAt: new Date(Date.now() + 45_000),
            jevConfigVersion: round.jevConfigVersion,
          })
          .returning({ id: turns.id });

        await app().queue.sendInTx(tx, 'dispatch-room', { roomId: room.id });
        return { controlCommand: false, turnId: turn!.id, acceptedSeq: event.seq };
      }

      case 'cancel_turn': {
        const { turnId } = payload as { turnId: string };
        const [turn] = await tx.select().from(turns).where(eq(turns.id, turnId)).for('update').limit(1);
        if (!turn || turn.userId !== user.userId) throw new DomainError('NOT_FOUND', '任务不存在');
        if (turn.status !== 'queued') throw new DomainError('STATE_CONFLICT', '任务已开始处理，不能取消');
        await tx.update(turns).set({ status: 'cancelled', completedAt: new Date() }).where(eq(turns.id, turnId));
        await appendEvent(tx, { roomId: room.id, roundId: turn.roundId, type: 'turn.cancelled', payload: { turnId } });
        await app().queue.sendInTx(tx, 'dispatch-room', { roomId: room.id });
        return { controlCommand: false };
      }

      case 'discussion': {
        if (!round) throw new DomainError('ROUND_ENDED', '当前没有进行中的一局');
        const text = String((payload as { text: string }).text);
        const [recent] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(sql`room_events`)
          .where(
            sql`room_id = ${room.id} and type = 'discussion.created' and payload->>'userId' = ${user.userId} and created_at > now() - interval '60 seconds'`,
          );
        if ((recent?.count ?? 0) >= DISCUSSION_RATE_PER_MINUTE) {
          throw new DomainError('RATE_LIMITED', '发言太频繁了，稍等片刻。');
        }
        const event = await appendEvent(tx, {
          roomId: room.id,
          roundId: round.id,
          type: 'discussion.created',
          payload: { clientRequestId: input.clientRequestId, userId: user.userId, nickname: user.nickname, text },
        });
        return { controlCommand: false, discussionId: event.eventId, acceptedSeq: event.seq };
      }

      case 'reveal_hint': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以解锁提示');
        if (!round) throw new DomainError('ROUND_ENDED', '当前没有进行中的一局');
        const index = nextHintIndex(round.hintsRevealed);
        const [version] = await tx.select().from(puzzleVersions).where(eq(puzzleVersions.id, round.puzzleVersionId)).limit(1);
        const hint = version?.hints[index];
        if (!hint) throw new DomainError('STATE_CONFLICT', '提示已全部解锁');
        await tx.update(rounds).set({ hintsRevealed: index + 1 }).where(eq(rounds.id, round.id));
        await appendEvent(tx, { roomId: room.id, roundId: round.id, type: 'hint.revealed', payload: { roundId: round.id, index, text: hint } });
        return { controlCommand: true };
      }

      case 'reveal_answer': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以公布答案');
        if (!round) throw new DomainError('ROUND_ENDED', '当前没有进行中的一局');
        await tx
          .update(rounds)
          .set({ status: 'revealed', endedAt: new Date(), endReason: 'host_revealed' })
          .where(eq(rounds.id, round.id));
        await tx.update(roundParticipants).set({ knowsAnswer: true }).where(eq(roundParticipants.roundId, round.id));
        await appendEvent(tx, {
          roomId: room.id,
          roundId: round.id,
          type: 'round.ended',
          payload: { roundId: round.id, status: 'revealed', reason: 'host_revealed' },
        });
        // 终局即归档：本房一题，公布后房间只读（10-ROOM-LIFECYCLE-REVISION §一.1）
        await archiveRoomTx(tx, room.id, 'round_ended', round.id);
        return { controlCommand: true };
      }

      case 'end_round': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以结束本局');
        if (!round) throw new DomainError('ROUND_ENDED', '当前没有进行中的一局');
        await tx
          .update(rounds)
          .set({ status: 'abandoned', endedAt: new Date(), endReason: 'by_host' })
          .where(eq(rounds.id, round.id));
        await appendEvent(tx, {
          roomId: room.id,
          roundId: round.id,
          type: 'round.ended',
          payload: { roundId: round.id, status: 'abandoned', reason: 'by_host' },
        });
        // 房主主动放弃：房间归档，未消费预留释放（10-ROOM-LIFECYCLE-REVISION §一.4）
        await archiveRoomTx(tx, room.id, 'round_ended', round.id);
        return { controlCommand: true };
      }

      case 'leave': {
        await this.removeMember(tx, { room, userId: user.userId, nickname: user.nickname, kicked: false });
        if (isHost) {
          // 房主离开：先转让给在线且最早加入的成员；无人可转让则关闭房间
          const successor = await this.pickSuccessorTx(tx, room.id, room.hostUserId);
          if (successor) {
            await tx.update(rooms).set({ hostUserId: successor }).where(eq(rooms.id, room.id));
            const [successorNickname] = await tx
              .select({ nickname: profiles.nickname })
              .from(profiles)
              .where(eq(profiles.userId, successor))
              .limit(1);
            await appendEvent(tx, {
              roomId: room.id,
              roundId: round?.id ?? null,
              type: 'room.host_changed',
              payload: { userId: successor, nickname: successorNickname?.nickname ?? successor },
            });
          } else {
            await archiveRoomTx(tx, room.id, 'host_left', round?.id ?? null);
          }
        }
        return { controlCommand: true };
      }

      case 'kick': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以移除成员');
        const { userId } = payload as { userId: string };
        const [target] = await tx
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)))
          .limit(1);
        if (!target || target.status !== 'joined') throw new DomainError('NOT_FOUND', '成员不存在');
        const [targetProfile] = await tx.select({ nickname: profiles.nickname }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
        await this.removeMember(tx, { room, userId, nickname: targetProfile?.nickname ?? userId, kicked: true });
        return { controlCommand: true, droppedUserId: userId };
      }

      case 'unrestrict_member': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以解除限制');
        const { userId } = payload as { userId: string };
        const [target] = await tx
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)))
          .limit(1);
        if (!target || target.status !== 'kicked') throw new DomainError('NOT_FOUND', '没有需要解除的成员');
        await tx.update(roomMembers).set({ status: 'left' }).where(eq(roomMembers.id, target.id));
        await appendEvent(tx, { roomId: room.id, roundId: round?.id ?? null, type: 'room.member_unrestricted', payload: { userId } });
        return { controlCommand: true };
      }

      case 'transfer_host': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以转让');
        const { userId } = payload as { userId: string };
        // 目标必须是在线成员（docs/rebuild/03-SPEC.md §6）
        const [targetPresence] = await tx
          .select()
          .from(presence)
          .where(and(eq(presence.roomId, room.id), eq(presence.userId, userId), sql`last_seen_at > now() - interval '45 seconds'`))
          .limit(1);
        if (!targetPresence) throw new DomainError('STATE_CONFLICT', '目标成员不在线');
        const [targetMember] = await tx
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId), eq(roomMembers.status, 'joined')))
          .limit(1);
        if (!targetMember) throw new DomainError('NOT_FOUND', '成员不存在');
        await tx.update(rooms).set({ hostUserId: userId }).where(eq(rooms.id, room.id));
        const [targetProfile] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
        await appendEvent(tx, {
          roomId: room.id,
          roundId: round?.id ?? null,
          type: 'room.host_changed',
          payload: { userId, nickname: targetProfile?.nickname ?? userId },
        });
        return { controlCommand: true };
      }

      case 'rotate_invite': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以重置邀请');
        const token = randomBytes(16).toString('hex');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        await tx.update(rooms).set({ inviteTokenHash: tokenHash }).where(eq(rooms.id, room.id));
        await appendEvent(tx, { roomId: room.id, roundId: round?.id ?? null, type: 'room.invite_rotated', payload: {} });
        return { controlCommand: true, inviteToken: token };
      }

      case 'close_room': {
        if (!isHost) throw new DomainError('FORBIDDEN', '只有房主可以解散房间');
        await archiveRoomTx(tx, room.id, 'by_host', round?.id ?? null);
        return { controlCommand: true };
      }

      default: {
        const exhaustive: never = input.type;
        throw new DomainError('VALIDATION_FAILED', `未知命令：${String(exhaustive)}`);
      }
    }
  }

  /** 成员离开/被移除：退出本局参与者阅读权、取消其排队任务、删除进行中标记。 */
  private async removeMember(
    tx: Parameters<Parameters<import('@jev/database').Database['transaction']>[0]>[0],
    ctx: { room: typeof rooms.$inferSelect; userId: string; nickname: string; kicked: boolean },
  ): Promise<void> {
    const { room, userId, nickname, kicked } = ctx;
    const now = new Date();

    await tx
      .update(roomMembers)
      .set(kicked ? { status: 'kicked', kickedAt: now, leftAt: now } : { status: 'left', leftAt: now })
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)));
    await tx.delete(presence).where(and(eq(presence.roomId, room.id), eq(presence.userId, userId)));

    // 进行中的局：被移除者撤销历史阅读权（主动离开保留）
    const [round] = await tx
      .select()
      .from(rounds)
      .where(and(eq(rounds.roomId, room.id), eq(rounds.status, 'active')))
      .limit(1);
    if (round) {
      if (kicked) {
        await tx
          .update(roundParticipants)
          .set({ canRead: false })
          .where(and(eq(roundParticipants.roundId, round.id), eq(roundParticipants.userId, userId)));
      }
      // 只取消排队任务；处理中的保留公共问题（docs/rebuild/04-ROOM-JEV.md §6）
      const queued = await tx
        .update(turns)
        .set({ status: 'cancelled', completedAt: now })
        .where(and(eq(turns.roundId, round.id), eq(turns.userId, userId), eq(turns.status, 'queued')))
        .returning({ id: turns.id });
      for (const t of queued) {
        await appendEvent(tx, { roomId: room.id, roundId: round.id, type: 'turn.cancelled', payload: { turnId: t.id } });
      }
      await appendEvent(tx, {
        roomId: room.id,
        roundId: round.id,
        type: kicked ? 'room.member_kicked' : 'room.member_left',
        payload: { userId, nickname },
      });
    } else {
      await appendEvent(tx, {
        roomId: room.id,
        roundId: null,
        type: kicked ? 'room.member_kicked' : 'room.member_left',
        payload: { userId, nickname },
      });
    }
  }

  /** 在线且最早加入的继任房主（纯规则在 domain.pickHostSuccessor）。 */
  private async pickSuccessorTx(
    tx: Parameters<Parameters<import('@jev/database').Database['transaction']>[0]>[0],
    roomId: string,
    currentHostId: string,
  ): Promise<string | null> {
    const members = await tx
      .select({ userId: roomMembers.userId, joinedAt: roomMembers.joinedAt })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, 'joined')));
    const online = await tx.select({ userId: presence.userId }).from(presence).where(eq(presence.roomId, roomId));
    const onlineSet = new Set(online.map((o) => o.userId));
    return pickHostSuccessor(
      members.map((m) => ({ ...m, status: 'joined' as const, online: onlineSet.has(m.userId) })),
      currentHostId,
    );
  }
}

