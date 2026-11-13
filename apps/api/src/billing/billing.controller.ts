/** 赞助与订单 HTTP 接口；支付回调使用原始请求体（bootstrap 中已挂 raw 解析）。 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { freeRoomAccounts, sponsorGrants } from '@jev/database';
import { freeRoomsRemaining, hasActiveSponsorship } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { Public } from '../common/public.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OrdersService } from './orders.service.js';
import { RedeemCodesService } from './redeem-codes.service.js';
import { RoomBonusService } from './room-bonus.service.js';
import { adIntentResponseSchema, inviteClaimRequestSchema, orderCreateRequestSchema, redeemCodeRequestSchema } from '@jev/contracts';
import { z } from 'zod';

@Controller()
@UseGuards(SessionGuard)
export class BillingController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(RedeemCodesService) private readonly redeemCodesService: RedeemCodesService,
    @Inject(RoomBonusService) private readonly roomBonusService: RoomBonusService,
  ) {}

  /** 当前赞助状态与免费开房余量。 */
  @Get('sponsorship')
  async sponsorship(@CurrentUser() user: SessionUser) {
    const context = app();
    const [grants, freeRows] = await Promise.all([
      context.db.db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, user.userId)),
      context.db.db.select().from(freeRoomAccounts).where(eq(freeRoomAccounts.userId, user.userId)).limit(1),
    ]);
    const now = new Date();
    const monthlyActive = grants
      .filter((g) => g.type === 'monthly' && g.status === 'active' && g.effectiveUntil && g.effectiveUntil > now)
      .map((g) => g.effectiveUntil!)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const free = freeRows[0];
    return {
      monthlyUntil: monthlyActive?.toISOString() ?? null,
      lifetime: grants.some((g) => g.type === 'lifetime' && g.status === 'active' && g.effectiveUntil === null),
      sponsored: hasActiveSponsorship(grants, now),
      freeRooms: free
        ? { total: free.total, remaining: freeRoomsRemaining(free), consumed: free.consumed, reserved: free.reserved }
        : { total: 10, remaining: 0, consumed: 0, reserved: 0 },
    };
  }

  @Get('sponsor-products')
  products() {
    return this.ordersService.listProducts();
  }

  /**
   * 可用收款通道：前端据此决定展示哪些购买入口。
   * 微信支付/支付宝需要商户资质（凭据未配齐时 available=false），
   * 赞助码零资质始终可用。
   */
  @Get('payment-channels')
  channels() {
    return {
      channels: [
        ...this.ordersService.availableChannels(),
        { channel: 'redeem_code' as const, available: true, label: '兑换码' },
      ],
    };
  }

  /** 兑换赞助码：核销与发授权同事务完成，权益只来自服务端。 */
  @Post('orders/redeem')
  async redeem(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(redeemCodeRequestSchema)) body: z.infer<typeof redeemCodeRequestSchema>,
  ) {
    return this.redeemCodesService.redeem(user.userId, body.code);
  }

  @Post('orders')
  async createOrder(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(orderCreateRequestSchema)) body: z.infer<typeof orderCreateRequestSchema>,
  ) {
    return this.ordersService.createOrder(user.userId, body.productVersionId, body.channel);
  }

  @Get('orders/:id')
  async order(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.ordersService.getOrder(user.userId, id);
  }

  /**
   * 支付回调：无会话；原始请求体验签（bootstrap 以 express.raw 挂载）。
   * 应答体按通道要求不同——微信要 JSON，支付宝要纯文本 success。
   *
   * 必须标 @Public()：控制器类上有 @UseGuards(SessionGuard)，而支付平台不会带
   * 我们的会话 Cookie。少了这一行，异步通知会在进 handler 前就被守卫 401 掉，
   * 权益永远发不出去（曾真实发生过，勿删）。
   *
   * 限流按客户端 IP、每分钟 120 次：每次通知都要做一次验签（支付宝 RSA2 / 微信平台公钥解密），
   * 这是通知接口唯一的 CPU 开销，必须挡住刷量。超限返回 429，两个平台都会按失败重试。
   */
  @RateLimit({ scope: 'payments.notify', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Public()
  @Post('payments/:channel/notify')
  @HttpCode(200)
  async notify(@Param('channel') channel: string, @Req() request: Request, @Res() response: Response) {
    const result = await this.ordersService.handleNotification(
      channel,
      request.headers as Record<string, string | string[] | undefined>,
      request.body as Buffer,
    );
    response.type(result.contentType).send(result.body);
  }

  // ---------- 奖励额度（广告 / 邀请，docs/rebuild/21-MONETIZATION-REVISION.md） ----------

  /** 看广告前置：换 5 分钟意图令牌，加载广告时作为 out_return_no 透传给微信。 */
  @RateLimit({ scope: 'ads.intent', limit: 30, windowSeconds: 3600, keyBy: 'user' })
  @Post('ads/intent')
  @HttpCode(200)
  async adIntent(@CurrentUser() user: SessionUser): Promise<z.infer<typeof adIntentResponseSchema>> {
    return this.roomBonusService.issueAdIntent(user.userId);
  }

  /**
   * 微信激励视频服务端验证回调：无会话（微信服务器 GET）。
   * 首次配置 URL 时微信带 echostr 校验，原样返回；奖励通知验签通过后发 +2 开房次数。
   * 必须标 @Public()，理由同支付回调。
   */
  @RateLimit({ scope: 'ads.notify', limit: 120, windowSeconds: 60, keyBy: 'ip' })
  @Public()
  @Get('ads/wechat/notify')
  async wechatAdNotify(@Query() query: Record<string, string | undefined>, @Res() response: Response) {
    const result = await this.roomBonusService.handleWechatAdCallback(query);
    if (result.echostr !== undefined) {
      response.type('text/plain').send(result.echostr);
      return;
    }
    response.json({ errcode: result.errcode, errmsg: result.errmsg });
  }

  /** 领取邀请奖励：被邀请人凭邀请链接里的 code 调用，奖励 +5 发给邀请人。 */
  @RateLimit({ scope: 'invites.claim', limit: 10, windowSeconds: 3600, keyBy: 'user' })
  @Post('invites/claim')
  async inviteClaim(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(inviteClaimRequestSchema)) body: z.infer<typeof inviteClaimRequestSchema>,
  ) {
    return this.roomBonusService.claimInviteBonus(user.userId, body.code);
  }
}
