/**
 * 永久会员（¥20）链路验证（真实数据库）：需 LIFETIME_TEST_DATABASE_URL。
 *
 * 覆盖四件事：
 *   1. 商品目录按类型幂等补齐——库里只有月度时，永久会员也必须出现在前台
 *      （老实现的「表空才插入」会让只种了月度的库永远缺永久会员）
 *   2. 永久会员支付成功 → 授权没有到期日（effective_until 为 null）
 *   3. 重复购买永久会员 → 登记待退款流水，钱不静默被吞
 *   4. 永久授权让开房走「赞助」来源：免费额度用光后依然能开房
 *
 * 用独立临时数据库跑，结束后整块删除，不碰其它库的数据。
 */
import { randomUUID, createSign, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schemaModule from '@jev/database/schema';
import type { DbHandle } from '@jev/database';
import { orders, productVersions, sponsorGrants, sponsorLedger, sponsorProducts, user } from '@jev/database';
import { resolveEntitlementSource } from '@jev/domain';
import { setAppContext } from '../context.js';
import { OrdersService } from './orders.service.js';
import { signParams } from './alipay-pay.adapter.js';

const databaseUrl = process.env.LIFETIME_TEST_DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe.runIf(!!databaseUrl)('永久会员链路（真实数据库）', () => {
  const dbName = `jev_life_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let handle: DbHandle;
  let service: OrdersService;
  let db: ReturnType<typeof drizzle>;
  let gatewayUrl: string;
  let gateway: http.Server;
  let keyDir: string;
  let userId: string;
  let lifetimeProductVersionId: string;

  beforeAll(async () => {
    const base = new URL(databaseUrl!);
    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    control = new Pool({ connectionString: adminUrl.toString() });
    await control.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await control.query(`CREATE DATABASE "${dbName}"`);

    const testUrl = new URL(base);
    testUrl.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: testUrl.toString() });

    const db2 = drizzle(pool, { schema: schemaModule });
    await migrate(db2, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle/', import.meta.url)) });
    handle = { db: db2, pool, tx: (fn) => db2.transaction(fn as never) as never, close: () => pool.end() };
    db = db2;

    // 本地假网关：按支付宝格式回带签名的应答
    gateway = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = Object.fromEntries(new URLSearchParams(body));
        const method = params.method ?? '';
        const nodeName = `${method.replace(/\./g, '_')}_response`;
        const node = JSON.stringify({
          code: '10000',
          msg: 'Success',
          qr_code: 'https://qr.alipay.com/lifetime-test',
          trade_status: 'WAIT_BUYER_PAY',
        });
        const sign = createSign('RSA-SHA256').update(node, 'utf8').sign(privateKey, 'base64');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"${nodeName}":${node},"sign":"${sign}"}`);
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/gateway.do`;

    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifetime-int-'));
    const privPath = path.join(keyDir, 'app_private_key.pem');
    const pubPath = path.join(keyDir, 'alipay_public_key.pem');
    fs.writeFileSync(privPath, PRIVATE_PEM, 'utf8');
    fs.writeFileSync(pubPath, PUBLIC_PEM, 'utf8');

    setAppContext({
      db: handle,
      env: {
        PUBLIC_BASE_URL: 'https://sp.example.com',
        ALIPAY_APP_ID: '2021000000000001',
        ALIPAY_PRIVATE_KEY_PATH: privPath,
        ALIPAY_PUBLIC_KEY_PATH: pubPath,
        ALIPAY_NOTIFY_URL: 'https://sp.example.com/api/v1/payments/alipay/notify',
        ALIPAY_GATEWAY: gatewayUrl,
        ALIPAY_SELLER_ID: '2088123456789012',
      },
    } as never);
    service = new OrdersService();

    const [u] = await db
      .insert(user)
      .values({ id: `u_${randomUUID().slice(0, 12)}`, name: 'payer', email: `${randomUUID().slice(0, 8)}@t.dev`, emailVerified: true })
      .returning({ id: user.id });
    userId = u!.id;

    // 关键前提：库里「只有月度」，模拟老库只种过月度的状态
    const [monthlyProduct] = await db.insert(sponsorProducts).values({ type: 'monthly' }).returning();
    await db.insert(productVersions).values({
      productId: monthlyProduct!.id,
      versionNo: 1,
      priceMinor: 600,
      title: '月度会员',
      available: true,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    fs.rmSync(keyDir, { recursive: true, force: true });
    try {
      await pool?.end();
    } finally {
      if (control) {
        try {
          await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } catch {
          /* 忽略 */
        }
        await control.end();
      }
    }
  });

  /** 造一条已用支付宝私钥签名的通知体 */
  function signedNotify(extra: Record<string, string>): Buffer {
    const params: Record<string, string> = {
      notify_time: '2026-10-22 12:00:00',
      notify_type: 'trade_status_sync',
      notify_id: randomUUID(),
      app_id: '2021000000000001',
      seller_id: '2088123456789012',
      sign_type: 'RSA2',
      ...extra,
    };
    params.sign = signParams(params, PRIVATE_PEM);
    return Buffer.from(new URLSearchParams(params).toString(), 'utf8');
  }

  it('商品目录按类型补齐：库里只有月度时，永久会员也必须出现', async () => {
    const products = await service.listProducts();
    const monthly = products.find((p) => p.type === 'monthly');
    const lifetime = products.find((p) => p.type === 'lifetime');
    expect(monthly?.priceMinor).toBe(600);
    expect(lifetime, '永久会员必须出现在商品目录里').toBeTruthy();
    expect(lifetime?.priceMinor).toBe(2000);
    lifetimeProductVersionId = lifetime!.productVersionId;
  });

  it('补齐是幂等的：重复调用不会插出第二条永久会员', async () => {
    await service.listProducts();
    await service.listProducts();
    const products = await service.listProducts();
    expect(products.filter((p) => p.type === 'lifetime').length).toBe(1);
    const lifetimeRows = await db.select().from(sponsorProducts).where(eq(sponsorProducts.type, 'lifetime'));
    expect(lifetimeRows.length).toBe(1);
  });

  it('永久会员支付成功 → 授权无到期日', async () => {
    const created = await service.createOrder(userId, lifetimeProductVersionId, 'alipay');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    expect(row?.amountMinor).toBe(2000);

    const ack = await service.handleNotification(
      'alipay',
      {},
      signedNotify({
        out_trade_no: row!.merchantOrderNo,
        trade_no: '20261022990001',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '20.00',
      }),
    );
    expect(ack.body).toBe('success');

    const [paid] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    expect(paid?.status).toBe('paid');

    const grants = await db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, userId));
    const lifetimeGrant = grants.find((g) => g.type === 'lifetime');
    expect(lifetimeGrant, '必须发放永久授权').toBeTruthy();
    expect(lifetimeGrant!.status).toBe('active');
    expect(lifetimeGrant!.effectiveUntil, '永久授权没有到期日').toBeNull();
  });

  it('永久授权让开房走「赞助」来源：免费额度用光后依然能开房', async () => {
    const grants = await db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, userId));
    const resolved = resolveEntitlementSource(
      grants.map((g) => ({
        type: g.type,
        status: g.status,
        effectiveFrom: g.effectiveFrom,
        effectiveUntil: g.effectiveUntil,
      })),
      // 免费额度已经被用光
      { total: 10, consumed: 10, reserved: 0 },
      new Date(),
    );
    expect(resolved.source).toBe('sponsorship');
  });

  it('重复购买永久会员 → 登记待退款流水，不静默吞款', async () => {
    const created = await service.createOrder(userId, lifetimeProductVersionId, 'alipay');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);

    const ack = await service.handleNotification(
      'alipay',
      {},
      signedNotify({
        out_trade_no: row!.merchantOrderNo,
        trade_no: '20261022990002',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '20.00',
      }),
    );
    expect(ack.body).toBe('success');

    const ledger = await db.select().from(sponsorLedger).where(eq(sponsorLedger.userId, userId));
    const flagged = ledger.find((l) => {
      const detail = l.detail as { issue?: string } | null;
      return detail?.issue === 'duplicate_lifetime_pending_refund';
    });
    expect(flagged, '重复购买必须留下待退款标记，供运营退钱').toBeTruthy();
    expect(flagged!.orderId).toBe(created.orderId);
  });
});
