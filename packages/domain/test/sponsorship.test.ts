import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  freeRoomsRemaining,
  hasActiveSponsorship,
  planMonthlyGrant,
  resolveEntitlementSource,
} from '../src/sponsorship.js';
import { DomainError } from '../src/error.js';

/** 构造上海时区某日某时刻的 UTC Date（仅测试用） */
function cst(y: number, m: number, d: number, h = 12): Date {
  return new Date(Date.UTC(y, m - 1, d, h - 8));
}

describe('addMonthsClamped（上海时区自然月）', () => {
  it('1 月 31 日的下一边界是 2 月最后一天', () => {
    expect(addMonthsClamped(cst(2026, 1, 31), 1).toISOString()).toBe(cst(2026, 2, 28).toISOString());
  });
  it('再下边界恢复为 3 月 31 日（锚点不漂移）', () => {
    expect(addMonthsClamped(cst(2026, 1, 31), 2).toISOString()).toBe(cst(2026, 3, 31).toISOString());
  });
  it('时分秒保持锚点值', () => {
    expect(addMonthsClamped(cst(2026, 3, 15, 9), 1).toISOString()).toBe(cst(2026, 4, 15, 9).toISOString());
  });
});

describe('planMonthlyGrant（提前续期与断档）', () => {
  it('提前续期接原到期日，锚点不变', () => {
    const anchor = cst(2026, 1, 10);
    const now = cst(2026, 1, 20);
    const currentUntil = addMonthsClamped(anchor, 1);
    const grants = [{ type: 'monthly', status: 'active', effectiveFrom: anchor, effectiveUntil: currentUntil }] as const;
    const plan = planMonthlyGrant(now, anchor, grants as never);
    expect(plan.effectiveFrom.toISOString()).toBe(currentUntil.toISOString());
    expect(plan.effectiveUntil.toISOString()).toBe(addMonthsClamped(anchor, 2).toISOString());
    expect(plan.rebaseAnchor).toBe(false);
  });

  it('断档购买从当前时刻重新起算并重置锚点', () => {
    const anchor = cst(2026, 1, 10);
    const now = cst(2026, 6, 1);
    const grants = [{ type: 'monthly', status: 'active', effectiveFrom: anchor, effectiveUntil: cst(2026, 2, 10) }] as const;
    const plan = planMonthlyGrant(now, anchor, grants as never);
    expect(plan.effectiveFrom.toISOString()).toBe(now.toISOString());
    expect(plan.effectiveUntil.toISOString()).toBe(addMonthsClamped(now, 1).toISOString());
    expect(plan.rebaseAnchor).toBe(true);
  });
});

describe('开房授权来源', () => {
  const free = { total: 10, consumed: 3, reserved: 1 };

  it('有效赞助优先', () => {
    const grants = [{ type: 'monthly', status: 'active', effectiveFrom: new Date(0), effectiveUntil: new Date(Date.now() + 86_400_000) }];
    expect(resolveEntitlementSource(grants as never, free, new Date())).toEqual({ source: 'sponsorship' });
  });

  it('无赞助时预留免费次数', () => {
    expect(resolveEntitlementSource([], free, new Date()).source).toBe('free');
  });

  it('免费次数用完抛出对应错误', () => {
    const exhausted = { total: 10, consumed: 10, reserved: 0 };
    expect(() => resolveEntitlementSource([], exhausted, new Date())).toThrow(DomainError);
  });

  it('冻结的授权不算有效赞助', () => {
    const grants = [{ type: 'monthly', status: 'frozen', effectiveFrom: new Date(0), effectiveUntil: new Date(Date.now() + 86_400_000) }];
    expect(hasActiveSponsorship(grants as never, new Date())).toBe(false);
  });
});

describe('免费次数余量', () => {
  it('total − consumed − reserved', () => {
    expect(freeRoomsRemaining({ total: 10, consumed: 4, reserved: 2 })).toBe(4);
  });
});
