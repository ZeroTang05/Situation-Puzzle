/**
 * 限流存储与拦截器全链路（真实数据库）：需 RATE_LIMIT_TEST_DATABASE_URL
 * （未设置时回落 PAYMENT_TEST_DATABASE_URL，方便复用同一条联调命令）。
 *
 * 覆盖：
 *   计数在固定窗口内累加 → 超过上限拒绝 → 不同桶互不影响 → 换窗口即重置
 *   拦截器：无规则零开销放行 → 按用户计数 → 按 IP 计数 → 匿名请求退回按 IP
 *
 * 用独立临时数据库跑，结束后整块删除，不碰其它库的数据。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import * as schemaModule from '@jev/database/schema';
import type { DbHandle } from '@jev/database';
import { rateLimitBuckets } from '@jev/database';
import { setAppContext } from '../context.js';
import { consumeRateLimit } from './rate-limit.store.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import { RateLimit, windowStartOf, type RateLimitRule } from './rate-limit.js';

const databaseUrl = process.env.RATE_LIMIT_TEST_DATABASE_URL ?? process.env.PAYMENT_TEST_DATABASE_URL;

/** 造一个最小可用的 ExecutionContext：handler 上挂规则，request 上挂会话与 IP。 */
function contextOf(rule: RateLimitRule | undefined, opts: { userId?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  const request = {
    sessionUser: opts.userId ? { userId: opts.userId } : undefined,
    ip: opts.ip,
    socket: { remoteAddress: opts.ip },
    headers,
  };
  const response = { setHeader: vi.fn() };
  const handler = function handler() {};
  if (rule) RateLimit(rule)(handler as never);
  return {
    ctx: {
      getHandler: () => handler,
      getClass: () => class Noop {},
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ExecutionContext,
    response,
  };
}

describe.runIf(!!databaseUrl)('限流存储与拦截器（真实数据库）', () => {
  const dbName = `jev_rl_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;

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

    const db = drizzle(pool, { schema: schemaModule });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle/', import.meta.url)) });
    const handle: DbHandle = { db, pool, tx: (fn) => db.transaction(fn as never) as never, close: () => pool.end() };
    setAppContext({ db: handle } as never);
  });

  afterAll(async () => {
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

  it('同一窗口内计数累加，超过上限即拒绝', async () => {
    const key = `test:user:${randomUUID()}`;
    const windowStart = new Date(windowStartOf(Date.now(), 60));
    expect((await consumeRateLimit(key, windowStart, 2)).allowed).toBe(true);
    expect((await consumeRateLimit(key, windowStart, 2)).allowed).toBe(true);
    const third = await consumeRateLimit(key, windowStart, 2);
    expect(third.allowed).toBe(false);
    expect(third.count).toBe(3);
  });

  it('不同桶互不影响', async () => {
    const a = `test:a:${randomUUID()}`;
    const b = `test:b:${randomUUID()}`;
    const windowStart = new Date(windowStartOf(Date.now(), 60));
    await consumeRateLimit(a, windowStart, 1);
    expect((await consumeRateLimit(a, windowStart, 1)).allowed).toBe(false);
    expect((await consumeRateLimit(b, windowStart, 1)).allowed).toBe(true);
  });

  it('换窗口即重置计数', async () => {
    const key = `test:reset:${randomUUID()}`;
    const first = new Date(windowStartOf(Date.now(), 60));
    const next = new Date(first.getTime() + 60_000);
    expect((await consumeRateLimit(key, first, 1)).allowed).toBe(true);
    expect((await consumeRateLimit(key, first, 1)).allowed).toBe(false);
    expect((await consumeRateLimit(key, next, 1)).allowed).toBe(true);
  });

  it('没有规则的接口零开销放行', async () => {
    const { ctx } = contextOf(undefined, { userId: 'u1' });
    const next = { handle: () => of('ok') };
    await expect(new RateLimitInterceptor().intercept(ctx, next)).resolves.toBeTruthy();
  });

  it('按用户计数：超过上限抛出 RATE_LIMITED 并带 Retry-After', async () => {
    const rule: RateLimitRule = { scope: 'test.user', limit: 1, windowSeconds: 60, keyBy: 'user' };
    const userId = `u_${randomUUID().slice(0, 8)}`;
    const interceptor = new RateLimitInterceptor();
    const next = { handle: () => of('ok') };

    const first = contextOf(rule, { userId });
    await expect(interceptor.intercept(first.ctx, next)).resolves.toBeTruthy();

    const second = contextOf(rule, { userId });
    await expect(interceptor.intercept(second.ctx, next)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(second.response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('按 IP 计数：同一 IP 共享额度，不同 IP 各自独立', async () => {
    const rule: RateLimitRule = { scope: 'test.ip', limit: 1, windowSeconds: 60, keyBy: 'ip' };
    const interceptor = new RateLimitInterceptor();
    const next = { handle: () => of('ok') };
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;

    await expect(interceptor.intercept(contextOf(rule, { ip }).ctx, next)).resolves.toBeTruthy();
    await expect(interceptor.intercept(contextOf(rule, { ip }).ctx, next)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(interceptor.intercept(contextOf(rule, { ip: '203.0.113.7' }).ctx, next)).resolves.toBeTruthy();
  });

  it('按用户的规则遇到匿名请求时退回按 IP，不放行无主流量', async () => {
    const rule: RateLimitRule = { scope: 'test.fallback', limit: 1, windowSeconds: 60, keyBy: 'user' };
    const interceptor = new RateLimitInterceptor();
    const next = { handle: () => of('ok') };
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 50}`;

    await expect(interceptor.intercept(contextOf(rule, { ip }).ctx, next)).resolves.toBeTruthy();
    await expect(interceptor.intercept(contextOf(rule, { ip }).ctx, next)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('计数真的落库了（跨请求共享，不依赖进程内存）', async () => {
    const key = `test:persist:${randomUUID()}`;
    const windowStart = new Date(windowStartOf(Date.now(), 60));
    await consumeRateLimit(key, windowStart, 5);
    const rows = await pool.query('select count from rate_limit_buckets where bucket_key = $1', [key]);
    expect(rows.rows[0].count).toBe(1);
    const table = rateLimitBuckets;
    expect(table.bucketKey.name).toBe('bucket_key');
  });
});
