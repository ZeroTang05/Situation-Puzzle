/** 发送倒计时保存绝对截止时间，刷新和后台停留后仍按实际时间计算。 */
export const otpCooldownKey = 'jev.otp-send-until';

export function remainingOtpSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function readOtpDeadline(storage: Pick<Storage, 'getItem'>): number {
  const value = storage.getItem(otpCooldownKey);
  if (value === null) return 0;
  const deadline = Number(value);
  if (!Number.isFinite(deadline) || deadline < 0) throw new Error('验证码倒计时存储无效');
  return deadline;
}

/** 认证库返回普通 JSON；发送接口额外提供等待秒数与 Retry-After。 */
export class OtpSendError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number) { super(message); }
}

export async function sendOtpCode(email: string, type: 'sign-in' | 'email-verification'): Promise<number> {
  const response = await fetch('/api/v1/auth/email-otp/send-verification-otp', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, type }), signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as { success?: boolean; message?: string; retryAfterSeconds?: number };
  const retry = body.retryAfterSeconds;
  if (retry !== undefined && (!Number.isInteger(retry) || retry < 0)) throw new Error('验证码接口返回了无效等待时间');
  if (response.status === 429 && (!retry || retry <= 0)) throw new Error('验证码限流响应缺少等待时间');
  if (!response.ok) throw new OtpSendError(body.message ?? '验证码发送失败，请稍后重试。', retry ?? 0);
  if (!body.success || retry === undefined) throw new Error('验证码发送响应格式不正确');
  return retry;
}
