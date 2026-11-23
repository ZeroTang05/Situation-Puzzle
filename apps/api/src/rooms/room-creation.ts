/**
 * 建房事务：等待室开局（LobbyService.start）与再来一题（RoomsService.createFollowupRoom）共用。
 * 锁授权账户 → 判定来源（先赞助后免费）→ 建房 + 房主成员 + 授权 + 免费预留流水。
 * 调用方负责前置状态检查；锁序遵守：房间 → 局 → 赞助账户 → 免费账户 → 任务。
 */
import { and, eq, sql } from 'drizzle-orm';
import { freeRoomAccounts, roomCreditColumns, roomCreditLedger, roomEntitlements, roomMembers, rooms } from '@jev/database';
import { DomainError, hasActiveSponsorship, resolveEntitlementSource } from '@jev/domain';
import { app } from '../context.js';
import { jevConfigVersion } from '@jev/jev';
import type { SessionUser } from '../common/http.js';
import { roomSponsorGrants } from '../auth/platform-email.js';
import { adRoomMode, roomCredits } from './room-credit-mode.js';

type Tx = Parameters<Parameters<import('@jev/database').Database['transaction']>[0]>[0];

/** 局固定的判题配置版本标识（开局时点一次定型；语言按本局题目，不取全局默认值）。 */
export function jevConfigVersionOf(language: 'zh' | 'en'): string {
  const jev = app().jev;
  return jevConfigVersion(jev, language);
}

export async function createRoomWithEntitlementTx(
  tx: Tx,
  input: { creatorUserId: string; miniPlatform?: SessionUser['miniPlatform']; capacity: number; inviteTokenHash: string; now: Date; isPublic?: boolean },
): Promise<string> {
  const { creatorUserId, capacity, inviteTokenHash, now } = input;
  const person = { userId: creatorUserId, ...(input.miniPlatform ? { miniPlatform: input.miniPlatform } : {}) };
  const grants = await roomSponsorGrants(tx, person);
  const ads = adRoomMode(person);
  const freeRows = await tx.select().from(freeRoomAccounts).where(eq(freeRoomAccounts.userId, creatorUserId)).for('update');
  const free = freeRows[0];
  if (!free) throw new DomainError('ACCOUNT_NOT_INITIALIZED', '账号未初始化免费次数账户');

  // 内测期（BETA_OPEN_ROOM=true）直接以 beta 来源放行，不占免费次数也不看赞助
  const betaOpen = app().env.BETA_OPEN_ROOM;
  const credits = roomCredits(free, ads);
  if (ads && !betaOpen && credits.consumed + credits.reserved >= credits.total && !hasActiveSponsorship(grants, now)) {
    throw new DomainError('AD_ROOMS_EXHAUSTED', '广告开房次数已用完');
  }
  const { source: originalSource, grantId } = resolveEntitlementSource(grants, credits, now, { betaOpen });
  const source = ads && originalSource === 'free' ? 'ad' : originalSource;

  const inserted = await tx
    .insert(rooms)
    .values({
      creatorUserId,
      hostUserId: creatorUserId,
      capacity,
      inviteTokenHash,
      // 默认私人房间；等待室开局 / 再来一题按调用方给的公开偏好落库
      ...(input.isPublic === undefined ? {} : { isPublic: input.isPublic }),
    })
    .returning({ id: rooms.id });
  const roomId = inserted[0]!.id;

  await tx.insert(roomMembers).values({ roomId, userId: creatorUserId, status: 'joined' });

  const entitlement = await tx
    .insert(roomEntitlements)
    .values({ roomId, creatorUserId, source, sponsorGrantId: grantId ?? null, status: 'reserved' })
    .returning({ id: roomEntitlements.id });
  await tx.update(rooms).set({ entitlementId: entitlement[0]!.id }).where(eq(rooms.id, roomId));

  if (source === 'free' || source === 'ad') {
    const { total, consumed, reserved, key } = roomCreditColumns(source);
    const reservedRows = await tx
      .update(freeRoomAccounts)
      .set({ [key.reserved]: sql`${reserved} + 1`, updatedAt: now })
      .where(
        and(
          eq(freeRoomAccounts.userId, creatorUserId),
          sql`${consumed} + ${reserved} < ${total}`,
        ),
      )
      .returning({ userId: freeRoomAccounts.userId });
    if (reservedRows.length === 0) throw new DomainError('FREE_ROOMS_EXHAUSTED', '免费开房次数已用完');
    await tx.insert(roomCreditLedger).values({ roomId, userId: creatorUserId, action: 'reserve', amount: 1 });
  }
  return roomId;
}
