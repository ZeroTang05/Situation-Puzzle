/**
 * Better Auth 前端客户端：邮箱验证码 + Google 登录共用同一会话协议。
 */
import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  basePath: '/api/v1/auth',
  plugins: [emailOTPClient()],
});

export const { signIn, signOut, useSession } = authClient;
