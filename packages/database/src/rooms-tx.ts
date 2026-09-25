/**
 * 房间事务封装：API（命令受理）与 jobs（判题完成、巡检）共用的数据库事务操作。
 * 全部函数在调用方事务内执行；调用方负责锁序：房间 → 局 → 赞助账户 → 免费账户 → 任务。
 */
import { and, eq, inArray, sql, min } from 'drizzle-orm';
import {
  freeRoomAccounts,
  roomCreditLedger,
  roomEntitlements,
  roomEvents,
  rooms,
  roundParticipants,
  rounds,
  turns,
} from './schema/index.js';
import type { Database } from './client.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** 事件类型（与 @jev/contracts 一致；此处独立声明避免包边界问题） */
export type RoomEventType =
  | 'room.member_joined'
  | 'room.member_left'
  | 'room.member_kicked'
  | 'room.member_unrestricted'
  | 'room.host_changed'
  | 'room.invite_rotated'
  | 'room.closed'
  | 'round.started'
  | 'round.ended'
  | 'turn.accepted'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'hint.revealed'
  | 'discussion.created';

export interface AppendedEvent {
  seq: number;
  eventId: string;
}

/** 在当前事务内追加房间事件：seq 以 rooms.last_seq 原子递增（调用方需持房间锁或接受自锁）。 */
export async function appendEvent(
  tx: Tx,
  input: { roomId: string; roundId: string | null; type: RoomEventType; payload: Record<string, unknown> },
): Promise<AppendedEvent> {
  const updated = await tx
    .update(rooms)
    .set({ lastSeq: sql`${rooms.lastSeq} + 1` })
    .where(eq(rooms.id, input.roomId))
    .returning({ lastSeq: rooms.lastSeq });
  if (updated.length === 0) throw new Error(`房间不存在：${input.roomId}`);
  const seq = updated[0]!.lastSeq;

  const inserted = await tx
    .insert(roomEvents)
    .values({
      eventId: crypto.randomUUID(),
      roomId: input.roomId,
      roundId: input.roundId,
      seq,
      type: input.type,
      payload: input.payload,
    })
    .returning({ eventId: roomEvents.eventId });
  return { seq, eventId: inserted[0]!.eventId };
}

/** 事务提交后调用：唤醒网关广播（通知仅提醒，扫描兜底）。 */
export async function notifyRoomChange(pool: import('pg').Pool, roomId: string): Promise<void> {
  await pool.query('select pg_notify($1, $2)', ['jev_room_events', roomId]);
}

/**
 * 终止一局：局转终态、取消未完成任务、cancelGeneration 加一。
 * 返回取消的 turnId 列表。调用方随后追加 round.ended 事件。
 */
export async function terminateRoundTx(tx: Tx, roundId: string): Promise<string[]> {
  const cancelled = await tx
    .update(turns)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(turns.roundId, roundId), inArray(turns.status, ['queued', 'processing'])))
    .returning({ turnId: turns.id });
  await tx
    .update(rounds)
    .set({ cancelGeneration: sql`${rounds.cancelGeneration} + 1` })
    .where(eq(rounds.id, roundId));
  return cancelled.map((c) => c.turnId);
}

/**
 * 房间首次有效判定的消费事务：free 来源且 reserved 状态时 reserved−1、consumed+1 并写唯一流水。
 * (room_id, action) 唯一约束保证重复结果事务不会重复扣减。
 */
export async function consumeEntitlementIfFreeTx(tx: Tx, roomId: string): Promise<void> {
  const [entitlement] = await tx.select().from(roomEntitlements).where(eq(roomEntitlements.roomId, roomId)).limit(1);
  if (!entitlement || entitlement.source !== 'free' || entitlement.status !== 'reserved') return;

  const ledger = await tx
    .insert(roomCreditLedger)
    .values({ roomId, userId: entitlement.creatorUserId, action: 'consume', amount: 1 })
    .onConflictDoNothing()
    .returning({ id: roomCreditLedger.id });
  if (ledger.length === 0) return; // 已消费过：幂等

  const updated = await tx
    .update(freeRoomAccounts)
    .set({ reserved: sql`${freeRoomAccounts.reserved} - 1`, consumed: sql`${freeRoomAccounts.consumed} + 1`, updatedAt: new Date() })
    .where(and(eq(freeRoomAccounts.userId, entitlement.creatorUserId), sql`${freeRoomAccounts.reserved} > 0`))
    .returning({ userId: freeRoomAccounts.userId });
  if (updated.length === 0) throw new Error(`免费次数预留不一致：room=${roomId}`);

  await tx.update(roomEntitlements).set({ status: 'consumed', consumedAt: new Date() }).where(eq(roomEntitlements.id, entitlement.id));
}

/** 释放未消费的预留（空房取消、故障关闭）：CHECK 约束防负数。 */
export async function releaseEntitlementIfReservedTx(tx: Tx, roomId: string): Promise<boolean> {
  const [entitlement] = await tx.select().from(roomEntitlements).where(eq(roomEntitlements.roomId, roomId)).limit(1);
  if (!entitlement || entitlement.source !== 'free' || entitlement.status !== 'reserved') return false;

  const ledger = await tx
    .insert(roomCreditLedger)
    .values({ roomId, userId: entitlement.creatorUserId, action: 'release', amount: 1 })
    .onConflictDoNothing()
    .returning({ id: roomCreditLedger.id });
  if (ledger.length === 0) return false;

  await tx
    .update(freeRoomAccounts)
    .set({ reserved: sql`${freeRoomAccounts.reserved} - 1`, updatedAt: new Date() })
    .where(and(eq(freeRoomAccounts.userId, entitlement.creatorUserId), sql`${freeRoomAccounts.reserved} > 0`));
  await tx.update(roomEntitlements).set({ status: 'released' }).where(eq(roomEntitlements.id, entitlement.id));
  return true;
}

/**
 * 故障整房退回一次（docs/rebuild/04-ROOM-JEV.md §7）：已消费的免费机会退回创建者。
 * 以 (room_id, action='refund') 唯一流水保证整房最多退一次。
 */
export async function refundConsumedEntitlementTx(tx: Tx, roomId: string): Promise<boolean> {
  const [entitlement] = await tx.select().from(roomEntitlements).where(eq(roomEntitlements.roomId, roomId)).limit(1);
  if (!entitlement || entitlement.source !== 'free' || entitlement.status !== 'consumed') return false;

  const ledger = await tx
    .insert(roomCreditLedger)
    .values({ roomId, userId: entitlement.creatorUserId, action: 'refund', amount: 1 })
    .onConflictDoNothing()
    .returning({ id: roomCreditLedger.id });
  if (ledger.length === 0) return false;

  await tx
    .update(freeRoomAccounts)
    .set({ consumed: sql`${freeRoomAccounts.consumed} - 1`, updatedAt: new Date() })
    .where(and(eq(freeRoomAccounts.userId, entitlement.creatorUserId), sql`${freeRoomAccounts.consumed} > 0`));
  await tx.update(roomEntitlements).set({ status: 'refunded' }).where(eq(roomEntitlements.id, entitlement.id));
  return true;
}

/** 房间事件保留下界：超出后要求快照（410 EVENT_GAP）。返回该房间现存最早 seq。 */
export async function earliestSeqTx(tx: Tx, roomId: string): Promise<number | null> {
  const rows = await tx.select({ value: min(roomEvents.seq) }).from(roomEvents).where(eq(roomEvents.roomId, roomId));
  return rows[0]?.value ?? null;
}
