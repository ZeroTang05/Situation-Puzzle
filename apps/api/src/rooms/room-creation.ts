/**
 * 建房事务：等待室开局（LobbyService.start）与再来一题（RoomsService.createFollowupRoom）共用。
 * 锁授权账户 → 判定来源（先赞助后免费）→ 建房 + 房主成员 + 授权 + 免费预留流水。
 * 调用方负责前置状态检查；锁序遵守：房间 → 局 → 赞助账户 → 免费账户 → 任务。
 */
import { and, eq, sql } from 'drizzle-orm';
import { freeRoomAccounts, roomCreditLedger, roomEntitlements, roomMembers, rooms, sponsorGrants } from '@jev/database';
import { DomainError, resolveEntitlementSource } from '@jev/domain';
import { app } from '../context.js';

type Tx = Parameters<Parameters<import('@jev/database').Database['transaction']>[0]>[0];

/** 局固定的判题配置版本标识（开局时点一次定型）。 */
export function jevConfigVersionOf(): string {
  const jev = app().jev;
  return `${jev.model}@${jev.promptVersion}@t${jev.threshold}@${jev.language}`;
}

export async function createRoomWithEntitlementTx(
  tx: Tx,
  input: { creatorUserId: string; capacity: number; inviteTokenHash: string; now: Date },
): Promise<string> {
  const { creatorUserId, capacity, inviteTokenHash, now } = input;
  const grants = await tx.select().from(sponsorGrants).where(eq(sponsorGrants.userId, creatorUserId));
  const freeRows = await tx.select().from(freeRoomAccounts).where(eq(freeRoomAccounts.userId, creatorUserId)).for('update');
  const free = freeRows[0];
  if (!free) throw new DomainError('ACCOUNT_NOT_INITIALIZED', '账号未初始化免费次数账户');

  const { source, grantId } = resolveEntitlementSource(grants, free, now);

  const inserted = await tx
    .insert(rooms)
    .values({ creatorUserId, hostUserId: creatorUserId, capacity, inviteTokenHash })
    .returning({ id: rooms.id });
  const roomId = inserted[0]!.id;

  await tx.insert(roomMembers).values({ roomId, userId: creatorUserId, status: 'joined' });

  const entitlement = await tx
    .insert(roomEntitlements)
    .values({ roomId, creatorUserId, source, sponsorGrantId: grantId ?? null, status: 'reserved' })
    .returning({ id: roomEntitlements.id });
  await tx.update(rooms).set({ entitlementId: entitlement[0]!.id }).where(eq(rooms.id, roomId));

  if (source === 'free') {
    const reservedRows = await tx
      .update(freeRoomAccounts)
      .set({ reserved: sql`${freeRoomAccounts.reserved} + 1`, updatedAt: now })
      .where(
        and(
          eq(freeRoomAccounts.userId, creatorUserId),
          sql`${freeRoomAccounts.consumed} + ${freeRoomAccounts.reserved} < ${freeRoomAccounts.total}`,
        ),
      )
      .returning({ userId: freeRoomAccounts.userId });
    if (reservedRows.length === 0) throw new DomainError('FREE_ROOMS_EXHAUSTED', '免费开房次数已用完');
    await tx.insert(roomCreditLedger).values({ roomId, userId: creatorUserId, action: 'reserve', amount: 1 });
  }
  return roomId;
}
