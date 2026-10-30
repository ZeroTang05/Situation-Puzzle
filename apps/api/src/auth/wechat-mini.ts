/**
 * 微信小程序一键登录（docs/rebuild/20-MINIPROGRAM.md）：
 * 客户端 wx.login 拿到 5 分钟临时 code → POST /auth/wechat-mini/login →
 * 服务端调 code2session（AppSecret 只在服务端）换 openid →
 * 按 (providerId='wechat-mini', accountId=openid) 找账号；没有就建号
 * （占位邮箱沿用 LINUX DO 的 *.invalid 约定，昵称走注册钩子的「用户+随机编号」，
 * 注册礼/免费账户/赞助账户钩子照常生效）→ 建会话，令牌放响应体。
 * 小程序没有 Cookie，拿 Bearer 令牌自己存（与 App 壳 Bearer 链路同约定）。
 * session_key 不落库：本站不解密微信侧数据，不保管高敏凭据。
 * unionid 当前不存：站内只有小程序一个微信入口，openid 已唯一；
 * 将来接公众号/网站微信登录时再引入 unionid 列做跨端身份合并。
 */
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { z } from 'zod';

/** code2session 的成功负载；errcode/errmsg 见 parseCode2Session */
export interface Code2SessionResult {
  openid: string;
  unionid?: string;
  session_key?: string;
}

/** 微信错误码 → 稳定错误码 + 人话信息（客户端 displayAuthError 再按语言翻译） */
export function parseCode2Session(payload: unknown): Code2SessionResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new APIError('BAD_REQUEST', { code: 'WECHAT_LOGIN_FAILED', message: '微信登录失败，请重试' });
  }
  const body = payload as { openid?: unknown; unionid?: unknown; session_key?: unknown; errcode?: unknown; errmsg?: unknown };
  const errcode = typeof body.errcode === 'number' ? body.errcode : 0;
  if (errcode !== 0) {
    // 40029/40126 code 无效或已使用：让用户重走一次 wx.login；45011/-1 是微信侧限流或繁忙
    const busy = errcode === 45011 || errcode === -1;
    throw new APIError('BAD_REQUEST', {
      code: busy ? 'WECHAT_LOGIN_BUSY' : 'WECHAT_LOGIN_FAILED',
      message: busy ? '微信登录繁忙，请稍后重试' : '微信登录凭证无效，请重新登录',
    });
  }
  if (typeof body.openid !== 'string' || body.openid.length === 0) {
    // 成功负载缺 openid 属协议异常：不编造身份，直接失败
    throw new APIError('BAD_REQUEST', { code: 'WECHAT_LOGIN_FAILED', message: '微信登录响应异常，请重试' });
  }
  return {
    openid: body.openid,
    ...(typeof body.unionid === 'string' && body.unionid.length > 0 && { unionid: body.unionid }),
    ...(typeof body.session_key === 'string' && { session_key: body.session_key }),
  };
}

/** 调微信 code2session：直连 api.weixin.qq.com（服务器在境内，无需中继） */
async function fetchCode2Session(appid: string, secret: string, code: string): Promise<unknown> {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', appid);
  url.searchParams.set('secret', secret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new APIError('SERVICE_UNAVAILABLE', { code: 'WECHAT_LOGIN_BUSY', message: '微信登录暂时不可用，请稍后重试' });
  }
  if (!res.ok) throw new APIError('SERVICE_UNAVAILABLE', { code: 'WECHAT_LOGIN_BUSY', message: '微信登录暂时不可用，请稍后重试' });
  return res.json();
}

/** 小程序登录插件：只在 WECHAT_MINI_APPID / WECHAT_MINI_SECRET 配齐时注册 */
export function wechatMiniPlugin(config: { appid: string; secret: string }): BetterAuthPlugin {
  return {
    id: 'wechat-mini',
    endpoints: {
      login: createAuthEndpoint(
        '/wechat-mini/login',
        {
          method: 'POST',
          body: z.object({ code: z.string().min(1) }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const session_result = await fetchCode2Session(config.appid, config.secret, ctx.body.code);
          const { openid } = parseCode2Session(session_result);
          const accountKey = { providerId: 'wechat-mini', accountId: openid } as const;
          const adapter = ctx.context.internalAdapter;
          let userId = (await adapter.findAccountByKey(accountKey))?.userId;
          if (!userId) {
            try {
              // 占位邮箱按 openid 唯一：昵称传空串，注册钩子补「用户+随机编号」
              const created = await adapter.createOAuthUser(
                { name: '', email: `wx-${openid}@wechat.invalid`, emailVerified: true },
                { ...accountKey },
              );
              userId = created.user.id;
            } catch (error) {
              // 并发双击撞唯一索引：重查一次拿已有账号，仍拿不到才向上抛
              const existing = await adapter.findAccountByKey(accountKey);
              if (!existing) throw error;
              userId = existing.userId;
            }
          }
          const session = await adapter.createSession(userId);
          return ctx.json({ token: session.token });
        },
      ),
    },
  };
}
