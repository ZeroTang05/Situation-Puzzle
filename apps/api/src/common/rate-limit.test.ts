/**
 * 限流纯函数与元数据规则（不依赖数据库）。
 *
 * 重点钉住两件容易出错的事：
 *  1. 窗口边界：日/小时必须按东八区自然边界，不能用 UTC（差 8 小时会让「每天 5 篇」实际变成「每 32 小时 5 篇」）。
 *  2. 规则解析：方法级覆盖类级（投稿 submit 要有更严的日额度，不能被类级的分钟额度盖掉）。
 */
import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_KEY,
  RateLimit,
  rateLimitBucketKey,
  rateLimitMessage,
  rateLimitRuleOf,
  retryAfterSeconds,
  windowStartOf,
  type RateLimitRule,
} from './rate-limit.js';

const DAY = 86_400;
const HOUR = 3_600;

describe('限流窗口起点', () => {
  it('日窗口按东八区自然日边界对齐', () => {
    // 2026-10-20 20:30 东八区 = 2026-10-20T12:30Z
    const now = Date.parse('2026-10-20T12:30:00.000Z');
    const start = windowStartOf(now, DAY);
    // 自然日起点 = 2026-10-19T16:00:00Z（东八区 2026-10-20 00:00）
    expect(new Date(start).toISOString()).toBe('2026-10-19T16:00:00.000Z');
  });

  it('小时窗口按东八区自然小时边界对齐', () => {
    const now = Date.parse('2026-10-20T12:30:00.000Z');
    const start = windowStartOf(now, HOUR);
    expect(new Date(start).toISOString()).toBe('2026-10-20T12:00:00.000Z');
  });

  it('分钟窗口按整分钟对齐（整点时区偏移下等于自然分钟）', () => {
    const now = Date.parse('2026-10-20T12:30:45.123Z');
    const start = windowStartOf(now, 60);
    expect(new Date(start).toISOString()).toBe('2026-10-20T12:30:00.000Z');
  });

  it('同一窗口内的请求落在同一个起点', () => {
    const a = windowStartOf(Date.parse('2026-10-20T12:00:01.000Z'), 60);
    const b = windowStartOf(Date.parse('2026-10-20T12:00:59.000Z'), 60);
    const c = windowStartOf(Date.parse('2026-10-20T12:01:00.000Z'), 60);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('非法窗口长度直接报错，不静默放行', () => {
    expect(() => windowStartOf(Date.now(), 0)).toThrow();
    expect(() => windowStartOf(Date.now(), -1)).toThrow();
  });
});

describe('限流桶键与重试时间', () => {
  it('桶键包含作用域与维度，互不干扰', () => {
    expect(rateLimitBucketKey('creations', 'user', 'u1')).toBe('creations:user:u1');
    expect(rateLimitBucketKey('creations', 'ip', '1.2.3.4')).toBe('creations:ip:1.2.3.4');
  });

  it('重试秒数随窗口推进递减，最少 1 秒', () => {
    const start = windowStartOf(Date.parse('2026-10-20T12:30:00.000Z'), 60);
    expect(retryAfterSeconds(start, 60, Date.parse('2026-10-20T12:30:00.000Z'))).toBe(60);
    expect(retryAfterSeconds(start, 60, Date.parse('2026-10-20T12:30:59.000Z'))).toBe(1);
    // 窗口已过也不返回 0，避免客户端立即重试再撞一次
    expect(retryAfterSeconds(start, 60, Date.parse('2026-10-20T12:31:30.000Z'))).toBe(1);
  });
});

describe('限流提示文案', () => {
  it('按等待时间选择粒度', () => {
    expect(rateLimitMessage(30)).toContain('30 秒');
    expect(rateLimitMessage(120)).toContain('2 分钟');
    expect(rateLimitMessage(7_200)).toContain('2 小时');
    expect(rateLimitMessage(90_000)).toContain('明天');
  });
});

describe('限流规则元数据', () => {
  it('方法级规则覆盖类级规则', () => {
    const classRule: RateLimitRule = { scope: 'creations', limit: 20, windowSeconds: 60, keyBy: 'user' };
    const methodRule: RateLimitRule = { scope: 'creations.submit', limit: 5, windowSeconds: DAY, keyBy: 'user' };

    class TestController {}
    RateLimit(classRule)(TestController as never);
    class TestHandler {
      submit() {}
      create() {}
    }
    RateLimit(methodRule)(TestHandler.prototype.submit as never);

    expect(rateLimitRuleOf(TestHandler.prototype.submit, TestController)).toEqual(methodRule);
    expect(rateLimitRuleOf(TestHandler.prototype.create, TestController)).toEqual(classRule);
  });

  it('没有标注就没有规则（不查库、零开销）', () => {
    class Bare {}
    expect(rateLimitRuleOf(Bare.prototype, Bare)).toBeUndefined();
  });

  it('元数据键名稳定，避免与其他装饰器串味', () => {
    expect(RATE_LIMIT_KEY).toBe('rate_limit_rule');
  });
});
