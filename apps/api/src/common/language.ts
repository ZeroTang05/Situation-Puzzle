/**
 * 用户界面语言的实时取值：只认客户端显式上报的值，服务端不落库。
 *
 * 客户端每次请求都带 X-Jev-Language（网页/App 壳同源或已加 CORS 白名单），
 * 服务端据此分流：事务邮件按它发中文或英文；判题语言另按题目走。
 * 请求头缺失（老客户端、OAuth 回调等）时回落中文。
 */
import type { Language } from '@jev/contracts';

/** 客户端上报当前界面语言的请求头 */
export const LANGUAGE_HEADER = 'x-jev-language';

/** 只认 zh / en（含 en-US、zh-CN 这类带地区后缀的形式）；无法识别时返回 null 交给上层兜底。 */
export function parseLanguage(value: string | null | undefined): Language | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh';
  return null;
}

/** 任意带 get(name) 的头集合（Request.headers）或 Express 头对象都能读 */
export function languageFromHeaders(
  headers: { get(name: string): string | null } | Record<string, string | string[] | undefined> | undefined,
): Language | null {
  if (!headers) return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    return parseLanguage((headers as { get(name: string): string | null }).get(LANGUAGE_HEADER));
  }
  const raw = (headers as Record<string, string | string[] | undefined>)[LANGUAGE_HEADER];
  return parseLanguage(Array.isArray(raw) ? raw[0] ?? null : raw ?? null);
}

/** 取请求里的界面语言；没有上报时回落中文 */
export function languageOf(headers: { get(name: string): string | null } | Record<string, string | string[] | undefined> | undefined): Language {
  return languageFromHeaders(headers) ?? 'zh';
}
