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
  sponsorAccounts,
  sponsorGrants,
  sponsorLedger,
  sponsorProducts,
} from '@jev/database';
import { DomainError, planMonthlyGrant } from '@jev/domain';
import { createWechatAdapter, type PayAdapter } from './wechat-pay.adapter.js';
import { app } from '../context.js';

const ORDER_TTL_MINUTES = 15;

@Injectable()
export class OrdersService {
  private adapter(): PayAdapter | null {
    return createWechatAdapter(app().env as never);
  }

  /** 商品目录：幂等初始化 600 分月度与 2000 分永久（已售版本不可变，改价走新版本）。 */
  async listProducts() {
    const db = app().db;
    const existing = await db.db.select().from(productVersions).innerJoin(sponsorProducts, eq(sponsorProducts.id, productVersions.productId));
    if (existing.length === 0) {
      const [monthly] = await db.db.insert(sponsorProducts).values({ type: 'monthly' }).returning();
      const [lifetime] = await db.db.insert(sponsorProducts).values({ type: 'lifetime' }).returning();
      await db.db.insert(productVersions).values([
        { productId: monthly!.id, versionNo: 1, priceMinor: 600, title: '月度赞助', available: true },
        { productId: lifetime!.id, versionNo: 1, priceMinor: 2000, title: '永久赞助', available: true },
      ]);
    }
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
   * 创建订单：已有同商品未过期 pending 订单时返回原单（防止重复下单重复收费）。
   * 通道未开通返回 PAYMENT_CHANNEL_UNAVAILABLE，收费入口保持关闭。
   */
  async createOrder(userId: string, productVersionId: string) {
    const db = app().db;
    const adapter = this.adapter();
    if (!adapter) throw new DomainError('PAYMENT_CHANNEL_UNAVAILABLE', '支付通道尚未开通');

    const [product] = await db.db.select().from(productVersions).where(eq(productVersions.id, productVersionId)).limit(1);
    if (!product || !product.available) throw new DomainError('NOT_FOUND', '商品不存在');

    const [pending] = await db.db
      .select()
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.productVersionId, productVersionId), eq(orders.status, 'pending'), sql`expires_at > now()`))
      .limit(1);
    if (pending) {
      return { orderId: pending.id, status: pending.status, payUrl: (pending.productSnapshot as { codeUrl?: string }).codeUrl ?? null };
    }

    const merchantOrderNo = `JEV${Date.now()}${randomBytes(4).toString('hex').toUpperCase()}`;
    const notifyUrl = new URL('/api/v1/payments/wechat_native/notify', app().env.PUBLIC_BASE_URL).toString();
    const [order] = await db.db
      .insert(orders)
      .values({
        userId,
        productVersionId,
        productSnapshot: { title: product.title, priceMinor: product.priceMinor, currency: product.currency },
        amountMinor: product.priceMinor,
        currency: product.currency,
        channel: 'wechat_native',
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
    await db.db.update(orders).set({ productSnapshot: { title: product.title, priceMinor: product.priceMinor, codeUrl: pay.codeUrl } }).where(eq(orders.id, order!.id));
    return { orderId: order!.id, status: 'pending' as const, payUrl: pay.codeUrl };
  }

  async getOrder(userId: string, orderId: string) {
    const db = app().db;
    const [order] = await db.db
      .select({
        orderId: orders.id,
        userId: orders.userId,
        status: orders.status,
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
    return {
      orderId: order.orderId,
      status: order.status,
      amountMinor: order.amountMinor,
      currency: order.currency,
      title: order.title,
      payUrl: (order.snapshot as { codeUrl?: string }).codeUrl ?? null,
      expiresAt: order.expiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(),
    };
  }

  /**
   * 支付成功核销（回调与查单共用）：同事务写交易、订单 paid、授权与流水；重复调用幂等。
   */
  async confirmPaid(channel: string, merchantOrderNo: string, transactionId: string): Promise<void> {
    const db = app().db;
    await db.tx(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.merchantOrderNo, merchantOrderNo))
        .for('update')
        .limit(1);
      if (!order) throw new Error(`支付核销找不到订单：${merchantOrderNo}`);
      if (order.status === 'paid' || order.status === 'refunded' || order.status === 'refund_pending') return;

      await tx.insert(paymentTransactions).values({
        channel: 'wechat_native',
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
        afterSummary: { transactionId, amountMinor: order.amountMinor },
        relatedRequestId: randomUUID(),
      });
    });
    void channel;
  }

  /** 支付回调：验签在适配器内完成，通知记录与幂等在这里。 */
  async handleNotification(channel: string, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<{ code: 'SUCCESS' | 'FAIL' }> {
    const db = app().db;
    const adapter = this.adapter();
    if (!adapter) return { code: 'FAIL' };
    let verified: { merchantOrderNo: string; transactionId: string; success: boolean; notificationId: string };
    try {
      verified = adapter.verifyNotification({ headers, rawBody });
    } catch {
      return { code: 'FAIL' };
    }

    const createHash = (await import('node:crypto')).createHash;
    await db.db
      .insert(paymentNotifications)
      .values({
        channel: 'wechat_native',
        notificationId: verified.notificationId,
        payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
        verifyResult: 'ok',
        handleResult: verified.success ? 'confirm' : 'ignored',
      })
      .onConflictDoNothing();

    if (verified.success) {
      await this.confirmPaid(channel, verified.merchantOrderNo, verified.transactionId);
    }
    return { code: 'SUCCESS' };
  }

  /** 关单任务：过期 pending/closing 订单先查单再关闭（防止先支付后超时的竞争）。 */
  async sweepExpiredOrders(): Promise<void> {
    const db = app().db;
    const adapter = this.adapter();
    if (!adapter) return;
    const expired = await db.db
      .select()
      .from(orders)
      .where(and(sql`status in ('pending','closing')`, sql`expires_at < now()`))
      .limit(50);
    for (const order of expired) {
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
