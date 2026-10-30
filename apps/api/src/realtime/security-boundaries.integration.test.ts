/** 安全边界回归：真实 PostgreSQL、网关和 WebSocket；临时数据库在结束后删除。 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';
import * as schema from '@jev/database/schema';
import type { DbHandle } from '@jev/database';
import type { SessionUser } from '../common/http.js';
import { setAppContext } from '../context.js';
import { LobbyService } from '../rooms/lobby.service.js';
import { RealtimeGateway } from './realtime.gateway.js';

const databaseUrl = process.env.SECURITY_TEST_DATABASE_URL;
const secret = 'security-boundaries-integration-secret';

describe.runIf(!!databaseUrl)('安全边界（真实数据库与实时连接）', () => {
  const dbName = `jev_security_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let pool: Pool;
  let handle: DbHandle;
  let server: http.Server;
  let gateway: RealtimeGateway;
  const sockets: WebSocket[] = [];
  const lobbyService = new LobbyService();

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = '/postgres';
    control = new Pool({ connectionString: adminUrl.toString() });
    await control.query(`CREATE DATABASE "${dbName}"`);
    const testUrl = new URL(databaseUrl!);
    testUrl.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: testUrl.toString() });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle/', import.meta.url)) });
    handle = { db, pool, tx: (fn) => db.transaction(fn as never) as never, close: () => pool.end() };
    setAppContext({ db: handle, env: { REALTIME_TICKET_SECRET: secret, WS_MAX_CONNECTIONS_PER_USER: 5 } } as never);
    gateway = new RealtimeGateway();
    server = http.createServer();
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // 记录实际写入次数，确认心跳没有逐帧放大为数据库写入。
    await pool.query(`CREATE TABLE presence_writes (user_id text);
      CREATE FUNCTION count_presence_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO presence_writes VALUES (NEW.user_id); RETURN NEW; END $$;
      CREATE TRIGGER count_presence_write AFTER INSERT OR UPDATE ON presence
      FOR EACH ROW EXECUTE FUNCTION count_presence_write()`);
  }, 30_000);

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway?.shutdown();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool?.end();
    if (control) {
      try { await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
      finally { await control.end(); }
    }
  }, 30_000);

  /** 建立真实身份、会话和所属房间，以正常权限路径订阅。 */
  async function identity() {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const user: SessionUser = { userId, email: `${userId}@example.com`, emailVerified: true, name: '测试玩家', nickname: '测试玩家', roles: [], status: 'active' };
    await handle.db.insert(schema.user).values({ id: userId, name: user.name, email: user.email });
    await handle.db.insert(schema.profiles).values({ userId, nickname: user.nickname });
    await handle.db.insert(schema.session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    const [room] = await handle.db.insert(schema.rooms).values({ creatorUserId: userId, hostUserId: userId, inviteTokenHash: randomUUID() }).returning();
    await handle.db.insert(schema.roomMembers).values({ roomId: room!.id, userId, status: 'joined' });
    return { user, sessionId, roomId: room!.id };
  }

  /** 收集服务器帧；等待使用真实网络事件和有限的轮询超时。 */
  async function connect(id: Awaited<ReturnType<typeof identity>>) {
    const ticket = await new SignJWT({ purpose: 'realtime', jti: randomUUID(), sessionId: id.sessionId })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(id.user.userId).setIssuedAt().setExpirationTime('30s')
      .sign(new TextEncoder().encode(secret));
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    sockets.push(socket);
    const frames: Array<Record<string, unknown>> = [];
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', ticket }));
    await expect.poll(() => frames.some((frame) => frame.userId === id.user.userId)).toBe(true);
    frames.length = 0;
    return { socket, frames, closed };
  }

  /** 阻塞查询已真正抵达行锁/表锁时才推进测试，避免依赖固定延时猜测并发时序。 */
  async function waitForBlocked(query: string) {
    await expect.poll(async () => {
      const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE $2`, [dbName, `%${query}%`]);
      return result.rows[0]!.n;
    }, { timeout: 3000, interval: 20 }).toBeGreaterThan(0);
  }

  it.each([false, true])('超大消息（含二进制分片=%s）在解析和排队前关闭', async (fragmented) => {
    const client = await connect(await identity());
    if (fragmented) {
      client.socket.send(Buffer.alloc(10_000, 32), { binary: true, fin: false });
      client.socket.send(Buffer.alloc(10_000, 32), { binary: true, fin: true });
    } else client.socket.send(' '.repeat(20_000));
    expect(await client.closed).toBe(1009);
  });

  it.each([false, true])('数据库阻塞时按待处理数量或字节容量（大消息=%s）拒绝积压', async (large) => {
    const id = await identity();
    const otherId = await identity();
    const client = await connect(id);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE');
    try {
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId: id.roomId, lastSeq: 0 }));
      await waitForBlocked('session');
      const ping = JSON.stringify({ type: 'ping' }) + (large ? ' '.repeat(15_000) : '');
      for (let i = 0; i < (large ? 6 : 40); i++) client.socket.send(ping);
      expect(await client.closed).toBe(4429);
      expect(client.frames.some((frame) => frame.code === 'RATE_LIMITED')).toBe(true);
      // 另一个用户仍能完成身份验证与心跳。
      const other = await connect(otherId);
      other.socket.send(JSON.stringify({ type: 'ping' }));
      await expect.poll(() => other.frames.some((frame) => frame.type === 'ack')).toBe(true);
      other.socket.close();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  }, 15_000);

  it('逐条等待应答仍受消息速率限制，正常短连发可完成', async () => {
    const client = await connect(await identity());
    // 逐条应答防止队列先达到上限，单独验证接收速率限制。
    for (let i = 0; i < 100 && client.socket.readyState === WebSocket.OPEN; i++) {
      const before = client.frames.length;
      client.socket.send(JSON.stringify({ type: 'ping' }));
      await new Promise<void>((resolve) => {
        const done = () => { client.socket.off('message', done); client.socket.off('close', done); resolve(); };
        client.socket.once('message', done);
        client.socket.once('close', done);
        if (client.frames.length > before) done();
      });
    }
    expect(await client.closed).toBe(4429);
    expect(client.frames.filter((frame) => frame.type === 'ack').length).toBeGreaterThan(3);
    expect(client.frames.some((frame) => frame.code === 'RATE_LIMITED')).toBe(true);
  });

  it('正常订阅、事件补齐和开局通知保留，连续心跳合并为周期写入', async () => {
    const id = await identity();
    const { lobbyId } = await lobbyService.openOrGetLobby(id.user, 8);
    await handle.db.insert(schema.roomEvents).values({ eventId: randomUUID(), roomId: id.roomId, seq: 1, type: 'room.visibility_changed', payload: { isPublic: true } });
    await handle.db.update(schema.rooms).set({ lastSeq: 1 }).where(eq(schema.rooms.id, id.roomId));
    const client = await connect(id);
    client.socket.send(JSON.stringify({ type: 'subscribe', roomId: id.roomId, lastSeq: 0 }));
    await expect.poll(() => client.frames.some((frame) => frame.type === 'sync.ready')).toBe(true);
    expect(client.frames.some((frame) => frame.seq === 1)).toBe(true);
    client.socket.send(JSON.stringify({ type: 'lobby.subscribe', lobbyId }));
    await expect.poll(() => client.frames.some((frame) => frame.type === 'ack')).toBe(true);
    gateway.broadcastLobbyStarted(lobbyId, id.roomId, 'test-invite');
    await expect.poll(() => client.frames.some((frame) => frame.type === 'lobby.started')).toBe(true);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE presence IN ACCESS EXCLUSIVE MODE');
    try {
      client.frames.length = 0;
      for (let i = 0; i < 20; i++) {
        client.socket.send(JSON.stringify({ type: 'ping' }));
        await new Promise<void>((resolve) => client.socket.once('message', () => resolve()));
      }
      expect(client.frames.filter((frame) => frame.type === 'ack')).toHaveLength(20);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await expect.poll(async () => (await pool.query('SELECT count(*)::int AS n FROM presence_writes WHERE user_id=$1', [id.user.userId])).rows[0].n,
      { timeout: 6500, interval: 50 }).toBeGreaterThan(0);
    const writes = await pool.query('SELECT count(*)::int AS n FROM presence_writes WHERE user_id=$1', [id.user.userId]);
    expect(writes.rows[0].n).toBeLessThanOrEqual(2);
    client.socket.send(JSON.stringify({ type: 'unsubscribe', roomId: id.roomId }));
    await expect.poll(async () => (await pool.query('SELECT count(*)::int AS n FROM presence WHERE user_id=$1', [id.user.userId])).rows[0].n,
      { timeout: 6500, interval: 50 }).toBe(0);
    client.socket.close();
  }, 20_000);

  it.each([false, true])('批量补齐在客户端持续读取时完成，停止读取时限制发送缓冲（暂停=%s）', async (paused) => {
    const id = await identity();
    await handle.db.insert(schema.roomEvents).values(Array.from({ length: 1000 }, (_, index) => ({
      eventId: randomUUID(), roomId: id.roomId, seq: index + 1,
      type: 'discussion.created', payload: { text: '汤'.repeat(3300) },
    })));
    await handle.db.update(schema.rooms).set({ lastSeq: 1000 }).where(eq(schema.rooms.id, id.roomId));
    const accepted = new Promise<import('node:net').Socket>((resolve) => server.once('connection', resolve));
    const client = await connect(id);
    const transport = await accepted;
    if (paused) client.socket.pause();
    try {
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId: id.roomId, lastSeq: 0 }));
      if (paused) {
        await expect.poll(() => transport.destroyed, { timeout: 5000 }).toBe(true);
      } else {
        await expect.poll(() => client.frames.some((frame) => frame.type === 'sync.ready'), { timeout: 5000 }).toBe(true);
        expect(client.frames.filter((frame) => typeof frame.seq === 'number')).toHaveLength(1000);
      }
    } finally {
      client.socket.resume();
      client.socket.close();
    }
  }, 15_000);

  it.each(['revoked_at', 'expires_at'])('等待会客厅锁期间邀请失效（%s），不会获得座位', async (column) => {
    const owner = await identity();
    const guest = await identity();
    const { lobbyId } = await lobbyService.openOrGetLobby(owner.user, 8);
    const { token } = await lobbyService.createInvite(owner.user, lobbyId);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM user_lobbies WHERE id=$1 FOR UPDATE', [lobbyId]);
    // 两个固定列名来自测试参数，用户输入不能参与 SQL 标识符。
    await blocker.query(`UPDATE lobby_invites SET ${column} = now() - interval '1 second' WHERE lobby_id=$1`, [lobbyId]);
    const joining = lobbyService.join(guest.user, token).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForBlocked('user_lobbies');
      await blocker.query('COMMIT');
      expect(await joining).toMatchObject({ error: { code: 'LOBBY_NOT_FOUND' } });
      expect((await pool.query('SELECT * FROM lobby_members WHERE lobby_id=$1', [lobbyId])).rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('邀请轮换也等待会客厅锁；并发生成只留下一个有效邀请，合法加入保持幂等', async () => {
    const owner = await identity();
    const guest = await identity();
    const { lobbyId } = await lobbyService.openOrGetLobby(owner.user, 8);
    const old = await lobbyService.createInvite(owner.user, lobbyId);
    await expect(lobbyService.createInvite(guest.user, lobbyId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM user_lobbies WHERE id=$1 FOR UPDATE', [lobbyId]);
    const rotating = lobbyService.createInvite(owner.user, lobbyId);
    try {
      await waitForBlocked('user_lobbies');
      await blocker.query('COMMIT');
      await rotating;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    const invites = await Promise.all(Array.from({ length: 5 }, () => lobbyService.createInvite(owner.user, lobbyId)));
    const current = await pool.query('SELECT token_hash FROM lobby_invites WHERE lobby_id=$1 AND revoked_at IS NULL', [lobbyId]);
    expect(current.rowCount).toBe(1);
    await expect(lobbyService.join(guest.user, old.token)).rejects.toMatchObject({ code: 'LOBBY_NOT_FOUND' });
    let validToken = '';
    for (const invite of invites) {
      const resolved = await lobbyService.resolveInvite(invite.token).then(() => true, () => false);
      if (resolved) validToken = invite.token;
    }
    expect(validToken).not.toBe('');
    expect(await lobbyService.join(guest.user, validToken)).toEqual({ lobbyId });
    expect(await lobbyService.join(guest.user, validToken)).toEqual({ lobbyId });
    expect((await pool.query('SELECT * FROM lobby_members WHERE lobby_id=$1', [lobbyId])).rowCount).toBe(1);
    expect((await pool.query('SELECT status FROM user_lobbies WHERE id=$1', [lobbyId])).rows[0].status).toBe('open');
    await lobbyService.dismiss(owner.user, lobbyId);
    await expect(lobbyService.join(guest.user, validToken)).rejects.toMatchObject({ code: 'LOBBY_NOT_FOUND' });
  });
});
