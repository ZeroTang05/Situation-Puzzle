/**
 * 注册闸门：/sign-up/email 的服务端邮箱验证。
 *
 * 前端「先验证邮箱、再设密码」只是 UI 流程，绕开页面直接打 API 也能建号。
 * 闸门要求注册请求在 x-jev-signup-otp 头里携带用户刚验证过的验证码，
 * 服务端原子消费比对（一次性），未通过一律 403。
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * 一次性/占位邮箱域名黑名单：验证码发送与注册两个入口都拒绝。
 * linuxdo.invalid 是 LINUX DO OAuth 的站内占位邮箱域，先到先注册会抢占
 * 尚未首次 OAuth 登录的真实用户身份，一并封死。
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'linuxdo.invalid',
  'mailinator.com',
  'tempmail.com',
  'temp-mail.org',
  '10minutemail.com',
  'guerrillamail.com',
  'yopmail.com',
  'maildrop.cc',
  'getnada.com',
  'throwawaymail.com',
  'sharklasers.com',
  'dispostable.com',
  'fakeinbox.com',
]);

/** 邮箱是否落在黑名单域（按 @ 后完整域名单匹配，不猜子域）。 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/**
 * Better Auth internalAdapter 里闸门用到的四个方法。
 * 包不导出 InternalAdapter 类型，这里按运行时契约（email-otp 插件源码）收敛，
 * 升级 better-auth 时若签名漂移会在调用处暴露。
 */
export interface SignupVerificationAdapter {
  findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  consumeVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  deleteVerificationByIdentifier(identifier: string): Promise<unknown>;
  createVerificationValue(data: { value: string; identifier: string; expiresAt: Date }): Promise<unknown>;
}

/** 注册流程用的验证码标识符，与 email-otp 插件的 toOTPIdentifier('sign-in', email) 一致。 */
const signupOtpIdentifier = (email: string) => `sign-in-otp-${email}`;

/** 验证码最多允许的比对失败次数，与插件默认 allowedAttempts 一致。 */
const MAX_OTP_ATTEMPTS = 3;

/** 常数时间比较；timingSafeEqual 长度不等会抛异常，先比长度。 */
function sameCode(provided: string, stored: string): boolean {
  return provided.length === stored.length && timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
}

/**
 * 原子消费一条 sign-in 验证码并比对，复刻 email-otp 插件 atomicVerifyOTP 的手法：
 * 先 consume 抢占（并发下只有第一个请求拿到记录），错码按次数 +1 回写、保留原过期时间，
 * 次数用尽的标识符不回写、保持锁死。本项目未开启 storeOTP 哈希，库里是明文 `${code}:${attempts}`。
 *
 * 返回 null 表示通过（码已消费，不可再用）；返回字符串为给用户的拒绝原因。
 */
export async function consumeSignupOtp(adapter: SignupVerificationAdapter, email: string, otp: string): Promise<string | null> {
  const identifier = signupOtpIdentifier(email);
  const existing = await adapter.findVerificationValue(identifier);
  if (existing && existing.expiresAt.getTime() < Date.now()) {
    await adapter.deleteVerificationByIdentifier(identifier);
    return '验证码已过期，请重新获取';
  }
  const consumed = await adapter.consumeVerificationValue(identifier);
  if (!consumed) return '请先获取并验证邮箱验证码';
  const split = consumed.value.lastIndexOf(':');
  const stored = split < 0 ? consumed.value : consumed.value.slice(0, split);
  const attempts = split < 0 ? 0 : parseInt(consumed.value.slice(split + 1), 10) || 0;
  if (attempts >= MAX_OTP_ATTEMPTS) return '验证码错误次数过多，请重新获取';
  if (!sameCode(otp, stored)) {
    await adapter.createVerificationValue({ value: `${stored}:${attempts + 1}`, identifier, expiresAt: consumed.expiresAt });
    return '验证码不正确';
  }
  return null;
}
