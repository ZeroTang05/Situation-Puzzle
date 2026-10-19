/** 赞助与订单 HTTP 接口；支付回调使用原始请求体（bootstrap 中已挂 raw 解析）。 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { freeRoomAccounts, sponsorGrants } from '@jev/database';
import { freeRoomsRemaining, hasActiveSponsorship } from '@jev/domain';
import { app } from '../context.js';
import { CurrentUser, type SessionUser, ZodValidationPipe } from '../common/http.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OrdersService } from './orders.service.js';
import { RedeemCodesService } from './redeem-codes.service.js';
import { orderCreateRequestSchema, redeemCodeRequestSchema } from '@jev/contracts';
import { z } from 'zod';

@Controller()
@UseGuards(SessionGuard)
export class BillingController {
  // tsx(esbuild) 不生成参数类型元数据：显式 @Inject 声明依赖令牌
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(RedeemCodesService) private readonly redeemCodesService: RedeemCodesService,
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
   * 微信支付需要商户资质（未开通时 available=false），赞助码零资质始终可用。
   */
  @Get('payment-channels')
  channels() {
    const wechatReady = this.ordersService.hasWechatChannel();
    return {
      channels: [
        { channel: 'wechat_native' as const, available: wechatReady, label: '微信支付' },
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
    return this.ordersService.createOrder(user.userId, body.productVersionId);
  }

  @Get('orders/:id')
  async order(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.ordersService.getOrder(user.userId, id);
  }

  /** 支付回调：无会话；原始请求体验签（bootstrap 以 express.raw 挂载）。 */
  @Post('payments/:channel/notify')
  @HttpCode(200)
  async notify(@Param('channel') channel: string, @Req() request: Request, @Res() response: Response) {
    const result = await this.ordersService.handleNotification(
      channel,
      request.headers as Record<string, string | string[] | undefined>,
      request.body as Buffer,
    );
    // 微信 v3 要求应答 JSON 体
    response.type('application/json').send(JSON.stringify({ code: result.code }));
  }
}
