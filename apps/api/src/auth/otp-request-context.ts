/** 每个真实 HTTP 请求独立保存 IP 与邮件结果，供认证钩子共用。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Language } from '@jev/contracts';

export interface OtpRequestContext {
  ip: string;
  /** 请求里的实时界面语言（X-Jev-Language 头）：没有时由调用方按账号档案兜底 */
  language?: Language;
  reservation?: { id: string; email: string };
  delivery: 'not_started' | 'accepted' | 'unknown' | 'rejected';
}
export const otpRequestContext = new AsyncLocalStorage<OtpRequestContext>();
