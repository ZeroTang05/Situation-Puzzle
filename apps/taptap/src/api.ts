/** TapTap 原生网络与会话。普通业务接口解析信封；Better Auth 接口解析裸响应。 */
import { z } from 'zod';
import { authSessionSchema, errorBodySchema, miniLoginResponseSchema } from '@jev/contracts';
import { displayError } from '@jev/i18n';
import { getLanguage } from './runtime.js';
import { ApiError } from './api-error.js';
import { parseAuthResult } from './auth-protocol.js';
export { ApiError } from './api-error.js';

const TOKEN_KEY = 'jev.taptap.auth';
let token = String(tap.getStorageSync(TOKEN_KEY) || '');
export function storeToken(value: string): void { token = value; tap.setStorageSync(TOKEN_KEY, value); }
export function hasToken(): boolean { return token.length > 0; }

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  anonymous?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** 匿名单人请求明确去掉账号凭证；超时交给宿主，中断只拒绝当前操作。 */
async function transport(path: string, options: RequestOptions = {}) {
  return new Promise<{ statusCode: number; data: unknown }>((resolve, reject) => {
    tap.request({
      url: `${__API_BASE__}/api/v1${path}`,
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      ...(options.body !== undefined && { data: options.body }),
      header: {
        'content-type': 'application/json', 'X-Jev-Language': getLanguage(),
        ...(!options.anonymous && token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      timeout: options.timeoutMs ?? 60_000,
      success(result) {
        const refreshed = Object.entries(result.header).find(([key]) => key.toLowerCase() === 'set-auth-token')?.[1];
        if (!options.anonymous && typeof refreshed === 'string' && refreshed) storeToken(refreshed);
        resolve(result);
      },
      fail(error) {
        console.error('[taptap:network]', path, error.errMsg);
        reject(new ApiError(0, 'NETWORK_ERROR', getLanguage() === 'zh' ? '连接失败，请检查网络后重试' : 'Connection failed. Check your network.'));
      },
    });
  });
}

/** 业务错误保存状态码，供实时连接和待确认请求区分权限、网络与业务拒绝。 */
export async function api<T>(path: string, options: RequestOptions = {}, schema?: z.ZodType<T>): Promise<T> {
  const result = await transport(path, options);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const parsed = errorBodySchema.parse(result.data);
    console.error('[taptap:api]', path, parsed.error.code, parsed.requestId);
    throw new ApiError(result.statusCode, parsed.error.code, displayError(parsed.error.code, getLanguage(), getLanguage() === 'zh' ? '请求失败' : 'Request failed'));
  }
  const envelope = z.object({ data: schema ?? z.unknown() }).parse(result.data);
  return envelope.data as T;
}

/** 强类型请求简写：单人接口自动不带登录令牌。 */
export function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  return api(path, { ...(body !== undefined && { body }), anonymous: path.startsWith('/solo/') }, schema);
}

export async function authRequest<T>(path: string, options: RequestOptions, schema: z.ZodType<T>): Promise<T> {
  const result = await transport(`/auth${path}`, options);
  return parseAuthResult(result.statusCode, result.data, schema, getLanguage());
}

export function platformCode(): Promise<string> {
  return new Promise((resolve, reject) => tap.login({ timeout: 15_000,
    success(result) { if (result.code) resolve(result.code); else reject(new Error('TapTap 未返回登录凭证')); },
    fail(error) { console.error('[taptap:login]', error.errMsg); reject(new Error('TapTap 登录失败，请重试')); },
  }));
}

/** 临时 code 当次交换，不持久化；保存服务器签发的本站会话令牌。 */
export async function login(): Promise<void> {
  const data = await authRequest('/taptap-mini/login', { body: { code: await platformCode() } }, miniLoginResponseSchema);
  storeToken(data.token);
}
export const getSession = () => authRequest('/get-session', {}, authSessionSchema);
export async function signOut(): Promise<void> {
  await authRequest('/sign-out', { method: 'POST' }, z.object({ success: z.boolean() }));
  storeToken('');
}
