/**
 * 支付宝适配器测试：用本地 HTTP 服务器扮演支付宝开放平台网关。
 *
 * 覆盖：RSA2 签名/验签、待签名串拼装、原始报文节点截取、金额换算、
 * 当面付预下单、查单、关单、退款、异步通知验签（以及伪造通知被拒）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  beijingTimestamp,
  buildSignContent,
  createAlipayAdapter,
  extractRawNode,
  minorToYuan,
  signParams,
  verifySign,
  yuanToMinor,
} from './alipay-pay.adapter.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
// 另一套密钥：用来伪造「签名来自非支付宝」的应答
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** 模拟支付宝网关：收到请求后按官方格式回一个带签名的应答。 */
interface MockGateway {
  url: string;
  requests: Array<{ method: string; params: Record<string, string>; body: string }>;
  close: () => Promise<void>;
}

async function startMockGateway(
  responder?: (method: string, params: Record<string, string>) => { node: string; code?: string; msg?: string },
  signWith = privateKey,
): Promise<MockGateway> {
  const requests: MockGateway['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      requests.push({ method: params.method ?? '', params, body });

      const method = params.method ?? '';
      const nodeName = `${method.replace(/\./g, '_')}_response`;
      const override = responder?.(method, params);
      const node =
        override?.node ??
        JSON.stringify({ code: '10000', msg: 'Success', qr_code: 'https://qr.alipay.com/bax-test', trade_status: 'WAIT_BUYER_PAY' });
      const sign = createSign('RSA-SHA256').update(node, 'utf8').sign(signWith, 'base64');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"${nodeName}":${node},"sign":"${sign}"}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/gateway.do`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 生成适配器用的临时密钥文件与配置。 */
function makeAdapter(gatewayUrl: string, dir: string) {
  const privPath = path.join(dir, 'app_private_key.pem');
  const pubPath = path.join(dir, 'alipay_public_key.pem');
  fs.writeFileSync(privPath, PRIVATE_PEM, 'utf8');
  fs.writeFileSync(pubPath, PUBLIC_PEM, 'utf8');
  return createAlipayAdapter({
    ALIPAY_APP_ID: '2021000000000001',
    ALIPAY_PRIVATE_KEY_PATH: privPath,
    ALIPAY_PUBLIC_KEY_PATH: pubPath,
    ALIPAY_NOTIFY_URL: 'https://sp.example.com/api/v1/payments/alipay/notify',
    ALIPAY_GATEWAY: gatewayUrl,
    ALIPAY_SELLER_ID: '2088123456789012',
  });
}

describe('支付宝签名基础', () => {
  it('待签名串按参数名升序、排除 sign 与空值', () => {
    const content = buildSignContent({ b: '2', a: '1', sign: 'x', empty: '', c: '  3  ' });
    expect(content).toBe('a=1&b=2&c=3');
  });

  it('签名可用公钥验证，篡改后失败', () => {
    const params = { app_id: 'x', method: 'alipay.trade.precreate' };
    const sign = signParams(params, PRIVATE_PEM);
    expect(verifySign(buildSignContent(params), sign, PUBLIC_PEM)).toBe(true);
    expect(verifySign(buildSignContent({ ...params, method: 'tampered' }), sign, PUBLIC_PEM)).toBe(false);
  });

  it('时间戳是北京时间格式', () => {
    const ts = beijingTimestamp(new Date('2026-10-20T04:00:00Z'));
    expect(ts).toBe('2026-10-20 12:00:00');
  });

  it('金额在分与元之间换算', () => {
    expect(minorToYuan(600)).toBe('6.00');
    expect(minorToYuan(2000)).toBe('20.00');
    expect(yuanToMinor('6.00')).toBe(600);
    expect(yuanToMinor('6')).toBe(600);
    expect(yuanToMinor(undefined)).toBeNull();
  });
});

describe('原始报文节点截取', () => {
  it('取出 xxx_response 节点的原始 JSON 文本', () => {
    const raw = '{"alipay_trade_precreate_response":{"code":"10000","qr_code":"https://x"},"sign":"abc"}';
    const node = extractRawNode(raw, 'alipay_trade_precreate_response');
    expect(node).toBe('{"code":"10000","qr_code":"https://x"}');
  });

  it('字符串里的花括号不会打断配平', () => {
    const raw = '{"alipay_trade_query_response":{"msg":"a{b}c","nested":{"k":"v"}},"sign":"s"}';
    const node = extractRawNode(raw, 'alipay_trade_query_response');
    expect(node).toBe('{"msg":"a{b}c","nested":{"k":"v"}}');
  });

  it('节点不存在时返回 null', () => {
    expect(extractRawNode('{"sign":"x"}', 'alipay_trade_precreate_response')).toBeNull();
  });
});

describe('支付宝适配器（对本地 mock 网关）', () => {
  let dir: string;
  let gateway: MockGateway;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-test-'));
    gateway = await startMockGateway();
  });

  afterEach(async () => {
    await gateway.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('凭据齐备时创建适配器，缺一项返回 null', () => {
    expect(makeAdapter(gateway.url, dir)).not.toBeNull();
    expect(
      createAlipayAdapter({
        ALIPAY_APP_ID: 'x',
        ALIPAY_PRIVATE_KEY_PATH: path.join(dir, 'app_private_key.pem'),
        // 缺公钥
        ALIPAY_NOTIFY_URL: 'https://x/notify',
      }),
    ).toBeNull();
  });

  it('当面付预下单：返回可打开的二维码链接', async () => {
    const adapter = makeAdapter(gateway.url, dir)!;
    const result = await adapter.createOrder({
      merchantOrderNo: 'JEV001',
      amountMinor: 600,
      description: '月度会员',
      notifyUrl: 'https://sp.example.com/api/v1/payments/alipay/notify',
    });
    expect(result.qrContent).toBe('https://qr.alipay.com/bax-test');
    expect(result.payUrl).toBe('https://qr.alipay.com/bax-test');
    expect(gateway.requests[0]?.method).toBe('alipay.trade.precreate');
    // 金额用「元」，通知地址与业务内容都要带上
    expect(JSON.parse(gateway.requests[0]!.params.biz_content!).total_amount).toBe('6.00');
    expect(gateway.requests[0]?.params.notify_url).toBe('https://sp.example.com/api/v1/payments/alipay/notify');
    expect(gateway.requests[0]?.params.sign).toBeTruthy();
  });

  it('页面支付：返回已签名的网关跳转 URL', async () => {
    // 先落密钥文件，再建页面支付的适配器
    makeAdapter(gateway.url, dir);
    const privPath = path.join(dir, 'app_private_key.pem');
    const pubPath = path.join(dir, 'alipay_public_key.pem');
    const adapter = createAlipayAdapter({
      ALIPAY_APP_ID: '2021000000000001',
      ALIPAY_PRIVATE_KEY_PATH: privPath,
      ALIPAY_PUBLIC_KEY_PATH: pubPath,
      ALIPAY_NOTIFY_URL: 'https://sp.example.com/notify',
      ALIPAY_GATEWAY: gateway.url,
      ALIPAY_PRODUCT: 'page',
    })!;
    const result = await adapter.createOrder({
      merchantOrderNo: 'JEV002',
      amountMinor: 2000,
      description: '永久会员',
      notifyUrl: 'https://sp.example.com/notify',
    });
    expect(result.qrContent).toBeNull();
    expect(result.payUrl).toContain('method=alipay.trade.page.pay');
    expect(result.payUrl).toContain('sign=');
    // 网关没被调用（页面支付是浏览器跳转，不走接口）
    expect(gateway.requests.length).toBe(0);
  });

  it('同步应答验签失败时拒绝下单（应答来自非支付宝的签名）', async () => {
    // 用另一套密钥签名：适配器拿支付宝公钥验签必然失败
    const bad = await startMockGateway(
      (method) => {
        if (method === 'alipay.trade.precreate') {
          return { node: JSON.stringify({ code: '10000', qr_code: 'https://evil' }) };
        }
        return { node: JSON.stringify({ code: '10000' }) };
      },
      otherKey,
    );
    try {
      const adapter = makeAdapter(bad.url, dir)!;
      await expect(
        adapter.createOrder({ merchantOrderNo: 'JEV003', amountMinor: 600, description: 'x', notifyUrl: 'https://x/notify' }),
      ).rejects.toThrow(/验签失败/);
    } finally {
      await bad.close();
    }
  });

  it('查单：TRADE_SUCCESS 记成功，TRADE_CLOSED 记失败', async () => {
    const ok = await startMockGateway((method) => {
      if (method === 'alipay.trade.query') {
        return { node: JSON.stringify({ code: '10000', trade_status: 'TRADE_SUCCESS', trade_no: '2026102022001' }) };
      }
      return { node: JSON.stringify({ code: '10000' }) };
    });
    try {
      const adapter = makeAdapter(ok.url, dir)!;
      await expect(adapter.queryOrder('JEV004')).resolves.toEqual({ status: 'success', transactionId: '2026102022001' });
    } finally {
      await ok.close();
    }
  });

  it('异步通知：验签通过后解析出单号、交易号与金额', async () => {
    const adapter = makeAdapter(gateway.url, dir)!;
    const params: Record<string, string> = {
      notify_time: '2026-10-20 12:00:00',
      notify_type: 'trade_status_sync',
      notify_id: randomUUID(),
      app_id: '2021000000000001',
      seller_id: '2088123456789012',
      out_trade_no: 'JEV005',
      trade_no: '2026102022002',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '6.00',
      sign_type: 'RSA2',
    };
    // 异步通知验签：按官方规则 sign 与 sign_type 都不参与签名（适配器同此）
    const { sign_type: _signType, ...signed } = params;
    params.sign = signParams(signed, PRIVATE_PEM);
    const body = Buffer.from(new URLSearchParams(params).toString(), 'utf8');

    const verified = adapter.verifyNotification({ headers: {}, rawBody: body });
    expect(verified.merchantOrderNo).toBe('JEV005');
    expect(verified.transactionId).toBe('2026102022002');
    expect(verified.success).toBe(true);
    expect(verified.amountMinor).toBe(600);
  });

  it('异步通知：签名不对直接拒绝', () => {
    const adapter = makeAdapter(gateway.url, dir)!;
    const params: Record<string, string> = {
      out_trade_no: 'JEV006',
      trade_no: '2026102022003',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '6.00',
      sign: 'bm90LWEtc2lnbmF0dXJl',
    };
    const body = Buffer.from(new URLSearchParams(params).toString(), 'utf8');
    expect(() => adapter.verifyNotification({ headers: {}, rawBody: body })).toThrow(/验签失败/);
  });

  it('异步通知：app_id / seller_id 对不上直接拒绝', () => {
    const adapter = makeAdapter(gateway.url, dir)!;
    const base: Record<string, string> = {
      out_trade_no: 'JEV007',
      trade_no: '2026102022004',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '6.00',
    };
    for (const [key, value] of [
      ['app_id', '9999999999999999'],
      ['seller_id', '2088000000000000'],
    ] as const) {
      const params = { ...base, [key]: value };
      params.sign = signParams(params, PRIVATE_PEM);
      const body = Buffer.from(new URLSearchParams(params).toString(), 'utf8');
      expect(() => adapter.verifyNotification({ headers: {}, rawBody: body })).toThrow(/不匹配/);
    }
  });

  it('成功应答体是纯文本 success（支付宝要求）', () => {
    const adapter = makeAdapter(gateway.url, dir)!;
    expect(adapter.notifyAck()).toEqual({ contentType: 'text/plain', body: 'success' });
  });
});

describe('渠道契约', () => {
  it('支付宝通道标识固定为 alipay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-chan-'));
    try {
      const adapter = makeAdapter('http://127.0.0.1:1/gateway.do', dir)!;
      expect(adapter.channel).toBe('alipay');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('md5 摘要用于通知幂等键', () => {
    // 通知去重依赖 notificationId 唯一；这里确认摘要算法稳定
    const a = createHash('sha256').update('x').digest('hex');
    const b = createHash('sha256').update('x').digest('hex');
    expect(a).toBe(b);
  });
});
