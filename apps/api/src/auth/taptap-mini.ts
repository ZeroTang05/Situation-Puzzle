/**
 * TapTap 小游戏身份交换。平台 code 经官方 code2Session 验证后，创建本站 Bearer 会话。
 * 平台 session_key 不落库、不返回客户端；同一 MiniApp 下按 openid 识别玩家。
 */
import { createHash } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { miniLoginRequestSchema } from '@jev/contracts';
import { z } from 'zod';

const identitySchema = z.object({ openid: z.string().min(1) });
const platformErrorSchema = z.object({ errcode: z.number() });

/** 验证官方响应，只提取本站需要的身份；失败日志只含错误码。 */
export function parseTapTapIdentity(payload: unknown): { openid: string } {
  const platformError = platformErrorSchema.safeParse(payload);
  if (platformError.success && platformError.data.errcode !== 0) {
    console.error('[auth:taptap] 平台拒绝身份交换', platformError.data.errcode);
    const busy = platformError.data.errcode === 1045011;
    throw new APIError(busy ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST', {
      code: busy ? 'TAPTAP_LOGIN_BUSY' : 'TAPTAP_LOGIN_FAILED',
      message: busy ? 'TapTap 登录繁忙，请稍后重试' : 'TapTap 登录凭证无效，请重新登录',
    });
  }
  const parsed = identitySchema.safeParse(payload);
  if (!parsed.success) {
    console.error('[auth:taptap] 身份响应缺少有效 openid');
    throw new APIError('BAD_GATEWAY', { code: 'TAPTAP_LOGIN_BUSY', message: 'TapTap 登录响应异常，请稍后重试' });
  }
  return parsed.data;
}

/** 只识别 PostgreSQL 唯一约束冲突，其余数据库故障原样上抛。 */
function isUniqueConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && error.cause !== error && isUniqueConflict(error.cause);
}

/** 请求包含密钥，故障日志禁止记录完整 URL 或上游原始响应。 */
async function exchange(config: { appid: string; secret: string }, code: string) {
  const url = new URL('https://cloud-miniapp.tapapis.cn/auth/v1/jscode2session');
  url.search = new URLSearchParams({ appid: config.appid, secret: config.secret, js_code: code, grant_type: 'authorization_code' }).toString();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    console.error('[auth:taptap] 身份交换网络失败');
    throw new APIError('SERVICE_UNAVAILABLE', { code: 'TAPTAP_LOGIN_BUSY', message: 'TapTap 登录暂时不可用，请稍后重试' });
  }
  if (!response.ok) {
    console.error('[auth:taptap] 身份交换 HTTP 失败', response.status);
    throw new APIError('SERVICE_UNAVAILABLE', { code: 'TAPTAP_LOGIN_BUSY', message: 'TapTap 登录暂时不可用，请稍后重试' });
  }
  return parseTapTapIdentity(await response.json());
}

/** 登录与关联共用平台身份校验；关联只允许绑定到已登录账号，不合并两个已有账号。 */
export function taptapMiniPlugin(config: { appid: string; secret: string }): BetterAuthPlugin {
  return {
    id: 'taptap-mini',
    endpoints: {
      taptapLogin: createAuthEndpoint('/taptap-mini/login', {
        method: 'POST', body: miniLoginRequestSchema, metadata: { scope: 'server' },
      }, async (ctx) => {
        const { openid } = await exchange(config, ctx.body.code);
        const key = { providerId: 'taptap-mini', accountId: `${config.appid}:${openid}` };
        const adapter = ctx.context.internalAdapter;
        let userId = (await adapter.findAccountByKey(key))?.userId;
        if (!userId) {
          try {
            // 无邮箱的提供方沿用 .invalid 身份邮箱约定；注册钩子初始化昵称和开房账户。
            const digest = createHash('sha256').update(key.accountId).digest('hex');
            const created = await adapter.createOAuthUser(
              { name: '', email: `tap-${digest}@taptap.invalid`, emailVerified: true }, key,
            );
            userId = created.user.id;
          } catch (error) {
            if (!isUniqueConflict(error)) throw error;
            const existing = await adapter.findAccountByKey(key);
            if (!existing) throw error;
            userId = existing.userId;
          }
        }
        const session = await adapter.createSession(userId);
        return ctx.json({ token: session.token });
      }),
      taptapLink: createAuthEndpoint('/taptap-mini/link', {
        method: 'POST', body: miniLoginRequestSchema, use: [sessionMiddleware], metadata: { scope: 'server' },
      }, async (ctx) => {
        const { openid } = await exchange(config, ctx.body.code);
        const key = { providerId: 'taptap-mini', accountId: `${config.appid}:${openid}` };
        const adapter = ctx.context.internalAdapter;
        const userId = ctx.context.session.user.id;
        const existing = await adapter.findAccountByKey(key);
        if (existing) {
          if (existing.userId !== userId) throw new APIError('CONFLICT', { code: 'TAPTAP_ACCOUNT_LINKED', message: '该 TapTap 账号已关联其他账号' });
          return ctx.json({ success: true });
        }
        try {
          await adapter.createAccount({ ...key, userId });
        } catch (error) {
          if (!isUniqueConflict(error)) throw error;
          const linked = await adapter.findAccountByKey(key);
          if (linked?.userId !== userId) throw new APIError('CONFLICT', { code: 'TAPTAP_ACCOUNT_LINKED', message: '该 TapTap 账号已关联其他账号' });
        }
        return ctx.json({ success: true });
      }),
    },
  };
}
