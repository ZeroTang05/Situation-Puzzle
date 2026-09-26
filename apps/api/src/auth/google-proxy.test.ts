/**
 * Google OAuth 出站代理改写测试：用本地 HTTP 服务器充当代理节点，
 * 断言改写后的 URL 形状为 `<代理>/<原域名>/<路径>`，且非 Google 请求原样放行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { installGoogleOAuthProxy } from './google-proxy.js';

/** 起一个记录请求路径的本地服务器 */
async function startRecorder(): Promise<{ server: http.Server; url: string; seen: () => string[] }> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, seen: () => paths };
}

let proxy: Awaited<ReturnType<typeof startRecorder>>;
let direct: Awaited<ReturnType<typeof startRecorder>>;

beforeEach(async () => {
  proxy = await startRecorder();
  direct = await startRecorder();
  installGoogleOAuthProxy(proxy.url);
});

afterEach(async () => {
  await Promise.all([
    new Promise<void>((resolve) => proxy.server.close(() => resolve())),
    new Promise<void>((resolve) => direct.server.close(() => resolve())),
  ]);
});

describe('installGoogleOAuthProxy', () => {
  it('把 googleapis 域名的请求改写到代理节点', async () => {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    expect(response.ok).toBe(true);
    // 代理节点收到的路径 = 原域名 + 原路径
    expect(proxy.seen()).toEqual(['/www.googleapis.com/oauth2/v3/certs']);
  });

  it('改写保留查询串与 POST 方法', async () => {
    await fetch('https://oauth2.googleapis.com/token?grant=x', { method: 'POST', body: 'code=1' });
    expect(proxy.seen()).toEqual(['/oauth2.googleapis.com/token?grant=x']);
  });

  it('非 Google 域名的请求不改写（直连原始目标）', async () => {
    const response = await fetch(`${direct.url}/some/api`);
    expect(response.ok).toBe(true);
    expect(direct.seen()).toEqual(['/some/api']);
    expect(proxy.seen()).toEqual([]);
  });

  it('非法代理地址启动即抛错', () => {
    expect(() => installGoogleOAuthProxy('ftp://bad.example')).toThrow('协议非法');
  });
});
