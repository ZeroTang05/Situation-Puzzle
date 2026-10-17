/**
 * Better Auth 前端客户端：邮箱验证码 + Google 登录共用同一会话协议。
 * App 壳里请求带 Authorization: Bearer 并从响应头捕获会话令牌（WebView 拒收第三方
 * Cookie，见 docs/rebuild/13-APP-VERSION.md §4）；网页无令牌时这些步骤全是空操作。
 */
import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { apiBase, authorizationHeader, captureBearerToken, clearBearerToken } from '../app-runtime.js';
import type { Session } from '../session.js';

/** 统一出口：附带 Bearer 令牌头 + 捕获 set-auth-token（网页端两者均为空操作） */
const jevFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(authorizationHeader())) headers.set(key, value);
  const response = await fetch(input, { ...init, headers });
  captureBearerToken(response);
  return response;
};

export const authClient = createAuthClient({
  basePath: '/api/v1/auth',
  // App 壳：请求发往生产接口；网页：不设 baseURL，走相对路径
  ...(apiBase ? { baseURL: apiBase } : {}),
  fetchOptions: { customFetchImpl: jevFetch },
  plugins: [emailOTPClient()],
});

export const { signIn, useSession } = authClient;

/** 登出同时清掉本地令牌（网页无令牌，行为不变） */
export async function signOut(): Promise<void> {
  try {
    await authClient.signOut();
  } finally {
    clearBearerToken();
  }
}

/**
 * 会话 + 加载态：在唯一的边界把库的返回收窄成业务 Session 投影。
 * 昵称不在这里 —— 权威值在 /api/v1/me，由用到昵称的页面自行查询。
 */
export function useJevSession(): { session: Session | null; isPending: boolean } {
  const { data, isPending } = useSession();
  return { session: (data ?? null) as Session | null, isPending };
}
