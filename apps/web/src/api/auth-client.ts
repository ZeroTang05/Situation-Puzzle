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
 * user.nickname 由 API 自定义 get-session 注入，库的推断类型不包含它。
 */
export function useJevSession(): { session: Session | null; isPending: boolean } {
  const { data, isPending } = useSession();
  return { session: (data ?? null) as Session | null, isPending };
}
