/** 会员之外的开房额度按服务端识别出的会话来源选择。 */
import type { freeRoomAccounts } from '@jev/database';
import type { SessionUser } from '../common/http.js';
import { app } from '../context.js';

export function adRoomMode(person: Pick<SessionUser, 'miniPlatform'>): boolean {
  return person.miniPlatform === 'wechat-mini' && app().env.WECHAT_AD_ROOMS;
}

export function roomCredits(account: typeof freeRoomAccounts.$inferSelect | undefined, ads: boolean) {
  if (!account) return { total: 0, consumed: 0, reserved: 0 };
  return ads
    ? { total: account.adTotal, consumed: account.adConsumed, reserved: account.adReserved }
    : { total: account.total, consumed: account.consumed, reserved: account.reserved };
}
