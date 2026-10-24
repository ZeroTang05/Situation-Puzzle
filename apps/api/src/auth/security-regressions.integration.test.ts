/** 已报告漏洞的真实 HTTP / WebSocket / PostgreSQL 回归；仅使用独立临时数据库。 */
import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import { hashPassword } from 'better-auth/crypto';
import { parseSetCookieHeader } from 'better-auth/cookies';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createDb, user, profiles, account, session, userLobbies, lobbyMembers, puzzles, puzzleVersions, verification, type DbHandle } from '@jev/database';
import { jevConfigFromEnv } from '@jev/jev';
import { setAppContext, type AppContext } from '../context.js';
import { type Env } from '../env.js';
import { createAuth } from './auth.instance.js';
import { createSmtpMailer } from './mailer.js';
import { AppSessionController } from './app-session.controller.js';
import { SessionGuard } from './session.guard.js';
import { EnvelopeInterceptor, type SessionUser } from '../common/http.js';
import { GlobalExceptionFilter } from '../exception.filter.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { RealtimeController } from '../realtime/realtime.controller.js';
import { LobbyService } from '../rooms/lobby.service.js';

@Module({ controllers: [AppSessionController] })
class HandoffTestModule {}

const databaseUrl = process.env.SECURITY_TEST_DATABASE_URL;
describe.runIf(!!databaseUrl)('已报告问题回归（真实服务）', () => {
  const dbName = `jev_security_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let control: Pool;
  let db: DbHandle;
  let server: INestApplication;
  let origin: string;
  let cookie: string;
  let gateway: RealtimeGateway;
  let puzzleId: string;
  const sockets: WebSocket[] = [];
  const lobby = new LobbyService();
  const host = identity('host');
  const guest = identity('guest');
  const removed = identity('removed');

  beforeAll(async () => {
    const base = new URL(databaseUrl!);
    base.pathname = '/postgres';
    control = new Pool({ connectionString: base.toString() });
    await control.query(`CREATE DATABASE "${dbName}"`);
    base.pathname = `/${dbName}`;
    db = createDb(base.toString());
    await migrate(db.db, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle/', import.meta.url)) });
    const env = {
      NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://127.0.0.1', APP_EXTRA_ORIGINS: '',
      AUTH_SECRET: 'security-integration-local-secret-0123456789',
      REALTIME_TICKET_SECRET: 'security-integration-local-realtime-0123456789',
      WS_MAX_CONNECTIONS_PER_USER: 20,
    } as Env;
    // SMTP 适配器是正式实现；本测试只调用密码登录和会话读取，不触发邮件。
    const mailer = createSmtpMailer({ host: '127.0.0.1', port: 2526, user: 'dev', pass: 'dev', from: 'dev@localhost' });
    const auth = createAuth({ env, db, mailer });
    gateway = new RealtimeGateway();
    setAppContext({ env, db, auth, mailer, realtime: gateway, jev: jevConfigFromEnv({}) } as unknown as AppContext);
    for (const person of [host, guest, removed]) {
      await db.db.insert(user).values({ id: person.userId, email: person.email, name: person.name, emailVerified: true });
      await db.db.insert(profiles).values({ userId: person.userId, nickname: person.nickname });
      await db.pool.query('INSERT INTO free_room_accounts (user_id,total) VALUES ($1,100)', [person.userId]);
      await db.db.insert(session).values({ id: `${person.userId}-session`, userId: person.userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) });
    }
    await db.db.insert(account).values({ id: randomUUID(), userId: host.userId, accountId: host.userId, providerId: 'credential', password: await hashPassword('security-test-password') });
    const [puzzle] = await db.db.insert(puzzles).values({ source: 'official' }).returning();
    puzzleId = puzzle!.id;
    await db.db.insert(puzzleVersions).values({ puzzleId, versionNo: 1, title: '测试题', surface: '汤面', answer: '汤底', language: 'zh', hints: [], moderationStatus: 'published' });
    server = await NestFactory.create(HandoffTestModule, { logger: false });
    server.use('/api/v1/auth', toNodeHandler(auth));
    server.setGlobalPrefix('api/v1');
    server.useGlobalGuards(new SessionGuard());
    server.useGlobalFilters(new GlobalExceptionFilter());
    server.useGlobalInterceptors(new EnvelopeInterceptor());
    await server.listen(0, '127.0.0.1');
    origin = await server.getUrl();
    gateway.attach(server.getHttpServer());
    // Better Auth 正式密码登录生成真实 Cookie，不手写签名。
    const login = await fetch(`${origin}/api/v1/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: host.email, password: 'security-test-password' }) });
    expect(login.status).toBe(200);
    const cookies = parseSetCookieHeader(login.headers.get('set-cookie')!);
    const authCookie = cookies.get('__Secure-better-auth.session_token');
    expect(authCookie?.value).toBeTruthy();
    cookie = `__Secure-better-auth.session_token=${authCookie!.value}`;
  }, 120_000);

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway?.shutdown();
    await server?.close();
    await db?.close();
    if (control) {
      await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await control.end();
    }
  }, 60_000);

  function identity(userId: string): SessionUser {
    return { userId, email: `${userId}@example.com`, name: userId, nickname: userId, emailVerified: true, status: 'active', roles: [] };
  }

  /** 真连接先认证再订阅，返回有界等待消息的工具。 */
  async function subscribe(person: SessionUser, lobbyId: string) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
    sockets.push(ws);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    const { ticket } = await new RealtimeController().ticket(person, { authSessionId: `${person.userId}-session` });
    ws.send(JSON.stringify({ type: 'auth', ticket }));
    await until(() => frames.some(f => f.type === 'ack' && f.userId === person.userId));
    ws.send(JSON.stringify({ type: 'lobby.subscribe', lobbyId }));
    await until(() => frames.filter(f => f.type === 'ack').length === 2);
    return { ws, frames };
  }

  async function until(condition: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('等待真实消息超时');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  it.each(['kick', 'leave', 'dismiss'] as const)('%s 后旧订阅拿不到新邀请，迁入客人仍正常收到通知', async action => {
    const { lobbyId } = await lobby.openOrGetLobby(host, 8);
    await db.db.update(userLobbies).set({ status: 'open' }).where(eq(userLobbies.id, lobbyId));
    await db.db.insert(lobbyMembers).values([{ lobbyId, userId: guest.userId }, { lobbyId, userId: removed.userId }]);
    const stale = await subscribe(removed, lobbyId);
    if (action === 'kick') await lobby.kick(host, lobbyId, removed.userId);
    else if (action === 'leave') await lobby.leave(removed, lobbyId);
    else {
      await lobby.dismiss(host, lobbyId);
      await db.db.insert(lobbyMembers).values({ lobbyId, userId: guest.userId });
    }
    const valid = await subscribe(guest, lobbyId);
    await db.db.update(userLobbies).set({ selectedPuzzleId: puzzleId, selectedPuzzleLang: 'zh' }).where(eq(userLobbies.id, lobbyId));
    const room = await lobby.start(host, lobbyId);
    await until(() => valid.frames.some(f => f.type === 'lobby.started'));
    await until(() => stale.ws.readyState === WebSocket.CLOSED);
    expect(stale.frames.some(f => f.type === 'lobby.started')).toBe(false);
    expect(valid.frames.find(f => f.type === 'lobby.started')).toMatchObject({ roomId: room.roomId, inviteToken: room.inviteToken });
    // 开局通知是单次订阅：旧客人的连接不自动跟随同一 lobby 的下一局。
    const count = valid.frames.length;
    gateway.broadcastLobbyStarted(lobbyId, room.roomId, 'next-token');
    valid.ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => valid.frames.length > count);
    expect(valid.frames.filter(f => f.type === 'lobby.started')).toHaveLength(1);
    valid.ws.close();
    await once(valid.ws, 'close');
  });

  it.each(['expired', 'suspended'] as const)('开局时 %s 身份不再接收邀请', async kind => {
    const { lobbyId } = await lobby.openOrGetLobby(host, 8);
    await db.db.insert(lobbyMembers).values({ lobbyId, userId: guest.userId });
    const connection = await subscribe(guest, lobbyId);
    try {
      if (kind === 'expired') await db.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, 'guest-session'));
      else await db.db.update(profiles).set({ status: 'suspended' }).where(eq(profiles.userId, guest.userId));
      await db.db.update(userLobbies).set({ selectedPuzzleId: puzzleId, selectedPuzzleLang: 'zh' }).where(eq(userLobbies.id, lobbyId));
      await lobby.start(host, lobbyId);
      await until(() => connection.ws.readyState === WebSocket.CLOSED);
      expect(connection.frames.some(f => f.type === 'lobby.started')).toBe(false);
    } finally {
      await db.db.update(session).set({ expiresAt: new Date(Date.now() + 3600_000) }).where(eq(session.id, 'guest-session'));
      await db.db.update(profiles).set({ status: 'active' }).where(eq(profiles.userId, guest.userId));
    }
  });

  async function issue(verifier: string) {
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const response = await fetch(`${origin}/api/v1/app-session/handoff?challenge=${challenge}&next=/me`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const url = new URL(response.headers.get('location')!);
    expect(url.searchParams.get('state')).toBe(challenge);
    expect(url.searchParams.get('code')).toBeTruthy();
    return url.searchParams.get('code')!;
  }
  async function exchange(code: string, verifier: string) {
    return fetch(`${origin}/api/v1/app-session/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, verifier }) });
  }

  it('错误 verifier 无法兑换他人 code，正确兑换一次后拒绝重放', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await issue(verifier);
    expect((await exchange(code, randomBytes(32).toString('base64url'))).status).toBe(401);
    const response = await exchange(code, verifier);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const me = await fetch(`${origin}/api/v1/auth/get-session`, { headers: { Authorization: `Bearer ${data.token}` } });
    expect((await me.json()).user.id).toBe(host.userId);
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  it('支持生产 Cookie 名，且并发兑换只有一次成功', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await issue(verifier);
    const results = await Promise.all([exchange(code, verifier), exchange(code, verifier)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
  });

  it('缺少挑战摘要、旧格式或过期 code 均拒绝', async () => {
    expect((await fetch(`${origin}/api/v1/app-session/handoff`, { headers: { cookie }, redirect: 'manual' })).status).toBe(400);
    const verifier = randomBytes(32).toString('base64url');
    const code = await issue(verifier);
    await db.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await exchange(code, verifier)).status).toBe(401);
    expect((await exchange('old.jwt.code', verifier)).status).toBe(400);
  });
});
