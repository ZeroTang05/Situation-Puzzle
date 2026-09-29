/** 使用真实 Express 和 TCP 连接验证代理信任与客户端地址，不替换网络实现。 */
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { otpHttpContext } from './otp-http-context.js';
import { otpRequestContext } from './otp-request-context.js';

/** 用真实监听端口调用被测中间件，测试结束关闭监听器。 */
async function clientIp(trust: false | string[], headers: Record<string, string> = {}) {
  const app = express(); app.set('trust proxy', trust);
  app.use(otpHttpContext(app.get('trust proxy fn')));
  app.get('/', (_request, response) => response.json({ ip: otpRequestContext.getStore()?.ip }));
  const server: Server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试监听端口缺失');
    const response = await fetch(`http://127.0.0.1:${address.port}`, { headers });
    return { status: response.status, body: await response.json() as { ip?: string; code?: string } };
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe('验证码客户端 IP', () => {
  it('直接连接忽略客户端伪造的转发头和内部头', async () => {
    expect(await clientIp(false, { 'x-forwarded-for': '198.51.100.10', 'x-jev-client-ip': '198.51.100.11' })).toEqual({ status: 200, body: { ip: '127.0.0.1' } });
  });
  it('从可信代理向右检查，取最近的非可信客户端地址', async () => {
    expect(await clientIp(['loopback'], { 'x-forwarded-for': '198.51.100.10, 203.0.113.8' })).toEqual({ status: 200, body: { ip: '203.0.113.8' } });
  });
  it('可信代理未提供客户端地址时明确拒绝', async () => {
    expect((await clientIp(['loopback'])).status).toBe(503);
    expect((await clientIp(['loopback'], { 'x-forwarded-for': '127.0.0.1' })).status).toBe(503);
  });
});
