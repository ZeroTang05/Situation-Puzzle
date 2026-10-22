/**
 * 支付回调请求体解析回归测试（真实 express + 真实 TCP 连接）。
 *
 * 钉死的关键事实：**两个支付通道的异步通知都必须拿到原始字节（Buffer）**。
 * 适配器靠原始字节验签（微信验签消息体、支付宝验签表单原文），
 * body 被上游解析器消费掉 = 验签必失败 = 通知被当作「验签失败」丢弃 =
 * 用户付了钱永远拿不到权益。
 *
 * 为什么这条要有测试：集成测试（payment-channels.integration.test.ts）
 * 直调 service.handleNotification 并手工构造 Buffer，
 * 绕过了 express 解析层——解析器顺序错了它照样是绿的。
 * 与当初 notify 漏标 @Public() 被守卫 401 属于同一类盲区。
 *
 * 曾经的真实故障：express.json() 排在 express.raw() 前面，
 * 而微信通知的 Content-Type 正是 application/json，
 * 微信的 body 被 JSON 解析器吃掉 → 微信回调永远验签失败。
 * 支付宝的通知是表单（不匹配 express.json），所以只有微信通道暴露此问题。
 */
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { mountBodyParsers } from '../bootstrap.js';

/** 起一个真实 express 实例，POST 通知后回传「拿到的 body 是什么」。 */
async function postNotify(contentType: string, body: string) {
  const app = express();
  mountBodyParsers(app);
  app.post('/api/v1/payments/:channel/notify', (request, response) => {
    response.json({
      isBuffer: Buffer.isBuffer(request.body),
      // 还原成字符串：Buffer 直接 toString，对象则是 "[object Object]"
      text: Buffer.isBuffer(request.body) ? request.body.toString('utf8') : String(request.body),
    });
  });
  const server: Server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试监听端口缺失');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/payments/wechat_native/notify`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    return (await response.json()) as { isBuffer: boolean; text: string };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('支付回调请求体解析', () => {
  it('微信通知（application/json）拿到原始字节，不是被 JSON 解析后的对象', async () => {
    // 微信支付异步通知的真实报文结构（这里只验 body 的形态，验签另由适配器测试覆盖）
    const payload = JSON.stringify({
      id: 'EV-2018022511223320873',
      event_type: 'TRANSACTION.SUCCESS',
      resource: { ciphertext: 'cipher-text', nonce: 'abcdef', associated_data: 'transaction' },
    });
    const result = await postNotify('application/json', payload);
    // 关键断言：必须是 Buffer，且内容与发出去的字节完全一致
    expect(result.isBuffer).toBe(true);
    expect(result.text).toBe(payload);
  });

  it('支付宝通知（表单）拿到原始字节', async () => {
    const payload = new URLSearchParams({
      notify_time: '2026-10-20 12:00:00',
      out_trade_no: 'WX1234567890',
      trade_status: 'TRADE_SUCCESS',
    }).toString();
    const result = await postNotify('application/x-www-form-urlencoded', payload);
    expect(result.isBuffer).toBe(true);
    expect(result.text).toBe(payload);
  });

  it('非支付路径仍然走 JSON 解析（不能被 raw 解析器误伤）', async () => {
    const app = express();
    mountBodyParsers(app);
    app.post('/api/v1/orders', (request, response) => {
      response.json({ isObject: typeof request.body === 'object' && !Buffer.isBuffer(request.body) });
    });
    const server: Server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('测试监听端口缺失');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productVersionId: 'pv_1', channel: 'wechat_native' }),
      });
      expect(await response.json()).toEqual({ isObject: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
