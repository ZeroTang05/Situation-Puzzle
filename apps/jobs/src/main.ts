/**
 * jobs 进程：pg-boss 任务执行器（docs/rebuild/04-ROOM-JEV.md §4）。
 *
 * 任务拓扑：
 *   dispatch-room    房间调度：领取最早 queued 任务并投递 process-turn
 *   process-turn     判题执行：领取（短事务）→ Jev 请求（事务外）→ 结果事务
 *   review-puzzle    投稿机器检查：Jev 辅助审核
 *   maintenance      每 5 秒巡检：排队超时、占用失效、房主转让、全员离线、订单关单
 *
 * 锁序：房间 → 局 → 赞助账户 → 免费账户 → 任务。
 */
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@jev/database/schema';
import {
  appendEvent,
  consumeEntitlementIfFreeTx,
  freeRoomAccounts,
  notifyRoomChange,
  presence,
  profiles,
  puzzleVersions,
  puzzles,
  refundConsumedEntitlementTx,
  roomMembers,
  rooms,
  roundParticipants,
  rounds,
  turns,
  jevCalls,
  moderationReviews,
} from '@jev/database';
import { JevClient, jevConfigFromEnv, isInfraFailure, type JevAttemptRecord } from '@jev/jev';
import { loadEnv } from './env.js';
import type { DispatchPayload, TurnPayload, ReviewPayload } from './types.js';

const TURN_ATTEMPT_TIMEOUT_MS = 20_000;
const TURN_TOTAL_DEADLINE_MS = 45_000;
const TURN_QUEUE_TIMEOUT_MS = 60_000;
const LEASE_MS = 60_000;
/** 单局连续基础设施失败次数阈值：达到即中止本局并关闭房间 */
const CONSECUTIVE_INFRA_FAILURES_LIMIT = 3;

interface Env {
  DATABASE_URL: string;
  OPENCODE_API_KEY: string;
  JEV_BASE_URL?: string;
  JEV_MODEL?: string;
  JEV_THRESHOLD?: string;
  JEV_LANGUAGE?: 'zh' | 'en';
  WECHAT_PAY_MCHID?: string;
}

type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

class JobsApp {
  private pool!: Pool;
  private db!: NodePgDatabase<typeof schema>;
  private boss!: PgBoss;
  private jev!: JevClient;
  private env!: Env;
  /** 基础设施熔断：连续失败计数与暂停截止时间（进程内） */
  private infraFailures = 0;
  private pausedUntil = 0;

  async start(): Promise<void> {
    this.env = loadEnv() as unknown as Env;
    this.pool = new Pool({ connectionString: this.env.DATABASE_URL, max: 10 });
    await this.pool.query('select 1');
    this.db = drizzle(this.pool, { schema });
    this.boss = new PgBoss({ connectionString: this.env.DATABASE_URL });
    this.boss.on('error', (e) => console.error('[pg-boss]', e));
    await this.boss.start();

    const jevConfig = jevConfigFromEnv(this.env as unknown as NodeJS.ProcessEnv);
    this.jev = new JevClient(jevConfig, (record) => void this.recordAttempt(record, jevConfig.model, jevConfig.promptVersion));

    await this.boss.createQueue('dispatch-room');
    await this.boss.createQueue('process-turn');
    await this.boss.createQueue('review-puzzle');
    await this.boss.createQueue('maintenance');

    await this.boss.work('dispatch-room', { pollingIntervalSeconds: 1 }, (jobs) => this.dispatchRoom(jobs[0]!.data as DispatchPayload));
    await this.boss.work('process-turn', { pollingIntervalSeconds: 1, batchSize: 1 }, (jobs) => this.processTurn(jobs[0]!.data as TurnPayload));
    await this.boss.work('review-puzzle', { batchSize: 1 }, (jobs) => this.reviewPuzzle(jobs[0]!.data as ReviewPayload));
    await this.boss.work('maintenance', { pollingIntervalSeconds: 5 }, () => this.maintenance());
    await this.boss.send('maintenance', {}, { startAfter: 5 });

    console.log('[jobs] 任务进程已启动');
  }

  /** 每次真实 Jev 尝试写 jev_calls（多人审计与成本统计）。 */
  private async recordAttempt(record: JevAttemptRecord, model: string, promptVersion: string): Promise<void> {
    try {
      await this.db.insert(jevCalls).values({
        turnId: this.currentTurnId,
        model,
        promptVersion,
        attempt: record.attempt,
        status: record.status,
        choice: record.choice ?? null,
        confidence: record.confidence !== undefined ? String(record.confidence) : null,
        usage: record.usage ?? null,
        errorClass: record.errorClass ?? null,
        startedAt: new Date(Date.now() - record.durationMs),
        endedAt: new Date(),
      });
    } catch (error) {
      console.error('[jobs] jev_calls 写入失败', error);
    }
  }

  private currentTurnId: string | null = null;

  // ---------- 房间调度 ----------

  /** 领取该房间最早 queued 任务并投递 process-turn（单队列：每房同一时刻只有一个 processing）。 */
  private async dispatchRoom(payload: DispatchPayload): Promise<void> {
    const db = this.db;
    const now = new Date();
    const claimed = await db.transaction(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, payload.roomId)).for('update').limit(1);
      if (!room || room.status === 'closed') return null;

      const [processing] = await tx
        .select({ id: turns.id })
        .from(turns)
        .where(and(eq(turns.roundId, sql`(select id from rounds where room_id = ${payload.roomId} and status = 'active' limit 1)`), eq(turns.status, 'processing')))
        .limit(1);
      if (processing) return null; // 已有任务在处理

      const [round] = await tx
        .select()
        .from(rounds)
        .where(and(eq(rounds.roomId, payload.roomId), eq(rounds.status, 'active')))
        .limit(1);
      if (!round) return null;

      const [next] = await tx
        .select()
        .from(turns)
        .where(and(eq(turns.roundId, round.id), eq(turns.status, 'queued')))
        .orderBy(asc(turns.acceptedSeq))
        .for('update', { skipLocked: true })
        .limit(1);
      if (!next) return null;

      // 排队超时：60 秒未开始判为失败，不消耗有效判题
      if (now.getTime() - next.acceptedAt.getTime() > TURN_QUEUE_TIMEOUT_MS) {
        await tx
          .update(turns)
          .set({ status: 'failed', failReason: 'queue_timeout', completedAt: now })
          .where(eq(turns.id, next.id));
        const nickname = (await tx.select({ n: profiles.nickname }).from(profiles).where(eq(profiles.userId, next.userId)).limit(1))[0]?.n ?? next.userId;
        await appendEvent(tx, {
          roomId: payload.roomId,
          roundId: round.id,
          type: 'turn.failed',
          payload: { turnId: next.id, reason: 'queue_timeout', retryable: true },
        });
        void nickname;
        return null;
      }

      const executionToken = crypto.randomUUID();
      await tx
        .update(turns)
        .set({ status: 'processing', executionToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), startedAt: now })
        .where(eq(turns.id, next.id));
      await appendEvent(tx, { roomId: payload.roomId, roundId: round.id, type: 'turn.started', payload: { turnId: next.id } });
      return { turnId: next.id };
    });

    if (claimed) {
      await notifyRoomChange(this.pool, payload.roomId);
      await this.boss.send('process-turn', { turnId: claimed.turnId, roomId: payload.roomId } satisfies TurnPayload);
    }
  }

  // ---------- 判题执行 ----------

  /** 领取（已由 dispatch 完成）→ Jev 请求（事务外）→ 结果事务（校验令牌与取消代次）。 */
  private async processTurn(payload: TurnPayload): Promise<void> {
    const db = this.db;
    const now = new Date();

    // 读取任务与固定题目版本
    const [turn] = await db.select().from(turns).where(eq(turns.id, payload.turnId)).limit(1);
    if (!turn || turn.status !== 'processing') return;
    if (turn.deadlineAt && turn.deadlineAt.getTime() < now.getTime()) {
      await this.failTurn(payload, 'deadline_exceeded', true);
      return;
    }
    const [round] = await db.select().from(rounds).where(eq(rounds.id, turn.roundId)).limit(1);
    if (!round || round.status !== 'active' || round.cancelGeneration !== turn.cancelGeneration) {
      await this.cancelTurnQuietly(payload.turnId);
      return;
    }
    const [version] = await db.select().from(puzzleVersions).where(eq(puzzleVersions.id, round.puzzleVersionId)).limit(1);
    const [puzzle] = await db.select().from(puzzles).where(eq(puzzles.id, version!.puzzleId)).limit(1);
    if (!version || !puzzle) {
      await this.failTurn(payload, 'content_missing', true);
      return;
    }

    this.currentTurnId = turn.id;
    try {
      // 熔断：暂停期间不发起模型请求
      if (this.pausedUntil > Date.now()) throw new Error('Jev 熔断暂停中');

      let verdict;
      if (turn.kind === 'ask') {
        verdict = await this.jev.ask({
          title: version.title,
          surface: version.surface,
          answer: version.answer,
          coreFacts: version.coreFacts,
          question: turn.text,
        });
        await this.completeTurn(payload, verdict.result, String(verdict.confidence));
      } else {
        verdict = await this.jev.solve({
          title: version.title,
          surface: version.surface,
          answer: version.answer,
          coreFacts: version.coreFacts,
          solution: turn.text,
        });
        await this.completeTurn(payload, verdict.result, String(verdict.confidence), verdict.result === 'solved');
      }
      this.infraFailures = 0;
    } catch (error) {
      this.currentTurnId = null;
      const infra = isInfraFailure(error);
      if (infra) {
        this.infraFailures += 1;
        if (this.infraFailures >= 5) this.pausedUntil = Date.now() + 30_000;
      }
      console.error(`[jobs] Jev 判题失败（turn=${turn.id}）`, error);
      await this.failTurn(payload, infra ? 'jev_infra' : 'jev_protocol', true);
    } finally {
      this.currentTurnId = null;
    }
  }

  /** 结果事务：终局判定、首个有效判定的免费次数消费、事件与下一任务调度，全部原子提交。 */
  private async completeTurn(payload: TurnPayload, result: string, confidence: string, solved = false): Promise<void> {
    const db = this.db;
    const now = new Date();
    await db.transaction(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, payload.roomId)).for('update').limit(1);
      const [turn] = await tx.select().from(turns).where(eq(turns.id, payload.turnId)).for('update').limit(1);
      const [round] = await tx.select().from(rounds).where(eq(rounds.id, turn!.roundId)).for('update').limit(1);
      if (!room || !turn || !round) return;
      if (turn.status !== 'processing' || round.cancelGeneration !== turn.cancelGeneration) return;
      if (round.status !== 'active') return;

      await tx
        .update(turns)
        .set({ status: 'succeeded', result, confidence, completedAt: now })
        .where(eq(turns.id, turn.id));
      await tx.update(rounds).set({ effectiveVerdicts: sql`${rounds.effectiveVerdicts} + 1` }).where(eq(rounds.id, round.id));
      await appendEvent(tx, { roomId: room.id, roundId: round.id, type: 'turn.completed', payload: { turnId: turn.id, result } });

      // 房间首次有效判定：免费预留正式消费（同一事务）
      await consumeEntitlementIfFreeTx(tx, room.id);

      if (solved) {
        // 破解成功：全局结束，取消未完成任务
        await tx
          .update(turns)
          .set({ status: 'cancelled', completedAt: now })
          .where(and(eq(turns.roundId, round.id), inArray(turns.status, ['queued', 'processing'])));
        await tx
          .update(rounds)
          .set({ status: 'solved', endedAt: now, endReason: 'solved', cancelGeneration: sql`${rounds.cancelGeneration} + 1` })
          .where(eq(rounds.id, round.id));
        await tx.update(roundParticipants).set({ knowsAnswer: true }).where(eq(roundParticipants.roundId, round.id));
        await tx.update(rooms).set({ status: 'waiting', lastActivityAt: now }).where(eq(rooms.id, room.id));
        await appendEvent(tx, { roomId: room.id, roundId: round.id, type: 'round.ended', payload: { roundId: round.id, status: 'solved', reason: 'solved' } });
      }
    });
    await notifyRoomChange(this.pool, payload.roomId);
    // 调度下一任务
    await this.boss.send('dispatch-room', { roomId: payload.roomId } satisfies DispatchPayload);
  }

  /** 失败事务：写失败状态与事件；连续基础设施失败达阈值时中止本局并关闭房间（含免费次数退回）。 */
  private async failTurn(payload: TurnPayload, reason: string, retryable: boolean): Promise<void> {
    const db = this.db;
    const now = new Date();
    await db.transaction(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, payload.roomId)).for('update').limit(1);
      const [turn] = await tx.select().from(turns).where(eq(turns.id, payload.turnId)).for('update').limit(1);
      if (!room || !turn) return;
      const [round] = await tx.select().from(rounds).where(eq(rounds.id, turn.roundId)).limit(1);
      if (turn.status !== 'processing' && turn.status !== 'queued') return;

      await tx
        .update(turns)
        .set({ status: 'failed', failReason: reason, completedAt: now })
        .where(eq(turns.id, turn.id));
      await appendEvent(tx, {
        roomId: room.id,
        roundId: turn.roundId,
        type: 'turn.failed',
        payload: { turnId: turn.id, reason, retryable },
      });

      if (!round || round.status !== 'active') return;
      // 连续 3 个任务因基础设施失败：中止本局并关闭房间（docs/rebuild/04-ROOM-JEV.md §7）
      const recent = await tx
        .select({ status: turns.status, failReason: turns.failReason })
        .from(turns)
        .where(and(eq(turns.roundId, round.id), inArray(turns.status, ['failed', 'succeeded'])))
        .orderBy(sql`${turns.acceptedSeq} desc`)
        .limit(CONSECUTIVE_INFRA_FAILURES_LIMIT);
      const infraStreak =
        recent.length >= CONSECUTIVE_INFRA_FAILURES_LIMIT &&
        recent.every((t) => t.status === 'failed' && t.failReason === 'jev_infra');
      if (infraStreak && reason === 'jev_infra') {
        const normalEnded = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(rounds)
          .where(and(eq(rounds.roomId, room.id), inArray(rounds.status, ['solved', 'revealed'])));
        await tx
          .update(rounds)
          .set({ status: 'aborted', endedAt: now, endReason: 'jev_unavailable', cancelGeneration: sql`${rounds.cancelGeneration} + 1` })
          .where(and(eq(rounds.id, round.id), eq(rounds.status, 'active')));
        await tx
          .update(turns)
          .set({ status: 'cancelled', completedAt: now })
          .where(and(eq(turns.roundId, round.id), inArray(turns.status, ['queued', 'processing'])));
        await appendEvent(tx, {
          roomId: room.id,
          roundId: round.id,
          type: 'round.ended',
          payload: { roundId: round.id, status: 'aborted', reason: 'jev_unavailable' },
        });

        if ((normalEnded[0]?.count ?? 0) === 0) {
          // 该房间从无正常结束的局：免费次数整房退回一次；赞助房间仅记录故障
          const refunded = await refundConsumedEntitlementTx(tx, room.id);
          await appendEvent(tx, {
            roomId: room.id,
            roundId: null,
            type: 'room.closed',
            payload: { reason: 'moderation', refundedFreeRoom: refunded },
          });
        } else {
          await appendEvent(tx, { roomId: room.id, roundId: null, type: 'room.closed', payload: { reason: 'moderation' } });
        }
        await tx.update(rooms).set({ status: 'closed', closedAt: now, closeReason: 'moderation' }).where(eq(rooms.id, room.id));
      }
    });
    await notifyRoomChange(this.pool, payload.roomId);
    await this.boss.send('dispatch-room', { roomId: payload.roomId } satisfies DispatchPayload);
  }

  private async cancelTurnQuietly(turnId: string): Promise<void> {
    await this.db.update(turns).set({ status: 'cancelled', completedAt: new Date() }).where(eq(turns.id, turnId));
  }

  // ---------- 投稿机器检查 ----------

  private async reviewPuzzle(payload: ReviewPayload): Promise<void> {
    const db = this.db;
    const [version] = await db.select().from(puzzleVersions).where(eq(puzzleVersions.id, payload.versionId)).limit(1);
    if (!version || version.moderationStatus !== 'submitted') return;
    try {
      const verdict = await this.jev.review({
        title: version.title,
        surface: version.surface,
        answer: version.answer,
        hints: version.hints,
      });
      const conclusion = verdict;
      await db.transaction(async (tx) => {
        await tx.insert(moderationReviews).values({
          versionId: version.id,
          stage: 'machine',
          conclusion,
          modelVersion: `${this.jevModel}@${this.jevPromptVersion}`,
        });
        // 机器通过 → 待人工审核；不通过 → 退回修改（附机器理由）
        if (conclusion === 'review_pass') {
          await tx.update(puzzleVersions).set({ moderationStatus: 'pending_review' }).where(eq(puzzleVersions.id, version.id));
        } else {
          await tx.update(puzzleVersions).set({ moderationStatus: 'changes_requested' }).where(eq(puzzleVersions.id, version.id));
          await tx.insert(moderationReviews).values({
            versionId: version.id,
            stage: 'machine',
            conclusion: 'changes_requested',
            reason: conclusion === 'review_reject' ? '内容检查未通过' : '内容检查无法确定，需人工复核',
          });
        }
      });
    } catch (error) {
      // 机器检查失败停在 submitted，可重试；不把接口失败当拒稿
      console.error('[jobs] 投稿机器检查失败，稍后重试', error);
      await this.boss.send('review-puzzle', payload, { startAfter: 60 });
    }
  }

  private jevModel = 'jev-1.13';
  private jevPromptVersion = 'v1-2026-09';

  // ---------- 巡检 ----------

  /** 每 5 秒：失效 processing、有排队无调度任务的房间、房主转让、全员离线、等待室闲置。 */
  private async maintenance(): Promise<void> {
    const db = this.db;
    const now = new Date();
    try {
      // 1. 失效 processing（占用期限已过）：标记失败并重新调度
      const expiredLeases = await db
        .select({ id: turns.id, roundId: turns.roundId })
        .from(turns)
        .where(and(eq(turns.status, 'processing'), sql`lease_expires_at < now()`))
        .limit(20);
      for (const turn of expiredLeases) {
        const [round] = await db.select({ roomId: rounds.roomId }).from(rounds).where(eq(rounds.id, turn.roundId)).limit(1);
        if (!round) continue;
        await db.transaction(async (tx) => {
          await tx
            .update(turns)
            .set({ status: 'failed', failReason: 'lease_expired', completedAt: now })
            .where(and(eq(turns.id, turn.id), eq(turns.status, 'processing')));
          await appendEvent(tx, { roomId: round.roomId, roundId: turn.roundId, type: 'turn.failed', payload: { turnId: turn.id, reason: 'lease_expired', retryable: true } });
        });
        await this.boss.send('dispatch-room', { roomId: round.roomId } satisfies DispatchPayload);
      }

      // 2. 有排队任务但无调度在跑的房间（崩溃恢复兜底）
      const stuckRooms = await db
        .select({ roomId: rounds.roomId })
        .from(rounds)
        .where(
          and(
            eq(rounds.status, 'active'),
            sql`exists (select 1 from turns t where t.round_id = rounds.id and t.status = 'queued')`,
            sql`not exists (select 1 from turns t where t.round_id = rounds.id and t.status = 'processing')`,
          ),
        )
        .limit(20);
      for (const row of stuckRooms) {
        await this.boss.send('dispatch-room', { roomId: row.roomId } satisfies DispatchPayload);
      }

      // 3. 全员离线 30 分钟：结束进行中局并关闭房间
      const offlineRooms = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(
          and(
            sql`rooms.status <> 'closed'`,
            sql`not exists (select 1 from presence p where p.room_id = rooms.id and p.last_seen_at > now() - interval '45 seconds')`,
            sql`rooms.last_activity_at < now() - interval '30 minutes'`,
          ),
        )
        .limit(10);
      for (const room of offlineRooms) {
        await db.transaction(async (tx) => {
          const [activeRound] = await tx
            .select()
            .from(rounds)
            .where(and(eq(rounds.roomId, room.id), eq(rounds.status, 'active')))
            .limit(1);
          if (activeRound) {
            await tx
              .update(rounds)
              .set({ status: 'abandoned', endedAt: now, endReason: 'all_offline', cancelGeneration: sql`${rounds.cancelGeneration} + 1` })
              .where(eq(rounds.id, activeRound.id));
            await tx
              .update(turns)
              .set({ status: 'cancelled', completedAt: now })
              .where(and(eq(turns.roundId, activeRound.id), inArray(turns.status, ['queued', 'processing'])));
            await appendEvent(tx, { roomId: room.id, roundId: activeRound.id, type: 'round.ended', payload: { roundId: activeRound.id, status: 'abandoned', reason: 'all_offline' } });
          }
          await tx.update(rooms).set({ status: 'closed', closedAt: now, closeReason: 'all_offline' }).where(eq(rooms.id, room.id));
          await tx.delete(presence).where(eq(presence.roomId, room.id));
          await appendEvent(tx, { roomId: room.id, roundId: activeRound?.id ?? null, type: 'room.closed', payload: { reason: 'all_offline' } });
        });
      }

      // 4. 等待室 24 小时无活动关闭
      const idleRooms = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.status, 'waiting'), sql`last_activity_at < now() - interval '24 hours'`))
        .limit(10);
      for (const room of idleRooms) {
        await db.transaction(async (tx) => {
          await tx.update(rooms).set({ status: 'closed', closedAt: now, closeReason: 'idle' }).where(eq(rooms.id, room.id));
          await appendEvent(tx, { roomId: room.id, roundId: null, type: 'room.closed', payload: { reason: 'idle' } });
        });
      }

      // 5. 房主离线 90 秒转让（docs/rebuild/04-ROOM-JEV.md §6）
      const roomsWithHostOffline = await db
        .select({ id: rooms.id, hostUserId: rooms.hostUserId })
        .from(rooms)
        .where(
          and(
            sql`rooms.status <> 'closed'`,
            sql`exists (select 1 from room_members m where m.room_id = rooms.id and m.status = 'joined')`,
            sql`not exists (select 1 from presence p where p.user_id = rooms.host_user_id and p.last_seen_at > now() - interval '90 seconds')`,
          ),
        )
        .limit(10);
      for (const room of roomsWithHostOffline) {
        await db.transaction(async (tx) => {
          const [fresh] = await tx.select().from(rooms).where(eq(rooms.id, room.id)).for('update').limit(1);
          if (!fresh || fresh.hostUserId !== room.hostUserId || fresh.status === 'closed') return;
          const [stillOffline] = await tx
            .select({ id: presence.userId })
            .from(presence)
            .where(and(eq(presence.userId, fresh.hostUserId), sql`last_seen_at > now() - interval '90 seconds'`))
            .limit(1);
          if (stillOffline) return; // 房主已回线
          const members = await tx
            .select({ userId: roomMembers.userId, joinedAt: roomMembers.joinedAt })
            .from(roomMembers)
            .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.status, 'joined')));
          const online = await tx
            .select({ userId: presence.userId })
            .from(presence)
            .where(sql`last_seen_at > now() - interval '45 seconds'`);
          const onlineSet = new Set(online.map((o) => o.userId));
          const successor = members
            .filter((m) => m.userId !== fresh.hostUserId && onlineSet.has(m.userId))
            .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
          if (!successor) return;
          await tx.update(rooms).set({ hostUserId: successor.userId }).where(eq(rooms.id, room.id));
          const nickname = (await tx.select({ n: profiles.nickname }).from(profiles).where(eq(profiles.userId, successor.userId)).limit(1))[0]?.n;
          await appendEvent(tx, { roomId: room.id, roundId: null, type: 'room.host_changed', payload: { userId: successor.userId, nickname: nickname ?? successor.userId } });
        });
      }

      // 6. presence 清理：超过 45 秒无心跳的行
      await db.execute(sql`delete from presence where last_seen_at < now() - interval '45 seconds'`);

      // 7. 赞助房间不再检查的账本一致性兜底：负余额由 CHECK 保护，这里只做异常告警
      const [negative] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(freeRoomAccounts)
        .where(sql`consumed < 0 or reserved < 0 or consumed + reserved > total`);
      if ((negative?.count ?? 0) > 0) throw new Error(`免费次数账本出现负值：${negative?.count} 行，立即排查`);

      // 8. 单人/总请求数等匿名聚合指标在日志中输出
    } catch (error) {
      console.error('[jobs] 巡检失败', error);
    } finally {
      await this.boss.send('maintenance', {}, { startAfter: 5 });
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop();
    await this.pool.end();
  }
}

const jobApp = new JobsApp();
jobApp.start().catch((error) => {
  console.error('[jobs] 启动失败：', error);
  process.exit(1);
});

const graceful = async () => {
  await jobApp.stop();
  process.exit(0);
};
process.on('SIGINT', () => void graceful());
process.on('SIGTERM', () => void graceful());

export { JobsApp };
