/**
 * Better Auth 实例：Email OTP（邮箱验证码）+ Google OAuth（docs/rebuild/05-OPERATIONS.md §2）。
 *
 * - 会话、Cookie、验证码协议全部交给 Better Auth，业务代码不手写
 * - Google 只申请 openid/email/profile；身份按 provider+accountId 唯一识别
 * - 注册钩子：新用户初始化 profile + 免费开房账户 + 赞助账户（每用户一次，唯一约束兜底）
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, genericOAuth } from 'better-auth/plugins';
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

/** LINUX DO /api/user 的展示名：name 优先，退回 username */
function linuxdoDisplayName(profile: Record<string, unknown>): string | undefined {
  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  const username = typeof profile.username === 'string' ? profile.username.trim() : '';
  return name || username || undefined;
}

/** LINUX DO 头像是 Discourse 模板路径，把 {size} 换成 288px；相对路径补全为绝对地址 */
function linuxdoAvatar(profile: Record<string, unknown>): string | undefined {
  if (typeof profile.avatar_template !== 'string') return undefined;
  const url = profile.avatar_template.replace('{size}', '288');
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  return url.startsWith('/') ? `https://connect.linux.do${url}` : undefined;
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
    emailAndPassword: {
      enabled: true,
      // 8+ 字符：避免过短口令撞库，同时不阻用户体验
      minPasswordLength: 8,
      // 邮件 OTP 与密码双轨并存：用户首次用 OTP 注册后仍可补建密码
      requireEmailVerification: false,
      // 忘记密码：Better Auth 签发一次性 token，拼成站内重置页链接交给 mailer
      sendResetPassword: async ({ user, token }) => {
        const url = `${env.PUBLIC_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
        await mailer.sendPasswordReset(user.email, url, env.JEV_LANGUAGE);
      },
    },
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
        // 插件默认 3 次/分钟过于收紧（多人同时登录会误伤），提到 10 次/分钟
        rateLimit: { window: 60, max: 10 },
        sendVerificationOTP: async ({ email, otp }) => {
          await mailer.sendVerificationCode(email, otp, env.JEV_LANGUAGE);
        },
      }),
      // LINUX DO OAuth（connect.linux.do，对接参数参考 GoWith）：无 OIDC discovery，
      // token 兑换用 Basic 头、不开 PKCE；/api/user 不返回邮箱，用稳定占位邮箱建账号
      ...(env.LINUXDO_OAUTH_CLIENT_ID && env.LINUXDO_OAUTH_CLIENT_SECRET
        ? [
            genericOAuth({
              config: [
                {
                  providerId: 'linuxdo',
                  name: 'LINUX DO',
                  clientId: env.LINUXDO_OAUTH_CLIENT_ID,
                  clientSecret: env.LINUXDO_OAUTH_CLIENT_SECRET,
                  authorizationUrl: 'https://connect.linux.do/oauth2/authorize',
                  tokenUrl: 'https://connect.linux.do/oauth2/token',
                  userInfoUrl: 'https://connect.linux.do/api/user',
                  scopes: [],
                  pkce: false,
                  authentication: 'basic',
                  mapProfileToUser: (profile) => {
                    if (profile.id === undefined || profile.id === null) {
                      throw new Error('LINUX DO 未返回稳定用户标识');
                    }
                    // exactOptionalPropertyTypes：可选字段有值才放进对象
                    const name = linuxdoDisplayName(profile);
                    const image = linuxdoAvatar(profile);
                    return {
                      email: `linuxdo-${String(profile.id)}@linuxdo.invalid`,
                      ...(name !== undefined && { name }),
                      ...(image !== undefined && { image }),
                    };
                  },
                },
              ],
            }),
          ]
        : []),
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
