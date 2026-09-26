/**
 * Google OAuth 出站中继改写测试：用本地 HTTP 服务器充当 oauth-relay，
 * 断言改写后的路径、X-Relay-Token 头与请求体透传形状，及非 Google 请求原样放行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { installGoogleOAuthProxy } from './google-proxy.js';

interface Recorded {
  paths: string[];
  headers: Record<string, string | string[] | undefined>;
  bodies: string[];
}

/** 起一个记录请求的本地服务器 */
async function startRecorder(): Promise<{ server: http.Server; url: string; seen: Recorded }> {
  const seen: Recorded = { paths: [], headers: {}, bodies: [] };
  const server = http.createServer((req, res) => {
    seen.paths.push(req.url ?? '');
    seen.headers = { ...seen.headers, ...req.headers };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, seen };
}

let relay: Awaited<ReturnType<typeof startRecorder>>;
let direct: Awaited<ReturnType<typeof startRecorder>>;
const SECRET = 'test-shared-secret-0123456789abcdef';

beforeEach(async () => {
  relay = await startRecorder();
  direct = await startRecorder();
  installGoogleOAuthProxy(relay.url, SECRET);
});

afterEach(async () => {
  await Promise.all([
    new Promise<void>((resolve) => relay.server.close(() => resolve())),
    new Promise<void>((resolve) => direct.server.close(() => resolve())),
  ]);
});

describe('installGoogleOAuthProxy', () => {
  it('token 兑换改写到中继 /oauth/google/token，带 X-Relay-Token 并透传表单', async () => {
    const body = 'code=abc&grant_type=authorization_code&client_id=x&client_secret=y';
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(response.ok).toBe(true);
    expect(relay.seen.paths).toEqual(['/oauth/google/token']);
    expect(relay.seen.headers['x-relay-token']).toBe(SECRET);
    expect(relay.seen.bodies).toEqual([body]);
  });

  it('userinfo 改写到中继 /oauth/google/userinfo，Authorization 头透传', async () => {
    await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: 'Bearer token123' },
    });
    expect(relay.seen.paths).toEqual(['/oauth/google/userinfo']);
    expect(relay.seen.headers['x-relay-token']).toBe(SECRET);
    expect(relay.seen.headers['authorization']).toBe('Bearer token123');
  });

  it('非 Google 域名的请求不改写（直连原始目标）', async () => {
    const response = await fetch(`${direct.url}/some/api`);
    expect(response.ok).toBe(true);
    expect(direct.seen.paths).toEqual(['/some/api']);
    expect(relay.seen.paths).toEqual([]);
  });

  it('非法中继地址或缺失密钥启动即抛错', () => {
    expect(() => installGoogleOAuthProxy('ftp://bad.example', SECRET)).toThrow('协议非法');
    expect(() => installGoogleOAuthProxy('https://relay.example', '')).toThrow('SHARED_SECRET');
  });
});
