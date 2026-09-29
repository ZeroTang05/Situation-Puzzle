/** 真实计数规则的单元测试：覆盖滚动窗口、等待时间及明确邮件失败分类。 */
import { describe, expect, it } from 'vitest';
import { otpSendLimit, otpLimitMessage } from './otp-send-quota.js';
import { smtpDeliveryOutcome } from './mailer.js';

describe('验证码发送额度', () => {
  it('邮箱 60 秒冷却，恰好到期即可再发送', () => {
    expect(otpSendLimit(18_000, 0, [0])).toEqual({ scope: 'email', retryAfterSeconds: 42 });
    expect(otpSendLimit(60_000, 0, [0])).toBeNull();
  });
  it('IP 使用最近一小时，第三次之前仍可发送', () => {
    expect(otpSendLimit(100_000, null, [0, 50_000])).toBeNull();
    expect(otpSendLimit(100_000, null, [0, 50_000, 90_000])).toEqual({ scope: 'ip', retryAfterSeconds: 3500 });
  });
  it('10:20 发出的额度只在 11:20 释放，整点不重置', () => {
    const first = Date.parse('2026-09-29T10:20:00Z');
    expect(otpSendLimit(first + 40 * 60_000, null, [first, first + 60_000, first + 120_000])).toEqual({ scope: 'ip', retryAfterSeconds: 1200 });
    expect(otpSendLimit(first + 60 * 60_000, null, [first, first + 60_000, first + 120_000])).toBeNull();
  });
  it('同时超限时返回真正需要等待的较长时间', () => {
    expect(otpSendLimit(100_000, 90_000, [0, 50_000, 90_000])).toEqual({ scope: 'ip', retryAfterSeconds: 3500 });
  });
  it('秒数向上取整，等待不因被拒绝的请求延长', () => {
    expect(otpSendLimit(1000, 0, [0])?.retryAfterSeconds).toBe(59);
    expect(otpSendLimit(1500, 0, [0])?.retryAfterSeconds).toBe(59);
    expect(otpSendLimit(2000, 0, [0])?.retryAfterSeconds).toBe(58);
    expect(otpLimitMessage(42)).toBe('发送过于频繁，请在 42 秒后重试。');
    expect(otpLimitMessage(28 * 60)).toBe('发送过于频繁，请在 28 分钟后重试。');
  });
});

describe('邮件投递结果', () => {
  it('明确 SMTP 拒绝和发送前连接失败可以退回额度', () => {
    expect(smtpDeliveryOutcome({ responseCode: 550, command: 'DATA' })).toBe('rejected');
    expect(smtpDeliveryOutcome({ responseCode: 451, command: 'RCPT TO' })).toBe('rejected');
    expect(smtpDeliveryOutcome({ command: 'CONN', code: 'ECONNECTION' })).toBe('rejected');
    expect(smtpDeliveryOutcome({ code: 'EAUTH' })).toBe('rejected');
  });
  it('提交后的超时和断线不能确定未投递，保留额度', () => {
    expect(smtpDeliveryOutcome({ command: 'DATA', code: 'ETIMEDOUT' })).toBe('unknown');
    expect(smtpDeliveryOutcome(new Error('connection closed'))).toBe('unknown');
  });
});
