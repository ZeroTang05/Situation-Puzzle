/**
 * HTTP 客户端（小程序版）：统一信封、稳定错误码、Bearer 令牌。
 * 令牌链路复用 App 壳的 Bearer 约定（docs/rebuild/13-APP-VERSION.md §4）——
 * 小程序与 WebView 一样没有可靠的跨域 Cookie，登录/刷新响应经 set-auth-token
 * 响应头下发令牌，之后每个请求带 Authorization 头。
 * 小程序网络只能走 https 且域名须在小程序后台配置 request 合法域名。
 */
import Taro from '@tarojs/taro'
import type { ErrorCode } from '@jev/contracts'
import { displayError, type Language } from '@jev/i18n'

/** 接口基址：小程序直接打生产域名（域名须已在小程序后台配为 request 合法域名） */
export const API_BASE = 'https://sp.xiaobaozi.cn'

const TOKEN_KEY = 'jev.mp-session-token'

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode | string,
    message: string,
    public readonly params?: Record<string, unknown>,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function apiUrl(path: string): string {
  return `${API_BASE}/api/v1${path}`
}

/** 已登录时返回 Bearer 头；与 web 壳的 authorizationHeader 同形 */
export function authorizationHeader(): Record<string, string> {
  const token = Taro.getStorageSync<string>(TOKEN_KEY)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 语言请求头：服务端按它分流事务邮件语言；与 web 端同键同值 */
export function languageHeader(): Record<string, string> {
  const stored = Taro.getStorageSync<string>('jev.language')
  return { 'X-Jev-Language': stored === 'en' ? 'en' : 'zh' }
}

/** 登录/会话刷新响应带 set-auth-token 头时更新本地令牌（响应头大小写两种都收） */
export function captureBearerToken(header: Record<string, string> | undefined): void {
  if (!header) return
  const token = header['set-auth-token'] ?? header['Set-Auth-Token']
  if (token) Taro.setStorageSync(TOKEN_KEY, token)
}

/** 直接写入 Bearer 令牌：微信一键登录的令牌在响应体里返回（无 Cookie/响应头链路） */
export function storeBearerToken(token: string): void {
  Taro.setStorageSync(TOKEN_KEY, token)
}

export function clearBearerToken(): void {
  Taro.removeStorageSync(TOKEN_KEY)
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  timeoutMs?: number
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const header: Record<string, string> = { ...authorizationHeader(), ...languageHeader() }
  if (options.body !== undefined) header['Content-Type'] = 'application/json'
  if (options.idempotencyKey) header['Idempotency-Key'] = options.idempotencyKey

  // Taro.request 只在网络层失败时 reject；HTTP 4xx/5xx 走 statusCode
  const res = await Taro.request({
    url: apiUrl(path),
    method: options.method ?? 'GET',
    data: options.body as string | TaroGeneral.IAnyObject | undefined,
    header,
    timeout: options.timeoutMs ?? 60_000
  })

  captureBearerToken(res.header)

  const payload = res.data as
    | { data?: T; error?: { code: string; message: string; params?: Record<string, unknown> } }
    | null
    | undefined

  if (res.statusCode < 200 || res.statusCode >= 300 || !payload || payload.error) {
    const error = payload?.error
    throw new ApiError(error?.code ?? 'INTERNAL', error?.message ?? 'Request failed', error?.params, res.statusCode)
  }
  return payload.data as T
}

/** 与 web 端同款：稳定错误码 → 本地语言文案 */
export function translateApiError(error: unknown, language: Language, fallback: string): string {
  if (error instanceof ApiError) return displayError(error.code, language, fallback)
  if (error instanceof Error) return error.message
  return fallback
}
