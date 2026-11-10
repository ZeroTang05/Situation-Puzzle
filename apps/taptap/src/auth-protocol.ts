/** Better Auth 裸响应解析：错误按稳定码翻译，OTP 等待时间保留服务器权威值。 */
import { z } from 'zod';
import type { Language } from '@jev/contracts';
import { displayAuthError, displayDeviceAuthError } from '@jev/i18n';
import { ApiError } from './api-error.js';

export const otpSendResponseSchema = z.object({ success: z.literal(true), retryAfterSeconds: z.number().int().nonnegative() });
const failureSchema = z.object({ code: z.string().optional(), error: z.string().optional(), retryAfterSeconds: z.number().int().nonnegative().optional() });

export function parseAuthResult<T>(status: number, body: unknown, schema: z.ZodType<T>, language: Language): T {
  if (status >= 200 && status < 300) return schema.parse(body);
  const error = failureSchema.parse(body);
  if (error.code === 'OTP_SEND_RATE_LIMITED' && !(error.retryAfterSeconds && error.retryAfterSeconds > 0)) throw new Error('验证码限流响应缺少有效等待时间');
  if (error.error) throw new ApiError(status, error.error, displayDeviceAuthError(error.error, language), error.retryAfterSeconds);
  const code = error.code ?? (status === 429 ? 'TOO_MANY_REQUESTS' : 'AUTH_FAILED');
  throw new ApiError(status, code, displayAuthError(code, language, language === 'zh' ? '登录操作失败，请重试。' : 'Sign-in failed. Please try again.'), error.retryAfterSeconds);
}
