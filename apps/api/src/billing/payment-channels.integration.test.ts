/**
 * 支付通道全链路验证（真实数据库）：需 PAYMENT_TEST_DATABASE_URL。
 *
 * 覆盖支付宝通道的完整闭环：
 *   下单 → 拿到付款信息 → 收到已验签的异步通知 → 订单 paid + 授权发放 + 流水入账
 *   → 通知幂等（重复通知不重复发授权）→ 金额不符被拒 → 退款撤销权益。
 *
 * 用独立临时数据库跑，结束后整块删除，不碰其它库的数据。
 * 微信通道的协议细节由 wechat-pay.adapter 覆盖（这里只验与通道无关的订单逻辑）。
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
import { orders, productVersions, sponsorGrants, sponsorLedger, user } from '@jev/database';
import { setAppContext } from '../context.js';
import { OrdersService } from './orders.service.js';
import { signParams } from './alipay-pay.adapter.js';

const databaseUrl = process.env.PAYMENT_TEST_DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe.runIf(!!databaseUrl)('支付通道全链路（真实数据库）', () => {
  const dbName = `jev_pay_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let handle: DbHandle;
  let service: OrdersService;
  let db: ReturnType<typeof drizzle>;
  let gatewayUrl: string;
  let gateway: http.Server;
  let keyDir: string;
  let userId: string;
  let adminUserId: string;
  let productVersionId: string;

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
          qr_code: 'https://qr.alipay.com/bax-integration',
          trade_status: 'WAIT_BUYER_PAY',
        });
        const sign = createSign('RSA-SHA256').update(node, 'utf8').sign(privateKey, 'base64');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"${nodeName}":${node},"sign":"${sign}"}`);
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/gateway.do`;

    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-int-'));
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

    // 造一个用户与一个 6 元的月度商品版本（外键要求真实 user 行）
    const [u] = await db.insert(user).values({ id: `u_${randomUUID().slice(0, 12)}`, name: 'payer', email: `${randomUUID().slice(0, 8)}@t.dev`, emailVerified: true }).returning({ id: user.id });
    userId = u!.id;
    const [op] = await db.insert(user).values({ id: `u_${randomUUID().slice(0, 12)}`, name: 'operator', email: `${randomUUID().slice(0, 8)}@t.dev`, emailVerified: true }).returning({ id: user.id });
    adminUserId = op!.id;
    const products = await service.listProducts();
    const monthly = products.find((p) => p.type === 'monthly')!;
    productVersionId = monthly.productVersionId;
    const [pv] = await db.select({ id: productVersions.id }).from(productVersions).where(eq(productVersions.id, productVersionId)).limit(1);
    expect(pv).toBeTruthy();
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
      notify_time: '2026-10-20 12:00:00',
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

  it('通道列表：支付宝凭据齐备时可用', () => {
    const channels = service.availableChannels();
    const alipay = channels.find((c) => c.channel === 'alipay');
    expect(alipay?.available).toBe(true);
    // 微信凭据没配 → 不可用
    expect(channels.find((c) => c.channel === 'wechat_native')?.available).toBe(false);
  });

  it('下单 → 拿到付款信息，订单落 pending', async () => {
    const created = await service.createOrder(userId, productVersionId, 'alipay');
    expect(created.status).toBe('pending');
    expect(created.qrContent).toBe('https://qr.alipay.com/bax-integration');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    expect(row?.channel).toBe('alipay');
    expect(row?.amountMinor).toBe(600);
  });

  it('已验签的支付通知 → 订单 paid + 授权发放 + 流水入账', async () => {
    const created = await service.createOrder(userId, productVersionId, 'alipay');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    const merchantOrderNo = row!.merchantOrderNo;

    const ack = await service.handleNotification(
      'alipay',
      {},
      signedNotify({
        out_trade_no: merchantOrderNo,
        trade_no: '20261020990001',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '6.00',
      }),
    );
    expect(ack.body).toBe('success');

    const [paid] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    expect(paid?.status).toBe('paid');
    const grants = await db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, userId));
    expect(grants.length).toBeGreaterThan(0);
    const ledger = await db.select().from(sponsorLedger).where(eq(sponsorLedger.userId, userId));
    expect(ledger.some((l) => l.action === 'grant')).toBe(true);
  });

  it('重复通知不重复发授权（幂等）', async () => {
    const created = await service.createOrder(userId, productVersionId, 'alipay');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    const merchantOrderNo = row!.merchantOrderNo;
    const notify = signedNotify({
      out_trade_no: merchantOrderNo,
      trade_no: '20261020990002',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '6.00',
    });

    await service.handleNotification('alipay', {}, notify);
    const grantsAfterFirst = await db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, userId));
    await service.handleNotification('alipay', {}, notify);
    const grantsAfterSecond = await db.select().from(sponsorGrants).where(eq(sponsorGrants.userId, userId));
    expect(grantsAfterSecond.length).toBe(grantsAfterFirst.length);
  });

  it('通知金额与订单金额不一致 → 拒绝入账', async () => {
    const created = await service.createOrder(userId, productVersionId, 'alipay');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);

    const ack = await service.handleNotification(
      'alipay',
      {},
      signedNotify({
        out_trade_no: row!.merchantOrderNo,
        trade_no: '20261020990003',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '0.01', // 订单是 6.00
      }),
    );
    expect(ack.body).toBe('fail');
    const [still] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    expect(still?.status).toBe('pending');
  });

  it('伪造通知（签名不对）→ 拒绝入账', async () => {
    const created = await service.createOrder(userId, productVersionId, 'alipay');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    const body = Buffer.from(
      new URLSearchParams({
        out_trade_no: row!.merchantOrderNo,
        trade_no: '20261020990004',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '6.00',
        sign: 'ZmFrZQ==',
      }).toString(),
      'utf8',
    );
    const ack = await service.handleNotification('alipay', {}, body);
    expect(ack.body).toBe('fail');
    const [still] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    expect(still?.status).toBe('pending');
  });

  it('退款：撤销授权，订单置 refunded', async () => {
    const created = await service.createOrder(userId, productVersionId, 'alipay');
    const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    await service.handleNotification(
      'alipay',
      {},
      signedNotify({
        out_trade_no: row!.merchantOrderNo,
        trade_no: '20261020990005',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '6.00',
      }),
    );
    const result = await service.refundOrder(created.orderId, '测试退款', adminUserId);
    expect(result.channelRefund).toBe('done');
    const [refunded] = await db.select().from(orders).where(eq(orders.id, created.orderId)).limit(1);
    expect(refunded?.status).toBe('refunded');
    const grants = await db.select().from(sponsorGrants).where(eq(sponsorGrants.orderId, created.orderId));
    expect(grants.every((g) => g.status === 'revoked' || g.status === 'frozen')).toBe(true);
  });

  it('未开通的通道下单 → PAYMENT_CHANNEL_UNAVAILABLE', async () => {
    await expect(service.createOrder(userId, productVersionId, 'wechat_native')).rejects.toThrow(/支付通道/);
  });

  it('在线通道凭据缺失时退款 → 权益保持冻结，不能当成「无线上退款步骤」撤权', async () => {
    // 造一笔已支付的微信订单（微信凭据在本测试环境里没配，适配器拿不到）：
    // 钱还在微信那边没退，站内绝不能把权益撤了。
    const merchantOrderNo = `WX${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const [wxOrder] = await db
      .insert(orders)
      .values({
        userId,
        productVersionId,
        productSnapshot: { title: '月度会员', priceMinor: 600, currency: 'CNY' },
        amountMinor: 600,
        currency: 'CNY',
        channel: 'wechat_native',
        status: 'paid',
        merchantOrderNo,
        paidAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: orders.id });
    await db.insert(sponsorGrants).values({
      userId,
      orderId: wxOrder!.id,
      type: 'monthly',
      status: 'active',
      effectiveFrom: new Date(),
      effectiveUntil: new Date(Date.now() + 30 * 86_400_000),
    });

    const result = await service.refundOrder(wxOrder!.id, '测试退款', adminUserId);
    // 钱没退 → 按失败处理，等人工跟进
    expect(result.channelRefund).toBe('failed');

    const grants = await db.select().from(sponsorGrants).where(eq(sponsorGrants.orderId, wxOrder!.id));
    expect(grants.every((g) => g.status === 'frozen')).toBe(true);
    const [order] = await db.select().from(orders).where(eq(orders.id, wxOrder!.id)).limit(1);
    expect(order?.status).toBe('refund_pending');
  });
});
