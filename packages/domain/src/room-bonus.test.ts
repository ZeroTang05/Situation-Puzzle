/** 奖励额度规则：邀请码格式、东八区日边界、内测期开房来源判定。 */
import { describe, expect, it } from 'vitest';
import {
  AD_REWARD_ROOMS,
  CREATION_REWARD_ROOMS,
  DAILY_AD_BONUS_LIMIT,
  DAILY_INVITE_BONUS_LIMIT,
  INVITE_CODE_LENGTH,
  INVITE_CODE_PATTERN,
  INVITE_REWARD_ROOMS,
  generateInviteCode,
  shanghaiDayStart,
} from './room-bonus.js';
import { resolveEntitlementSource } from './sponsorship.js';
import { DomainError } from './error.js';

describe('invite codes', () => {
  it('生成的邀请码符合 8 位易混字符表', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(INVITE_CODE_PATTERN);
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      // 字符表去掉了 0/O/1/I/L
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it('注入固定随机源时结果可复现', () => {
    // 全 0 → 每一位取字符表第一个字符
    expect(generateInviteCode(() => 0)).toBe('22222222');
    // 接近 1 → 每一位取字符表最后一个字符
    expect(generateInviteCode(() => 0.999999)).toBe('ZZZZZZZZ');
  });

  it('正则拒绝长度不符与字符表外的码', () => {
    expect(INVITE_CODE_PATTERN.test('23456789')).toBe(true);
    expect(INVITE_CODE_PATTERN.test('ABCDMNPQ')).toBe(true);
    expect(INVITE_CODE_PATTERN.test('abcdefgh')).toBe(false); // 小写
    expect(INVITE_CODE_PATTERN.test('ABCDEFGI')).toBe(false); // 含 I
    expect(INVITE_CODE_PATTERN.test('ABCDLMPQ')).toBe(false); // 含 L
    expect(INVITE_CODE_PATTERN.test('ABCDEFG0')).toBe(false); // 含 0
    expect(INVITE_CODE_PATTERN.test('2345678')).toBe(false); // 7 位
    expect(INVITE_CODE_PATTERN.test('234567890')).toBe(false); // 9 位
  });

  it('奖励常量与产品决策一致（广告 +2、邀请 +5、作品 +10、日上限各 10）', () => {
    expect(AD_REWARD_ROOMS).toBe(2);
    expect(INVITE_REWARD_ROOMS).toBe(5);
    expect(CREATION_REWARD_ROOMS).toBe(10);
    expect(DAILY_AD_BONUS_LIMIT).toBe(10);
    expect(DAILY_INVITE_BONUS_LIMIT).toBe(10);
  });
});

describe('shanghaiDayStart', () => {
  it('东八区零点对应 UTC 前一天 16:00', () => {
    // 2026-10-24 15:59:59 UTC = 上海 23:59:59，仍属于 10-24 这一天（零点在 10-23 16:00 UTC）
    expect(shanghaiDayStart(new Date('2026-10-24T15:59:59Z')).toISOString()).toBe('2026-10-23T16:00:00.000Z');
    // 2026-10-24 16:00:00 UTC = 上海 10-25 00:00，跨天
    expect(shanghaiDayStart(new Date('2026-10-24T16:00:00Z')).toISOString()).toBe('2026-10-24T16:00:00.000Z');
    // 当天中午（UTC 04:00 = 上海 12:00）回到上海当天零点
    expect(shanghaiDayStart(new Date('2026-10-24T04:00:00Z')).toISOString()).toBe('2026-10-23T16:00:00.000Z');
  });
});

describe('resolveEntitlementSource 内测期', () => {
  const now = new Date('2026-10-24T00:00:00Z');
  const grants: Parameters<typeof resolveEntitlementSource>[0] = [];
  const exhausted = { total: 10, consumed: 10, reserved: 0 };

  it('betaOpen 优先于一切：免费次数耗尽也放行', () => {
    expect(resolveEntitlementSource(grants, exhausted, now, { betaOpen: true })).toEqual({ source: 'beta' });
  });

  it('betaOpen 时不返回 grantId（roomEntitlements.sponsorGrantId 为 null）', () => {
    const result = resolveEntitlementSource(grants, exhausted, now, { betaOpen: true });
    expect(result.grantId).toBeUndefined();
  });

  it('不传 betaOpen 保持原判定：耗尽抛 FREE_ROOMS_EXHAUSTED', () => {
    expect(() => resolveEntitlementSource(grants, exhausted, now)).toThrow(DomainError);
    expect(() => resolveEntitlementSource(grants, exhausted, now)).toThrow(/免费开房次数已用完/);
  });

  it('不传 betaOpen 且有余量时仍走 free 来源', () => {
    expect(resolveEntitlementSource(grants, { total: 10, consumed: 3, reserved: 0 }, now)).toEqual({ source: 'free' });
  });

  it('显式传 betaOpen: false 等同于正式期', () => {
    expect(() => resolveEntitlementSource(grants, exhausted, now, { betaOpen: false })).toThrow(/免费开房次数已用完/);
  });
});
