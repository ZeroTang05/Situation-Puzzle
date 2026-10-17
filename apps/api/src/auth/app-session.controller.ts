/**
 * App 壳 OAuth 回流的会话交接（docs/rebuild/13-APP-VERSION.md §5、M2）。
 *
 * 系统（浏览）器里完成 OAuth 后，会话 Cookie 落在系统浏览器的 Cookie 罐里，
 * App 的 WebView 拿不到。链条：
 *   1. App 发起 OAuth 时把 callbackURL 指到本控制器 handoff（https 站内地址）；
 *   2. 系统浏览器带着刚设置的会话 Cookie GET handoff → 换 60 秒一次性 code，
 *      302 到 App 自定义 scheme（cn.xiaobaozi.sp:/oauth，包名拍板后不可改故写死）；
 *   3. Android 以深链唤起 App，App 用 code 调 exchange 换回 Bearer 令牌存本地。
 * code 是 jose HS256 签名的短期令牌（载荷含会话令牌本身），无服务端状态、不可伪造。
 */
import { Controller, Get, Post, Body, HttpCode, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { Anonymous, Public } from '../common/public.js';
import { ZodValidationPipe } from '../common/http.js';
import { appSessionExchangeRequestSchema } from '@jev/contracts';
import type { z } from 'zod';

/** better-auth 默认会话 Cookie 名（bearer 令牌 = 该 Cookie 的完整值 token.signature） */
const SESSION_COOKIE = 'better-auth.session_token';
/** App 深链回调地址：与 AndroidManifest 的 intent-filter 对应 */
const APP_OAUTH_DEEPLINK = 'cn.xiaobaozi.sp:/oauth';
const ISSUER = 'jev-app-oauth';

/** 深链回 App 的 next 只接受站内相对路径（以单个 / 开头），防借深链做跳转 */
function safeNext(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

@Controller('app-session')
export class AppSessionController {
  private secret(): Uint8Array {
    return new TextEncoder().encode(app().env.AUTH_SECRET);
  }

  /**
   * 会话交接：系统浏览器持 Cookie 访问，签发一次性 code 后 302 回 App。
   * 未登录（无 Cookie）也走 302，带 error 参数让 App 端给出可读提示。
   */
  @Public()
  @Get('handoff')
  async handoff(@Req() req: Request, @Res() res: Response, @Query('next') next?: string) {
    const cookieHeader = req.headers.cookie ?? '';
    const sessionCookie = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    const target = safeNext(next);
    if (!sessionCookie) {
      res.redirect(302, `${APP_OAUTH_DEEPLINK}?error=unauthenticated&next=${encodeURIComponent(target)}`);
      return;
    }
    const token = sessionCookie.slice(SESSION_COOKIE.length + 1);
    const code = await new SignJWT({ t: token })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(this.secret());
    res.redirect(302, `${APP_OAUTH_DEEPLINK}?code=${encodeURIComponent(code)}&next=${encodeURIComponent(target)}`);
  }

  /** App 端用一次性 code 换回 Bearer 令牌；过期或伪造直接失败，不编造会话。 */
  @Anonymous()
  @HttpCode(200)
  @Post('exchange')
  async exchange(
    @Body(new ZodValidationPipe(appSessionExchangeRequestSchema)) body: z.infer<typeof appSessionExchangeRequestSchema>,
  ): Promise<{ token: string }> {
    try {
      const { payload } = await jwtVerify(body.code, this.secret(), { issuer: ISSUER });
      if (typeof payload.t !== 'string' || payload.t.length === 0) throw new Error('载荷缺少令牌');
      return { token: payload.t };
    } catch {
      throw new DomainError('UNAUTHORIZED', '回流凭证无效或已过期，请重新登录');
    }
  }
}
