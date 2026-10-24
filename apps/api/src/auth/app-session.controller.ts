/**
 * App OAuth 会话交接：随机短期 code 绑定本机 verifier 摘要，数据库原子消费一次。
 * 系统浏览器仅传递摘要；真正的 verifier 保留在发起登录的 App 私有存储中。
 */
import { Controller, Get, Post, Body, HttpCode, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSessionCookie } from 'better-auth/cookies';
import { and, eq, gt, like, lte } from 'drizzle-orm';
import { profiles, verification } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import { Anonymous, Public } from '../common/public.js';
import { ZodValidationPipe } from '../common/http.js';
import { appSessionChallengeSchema, appSessionExchangeRequestSchema } from '@jev/contracts';
import type { z } from 'zod';

const APP_OAUTH_DEEPLINK = 'cn.xiaobaozi.sp:/oauth';
const HANDOFF_PREFIX = 'jev-app-handoff:';

/** 深链 next 只接受站内相对路径。 */
function safeNext(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

/** code 的散列与本机摘要共同定位记录，错误 verifier 无法消费合法 code。 */
function identifierOf(code: string, challenge: string): string {
  return `${HANDOFF_PREFIX}${createHash('sha256').update(code).digest('hex')}:${challenge}`;
}

@Controller('app-session')
export class AppSessionController {
  /** 验证浏览器会话后签发 60 秒交接码，支持 Better Auth 的安全 Cookie 名。 */
  @Public()
  @Get('handoff')
  async handoff(
    @Req() req: Request,
    @Res() res: Response,
    @Query('challenge', new ZodValidationPipe(appSessionChallengeSchema)) challenge: string,
    @Query('next') next?: string,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const callback = new URL(APP_OAUTH_DEEPLINK);
    callback.searchParams.set('state', challenge);
    callback.searchParams.set('next', safeNext(next));
    const headers = new Headers({ cookie: req.headers.cookie ?? '' });
    const auth = await app().auth.api.getSession({ headers });
    const token = getSessionCookie(headers);
    const [profile] = auth ? await app().db.db.select({ status: profiles.status }).from(profiles)
      .where(eq(profiles.userId, auth.user.id)).limit(1) : [];
    if (!auth || !token || profile?.status !== 'active') {
      callback.searchParams.set('error', 'unauthenticated');
      res.redirect(302, callback.toString());
      return;
    }
    const now = new Date();
    await app().db.db.delete(verification).where(and(
      like(verification.identifier, `${HANDOFF_PREFIX}%`), lte(verification.expiresAt, now),
    ));
    const code = randomBytes(32).toString('base64url');
    await app().db.db.insert(verification).values({
      id: randomUUID(), identifier: identifierOf(code, challenge), value: token,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    callback.searchParams.set('code', code);
    res.redirect(302, callback.toString());
  }

  /** 正确 verifier、有效期和单次消费同时成立才返回会话令牌。 */
  @Anonymous()
  @HttpCode(200)
  @Post('exchange')
  async exchange(
    @Body(new ZodValidationPipe(appSessionExchangeRequestSchema)) body: z.infer<typeof appSessionExchangeRequestSchema>,
  ): Promise<{ token: string }> {
    const challenge = createHash('sha256').update(body.verifier).digest('base64url');
    const [consumed] = await app().db.db.delete(verification).where(and(
      eq(verification.identifier, identifierOf(body.code, challenge)),
      gt(verification.expiresAt, new Date()),
    )).returning({ token: verification.value });
    if (!consumed) throw new DomainError('UNAUTHORIZED', '回流凭证无效或已过期，请重新登录');
    return { token: consumed.token };
  }
}
