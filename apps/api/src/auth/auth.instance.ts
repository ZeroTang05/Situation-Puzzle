/**
 * Better Auth 实例：Email OTP（邮箱验证码）+ Google OAuth（docs/rebuild/05-OPERATIONS.md §2）。
 *
 * - 会话、Cookie、验证码协议全部交给 Better Auth，业务代码不手写
 * - Google 只申请 openid/email/profile；身份按 provider+accountId 唯一识别
 * - 注册钩子：新用户初始化 profile + 免费开房账户 + 赞助账户（每用户一次，唯一约束兜底）
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';
import {
  user as userTable,
  session as sessionTable,
  account as accountTable,
  verification as verificationTable,
  profiles,
  freeRoomAccounts,
  sponsorAccounts,
} from '@jev/database';
import type { DbHandle } from '@jev/database';
import type { Env } from '../env.js';
import type { Mailer } from './mailer.js';

export interface AuthDeps {
  env: Env;
  db: DbHandle;
  mailer: Mailer;
}

export function createAuth({ env, db, mailer }: AuthDeps) {
  const baseURL = new URL('/api/v1/auth', env.PUBLIC_BASE_URL).toString();

  return betterAuth({
    appName: 'Jev',
    baseURL,
    trustedOrigins: [env.PUBLIC_BASE_URL],
    database: drizzleAdapter(db.db, {
      provider: 'pg',
      schema: {
        // 模型 → drizzle 表映射；字段协议由 Better Auth 定义
        user: userTable,
        session: sessionTable,
        account: accountTable,
        verification: verificationTable,
      },
    }),
    emailAndPassword: { enabled: false },
    socialProviders: env.GOOGLE_CLIENT_ID
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            scope: ['openid', 'email', 'profile'],
          },
        }
      : {},
    plugins: [
      emailOTP({
        // 验证码 5 分钟有效、6 位；同邮箱 60 秒限发由 better-auth rateLimit 承担
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOTP: async ({ email, otp }) => {
          await mailer.sendVerificationCode(email, otp, env.JEV_LANGUAGE);
        },
      }),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === 'production',
    },
    rateLimit: { enabled: true, window: 60, max: 20 },
    user: {
      // 昵称默认取邮箱前缀；玩家可在「我的」里改
    },
    databaseHooks: {
      user: {
        create: {
          after: async (userRow) => {
            const nickname = userRow.name || userRow.email.split('@')[0] || '玩家';
            await db.db.insert(profiles).values({ userId: userRow.id, nickname }).onConflictDoNothing();
            await db.db.insert(freeRoomAccounts).values({ userId: userRow.id }).onConflictDoNothing();
            await db.db.insert(sponsorAccounts).values({ userId: userRow.id }).onConflictDoNothing();
          },
        },
      },
    },
  });
}
