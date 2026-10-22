/**
 * 赞助码核销的真实数据库验证：需 REDEEM_TEST_DATABASE_URL。
 *
 * 覆盖：一码一权、并发只放行一个、授权与流水同事务写、重复兑换被拒。
 * 用独立 schema 跑，结束后整块删除，不碰其它库的数据。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as schemaModule from '@jev/database/schema';
import type { DbHandle } from '@jev/database';
import { setAppContext } from '../context.js';
import { RedeemCodesService } from './redeem-codes.service.js';
import { OrdersService } from './orders.service.js';

const databaseUrl = process.env.REDEEM_TEST_DATABASE_URL;

describe.runIf(!!databaseUrl)('赞助码核销（真实数据库）', () => {
  // 迁移脚本里写死了 public schema，所以这里用独立的临时数据库而不是独立 schema
  const dbName = `jev_redeem_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let handle: DbHandle;
  let service: RedeemCodesService;

  beforeAll(async () => {
    // 连到同实例的 postgres 库来建/删临时库
    const base = new URL(databaseUrl!);
    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    control = new Pool({ connectionString: adminUrl.toString() });
    await control.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await control.query(`CREATE DATABASE "${dbName}"`);

    const testUrl = new URL(base);
    testUrl.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: testUrl.toString() });

    const db = drizzle(pool, { schema: schemaModule });
    // 用真正的 drizzle 迁移器按 journal 顺序建表：和生产启动时跑的是同一条路径
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle/', import.meta.url)) });

    handle = { db, pool, tx: (fn) => db.transaction(fn as never) as never, close: () => pool.end() };

    // 应用上下文只需要 db：核销路径不碰邮件、鉴权与模型
    setAppContext({ db: handle } as never);
    service = new RedeemCodesService(new OrdersService());
  });

  afterAll(async () => {
    try {
      await pool?.end();
    } finally {
      if (control) {
        try {
          await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } finally {
          await control.end();
        }
      }
    }
  });

  /** 造一个用户 + 月度商品 + 一个未使用的赞助码。 */
  async function seedCode(userId: string) {
    const [product] = await handle.db
      .insert(schemaModule.sponsorProducts)
      .values({ type: 'monthly' })
      .returning();
    const [version] = await handle.db
      .insert(schemaModule.productVersions)
      .values({ productId: product!.id, versionNo: 1, priceMinor: 600, title: '月度会员' })
      .returning();
    const batch = await service.generateBatch({
      operatorUserId: userId,
      type: 'monthly',
      count: 1,
      note: 'test',
    });
    return { productId: product!.id, versionId: version!.id, code: batch.codes[0]!, batchId: batch.batchId };
  }

  async function createUser(email: string) {
    const id = randomUUID();
    await handle.db.insert(schemaModule.user).values({ id, name: email, email });
    return id;
  }

  it('兑换成功后发放月度授权并写流水', async () => {
    const userId = await createUser('redeem-ok@example.com');
    const { code } = await seedCode(userId);

    const result = await service.redeem(userId, code);
    expect(result.status).toBe('paid');
    expect(result.amountMinor).toBe(600);

    const grants = await handle.db.select().from(schemaModule.sponsorGrants).where(eq(schemaModule.sponsorGrants.userId, userId));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.type).toBe('monthly');
    expect(grants[0]!.status).toBe('active');
    expect(grants[0]!.effectiveUntil).not.toBeNull();

    const ledger = await handle.db.select().from(schemaModule.sponsorLedger);
    expect(ledger.some((row) => row.action === 'grant')).toBe(true);

    const paid = await handle.db.select().from(schemaModule.orders);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.channel).toBe('redeem_code');
    expect(paid[0]!.status).toBe('paid');

    const transactions = await handle.db.select().from(schemaModule.paymentTransactions);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.channel).toBe('redeem_code');
  });

  it('同一码重复兑换被拒，且不产生第二笔订单', async () => {
    const userId = await createUser('redeem-twice@example.com');
    const { code } = await seedCode(userId);

    await service.redeem(userId, code);
    await expect(service.redeem(userId, code)).rejects.toThrow();

    const orders = await handle.db.select().from(schemaModule.orders);
    const forUser = orders.filter((o) => o.userId === userId);
    expect(forUser).toHaveLength(1);
  });

  it('并发兑换同一码只放行一个', async () => {
    const userId = await createUser('redeem-race@example.com');
    const { code } = await seedCode(userId);

    const results = await Promise.allSettled([
      service.redeem(userId, code),
      service.redeem(userId, code),
      service.redeem(userId, code),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    const grants = await handle.db
      .select()
      .from(schemaModule.sponsorGrants)
      .where(eq(schemaModule.sponsorGrants.userId, userId));
    expect(grants).toHaveLength(1);
  });

  it('码内容大小写与空格不影响兑换', async () => {
    const userId = await createUser('redeem-normalize@example.com');
    const { code } = await seedCode(userId);

    const result = await service.redeem(userId, ` ${code.toLowerCase().replace(/-/g, ' ')} `);
    expect(result.status).toBe('paid');
  });

  it('作废后的码不能兑换', async () => {
    const userId = await createUser('redeem-revoked@example.com');
    const { code } = await seedCode(userId);

    const revoked = await service.revoke(code);
    expect(revoked.revoked).toBe(1);
    await expect(service.redeem(userId, code)).rejects.toThrow();
  });

  it('兑换码订单退款：无线上退款步骤，但权益要在站内撤销', async () => {
    const userId = await createUser('redeem-refund@example.com');
    const adminUserId = await createUser('redeem-refund-admin@example.com');
    const { code } = await seedCode(userId);

    const redeemed = await service.redeem(userId, code);
    expect(redeemed.status).toBe('paid');

    const ordersService = new OrdersService();
    const refund = await ordersService.refundOrder(redeemed.orderId, '测试退款', adminUserId);
    // 钱是线下收的，没有线上退款接口可调
    expect(refund.channelRefund).toBe('not_applicable');

    const grants = await handle.db
      .select()
      .from(schemaModule.sponsorGrants)
      .where(eq(schemaModule.sponsorGrants.orderId, redeemed.orderId));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.status === 'revoked')).toBe(true);

    const [order] = await handle.db
      .select()
      .from(schemaModule.orders)
      .where(eq(schemaModule.orders.id, redeemed.orderId));
    expect(order?.status).toBe('refunded');
  });

  // ---------- 批次视图（后台列表口径） ----------

  it('批次列表：一批一行，带会员时长与各状态码数', async () => {
    const userId = await createUser('redeem-batch@example.com');
    const batch = await service.generateBatch({ operatorUserId: userId, type: 'monthly', count: 3, note: 'batch-test' });
    // 用掉一个
    await service.redeem(userId, batch.codes[0]!);
    // 作废一个
    await service.revoke(batch.codes[1]!);

    const result = await service.listBatches({ sort: undefined, order: undefined, limit: 100, offset: 0 });
    const row = result.items.find((item) => item.batchId === batch.batchId);
    expect(row).toBeTruthy();
    expect(row!.totalCount).toBe(3);
    expect(row!.usedCount).toBe(1);
    expect(row!.revokedCount).toBe(1);
    expect(row!.unusedCount).toBe(1);
    // 会员时长由商品类型决定：monthly = 1 个自然月
    expect(row!.type).toBe('monthly');
    expect(row!.priceMinor).toBe(600);
  });

  it('批次列表：lifetime 批次的会员时长是永久', async () => {
    const userId = await createUser('redeem-lifetime@example.com');
    const [product] = await handle.db
      .insert(schemaModule.sponsorProducts)
      .values({ type: 'lifetime' })
      .returning();
    await handle.db
      .insert(schemaModule.productVersions)
      .values({ productId: product!.id, versionNo: 1, priceMinor: 2000, title: '永久会员' });

    const batch = await service.generateBatch({ operatorUserId: userId, type: 'lifetime', count: 2, note: 'lifetime-batch' });
    const result = await service.listBatches({ sort: undefined, order: undefined, limit: 100, offset: 0 });
    const row = result.items.find((item) => item.batchId === batch.batchId);
    expect(row!.type).toBe('lifetime');
    expect(row!.totalCount).toBe(2);
    expect(row!.priceMinor).toBe(2000);

    const codes = await service.listCodes(batch.batchId);
    expect(codes).toHaveLength(2);
    expect(codes[0]!.type).toBe('lifetime');
  });

  it('批次列表：按白名单列排序生效，白名单外的列名回落默认顺序', async () => {
    const userId = await createUser('redeem-batch-sort@example.com');
    const small = await service.generateBatch({ operatorUserId: userId, type: 'monthly', count: 1, note: 'sort-small' });
    const big = await service.generateBatch({ operatorUserId: userId, type: 'monthly', count: 4, note: 'sort-big' });

    const asc = await service.listBatches({ sort: 'totalCount', order: 'ASC', limit: 100, offset: 0 });
    const ascRows = asc.items.filter((item) => item.batchId === small.batchId || item.batchId === big.batchId);
    expect(ascRows.map((item) => item.batchId)).toEqual([small.batchId, big.batchId]);

    const desc = await service.listBatches({ sort: 'totalCount', order: 'DESC', limit: 100, offset: 0 });
    const descRows = desc.items.filter((item) => item.batchId === small.batchId || item.batchId === big.batchId);
    expect(descRows.map((item) => item.batchId)).toEqual([big.batchId, small.batchId]);

    // 白名单外的列名不报错，也不影响排序
    const fallback = await service.listBatches({ sort: 'not-a-column', order: 'ASC', limit: 100, offset: 0 });
    expect(fallback.items.length).toBeGreaterThan(0);
  });

  it('批次列表支持分页，总数是批次数而不是码数', async () => {
    const page1 = await service.listBatches({ sort: undefined, order: undefined, limit: 1, offset: 0 });
    const page2 = await service.listBatches({ sort: undefined, order: undefined, limit: 1, offset: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.batchId).not.toBe(page1.items[0]!.batchId);
    expect(page1.total).toBeGreaterThanOrEqual(2);
  });
});
