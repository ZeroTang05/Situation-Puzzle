/** 原生认证协议联调：真实邮件、注册会话、OTP 登录、密码重置和实际发送限制。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authSessionSchema, miniLoginResponseSchema } from '@jev/contracts';
import { ApiError } from '../src/api-error.js';
import { otpSendResponseSchema, parseAuthResult } from '../src/auth-protocol.js';
import { latestOtp } from './smtp-inbox.mjs';

const origin = process.env.TAPTAP_E2E_API_ORIGIN;
const mailbox = process.env.TAPTAP_E2E_MAILBOX;
if (!origin || !mailbox) throw new Error('请指定独立联调 API 和真实 SMTP 收信文件');
let checks = 0;
function check(value: unknown, label: string): asserts value { assert(value, label); checks++; console.log(`通过：${label}`); }
async function raw(path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api/v1/auth${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.json() as unknown };
}
async function auth<T>(path: string, schema: z.ZodType<T>, body?: unknown, token?: string, headers?: Record<string, string>): Promise<T> {
  const result = await raw(path, body, token, headers); return parseAuthResult(result.status, result.body, schema, 'zh');
}
const email = `taptap-auth-${randomUUID()}@e2e.test`;
const password = `Auth-${randomUUID()}`; const newPassword = `Reset-${randomUUID()}`;
const unknownUser = await raw('/email-otp/send-verification-otp', { email, type: 'sign-in' });
let unknownError: unknown;
try { parseAuthResult(unknownUser.status, unknownUser.body, otpSendResponseSchema, 'zh'); } catch (error) { unknownError = error; }
check(unknownError instanceof ApiError && unknownError.code === 'USER_NOT_FOUND', '原生认证解析器保留未注册邮箱的稳定错误码');

const beforeSignup = Date.now();
const signupSend = await auth('/email-otp/send-verification-otp', otpSendResponseSchema, { email, type: 'sign-in' }, undefined, { 'x-jev-otp-purpose': 'signup' });
check(signupSend.retryAfterSeconds === 60, '成功发码返回实际六十秒等待时间');
const signupOtp = await latestOtp(mailbox, email, beforeSignup); check(signupOtp.length === 6, '真实 SMTP 收到注册验证码');
const registration = await auth('/sign-up/email', miniLoginResponseSchema, { email, password, name: '认证验收' }, undefined, { 'x-jev-signup-otp': signupOtp });
const registeredSession = await auth('/get-session', authSessionSchema, undefined, registration.token);
check(registeredSession?.user.email === email, '注册响应令牌直接建立有效会话，无需二次密码登录');

/** 按真实限流响应等待，计时期间不重发，保留实际服务规则。 */
async function waitForEmailWindow(): Promise<void> {
  const result = await raw('/email-otp/send-verification-otp', { email, type: 'sign-in' });
  let failure: unknown;
  try { parseAuthResult(result.status, result.body, otpSendResponseSchema, 'zh'); } catch (error) { failure = error; }
  check(failure instanceof ApiError && failure.status === 429 && Boolean(failure.retryAfterSeconds), '原生错误保留真实限流等待时间');
  const seconds = failure.retryAfterSeconds!;
  console.log(`等待真实邮箱发送窗口：${seconds} 秒；期间没有重发。`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 200));
}
await waitForEmailWindow();
const beforeLogin = Date.now();
await auth('/email-otp/send-verification-otp', otpSendResponseSchema, { email, type: 'sign-in' });
const loginOtp = await latestOtp(mailbox, email, beforeLogin);
const login = await auth('/sign-in/email-otp', miniLoginResponseSchema, { email, otp: loginOtp });
const otpSession = await auth('/get-session', authSessionSchema, undefined, login.token);
check(otpSession?.user.id === registeredSession?.user.id, '验证码登录与注册账号相同');
const replay = await raw('/sign-in/email-otp', { email, otp: loginOtp }); check(replay.status === 400, '登录验证码只能消费一次');

await waitForEmailWindow();
const beforeReset = Date.now();
await auth('/email-otp/request-password-reset', otpSendResponseSchema, { email });
const resetOtp = await latestOtp(mailbox, email, beforeReset);
check(resetOtp.length === 6, '真实 SMTP 收到密码重置验证码');
await auth('/email-otp/reset-password', z.object({ success: z.literal(true) }), { email, otp: resetOtp, password: newPassword });
const oldPassword = await raw('/sign-in/email', { email, password }); check(oldPassword.status === 401, '密码重置后旧密码无法登录');
const updated = await auth('/sign-in/email', miniLoginResponseSchema, { email, password: newPassword });
const updatedSession = await auth('/get-session', authSessionSchema, undefined, updated.token);
check(updatedSession?.user.id === registeredSession?.user.id, '新密码可以登录原账号');
const resetReplay = await raw('/email-otp/reset-password', { email, otp: resetOtp, password }); check(resetReplay.status === 400, '密码重置验证码只能消费一次');
const dailyWait = await raw('/email-otp/request-password-reset', { email });
let longWait: unknown;
try { parseAuthResult(dailyWait.status, dailyWait.body, otpSendResponseSchema, 'en'); } catch (error) { longWait = error; }
check(longWait instanceof ApiError && longWait.status === 429 && longWait.retryAfterSeconds! > 60, 'IP 发送上限返回超过六十秒的真实等待时间');
check(longWait.message.includes('countdown'), '限流错误按当前英文界面翻译');
await auth('/sign-out', z.object({ success: z.boolean() }), {}, updated.token);
console.log(`全部 ${checks} 项真实邮件认证检查通过；原生键盘与页面交互仍待真机。`);
