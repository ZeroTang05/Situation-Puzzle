/**
 * 赞助码通道（零实名收款）。
 *
 * 为什么需要这一条：微信支付 v3 适配器已完整实现，但商户号、APIv3 密钥与平台证书
 * 需要商户资质与实名才能开通。资质到位前站内没有任何可用收款入口，赞助权益售不出去。
 * 赞助码把「收钱」这一步交给运营方用个人收款码完成（不需要任何平台资质），
 * 站内只负责「发码 → 兑换 → 核销 → 发授权」，全部自动完成。
 *
 * 铁律（docs/rebuild/05-OPERATIONS.md §4 同源约束）：
 *  - 一码一权：核销时对码行加锁（FOR UPDATE）并把状态从 unused 改为 used；
 *    码状态流转与授权发放在**同一事务**内，杜绝「码已用但权益没发」。
 *  - 权益只来自服务端：兑换成功后由服务端发放授权，前端回跳不发放任何权益。
 *  - 幂等：同一码重复兑换返回明确错误，不产生第二笔订单、不重复发授权。
 *  - 金额取商品版本快照：改价产生新版本，已发出的老码仍按老价发货。
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { orders, productVersions, redeemCodes, sponsorProducts, type Tx } from '@jev/database';
import { DomainError, generateRedeemCode, normalizeRedeemCode } from '@jev/domain';
import { app } from '../context.js';
import { OrdersService } from './orders.service.js';
import { orderBySort, type SortWhitelist } from '../admin/admin-sort.js';

/** 订单有效期：赞助码兑换即时完成，订单仍然走统一的下单快照与流水。 */
const ORDER_TTL_MINUTES = 15;

/**
 * 批次聚合表达式：SELECT 与 ORDER BY 共用同一批片段，
 * 保证「看到的个数」和「排序依据」是同一个口径。
 */
const BATCH_TOTAL_COUNT = sql<number>`count(*)::int`;
const BATCH_UNUSED_COUNT = sql<number>`count(*) filter (where ${redeemCodes.status} = 'unused')::int`;
const BATCH_USED_COUNT = sql<number>`count(*) filter (where ${redeemCodes.status} = 'used')::int`;
const BATCH_REVOKED_COUNT = sql<number>`count(*) filter (where ${redeemCodes.status} = 'revoked')::int`;
const BATCH_CREATED_AT = sql<Date>`min(${redeemCodes.createdAt})`;
const BATCH_NOTE = sql<string | null>`min(${redeemCodes.note})`;

/** 批次列表可排序列（白名单外一律回落「最新在前」）。 */
const REDEEM_BATCH_SORT: SortWhitelist = {
  batchId: redeemCodes.batchId,
  type: sponsorProducts.type,
  priceMinor: productVersions.priceMinor,
  totalCount: BATCH_TOTAL_COUNT,
  unusedCount: BATCH_UNUSED_COUNT,
  usedCount: BATCH_USED_COUNT,
  revokedCount: BATCH_REVOKED_COUNT,
  createdAt: BATCH_CREATED_AT,
};

@Injectable()
export class RedeemCodesService {
  // tsx(esbuild) 不生成构造参数元数据：必须显式 @Inject，否则运行时 this.ordersService 为 undefined
  constructor(@Inject(OrdersService) private readonly ordersService: OrdersService) {}

  /**
   * 兑换赞助码：核销码 + 建单 + 发授权，同事务完成。
   *
   * 失败语义统一为 NOT_FOUND，避免泄露「码存在但已用/过期」这类内部状态。
   */
  async redeem(userId: string, rawCode: string) {
    const db = app().db;
    const codeKey = normalizeRedeemCode(rawCode);
    if (codeKey.length < 6) throw new DomainError('VALIDATION_FAILED', '兑换码格式不正确');

    return db.tx(async (tx) => {
      // 锁码行：并发兑换同一码时只有一个事务能拿到未使用的码
      const [row] = await tx
        .select()
        .from(redeemCodes)
        .where(eq(redeemCodes.codeKey, codeKey))
        .for('update')
        .limit(1);
      if (!row) throw new DomainError('NOT_FOUND', '兑换码不存在');
      if (row.status === 'used') throw new DomainError('NOT_FOUND', '兑换码已被使用');
      if (row.status === 'revoked') throw new DomainError('NOT_FOUND', '兑换码已作废');
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
        throw new DomainError('NOT_FOUND', '兑换码已过期');
      }

      const [product] = await tx
        .select()
        .from(productVersions)
        .where(eq(productVersions.id, row.productVersionId))
        .limit(1);
      if (!product) throw new DomainError('NOT_FOUND', '兑换码对应的商品不存在');

      const merchantOrderNo = `RC${Date.now()}${randomBytes(4).toString('hex').toUpperCase()}`;
      const [order] = await tx
        .insert(orders)
        .values({
          userId,
          productVersionId: product.id,
          productSnapshot: { title: product.title, priceMinor: product.priceMinor, currency: product.currency },
          amountMinor: product.priceMinor,
          currency: product.currency,
          channel: 'redeem_code',
          merchantOrderNo,
          expiresAt: new Date(Date.now() + ORDER_TTL_MINUTES * 60_000),
        })
        .returning({ id: orders.id });
      if (!order) throw new Error('赞助码兑换建单失败');

      // 码状态与授权发放同事务：任一失败整体回滚，码不会被"吃掉"
      await tx
        .update(redeemCodes)
        .set({ status: 'used', usedBy: userId, usedAt: new Date(), orderId: order.id })
        .where(eq(redeemCodes.id, row.id));

      await this.ordersService.confirmPaidTx(tx, 'redeem_code', merchantOrderNo, `redeem:${row.code}`);

      return {
        orderId: order.id,
        status: 'paid' as const,
        title: product.title,
        type: await this.productTypeOf(tx, product.productId),
        amountMinor: product.priceMinor,
        currency: product.currency,
      };
    });
  }

  /** 商品类型（monthly/lifetime）：授权发放与前端文案都要用。 */
  private async productTypeOf(tx: Tx, productId: string): Promise<'monthly' | 'lifetime' | null> {
    const [row] = await tx.select({ type: sponsorProducts.type }).from(sponsorProducts).where(eq(sponsorProducts.id, productId)).limit(1);
    return row?.type ?? null;
  }

  /**
   * 批量发码：生成一批未使用赞助码并返回明文（仅此一次可读明文，之后只能按批次查询）。
   * 运营方拿到明文后用个人收款码收款，交付给买家。
   */
  async generateBatch(input: {
    operatorUserId: string;
    type: 'monthly' | 'lifetime';
    count: number;
    note?: string | undefined;
    expiresAt?: Date | undefined;
  }) {
    const db = app().db;
    const [product] = await db.db
      .select({
        id: productVersions.id,
        title: productVersions.title,
        priceMinor: productVersions.priceMinor,
        currency: productVersions.currency,
      })
      .from(productVersions)
      .innerJoin(sponsorProducts, eq(sponsorProducts.id, productVersions.productId))
      .where(and(eq(sponsorProducts.type, input.type), eq(productVersions.available, true), eq(sponsorProducts.available, true)))
      .orderBy(desc(productVersions.versionNo))
      .limit(1);
    if (!product) throw new DomainError('NOT_FOUND', `没有可用的${input.type === 'monthly' ? '月度' : '永久'}商品版本`);

    const batchId = `B${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const rows = Array.from({ length: input.count }, () => {
      const code = generateRedeemCode();
      return {
        code,
        codeKey: normalizeRedeemCode(code),
        productVersionId: product.id,
        status: 'unused' as const,
        batchId,
        note: input.note ?? null,
        createdBy: input.operatorUserId,
        expiresAt: input.expiresAt ?? null,
      };
    });
    // 极小概率的码值碰撞：唯一索引会直接报错，重试一次即可
    const inserted = await db.db
      .insert(redeemCodes)
      .values(rows)
      .onConflictDoNothing({ target: redeemCodes.codeKey })
      .returning({ code: redeemCodes.code });
    if (inserted.length !== rows.length) {
      const insertedKeys = new Set(inserted.map((r) => normalizeRedeemCode(r.code)));
      const missing = rows.filter((r) => !insertedKeys.has(r.codeKey));
      throw new DomainError('ORDER_STATE_CONFLICT', `码值冲突，${missing.length} 个未生成，请重试`);
    }

    return {
      batchId,
      type: input.type,
      title: product.title,
      priceMinor: product.priceMinor,
      currency: product.currency,
      count: inserted.length,
      codes: inserted.map((r) => r.code),
    };
  }

  /**
   * 批次列表（对账用）：一批一行，含会员时长与各状态码数。
   *
   * 口径：总数 = 该批次的全部码；未用 / 已用 / 已作废按 redeem_codes.status 分桶。
   * 商品类型（monthly=1 个自然月，lifetime=永久）决定兑换后拿到的会员时长，
   * 所以这里直接带上 type，后台不必再猜。
   */
  async listBatches(params: { sort: string | undefined; order: string | undefined; limit: number; offset: number }) {
    const db = app().db;
    const rows = await db.db
      .select({
        batchId: redeemCodes.batchId,
        type: sponsorProducts.type,
        title: productVersions.title,
        priceMinor: productVersions.priceMinor,
        currency: productVersions.currency,
        note: BATCH_NOTE,
        createdAt: BATCH_CREATED_AT,
        totalCount: BATCH_TOTAL_COUNT,
        unusedCount: BATCH_UNUSED_COUNT,
        usedCount: BATCH_USED_COUNT,
        revokedCount: BATCH_REVOKED_COUNT,
      })
      .from(redeemCodes)
      .innerJoin(productVersions, eq(productVersions.id, redeemCodes.productVersionId))
      .innerJoin(sponsorProducts, eq(sponsorProducts.id, productVersions.productId))
      .groupBy(
        redeemCodes.batchId,
        productVersions.id,
        productVersions.title,
        productVersions.priceMinor,
        productVersions.currency,
        sponsorProducts.type,
      )
      .orderBy(
        ...orderBySort(
          params.sort,
          params.order,
          REDEEM_BATCH_SORT,
          desc(BATCH_CREATED_AT),
          desc(redeemCodes.batchId),
        ),
      )
      .limit(params.limit)
      .offset(params.offset);
    const [counted] = await db.db
      .select({ total: sql<number>`count(distinct ${redeemCodes.batchId})::int` })
      .from(redeemCodes);
    return { items: rows, total: counted?.total ?? rows.length };
  }

  /** 批次内的码明细（含使用状态与使用者）。 */
  async listCodes(batchId: string) {
    const db = app().db;
    return db.db
      .select({
        code: redeemCodes.code,
        status: redeemCodes.status,
        note: redeemCodes.note,
        usedBy: redeemCodes.usedBy,
        usedAt: redeemCodes.usedAt,
        expiresAt: redeemCodes.expiresAt,
        createdAt: redeemCodes.createdAt,
        type: sponsorProducts.type,
        title: productVersions.title,
        priceMinor: productVersions.priceMinor,
      })
      .from(redeemCodes)
      .innerJoin(productVersions, eq(productVersions.id, redeemCodes.productVersionId))
      .innerJoin(sponsorProducts, eq(sponsorProducts.id, productVersions.productId))
      .where(eq(redeemCodes.batchId, batchId))
      .orderBy(redeemCodes.createdAt);
  }

  /** 作废未使用的码：卖错价/退款的兜底。已使用的码不可作废。 */
  async revoke(code: string): Promise<{ revoked: number }> {
    const db = app().db;
    const rows = await db.db
      .update(redeemCodes)
      .set({ status: 'revoked' })
      .where(and(eq(redeemCodes.codeKey, normalizeRedeemCode(code)), eq(redeemCodes.status, 'unused')))
      .returning({ id: redeemCodes.id });
    return { revoked: rows.length };
  }
}
