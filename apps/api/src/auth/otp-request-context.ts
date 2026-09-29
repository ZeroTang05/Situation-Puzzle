/** 每个真实 HTTP 请求独立保存 IP 与邮件结果，供认证钩子共用。 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface OtpRequestContext {
  ip: string;
  reservation?: { id: string; email: string };
  delivery: 'not_started' | 'accepted' | 'unknown' | 'rejected';
}
export const otpRequestContext = new AsyncLocalStorage<OtpRequestContext>();
