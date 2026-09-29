/** 实时网关：协议心跳、批量进度查询、串行补齐与可撤销订阅。 */
import { Logger } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import { presence, profiles, roomEvents, roomMembers, rooms, session } from '@jev/database';
import { wsClientFrameSchema } from '@jev/contracts';
import { app } from '../context.js';
import { consumeJti } from './realtime.controller.js';

interface Subscription { roomId: string; lastSeq: number }
interface ClientState {
  userId: string | null;
  sessionId: string | null;
  subscriptions: Map<string, Subscription>;
  lastPongAt: number;
  lastPingAt: number;
  lastActiveAt: number;
  connectedAt: number;
  queue: Promise<void>;
  scheduled: boolean;
}

export class RealtimeGateway {
  private readonly logger = new Logger('RealtimeGateway');
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private ticker: NodeJS.Timeout | null = null;
  private listenClient: import('pg').PoolClient | null = null;
  private ticking = false;
  private stopping = false;
  private lastHeartbeatAt = 0;

  attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws));
    });
    this.wss.on('connection', (socket) => this.connect(socket));
    this.ticker = setInterval(() => { void this.tick(); }, 5_000);
    void this.listen();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.ticker) clearInterval(this.ticker);
    for (const socket of this.clients.keys()) socket.terminate();
    if (this.listenClient) {
      await this.listenClient.query('UNLISTEN jev_room_events');
      this.listenClient.release();
      this.listenClient = null;
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** NOTIFY 即时唤醒；周期查询仍从数据库持久事件恢复遗漏。 */
  private async listen(): Promise<void> {
    try {
      const connection = await app().db.pool.connect();
      if (this.stopping) { connection.release(); return; }
      this.listenClient = connection;
      connection.on('notification', (message) => {
        if (message.channel !== 'jev_room_events' || !message.payload) return;
        for (const [socket, state] of this.clients) {
          if (state.subscriptions.has(message.payload)) this.scheduleDelivery(socket, state);
        }
      });
      connection.on('error', (error) => this.logger.error('实时数据库通知连接错误', error));
      await connection.query('LISTEN jev_room_events');
    } catch (error) { this.logger.error('实时数据库通知建立失败', error); }
  }

  private connect(socket: WebSocket): void {
    const now = Date.now();
    const state: ClientState = { userId: null, sessionId: null, subscriptions: new Map(), lastPongAt: now, lastPingAt: 0, lastActiveAt: 0, connectedAt: now, queue: Promise.resolve(), scheduled: false };
    this.clients.set(socket, state);
    const authTimer = setTimeout(() => { if (!state.userId) socket.close(4401, 'auth_timeout'); }, 5_000);
    socket.on('pong', () => { state.lastPongAt = Date.now(); });
    socket.on('message', (raw) => {
      state.lastPongAt = Date.now();
      this.enqueue(socket, state, () => this.onMessage(socket, state, raw.toString()));
    });
    socket.on('error', (error) => this.logger.warn(`实时连接错误: ${error.message}`));
    socket.on('close', (code) => {
      clearTimeout(authTimer);
      this.clients.delete(socket);
      this.logger.log(JSON.stringify({ event: 'ws.closed', code, durationMs: Date.now() - state.connectedAt }));
      void this.updatePresence(state.userId).catch((error: unknown) => this.logger.error('在线状态清理失败', error));
    });
  }

  /** 单连接任务串行，防止补齐与订阅同时改写游标。 */
  private enqueue(socket: WebSocket, state: ClientState, action: () => Promise<void>): void {
    state.queue = state.queue.then(async () => {
      if (socket.readyState === 1 && this.clients.get(socket) === state) await action();
    }).catch((error: unknown) => {
      this.logger.error('实时操作失败', error);
      socket.close(1011, 'operation_failed');
    });
  }

  private scheduleDelivery(socket: WebSocket, state: ClientState): void {
    if (state.scheduled) return;
    state.scheduled = true;
    this.enqueue(socket, state, async () => {
      state.scheduled = false;
      for (const sub of [...state.subscriptions.values()]) {
        if (await this.authorized(socket, state, sub.roomId)) await this.deliver(socket, state, sub);
      }
    });
  }

  /** 会话失效和成员撤权后，旧连接立即失去后续读取权限。 */
  private async authorized(socket: WebSocket, state: ClientState, roomId: string): Promise<boolean> {
    if (!state.userId || !state.sessionId) return false;
    const [identity] = await app().db.db.select({ status: profiles.status }).from(session)
      .innerJoin(profiles, eq(profiles.userId, session.userId))
      .where(and(eq(session.id, state.sessionId), eq(session.userId, state.userId), gt(session.expiresAt, new Date()))).limit(1);
    if (!identity) { this.reject(socket, 'UNAUTHORIZED', '登录已过期', 4401); return false; }
    if (identity.status !== 'active') { this.reject(socket, 'FORBIDDEN', '账号已停用', 4403); return false; }
    const [member] = await app().db.db.select({ status: roomMembers.status }).from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, state.userId))).limit(1);
    if (!member || member.status !== 'joined') {
      state.subscriptions.delete(roomId);
      this.reject(socket, 'FORBIDDEN', '你已不在该房间', 4403);
      return false;
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const [socket, state] of this.clients) {
        if (now - state.lastPongAt > 60_000) { this.logger.log('ws heartbeat_timeout'); socket.terminate(); continue; }
        if (socket.readyState === 1 && now - state.lastPingAt >= 20_000) { socket.ping(); state.lastPingAt = now; }
      }
      if (now - this.lastHeartbeatAt < 15_000) return;
      this.lastHeartbeatAt = now;
      const ids = [...new Set([...this.clients.values()].flatMap((s) => [...s.subscriptions.keys()]))];
      if (!ids.length) return;
      const db = app().db.db;
      const [watermarks, members, identities] = await Promise.all([
        db.select({ roomId: rooms.id, seq: rooms.lastSeq }).from(rooms).where(inArray(rooms.id, ids)),
        db.select().from(roomMembers).where(inArray(roomMembers.roomId, ids)),
        db.select({ id: session.id, status: profiles.status }).from(session).innerJoin(profiles, eq(profiles.userId, session.userId))
          .where(and(inArray(session.id, [...this.clients.values()].flatMap((s) => s.sessionId ? [s.sessionId] : [])), gt(session.expiresAt, new Date()))),
      ]);
      const allowed = new Set(members.filter((m) => m.status === 'joined').map((m) => `${m.roomId}:${m.userId}`));
      const identityMap = new Map(identities.map((i) => [i.id, i.status]));
      for (const [socket, state] of this.clients) {
        if (!state.userId || !state.subscriptions.size) continue;
        const identity = identityMap.get(state.sessionId ?? '');
        if (!identity) { this.reject(socket, 'UNAUTHORIZED', '登录已过期', 4401); continue; }
        if (identity !== 'active' || [...state.subscriptions.keys()].some((id) => !allowed.has(`${id}:${state.userId}`))) {
          this.reject(socket, 'FORBIDDEN', '访问权限已失效', 4403); continue;
        }
        const own = watermarks.filter((w) => state.subscriptions.has(w.roomId));
        this.send(socket, { type: 'heartbeat', watermarks: own });
        if (own.some((w) => w.seq > state.subscriptions.get(w.roomId)!.lastSeq)) this.scheduleDelivery(socket, state);
      }
    } catch (error) { this.logger.error('实时巡检失败', error); }
    finally { this.ticking = false; }
  }

  private async onMessage(socket: WebSocket, state: ClientState, raw: string): Promise<void> {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { this.reject(socket, 'VALIDATION_FAILED', '消息格式错误', 1007); return; }
    const parsed = wsClientFrameSchema.safeParse(data);
    if (!parsed.success) { this.reject(socket, 'VALIDATION_FAILED', '消息格式错误', 1007); return; }
    const frame = parsed.data;
    if (frame.type === 'auth') {
      if (state.userId) { this.reject(socket, 'UNAUTHORIZED', '连接已验证身份', 4401); return; }
      try {
        const secret = new TextEncoder().encode(app().env.REALTIME_TICKET_SECRET ?? app().env.AUTH_SECRET + ':rt');
        const { payload } = await jwtVerify(frame.ticket, secret);
        if (payload.purpose !== 'realtime' || !payload.sub || !payload.jti || typeof payload.sessionId !== 'string' || !consumeJti(payload.jti)) throw new Error('invalid_ticket');
        state.userId = payload.sub;
        state.sessionId = payload.sessionId;
        this.send(socket, { type: 'ack', userId: state.userId });
      } catch { this.reject(socket, 'UNAUTHORIZED', '票据无效或过期', 4401); }
      return;
    }
    if (!state.userId) { this.reject(socket, 'UNAUTHORIZED', '请先登录', 4401); return; }
    if (frame.type === 'ping') {
      state.lastActiveAt = frame.visible === false ? 0 : Date.now();
      await this.updatePresence(state.userId);
      this.send(socket, { type: 'ack' });
      return;
    }
    if (frame.type === 'unsubscribe') { state.subscriptions.delete(frame.roomId); await this.updatePresence(state.userId); return; }
    if (frame.type === 'subscribe') {
      if (!await this.authorized(socket, state, frame.roomId)) return;
      const sub = { roomId: frame.roomId, lastSeq: frame.lastSeq };
      state.subscriptions.set(frame.roomId, sub);
      if (await this.deliver(socket, state, sub)) this.send(socket, { type: 'sync.ready', roomId: sub.roomId, watermark: sub.lastSeq });
    }
  }

  /** 固定高水位、顺序分页；发现缺口明确要求快照，不跳过序号。 */
  private async deliver(socket: WebSocket, state: ClientState, sub: Subscription): Promise<boolean> {
    const db = app().db.db;
    const [room] = await db.select({ seq: rooms.lastSeq }).from(rooms).where(eq(rooms.id, sub.roomId)).limit(1);
    if (!room || sub.lastSeq > room.seq || room.seq - sub.lastSeq > 1000) { this.resnapshot(socket, state, sub); return false; }
    const from = sub.lastSeq;
    while (sub.lastSeq < room.seq && socket.readyState === 1) {
      if (state.subscriptions.get(sub.roomId) !== sub || !await this.authorized(socket, state, sub.roomId)) return false;
      const rows = await db.select().from(roomEvents)
        .where(and(eq(roomEvents.roomId, sub.roomId), gt(roomEvents.seq, sub.lastSeq), lte(roomEvents.seq, room.seq))).orderBy(asc(roomEvents.seq)).limit(100);
      if (!rows.length) { this.resnapshot(socket, state, sub); return false; }
      for (const row of rows) {
        if (row.seq !== sub.lastSeq + 1) { this.resnapshot(socket, state, sub); return false; }
        if (socket.readyState !== 1 || state.subscriptions.get(sub.roomId) !== sub) return false;
        this.send(socket, { schemaVersion: 1, eventId: row.eventId, roomId: row.roomId, roundId: row.roundId, seq: row.seq, type: row.type, occurredAt: row.createdAt.toISOString(), payload: row.payload });
        sub.lastSeq = row.seq;
      }
    }
    if (sub.lastSeq > from) this.logger.debug(JSON.stringify({ event: 'ws.replayed', count: sub.lastSeq - from }));
    return socket.readyState === 1;
  }

  private resnapshot(socket: WebSocket, state: ClientState, sub: Subscription): void {
    state.subscriptions.delete(sub.roomId);
    this.send(socket, { type: 'error', code: 'RESYNC_REQUIRED', requestId: sub.roomId, message: '请重新同步房间' });
  }

  dropUserFromRoom(userId: string, roomId: string): void {
    for (const [socket, state] of this.clients) if (state.userId === userId && state.subscriptions.has(roomId)) {
      state.subscriptions.delete(roomId);
      this.reject(socket, 'FORBIDDEN', '你已不在该房间', 4403);
    }
  }

  /** 多标签页聚合活动，关闭一页不抹掉另一页的在线状态。 */
  private async updatePresence(userId: string | null): Promise<void> {
    if (!userId || this.stopping) return;
    const active = [...this.clients.values()].filter((s) => s.userId === userId && s.subscriptions.size && s.lastActiveAt > Date.now() - 60_000)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (!active) { await app().db.db.delete(presence).where(eq(presence.userId, userId)); return; }
    const roomId = [...active.subscriptions.keys()][0]!;
    await app().db.db.insert(presence).values({ userId, roomId, lastSeenAt: new Date(active.lastActiveAt) })
      .onConflictDoUpdate({ target: presence.userId, set: { roomId, lastSeenAt: new Date(active.lastActiveAt) } });
  }

  private reject(socket: WebSocket, code: string, message: string, closeCode: number): void {
    this.send(socket, { type: 'error', code, message });
    socket.close(closeCode, code);
  }
  private send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  }
}
