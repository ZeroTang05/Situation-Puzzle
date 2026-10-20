/**
 * 实时网关「每用户连接数上限」端到端验证（真实网关 + 真实 WebSocket 客户端）。
 *
 * 背景：连接表是无界 Map，不设闸门等于把服务端内存交给客户端。
 * 这里真起一个网关、真连 N+1 条连接，确认第 N+1 条在鉴权后立刻被断开（4429）。
 *
 * 需要 RATE_LIMIT_TEST_DATABASE_URL（未设置时回落 PAYMENT_TEST_DATABASE_URL）。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';
import * as schemaModule from '@jev/database/schema';
import type { DbHandle } from '@jev/database';
import { setAppContext } from '../context.js';
import { RealtimeGateway } from './realtime.gateway.js';

const databaseUrl = process.env.RATE_LIMIT_TEST_DATABASE_URL ?? process.env.PAYMENT_TEST_DATABASE_URL;
const TICKET_SECRET = 'ws-connection-limit-test-secret';
const MAX_PER_USER = 2;

describe.runIf(!!databaseUrl)('实时连接数上限（真实网关）', () => {
  const dbName = `jev_ws_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let server: http.Server;
  let gateway: RealtimeGateway;
  /** 测试期间保持打开的连接：上限是「同时保持」的数量，提前关掉就测不出来了 */
  const openSockets: WebSocket[] = [];

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
    setAppContext({
      db: handle,
      env: { REALTIME_TICKET_SECRET: TICKET_SECRET, WS_MAX_CONNECTIONS_PER_USER: MAX_PER_USER },
    } as never);

    gateway = new RealtimeGateway();
    server = http.createServer();
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      try { socket.close(); } catch { /* 忽略 */ }
    }
    await gateway?.shutdown();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
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

  async function mintTicket(userId: string): Promise<string> {
    return new SignJWT({ purpose: 'realtime', jti: randomUUID(), sessionId: `sess_${randomUUID().slice(0, 8)}` })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(new TextEncoder().encode(TICKET_SECRET));
  }

  /** 连一条连接并完成鉴权，返回结果（ack 或关闭码）。连接保持打开，由测试结束时统一关闭。 */
  async function connectAndAuth(userId: string): Promise<{ acked: boolean; closeCode?: number; errorCode?: string | undefined }> {
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openSockets.push(socket);
    const ticket = await mintTicket(userId);
    return new Promise((resolve) => {
      let errorCode: string | undefined;
      socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', ticket })));
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; code?: string };
        if (frame.type === 'ack') resolve({ acked: true });
        else if (frame.type === 'error') errorCode = frame.code;
      });
      // 关闭事件一定发生；错误帧先到，先把它记下来，等关闭时一起返回
      socket.on('close', (code) => resolve({ acked: false, closeCode: code, errorCode }));
      socket.on('error', () => resolve({ acked: false, errorCode }));
    });
  }

  it('同一用户的连接数达到上限后，第 N+1 条被断开（4429）', async () => {
    const userId = `u_${randomUUID().slice(0, 8)}`;
    const first = await connectAndAuth(userId);
    expect(first.acked).toBe(true);
    const second = await connectAndAuth(userId);
    expect(second.acked).toBe(true);

    const third = await connectAndAuth(userId);
    expect(third.acked).toBe(false);
    expect(third.closeCode).toBe(4429);
    expect(third.errorCode).toBe('RATE_LIMITED');
  });

  it('不同用户互不影响', async () => {
    const a = `u_${randomUUID().slice(0, 8)}`;
    const b = `u_${randomUUID().slice(0, 8)}`;
    expect((await connectAndAuth(a)).acked).toBe(true);
    expect((await connectAndAuth(a)).acked).toBe(true);
    // a 已达上限，b 仍应正常
    expect((await connectAndAuth(b)).acked).toBe(true);
  });
});
