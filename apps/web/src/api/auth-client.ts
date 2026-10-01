/**
 * Better Auth 前端客户端：邮箱验证码 + Google 登录共用同一会话协议。
 */
import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import type { Session } from '../session.js';

export const authClient = createAuthClient({
  basePath: '/api/v1/auth',
  plugins: [emailOTPClient()],
});

export const { signIn, signOut, useSession } = authClient;

/**
 * 会话 + 加载态：在唯一的边界把库的返回收窄成业务 Session 投影。
 * 昵称不在这里 —— 权威值在 /api/v1/me，由用到昵称的页面自行查询。
 */
export function useJevSession(): { session: Session | null; isPending: boolean } {
  const { data, isPending } = useSession();
  return { session: (data ?? null) as Session | null, isPending };
}
