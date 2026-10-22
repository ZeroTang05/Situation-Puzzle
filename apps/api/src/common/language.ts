/**
 * 用户界面语言的实时取值。
 *
 * 优先级：请求头 X-Jev-Language（客户端当前选择，未登录也可用）→ 账号档案 profiles.language → 中文。
 * 与判题语言无关：判题按题目/本局/投稿自身的语言走，同一部署可同时判中英文题。
 */
import { eq } from 'drizzle-orm';
import { profiles, user as userTable } from '@jev/database';
import type { Language } from '@jev/contracts';
import { app } from '../context.js';

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

/** 账号档案里的界面语言（没有档案或值不合法时为 null） */
export async function profileLanguage(userId: string): Promise<Language | null> {
  const rows = await app()
    .db.db.select({ language: profiles.language })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return parseLanguage(rows[0]?.language ?? null);
}

/** 按邮箱找账号档案里的界面语言（登录发码时账号已存在但可能还没建档） */
export async function profileLanguageByEmail(email: string): Promise<Language | null> {
  const rows = await app()
    .db.db.select({ language: profiles.language })
    .from(profiles)
    .innerJoin(userTable, eq(userTable.id, profiles.userId))
    .where(eq(userTable.email, email))
    .limit(1);
  return parseLanguage(rows[0]?.language ?? null);
}
