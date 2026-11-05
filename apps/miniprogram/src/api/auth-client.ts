/**
 * Better Auth 前端客户端（小程序版）。
 * 与 web 端同一套会话协议（apps/web/src/api/auth-client.ts）：
 * - 令牌链路复用 App 壳的 Bearer 约定，taroFetch 统一附加头并捕获 set-auth-token；
 * - 登录已换微信一键登录（POST /auth/wechat-mini/login 直调），客户端只承担
 *   会话读取 / 刷新 / 登出。
 * 这里用 vanilla 入口（better-auth/client）——它不依赖 DOM，react 入口的
 * useSession/state 体系依赖浏览器 API（BroadcastChannel、focus 等）进不来。
 * 会话状态由 state/session.ts 自建 hook 提供。
 */
import '../polyfills'
import { createAuthClient } from 'better-auth/client'
import { API_BASE, clearBearerToken } from './client'
import { taroFetch } from './fetch-adapter'

export const authClient = createAuthClient({
  basePath: '/api/v1/auth',
  baseURL: API_BASE,
  fetchOptions: { customFetchImpl: taroFetch },
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
