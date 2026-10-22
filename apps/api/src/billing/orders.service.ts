/**
 * 订单与赞助授权服务（docs/rebuild/05-OPERATIONS.md）。
 *
 * 支付结果处理铁律：回调验签 → 锁订单与授权账户 → 同事务写支付交易、订单状态、授权与流水
 * → 重复通知返回原结果。前端支付页回跳不发放权益，权益只来自服务端。
 */
import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  auditLogs,
  orders,
  paymentNotifications,
  paymentTransactions,
  productVersions,
  refunds,
  sponsorAccounts,
  sponsorGrants,
  sponsorLedger,
  sponsorProducts,
  type Tx,
} from '@jev/database';
import { DomainError, planMonthlyGrant } from '@jev/domain';
import { createWechatAdapter } from './wechat-pay.adapter.js';
import { createAlipayAdapter } from './alipay-pay.adapter.js';
import { PAY_CHANNELS, ONLINE_REFUND_CHANNELS, type PayAdapter, type PayChannel } from './pay-adapter.js';
import { app } from '../context.js';

const ORDER_TTL_MINUTES = 15;

@Injectable()
export class OrdersService {
  /**
   * 商品目录（首发价，单位分）：月度 600 = ¥6，永久 2000 = ¥20。
   * 这里的数字只在「该类型完全没有版本」时用于建第一个版本；
   * 之后改价走新版本（versionNo+1），已售版本不动。
   */
  private static readonly CATALOG: Array<{
    type: 'monthly' | 'lifetime';
    priceMinor: number;
    title: string;
  }> = [
    { type: 'monthly', priceMinor: 600, title: '月度会员' },
    { type: 'lifetime', priceMinor: 2000, title: '永久会员' },
  ];

  /** 按通道取适配器：凭据不齐返回 null（该通道收费入口保持关闭）。 */
  private adapter(channel: string): PayAdapter | null {
    const env = app().env as never;
    if (channel === 'wechat_native') return createWechatAdapter(env);
    if (channel === 'alipay') return createAlipayAdapter(env);
    return null;
  }

  /** 已开通的在线收款通道：前端据此展示哪些购买入口。 */
  availableChannels(): Array<{ channel: PayChannel; available: boolean; label: string }> {
    return [
      { channel: 'wechat_native', available: this.adapter('wechat_native') !== null, label: '微信支付' },
      { channel: 'alipay', available: this.adapter('alipay') !== null, label: '支付宝' },
    ];
  }

  /** 通道是否可用（下单前校验）。 */
  isChannelAvailable(channel: string): boolean {
    return (PAY_CHANNELS as readonly string[]).includes(channel) && this.adapter(channel) !== null;
  }

  /**
   * 商品目录：600 分月度 + 2000 分永久。
   *
   * 已售出的版本不可变（改价走新版本 versionNo+1），所以这里只做「补齐缺失的类型」，
   * 绝不改已有版本的价与标题。
   */
  async listProducts() {
    const db = app().db;
    await this.ensureCatalog();
    return db.db
      .select({
        productVersionId: productVersions.id,
        type: sponsorProducts.type,
        title: productVersions.title,
        priceMinor: productVersions.priceMinor,
        currency: productVersions.currency,
      })
      .from(productVersions)
      .innerJoin(sponsorProducts, eq(sponsorProducts.id, productVersions.productId))
      .where(and(eq(productVersions.available, true), eq(sponsorProducts.available, true)))
      .orderBy(desc(productVersions.priceMinor));
  }

  /**
   * 按类型幂等补齐商品目录。
   *
   * 为什么不是「表空时才插入」：那样老库里只要已经有月度、缺了永久，
   * 永久会员就永远不会出现在前台——玩家端只会看到 ¥6 那一项。
   *
   * 并发补齐要串行化：sponsor_products.type 上没有唯一约束，
   * 两个进程同时补会插出两条同类型商品行，前台就会显示两个「¥20 永久」。
   * 这里用事务级 advisory lock 把补齐过程串起来。
   */
  private async ensureCatalog(): Promise<void> {
    const db = app().db;

    // 快路径：目录已齐（每种类型都有 versionNo=1）就不开事务
    const snapshot = await db.db
      .select({ type: sponsorProducts.type, versionId: productVersions.id })
      .from(sponsorProducts)
      .leftJoin(
        productVersions,
        and(eq(productVersions.productId, sponsorProducts.id), eq(productVersions.versionNo, 1)),
      );
    const ready = new Set(snapshot.filter((r) => r.versionId).map((r) => r.type));
    if (OrdersService.CATALOG.every((item) => ready.has(item.type))) return;

    await db.tx(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(778899)`);
      for (const item of OrdersService.CATALOG) {
        const [product] = await tx
          .select({ id: sponsorProducts.id })
          .from(sponsorProducts)
          .where(eq(sponsorProducts.type, item.type))
          .limit(1);
        let productId = product?.id;
        if (!productId) {
          const [created] = await tx
            .insert(sponsorProducts)
            .values({ type: item.type })
            .returning({ id: sponsorProducts.id });
          productId = created!.id;
        }
        const [version] = await tx
          .select({ id: productVersions.id })
          .from(productVersions)
          .where(and(eq(productVersions.productId, productId), eq(productVersions.versionNo, 1)))
          .limit(1);
        if (!version) {
          await tx.insert(productVersions).values({
            productId,
            versionNo: 1,
            priceMinor: item.priceMinor,
            title: item.title,
            available: true,
          });
        }
      }
    });
  }

  /**
   * 创建订单：已有同商品同通道未过期 pending 订单时返回原单（防止重复下单重复收费）。
   * 通道未开通返回 PAYMENT_CHANNEL_UNAVAILABLE，收费入口保持关闭。
   */
  async createOrder(userId: string, productVersionId: string, channel: PayChannel = 'wechat_native') {
    const db = app().db;
    const adapter = this.adapter(channel);
    if (!adapter) throw new DomainError('PAYMENT_CHANNEL_UNAVAILABLE', '支付通道尚未开通');

    const [product] = await db.db.select().from(productVersions).where(eq(productVersions.id, productVersionId)).limit(1);
    if (!product || !product.available) throw new DomainError('NOT_FOUND', '商品不存在');

    const [pending] = await db.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          eq(orders.productVersionId, productVersionId),
          eq(orders.channel, channel),
          eq(orders.status, 'pending'),
          sql`expires_at > now()`,
        ),
      )
      .limit(1);
    if (pending) {
      const snapshot = pending.productSnapshot as { payUrl?: string | null; qrContent?: string | null; codeUrl?: string };
      return {
        orderId: pending.id,
        status: pending.status,
        payUrl: snapshot.payUrl ?? null,
        qrContent: snapshot.qrContent ?? snapshot.codeUrl ?? null,
      };
    }

    const merchantOrderNo = `JEV${Date.now()}${randomBytes(4).toString('hex').toUpperCase()}`;
    const notifyUrl = this.notifyUrlFor(channel);
    const [order] = await db.db
      .insert(orders)
      .values({
        userId,
        productVersionId,
        productSnapshot: { title: product.title, priceMinor: product.priceMinor, currency: product.currency },
        amountMinor: product.priceMinor,
        currency: product.currency,
        channel,
        merchantOrderNo,
        expiresAt: new Date(Date.now() + ORDER_TTL_MINUTES * 60_000),
      })
      .returning({ id: orders.id });

    // 下单在外部完成：失败时订单保持 pending，由关单任务核销；重试沿用同一商户单号
    const pay = await adapter.createOrder({
      merchantOrderNo,
      amountMinor: product.priceMinor,
      description: product.title,
      notifyUrl,
    });
    await db.db
      .update(orders)
      .set({
        productSnapshot: {
          title: product.title,
          priceMinor: product.priceMinor,
          currency: product.currency,
          payUrl: pay.payUrl,
          qrContent: pay.qrContent,
        },
      })
      .where(eq(orders.id, order!.id));
    return { orderId: order!.id, status: 'pending' as const, payUrl: pay.payUrl, qrContent: pay.qrContent };
  }

  /**
   * 通知地址：优先用通道自己配置的回调地址（必须公网可达且已备案域名），
   * 没配就从 PUBLIC_BASE_URL 拼。
   */
  private notifyUrlFor(channel: PayChannel): string {
    const env = app().env as { WECHAT_PAY_NOTIFY_URL?: string; ALIPAY_NOTIFY_URL?: string; PUBLIC_BASE_URL: string };
    const configured = channel === 'alipay' ? env.ALIPAY_NOTIFY_URL : env.WECHAT_PAY_NOTIFY_URL;
    if (configured) return configured;
    return new URL(`/api/v1/payments/${channel}/notify`, env.PUBLIC_BASE_URL).toString();
  }

  async getOrder(userId: string, orderId: string) {
    const db = app().db;
    const [order] = await db.db
      .select({
        orderId: orders.id,
        userId: orders.userId,
        status: orders.status,
        channel: orders.channel,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        title: productVersions.title,
        merchantOrderNo: orders.merchantOrderNo,
        expiresAt: orders.expiresAt,
        createdAt: orders.createdAt,
        snapshot: orders.productSnapshot,
      })
      .from(orders)
      .innerJoin(productVersions, eq(productVersions.id, orders.productVersionId))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order || order.userId !== userId) throw new DomainError('NOT_FOUND', '订单不存在');
    const snapshot = order.snapshot as { payUrl?: string | null; qrContent?: string | null; codeUrl?: string };
    return {
      orderId: order.orderId,
      status: order.status,
      channel: order.channel,
      amountMinor: order.amountMinor,
      currency: order.currency,
      title: order.title,
      payUrl: snapshot.payUrl ?? null,
      qrContent: snapshot.qrContent ?? snapshot.codeUrl ?? null,
      expiresAt: order.expiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(),
    };
  }

  /**
   * 支付成功核销（回调与查单共用）：同事务写交易、订单 paid、授权与流水；重复调用幂等。
   */
  async confirmPaid(channel: string, merchantOrderNo: string, transactionId: string): Promise<void> {
    const db = app().db;
    await db.tx((tx) => this.confirmPaidTx(tx, channel, merchantOrderNo, transactionId));
  }

  /**
   * 同事务核销：供需要把「核销」与其它写入合并进同一事务的场景复用
   * （赞助码兑换：码状态流转与授权发放必须同生共死）。
   *
   * 幂等性：订单已是 paid/refunded/refund_pending 时直接返回，不重复发授权。
   */
  async confirmPaidTx(tx: Tx, channel: string, merchantOrderNo: string, transactionId: string): Promise<void> {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.merchantOrderNo, merchantOrderNo))
      .for('update')
      .limit(1);
    if (!order) throw new Error(`支付核销找不到订单：${merchantOrderNo}`);
    if (order.status === 'paid' || order.status === 'refunded' || order.status === 'refund_pending') return;

    await tx.insert(paymentTransactions).values({
      channel: channel as (typeof paymentTransactions.$inferInsert)['channel'],
      transactionId,
      orderId: order.id,
      amountMinor: order.amountMinor,
      currency: order.currency,
      success: true,
    });

    const [product] = await tx.select().from(productVersions).where(eq(productVersions.id, order.productVersionId)).limit(1);
    const productIdRow = product
      ? await tx.select({ type: sponsorProducts.type }).from(sponsorProducts).where(eq(sponsorProducts.id, product.productId)).limit(1)
      : [];
    const type = productIdRow[0]?.type;
    if (!type) throw new Error(`订单商品类型缺失：${order.id}`);

    // 锁授权账户
    await tx.select().from(sponsorAccounts).where(eq(sponsorAccounts.userId, order.userId)).for('update');
    const grants = await tx.select().from(sponsorGrants).where(eq(sponsorGrants.userId, order.userId));
    const now = new Date();
    let effectiveFrom = now;
    let effectiveUntil: Date | null = null;
    let rebaseAnchor = false;

    if (type === 'monthly') {
      const plan = planMonthlyGrant(now, (await tx.select().from(sponsorAccounts).where(eq(sponsorAccounts.userId, order.userId)).limit(1))[0]?.monthlyAnchor ?? null, grants);
      effectiveFrom = plan.effectiveFrom;
      effectiveUntil = plan.effectiveUntil;
      rebaseAnchor = plan.rebaseAnchor;
    } else if (type === 'lifetime') {
      const [alreadyLifetime] = await tx
        .select({ id: sponsorGrants.id })
        .from(sponsorGrants)
        .where(and(eq(sponsorGrants.userId, order.userId), eq(sponsorGrants.type, 'lifetime'), eq(sponsorGrants.status, 'active'), sql`effective_until is null`))
        .limit(1);
      if (alreadyLifetime) {
        // 并发完成造成的重复永久购买：登记待退款，不静默吞款
        await tx.insert(sponsorLedger).values({
          userId: order.userId,
          action: 'grant',
          orderId: order.id,
          detail: { issue: 'duplicate_lifetime_pending_refund' },
          idempotencyKey: `dup-lifetime:${order.id}`,
        });
      }
    }

    const [account] = await tx.select().from(sponsorAccounts).where(eq(sponsorAccounts.userId, order.userId)).limit(1);
    if (type === 'monthly' && (!account?.monthlyAnchor || rebaseAnchor)) {
      await tx
        .insert(sponsorAccounts)
        .values({ userId: order.userId, monthlyAnchor: effectiveFrom })
        .onConflictDoUpdate({ target: sponsorAccounts.userId, set: { monthlyAnchor: effectiveFrom, updatedAt: now } });
    }

    await tx.insert(sponsorGrants).values({
      userId: order.userId,
      orderId: order.id,
      type,
      status: 'active',
      effectiveFrom,
      effectiveUntil,
    });
    await tx.insert(sponsorLedger).values({
      userId: order.userId,
      action: 'grant',
      orderId: order.id,
      detail: { type, effectiveFrom: effectiveFrom.toISOString(), effectiveUntil: effectiveUntil?.toISOString() ?? null },
      idempotencyKey: `grant:${order.id}`,
    });
    await tx.update(orders).set({ status: 'paid', paidAt: now, updatedAt: now }).where(eq(orders.id, order.id));
    await tx.insert(auditLogs).values({
      action: 'order.paid',
      objectType: 'order',
      objectId: order.id,
      afterSummary: { transactionId, amountMinor: order.amountMinor, channel },
      relatedRequestId: randomUUID(),
    });
  }

  /**
   * 退款：事务内先冻结授权并登记退款单，事务外再调通道退款。
   *
   * 通道退款成功 → 撤销授权、订单置 refunded；失败 → 退款单置 failed，
   * 授权保持冻结等人工跟进（不静默当成已退钱）。
   *
   * 赞助码等线下收款通道没有「线上退款」这一步（钱是线下收的），
   * 由运营方线下退钱，站内直接撤销权益——不能停在 frozen 让用户永久失去权益。
   *
   * 反过来，在线通道如果因为凭据被移除而拿不到适配器，钱是**还没退**的，
   * 必须按失败处理，绝不能当成「无线上退款步骤」把权益撤了。
   *
   * 退款只在后台提供（POST /admin/orders/:id/refund），玩家端没有退款入口。
   */
  async refundOrder(
    orderId: string,
    reason: string,
    operatorUserId: string,
  ): Promise<{ refundId: string; refundNo: string; channelRefund: 'done' | 'failed' | 'not_applicable' }> {
    const db = app().db;

    const prepared = await db.tx(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
      if (!order) throw new DomainError('NOT_FOUND', '订单不存在');
      if (order.status !== 'paid') throw new DomainError('ORDER_STATE_CONFLICT', '只有已支付订单可以退款');

      const refundNo = `RF${Date.now()}${randomBytes(4).toString('hex').toUpperCase()}`;
      const [refund] = await tx
        .insert(refunds)
        .values({
          orderId,
          refundNo,
          amountMinor: order.amountMinor,
          reason,
          status: 'pending',
          entitlementStatus: 'frozen',
          approvedBy: operatorUserId,
        })
        .returning({ id: refunds.id });
      await tx.update(orders).set({ status: 'refund_pending', updatedAt: new Date() }).where(eq(orders.id, orderId));
      // 冻结该订单授权：不再用于新开房
      await tx
        .update(sponsorGrants)
        .set({ status: 'frozen' })
        .where(and(eq(sponsorGrants.orderId, orderId), eq(sponsorGrants.status, 'active')));
      await tx.insert(sponsorLedger).values({
        userId: order.userId,
        action: 'freeze',
        orderId,
        detail: { refundNo },
        idempotencyKey: `freeze:${refundNo}`,
      });
      await tx.insert(auditLogs).values({
        operatorUserId,
        action: 'order.refund_approve',
        objectType: 'order',
        objectId: orderId,
        reason,
      });
      return {
        refundId: refund!.id,
        refundNo,
        channel: order.channel,
        merchantOrderNo: order.merchantOrderNo,
        amountMinor: order.amountMinor,
        userId: order.userId,
      };
    });

    // 事务外调通道退款
    const adapter = this.adapter(prepared.channel);
    let channelRefund: 'done' | 'failed' | 'not_applicable' = 'not_applicable';
    if (adapter) {
      try {
        await adapter.refund({
          refundNo: prepared.refundNo,
          merchantOrderNo: prepared.merchantOrderNo,
          amountMinor: prepared.amountMinor,
          reason,
        });
        channelRefund = 'done';
      } catch (error) {
        channelRefund = 'failed';
        console.error(`[orders] 通道退款失败 ${prepared.merchantOrderNo}`, error);
      }
    } else if (ONLINE_REFUND_CHANNELS.has(prepared.channel)) {
      // 在线通道但拿不到适配器（凭据被移除或未配齐）：钱还没退，绝不能当成已完成，
      // 否则会出现「用户付了钱、权益被撤销、通道那边一分没退」。按失败处理，等人工跟进。
      channelRefund = 'failed';
      console.error(`[orders] 通道 ${prepared.channel} 无可用适配器，退款需人工处理 ${prepared.merchantOrderNo}`);
    }

    if (channelRefund === 'done' || channelRefund === 'not_applicable') {
      // done：线上通道已退款。
      // not_applicable：赞助码等线下收款通道没有线上退款步骤，钱由运营方线下退，
      // 站内直接撤销权益——不能停在 frozen 让用户永久失去权益。
      await db.tx(async (tx) => {
        await tx.update(refunds).set({ status: 'refunded', entitlementStatus: 'revoked', updatedAt: new Date() }).where(eq(refunds.id, prepared.refundId));
        await tx.update(orders).set({ status: 'refunded', updatedAt: new Date() }).where(eq(orders.id, orderId));
        await tx.update(sponsorGrants).set({ status: 'revoked' }).where(and(eq(sponsorGrants.orderId, orderId), eq(sponsorGrants.status, 'frozen')));
        await tx.insert(sponsorLedger).values({
          userId: prepared.userId,
          action: 'revoke',
          orderId,
          detail: { refundNo: prepared.refundNo },
          idempotencyKey: `revoke:${prepared.refundNo}`,
        });
        await tx.insert(auditLogs).values({
          operatorUserId,
          action: 'order.refund_done',
          objectType: 'order',
          objectId: orderId,
          afterSummary: { refundNo: prepared.refundNo, channel: prepared.channel },
          relatedRequestId: randomUUID(),
        });
      });
    } else if (channelRefund === 'failed') {
      // 钱没退回去：授权保持冻结，订单留在 refund_pending，等人工跟进
      await db.db.update(refunds).set({ status: 'failed', updatedAt: new Date() }).where(eq(refunds.id, prepared.refundId));
    }

    return { refundId: prepared.refundId, refundNo: prepared.refundNo, channelRefund };
  }

  /**
   * 支付回调：验签在适配器内完成，通知记录与幂等在这里。
   *
   * 金额校验：通知里带的金额必须与订单金额一致，否则拒绝入账
   * （通道没带金额时跳过，微信/支付宝正常通知都会带）。
   */
  async handleNotification(
    channel: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<{ contentType: 'application/json' | 'text/plain'; body: string }> {
    const db = app().db;
    const adapter = this.adapter(channel);
    if (!adapter) return { contentType: 'text/plain', body: 'fail' };
    let verified: { merchantOrderNo: string; transactionId: string; success: boolean; notificationId: string; amountMinor: number | null };
    try {
      verified = adapter.verifyNotification({ headers, rawBody });
    } catch (error) {
      console.error(`[orders] ${channel} 回调验签失败`, error);
      return { contentType: 'text/plain', body: 'fail' };
    }

    const createHash = (await import('node:crypto')).createHash;
    await db.db
      .insert(paymentNotifications)
      .values({
        channel: channel as (typeof paymentNotifications.$inferInsert)['channel'],
        notificationId: verified.notificationId,
        payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
        verifyResult: 'ok',
        handleResult: verified.success ? 'confirm' : 'ignored',
      })
      .onConflictDoNothing();

    if (verified.success) {
      if (verified.amountMinor !== null) {
        const [order] = await db.db
          .select({ amountMinor: orders.amountMinor })
          .from(orders)
          .where(eq(orders.merchantOrderNo, verified.merchantOrderNo))
          .limit(1);
        if (order && order.amountMinor !== verified.amountMinor) {
          // 金额对不上：登记通知但不入账，等人工/关单任务处理
          console.error(
            `[orders] ${channel} 回调金额不符：订单 ${order.amountMinor} 分，通知 ${verified.amountMinor} 分（单号 ${verified.merchantOrderNo}）`,
          );
          return { contentType: 'text/plain', body: 'fail' };
        }
      }
      await this.confirmPaid(channel, verified.merchantOrderNo, verified.transactionId);
    }
    return adapter.notifyAck();
  }

  /** 关单任务：过期 pending/closing 订单先查单再关闭（防止先支付后超时的竞争）。 */
  async sweepExpiredOrders(): Promise<void> {
    const db = app().db;
    const expired = await db.db
      .select()
      .from(orders)
      .where(and(sql`status in ('pending','closing')`, sql`expires_at < now()`))
      .limit(50);
    for (const order of expired) {
      // 按订单自己的通道取适配器：不同通道的关单接口不一样
      const adapter = this.adapter(order.channel);
      if (!adapter) continue;
      try {
        const remote = await adapter.queryOrder(order.merchantOrderNo);
        if (remote.status === 'success' && remote.transactionId) {
          await this.confirmPaid(order.channel, order.merchantOrderNo, remote.transactionId);
          continue;
        }
        await adapter.closeOrder(order.merchantOrderNo);
        await db.db.update(orders).set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, order.id));
      } catch (error) {
        console.error(`[orders] 关单失败 ${order.merchantOrderNo}`, error);
      }
    }
  }
}
