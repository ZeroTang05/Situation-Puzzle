/**
 * 赞助有效期规则（docs/rebuild/05-OPERATIONS.md §3）。
 *
 * - 月度按一个自然月，时间以 Asia/Shanghai 计算（UTC+8，无夏令时）
 * - 记录首次生效的日和时分秒作为锚点；下月无对应日取该月最后一天
 *   （1 月 31 日开始 → 2 月最后一天 → 3 月 31 日恢复）
 * - 提前续期从已有最后到期日延后；断档购买从支付生效时刻重新起算（锚点重置）
 * - 永久授权无截止时间
 */
import { DomainError } from './error.js';

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

interface GrantLike {
  type: 'monthly' | 'lifetime' | 'test';
  status: 'active' | 'frozen' | 'revoked';
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

/** 以上海墙钟日期在锚点上加 N 个月，目标月没有对应日时取月末。 */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const wall = new Date(anchor.getTime() + CST_OFFSET_MS);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const d = wall.getUTCDate();
  const targetMonthStart = new Date(Date.UTC(y, m + months, 1));
  const daysInTarget = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const day = Math.min(d, daysInTarget);
  const shifted = new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth(),
      day,
      wall.getUTCHours(),
      wall.getUTCMinutes(),
      wall.getUTCSeconds(),
      wall.getUTCMilliseconds(),
    ),
  );
  return new Date(shifted.getTime() - CST_OFFSET_MS);
}

/** 求 k 使 addMonthsClamped(anchor, k) === until（授权区间始终由本算法生成，必有精确解）。 */
function monthsFromAnchor(anchor: Date, until: Date): number {
  for (let k = 1; k <= 1200; k++) {
    if (addMonthsClamped(anchor, k).getTime() === until.getTime()) return k;
  }
  throw new DomainError('INTERNAL', `赞助月度区间与锚点不连续：anchor=${anchor.toISOString()} until=${until.toISOString()}`);
}

export interface MonthlyRenewal {
  /** 新授权区间起点 */
  effectiveFrom: Date;
  /** 新授权区间终点 */
  effectiveUntil: Date;
  /** 锚点是否需要重置（断档续买时 true） */
  rebaseAnchor: boolean;
}

/**
 * 计算一笔新月度订单的授权区间。
 *
 * @param now 支付核验成功的生效时刻
 * @param anchor 账户上记录的月度锚点（可能为空：从未买过月度）
 * @param grants 该用户现有的全部授权
 */
export function planMonthlyGrant(now: Date, anchor: Date | null, grants: GrantLike[]): MonthlyRenewal {
  const activeMonthly = grants
    .filter((g) => g.type === 'monthly' && g.status === 'active')
    .map((g) => g.effectiveUntil)
    .filter((u): u is Date => u !== null && u.getTime() > now.getTime());
  const latestUntil = activeMonthly.sort((a, b) => a.getTime() - b.getTime()).at(-1);

  if (latestUntil) {
    // 提前续期：接原到期日，锚点不变
    if (!anchor) throw new DomainError('INTERNAL', '存在有效月度授权但缺少锚点');
    const n = monthsFromAnchor(anchor, latestUntil);
    return { effectiveFrom: latestUntil, effectiveUntil: addMonthsClamped(anchor, n + 1), rebaseAnchor: false };
  }

  // 断档或首购：从当前生效时刻重新起算，锚点重置
  return { effectiveFrom: now, effectiveUntil: addMonthsClamped(now, 1), rebaseAnchor: true };
}

/** 当前是否拥有有效赞助（未冻结且在有效期内；永久即 until 为 null）。 */
export function hasActiveSponsorship(grants: GrantLike[], now: Date): boolean {
  return grants.some((g) => {
    if (g.status !== 'active') return false;
    if (g.type === 'test') return g.effectiveUntil === null || g.effectiveUntil.getTime() > now.getTime();
    return g.effectiveUntil === null || g.effectiveUntil.getTime() > now.getTime();
  });
}

/** 当前生效中的永久授权是否存在。 */
export function hasLifetimeGrant(grants: GrantLike[]): boolean {
  return grants.some((g) => g.type === 'lifetime' && g.status === 'active' && g.effectiveUntil === null);
}

export interface FreeRoomAccountLike {
  total: number;
  consumed: number;
  reserved: number;
}

/** 免费可开房余量 = total − consumed − reserved；CHECK 已在数据库层兜底。 */
export function freeRoomsRemaining(account: FreeRoomAccountLike): number {
  return account.total - account.consumed - account.reserved;
}

/** 开房授权来源判定：先赞助后免费；都不行抛出对应错误码。 */
export function resolveEntitlementSource(
  grants: GrantLike[],
  freeAccount: FreeRoomAccountLike,
  now: Date,
): { source: 'sponsorship' | 'free'; grantId?: string } {
  if (hasActiveSponsorship(grants, now)) return { source: 'sponsorship' };
  if (freeRoomsRemaining(freeAccount) > 0) return { source: 'free' };
  if (freeRoomsRemaining(freeAccount) <= 0 && freeAccount.consumed + freeAccount.reserved >= freeAccount.total) {
    throw new DomainError('FREE_ROOMS_EXHAUSTED', '免费开房次数已用完');
  }
  throw new DomainError('SPONSORSHIP_REQUIRED', '需要赞助或免费开房次数');
}
