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
});
