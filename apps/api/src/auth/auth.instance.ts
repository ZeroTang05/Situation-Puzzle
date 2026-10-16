/**
 * Better Auth 实例：Email OTP（邮箱验证码）+ Google OAuth（docs/rebuild/05-OPERATIONS.md §2）。
 *
 * - 会话、Cookie、验证码协议全部交给 Better Auth，业务代码不手写
 * - Google 只申请 openid/email/profile；身份按 provider+accountId 唯一识别
 * - 登录端点只登录：/sign-in/email-otp 拒绝未注册邮箱，账号一律经 /sign-up/email 建立
 * - 发码按用途闸门：登录发码要求账号已存在，注册发码（x-jev-otp-purpose: signup）要求邮箱未注册
 * - 注册钩子：新用户初始化 profile + 免费开房账户 + 赞助账户 + 注册礼一个月赞助（每用户一次，唯一约束兜底）
 * - 账户关联创建即写 email_verified（credential 经验证码闸门、OAuth 由提供方认证），
 *   避免日后验证码登录触发 Better Auth 的 revokeUnprovenAccountAccess 清掉密码凭证
 */
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, genericOAuth } from 'better-auth/plugins';
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  user as userTable,
  session as sessionTable,
  account as accountTable,
  verification as verificationTable,
  profiles,
  freeRoomAccounts,
  sponsorAccounts,
  sponsorGrants,
  sponsorLedger,
} from '@jev/database';
import { addMonthsClamped } from '@jev/domain';
import type { DbHandle } from '@jev/database';
import type { Env } from '../env.js';
import { MailDeliveryError, type Mailer } from './mailer.js';
import { OtpSendQuota, otpLimitMessage } from './otp-send-quota.js';
import { otpRequestContext } from './otp-request-context.js';
import { consumeSignupOtp, isDisposableEmail } from './signup-otp-gate.js';
import { z } from 'zod';

export interface AuthDeps {
  env: Env;
  db: DbHandle;
  mailer: Mailer;
}

/** 默认昵称：用户 + 6 位随机编号（昵称允许重复，不做唯一性检查） */
export function defaultNickname(): string {
  return `用户${randomInt(100000, 1000000)}`;
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
  const quota = new OtpSendQuota(db.pool);
  const otpSendPaths = new Set(['/email-otp/send-verification-otp', '/email-otp/request-password-reset', '/forget-password/email-otp', '/email-otp/request-email-change']);
  // 密码最短长度：emailAndPassword 配置与注册闸门共用一个值
  const MIN_PASSWORD_LENGTH = 8;

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
      minPasswordLength: MIN_PASSWORD_LENGTH,
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
        // 验证码 5 分钟有效、6 位；发送额度在前置钩子里由 PostgreSQL 管理。
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOTP: async ({ email, otp }) => {
          const request = otpRequestContext.getStore();
          if (!request?.reservation || request.reservation.email !== email) throw new APIError('INTERNAL_SERVER_ERROR', { message: '验证码发送缺少额度预占' });
          request.delivery = 'unknown';
          try {
            await mailer.sendVerificationCode(email, otp, env.JEV_LANGUAGE);
            request.delivery = 'accepted';
          } catch (error) {
            console.error('[auth] 验证码邮件发送失败', error);
            if (error instanceof MailDeliveryError && error.outcome === 'rejected') {
              request.delivery = 'rejected';
              await quota.release(request.reservation.id);
            }
            throw new APIError('SERVICE_UNAVAILABLE', { code: 'OTP_SEND_FAILED', message: request.delivery === 'rejected' ? '验证码发送失败，请稍后重试。' : '邮件发送结果暂未确认，请检查收件箱，60 秒后可重试。', retryAfterSeconds: request.delivery === 'rejected' ? 0 : 60 });
          }
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
      ipAddress: { ipAddressHeaders: ['x-jev-client-ip'] },
    },
    rateLimit: { enabled: true, window: 60, max: 20, customRules: Object.fromEntries([...otpSendPaths].map((path) => [path, false])) },
    hooks: {
      /** 注册闸门 + 验证码发送预占：登录和注册按相同邮箱/IP 共用额度。 */
      before: createAuthMiddleware(async (ctx) => {
        // 注册闸门：密码注册必须当场消费一条有效验证码，堵住「绕开页面直接建号」的口子
        if (ctx.path === '/sign-up/email') {
          const parsed = z.email().safeParse(typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : undefined);
          if (!parsed.success) throw new APIError('BAD_REQUEST', { code: 'INVALID_EMAIL', message: '邮箱格式不正确' });
          if (isDisposableEmail(parsed.data)) throw new APIError('BAD_REQUEST', { code: 'DISPOSABLE_EMAIL', message: '不支持一次性邮箱地址' });
          // 邮箱已注册、密码过短等能在消费验证码之前发现的错误先拒绝，不白烧用户的验证码
          if (typeof ctx.body?.name !== 'string') throw new APIError('BAD_REQUEST', { message: '昵称不能为空' });
          if (typeof ctx.body?.password !== 'string' || ctx.body.password.length < MIN_PASSWORD_LENGTH) throw new APIError('BAD_REQUEST', { code: 'INVALID_PASSWORD_LENGTH', message: `密码至少 ${MIN_PASSWORD_LENGTH} 位` });
          if (await ctx.context.internalAdapter.findUserByEmail(parsed.data)) throw new APIError('BAD_REQUEST', { code: 'USER_ALREADY_EXISTS', message: '该邮箱已注册，请直接登录' });
          const otp = ctx.headers?.get('x-jev-signup-otp') ?? '';
          const rejection = await consumeSignupOtp(ctx.context.internalAdapter, parsed.data, otp);
          if (rejection) throw new APIError('FORBIDDEN', { code: 'SIGNUP_OTP_REQUIRED', message: rejection });
          return;
        }
        // 登录端点只登录：账号不存在直接拒绝（发生在验证码消费之前，不烧码），杜绝无密码建号
        if (ctx.path === '/sign-in/email-otp') {
          const parsed = z.email().safeParse(typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : undefined);
          if (parsed.success && !(await ctx.context.internalAdapter.findUserByEmail(parsed.data))) {
            throw new APIError('BAD_REQUEST', { code: 'USER_NOT_FOUND', message: '该邮箱未注册，请先注册' });
          }
          return;
        }
        if (!ctx.path || !otpSendPaths.has(ctx.path)) return;
        const request = otpRequestContext.getStore();
        if (!request) throw new APIError('SERVICE_UNAVAILABLE', { message: '验证码请求缺少客户端地址' });
        const emailField = ctx.path === '/email-otp/request-email-change' ? 'newEmail' : 'email';
        const parsed = z.email().safeParse(typeof ctx.body?.[emailField] === 'string' ? ctx.body[emailField].toLowerCase() : undefined);
        if (!parsed.success) throw new APIError('BAD_REQUEST', { code: 'INVALID_EMAIL', message: '邮箱格式不正确' });
        if (isDisposableEmail(parsed.data)) throw new APIError('BAD_REQUEST', { code: 'DISPOSABLE_EMAIL', message: '不支持一次性邮箱地址' });
        if (ctx.path === '/email-otp/send-verification-otp' && !['sign-in', 'email-verification', 'forget-password'].includes(ctx.body.type)) throw new APIError('BAD_REQUEST', { message: '验证码用途无效' });
        ctx.body[emailField] = parsed.data;
        // 发码用途闸门：登录发码要求账号已存在；注册发码（x-jev-otp-purpose: signup）要求邮箱未注册
        if (ctx.path === '/email-otp/send-verification-otp') {
          const exists = !!(await ctx.context.internalAdapter.findUserByEmail(parsed.data));
          if (ctx.headers?.get('x-jev-otp-purpose') === 'signup') {
            if (exists) throw new APIError('BAD_REQUEST', { code: 'USER_ALREADY_EXISTS', message: '该邮箱已注册，请直接登录' });
          } else if (ctx.body.type === 'sign-in' && !exists) {
            throw new APIError('BAD_REQUEST', { code: 'USER_NOT_FOUND', message: '该邮箱未注册，请先注册' });
          }
        }
        const reserved = await quota.reserve(parsed.data, request.ip);
        if ('retryAfterSeconds' in reserved) {
          ctx.setHeader('Retry-After', String(reserved.retryAfterSeconds));
          throw new APIError('TOO_MANY_REQUESTS', { code: 'OTP_SEND_RATE_LIMITED', message: otpLimitMessage(reserved.retryAfterSeconds), retryAfterSeconds: reserved.retryAfterSeconds, limitScope: reserved.scope });
        }
        request.reservation = { id: reserved.id, email: parsed.data };
      }),
      /** 未实际进入邮件发送的请求退回额度；邮件接受后保持原始计数。 */
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.path || !otpSendPaths.has(ctx.path)) return;
        const request = otpRequestContext.getStore();
        if (!request?.reservation) return;
        if (request.delivery === 'not_started') await quota.release(request.reservation.id);
        const retryAfterSeconds = request.delivery === 'accepted' || request.delivery === 'unknown' ? 60 : 0;
        ctx.setHeader('Retry-After', String(retryAfterSeconds));
        if (!isAPIError(ctx.context.returned)) return ctx.json({ success: true, retryAfterSeconds });
      }),
    },
    user: {
      // 昵称默认取邮箱前缀；玩家可在「我的」里改
    },
    databaseHooks: {
      user: {
        create: {
          after: async (userRow) => {
            // 昵称允许重复；未填写时用「用户+随机编号」，避免把邮箱前缀当昵称展示
            const nickname = userRow.name?.trim() || defaultNickname();
            await db.db.insert(profiles).values({ userId: userRow.id, nickname }).onConflictDoNothing();
            await db.db.insert(freeRoomAccounts).values({ userId: userRow.id }).onConflictDoNothing();
            await db.db.insert(sponsorAccounts).values({ userId: userRow.id }).onConflictDoNothing();
            // 注册礼：一个月赞助（signup_bonus），授权与流水同事务；不设月度锚点，续购月度时按首购重新起算
            const now = new Date();
            await db.tx(async (tx) => {
              const [grant] = await tx
                .insert(sponsorGrants)
                .values({
                  userId: userRow.id,
                  type: 'signup_bonus',
                  status: 'active',
                  effectiveFrom: now,
                  effectiveUntil: addMonthsClamped(now, 1),
                })
                .returning({ id: sponsorGrants.id });
              await tx.insert(sponsorLedger).values({
                userId: userRow.id,
                action: 'grant',
                grantId: grant!.id,
                detail: { signupBonus: true },
                idempotencyKey: `signup-bonus:${userRow.id}`,
              });
            });
          },
        },
      },
      // 账户关联创建即视为已验证邮箱：credential 走验证码闸门，OAuth（Google/LINUX DO）由提供方认证
      account: {
        create: {
          after: async (accountRow) => {
            await db.db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, accountRow.userId));
          },
        },
      },
      // 兜底：注册 + 登录都覆盖，防止清库/迁移后老用户数据缺失
      session: {
        create: {
          before: async (sessionRow) => {
            await db.db
              .insert(freeRoomAccounts)
              .values({ userId: sessionRow.userId })
              .onConflictDoNothing();
            await db.db
              .insert(sponsorAccounts)
              .values({ userId: sessionRow.userId })
              .onConflictDoNothing();
          },
        },
      },
    },
  });
}
