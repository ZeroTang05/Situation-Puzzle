/** 验证绝对截止时间，刷新与后台停留不会重新开始或暂停倒计时。 */
import { describe, expect, it } from 'vitest';
import { remainingOtpSeconds } from '../src/auth/otp-cooldown.js';

describe('验证码发送倒计时', () => {
  it('邮箱和 IP 等待时间都按服务器给出的期限计算', () => {
    expect(remainingOtpSeconds(60_000, 0)).toBe(60);
    expect(remainingOtpSeconds(60_000, 18_000)).toBe(42);
    expect(remainingOtpSeconds(28 * 60_000, 0)).toBe(1680);
  });
  it('返回页面时按实际时间恢复，不累计定时器调用次数', () => {
    expect(remainingOtpSeconds(60_000, 59_001)).toBe(1);
    expect(remainingOtpSeconds(60_000, 60_000)).toBe(0);
    expect(remainingOtpSeconds(60_000, 90_000)).toBe(0);
  });
});
