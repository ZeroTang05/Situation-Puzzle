/**
 * 会话接口（小程序版）。
 *
 * 与 web 端同一套会话协议（apps/web/src/api/auth-client.ts）：Bearer 令牌 +
 * 服务端 better-auth 的 /api/v1/auth/* 端点。但**不引 better-auth 客户端**，
 * 请求自己发——参照 ~/GoWith/apps/miniapp/src/lib/api.ts 的做法（那边小程序端
 * 同样没有会话客户端库，只有一层自写的 request 包装）。
 *
 * 【为什么不用 better-auth 客户端】它取址靠 better-fetch 的 `new URL(path, base)`；
 * 微信运行时没有原生 URL（Taro 用 ProvidePlugin 注入的 polyfill 顶上），而那个 polyfill
 * 解析「相对地址 + 绝对 base」时只保留 base 的 origin、**丢掉 base 的 path 段**：
 * /api/v1/auth 前缀消失，请求打到 https://sp.xiaobaozi.cn/get-session，落到站点
 * SPA 回退页（200 text/html），会话读不回来，表现为「登录成功后立刻又显示未登录」。
 * 这里改成自己拼绝对地址（apiBase + path），不经过 URL 解析，也就不受 polyfill 语义影响。
 *
 * better-auth 端点不走业务接口的 {data,error} 信封，返回裸 JSON：
 * - 登录 POST /wechat-mini/login → { token }
 * - 会话 GET  /get-session → { session, user }；无有效令牌时为 null
 * - 登出 POST /sign-out → { success: true }
 * 错误体为 { code, message }（code 是稳定错误码，页面据此翻译）。
 */
import Taro from '@tarojs/taro'
import { API_BASE, authorizationHeader, captureBearerToken, clearBearerToken, languageHeader, storeBearerToken } from './client'

/** better-auth 端点前缀（服务端挂在 /api/v1/auth 下）；地址自己拼，不过 URL 解析 */
const AUTH_BASE = `${API_BASE}/api/v1/auth`

/** 服务端 better-auth 的会话返回体（裸 JSON，不走 {data,error} 信封） */
export interface AuthSession {
  session: { id: string; userId: string; expiresAt: string | Date }
  user: { id: string; email: string; name: string; emailVerified: boolean }
}

/** 认证失败：带 better-auth 的错误码（WECHAT_LOGIN_FAILED 等），页面据此翻译 */
export class AuthError extends Error {
  constructor(
    readonly code: string | null,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

interface AuthRequestInit {
  method?: 'GET' | 'POST'
  body?: unknown
}

/**
 * 发一个 better-auth 端点请求：地址自己拼、带 Bearer 令牌与语言头。
 * 响应体自己解析（不依赖微信的自动 JSON 解析：SPA 回退页这类非 JSON 响应会让它炸）。
 * 非 2xx 抛 AuthError（带服务端错误码），页面按 code 翻译文案。
 */
async function authRequest<T>(path: string, init: AuthRequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined
  const res = await Taro.request({
    url: `${AUTH_BASE}${path}`,
    method: init.method ?? 'GET',
    data: init.body as TaroGeneral.IAnyObject | undefined,
    header: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...authorizationHeader(),
      ...languageHeader(),
    },
    // 关掉自动 JSON 解析：响应体自己 parse，解析失败按「未登录/失败」处理而不是抛 SyntaxError
    dataType: 'text',
    timeout: 30_000,
  })
  captureBearerToken(res.header)
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
  let payload: (T & { code?: string; message?: string }) | null = null
  try {
    payload = text ? (JSON.parse(text) as T & { code?: string; message?: string }) : null
  } catch {
    payload = null
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new AuthError(payload?.code ?? null, payload?.message ?? '请求失败', res.statusCode)
  }
  return payload as T
}

/**
 * 微信一键登录：wx.login 的 code 交服务端换 openid、建号建会话，
 * 令牌存本地（后续请求由 authorizationHeader 带上）。
 */
export async function loginWithWechat(code: string): Promise<void> {
  const payload = await authRequest<{ token?: string }>('/wechat-mini/login', {
    method: 'POST',
    body: { code },
  })
  if (!payload?.token) throw new AuthError(null, '登录响应缺少令牌', 500)
  storeBearerToken(payload.token)
}

/**
 * 读当前会话：带 Bearer 令牌查服务端。
 * 无有效令牌时服务端回 null（HTTP 200），按未登录处理。
 */
export async function getSession(): Promise<AuthSession | null> {
  const payload = await authRequest<AuthSession | null>('/get-session')
  return payload?.user ? payload : null
}

/** 登出：服务端撤销会话 + 本地清令牌（与 web 端 signOut 同语义） */
export async function signOut(): Promise<void> {
  try {
    await authRequest('/sign-out', { method: 'POST' })
  } finally {
    clearBearerToken()
  }
}
