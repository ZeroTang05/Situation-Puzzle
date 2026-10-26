/**
 * Better Auth 前端客户端（小程序版）。
 * 与 web 端同一套会话协议（apps/web/src/api/auth-client.ts）：
 * - 令牌链路复用 App 壳的 Bearer 约定，taroFetch 统一附加头并捕获 set-auth-token；
 * - 插件只挂 emailOTP（密码 + 验证码登录 / 注册验证）；Google、LINUX DO 登录
 *   需要系统浏览器完成授权跳转，小程序里无法承接回调，M1 不提供。
 * 这里用 vanilla 入口（better-auth/client）——它不依赖 DOM，react 入口的
 * useSession/state 体系依赖浏览器 API（BroadcastChannel、focus 等）进不来。
 * 会话状态由 state/session.ts 自建 hook 提供。
 */
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient } from 'better-auth/client/plugins'
import { API_BASE, clearBearerToken } from './client'
import { taroFetch } from './fetch-adapter'

export const authClient = createAuthClient({
  basePath: '/api/v1/auth',
  baseURL: API_BASE,
  fetchOptions: { customFetchImpl: taroFetch },
  plugins: [emailOTPClient()],
})

export const { signIn, signUp } = authClient

/** 登出同时清掉本地令牌（与 web 端 signOut 同语义） */
export async function signOut(): Promise<void> {
  try {
    await authClient.signOut()
  } finally {
    clearBearerToken()
  }
}
