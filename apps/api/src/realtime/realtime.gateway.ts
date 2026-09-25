/**
 * 实时网关：标准 WebSocket（/ws），订阅房间事件、快照握手、心跳与断线恢复
 * （docs/rebuild/04-ROOM-JEV.md §5）。
 *
 * 连接流程：HTTP 票据 → ws 连接 → 5 秒内 auth 帧 → subscribe + lastSeq →
 * 服务端补事件 → sync.ready 后开放写操作。数据库事件表承担可靠发送：
 * NOTIFY 只是唤醒，5 秒扫描兜底；客户端按 seq 去重补齐。
 */
import { Logger } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { WebSocketServer as WsServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { presence, roomEvents, roomMembers, rooms } from '@jev/database';
import { roomEventSchema, wsClientFrameSchema } from '@jev/contracts';
import { app } from '../context.js';
import { consumeJti } from './realtime.controller.js';

interface Subscription {
  roomId: string;
  /** 最后连续应用的序号 */
  lastSeq: number;
  /** 快照握手期间暂停直发，改为缓冲 */
  syncing: boolean;
}

interface ClientState {
  userId: string | null;
  subscriptions: Map<string, Subscription>;
  lastPongAt: number;
  alive: boolean;
}

/**
 * 说明：不走 @nestjs/platform-ws 的 WsAdapter——tsx(esbuild) 环境下适配器与
 * Nest 生命周期挂载不稳定；这里直接用标准 ws 库挂 upgrade 事件，协议不变。
 */
export class RealtimeGateway {
  private readonly logger = new Logger('RealtimeGateway');
  private clients = new WeakMap<WebSocket, ClientState>();
  private ticker: NodeJS.Timeout | null = null;
  private listenClient: import('pg').PoolClient | null = null;
  private readonly wss = new WsServer({ noServer: true });

  /** 挂到已监听的 http server：upgrade 到 /ws 的连接交由 ws 服务器处理。 */
  attach(httpServer: HttpServer): void {
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'ws://localhost').pathname;
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });
    this.wss.on('connection', (ws: WebSocket) => this.handleConnection(ws));
    this.ticker = setInterval(() => void this.tick(), 5000);
    void this.startListen();
  }

  async shutdown(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.listenClient?.release();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** 监听事务提交通知：仅作为唤醒信号，扫描是正确性兜底。 */
  private async startListen(): Promise<void> {
    try {
      const client = await app().db.pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel === 'jev_room_events' && msg.payload) {
          void this.broadcastRoom(msg.payload);
        }
      });
      await client.query('LISTEN jev_room_events');
      this.listenClient = client;
    } catch (error) {
      this.logger.error('LISTEN 建立失败，退化为纯扫描模式', error);
    }
  }

  handleConnection(client: WebSocket): void {
    this.clients.set(client, { userId: null, subscriptions: new Map(), lastPongAt: Date.now(), alive: true });
    client.on('pong', () => {
      const state = this.clients.get(client);
      if (state) state.lastPongAt = Date.now();
    });
    client.on('message', (raw) => {
      void this.onMessage(client, raw.toString());
    });
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.clients.get(client);
    if (!state) return;
    void this.clearPresence(state);
    this.clients.delete(client);
  }

  /** 每 5 秒：心跳帧广播高水位 + 补发遗漏事件 + 踢掉超时连接。 */
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [client, state] of this.clientEntries()) {
      if (!state.alive || now - state.lastPongAt > 45_000) {
        client.terminate();
        continue;
      }
      if (state.userId && state.subscriptions.size > 0) {
        try {
          const watermarks = await this.watermarksOf([...state.subscriptions.keys()]);
          this.send(client, { type: 'heartbeat', watermarks });
          for (const sub of state.subscriptions.values()) {
            const watermark = watermarks.find((w) => w.roomId === sub.roomId)?.seq ?? 0;
            if (!sub.syncing && watermark > sub.lastSeq) {
              await this.deliverEvents(client, sub);
            }
          }
        } catch (error) {
          this.logger.warn('心跳补发失败', error);
        }
      }
    }
  }

  private clientEntries(): Array<[WebSocket, ClientState]> {
    // WeakMap 不可枚举：活跃连接清单由 server.clients 维护
    const entries: Array<[WebSocket, ClientState]> = [];
    this.wss.clients.forEach((client) => {
      const state = this.clients.get(client);
      if (state) entries.push([client, state]);
    });
    return entries;
  }

  private async onMessage(client: WebSocket, raw: string): Promise<void> {
    const state = this.clients.get(client);
    if (!state) return;
    state.lastPongAt = Date.now();

    const parsed = wsClientFrameSchema.safeParse((() => {
      try {
        return JSON.parse(raw);
      } catch {
        return { type: 'unknown' };
      }
    })());
    if (!parsed.success) {
      this.send(client, { type: 'error', code: 'VALIDATION_FAILED', message: '帧格式不合法' });
      return;
    }
    const frame = parsed.data;

    if (frame.type === 'auth') {
      const userId = await this.verifyTicket(frame.ticket);
      if (!userId) {
        this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: '票据无效或已过期' });
        client.close();
        return;
      }
      state.userId = userId;
      this.send(client, { type: 'ack', userId });
      return;
    }

    if (!state.userId) {
      this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: '请先完成鉴权' });
      return;
    }

    if (frame.type === 'ping') {
      this.send(client, { type: 'ack' });
      // 应用层 ping 顺带刷新 presence（每 15 秒一次，来自客户端）
      await app().db.db.update(presence).set({ lastSeenAt: new Date() }).where(eq(presence.userId, state.userId));
      return;
    }

    if (frame.type === 'subscribe') {
      await this.subscribe(client, state, frame.roomId, frame.lastSeq);
      return;
    }

    if (frame.type === 'unsubscribe') {
      state.subscriptions.delete(frame.roomId);
      this.send(client, { type: 'ack', requestId: frame.roomId });
    }
  }

  /** 订阅：核验成员资格 → 快照握手（补事件到当前高水位 → sync.ready）。 */
  private async subscribe(client: WebSocket, state: ClientState, roomId: string, lastSeq: number): Promise<void> {
    const userId = state.userId!;
    const db = app().db;

    // 成员资格在每次订阅与发送前核实
    const membership = await db.db
      .select({ id: roomMembers.id })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId), eq(roomMembers.status, 'joined')))
      .limit(1);
    if (membership.length === 0) {
      this.send(client, { type: 'error', code: 'FORBIDDEN', message: '你不在这个房间里' });
      return;
    }

    const sub: Subscription = { roomId, lastSeq, syncing: true };
    state.subscriptions.set(roomId, sub);
    await db.db
      .insert(presence)
      .values({ userId, roomId, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: presence.userId, set: { roomId, lastSeenAt: new Date() } });

    try {
      const [room] = await db.db.select({ lastSeq: rooms.lastSeq }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
      if (!room) {
        this.send(client, { type: 'error', code: 'NOT_FOUND', message: '房间不存在' });
        return;
      }
      await this.deliverEvents(client, sub, room.lastSeq);
      sub.syncing = false;
      this.send(client, { type: 'sync.ready', roomId, watermark: sub.lastSeq });
    } catch (error) {
      sub.syncing = false;
      this.logger.warn('订阅握手失败', error);
      this.send(client, { type: 'error', code: 'INTERNAL', message: '同步失败，请重试' });
    }
  }

  /** 从数据库补发 seq > sub.lastSeq 的事件，推进游标；禁止跳号。 */
  private async deliverEvents(client: WebSocket, sub: Subscription, upTo?: number): Promise<void> {
    const db = app().db;
    for (let guard = 0; guard < 50; guard++) {
      const rows = await db.db
        .select()
        .from(roomEvents)
        .where(and(eq(roomEvents.roomId, sub.roomId), gt(roomEvents.seq, sub.lastSeq)))
        .orderBy(asc(roomEvents.seq))
        .limit(100);
      if (rows.length === 0) return;
      for (const row of rows) {
        if (upTo !== undefined && row.seq > upTo) return;
        this.send(client, {
          schemaVersion: 1,
          eventId: row.eventId,
          roomId: row.roomId,
          roundId: row.roundId,
          seq: row.seq,
          type: row.type,
          occurredAt: row.createdAt.toISOString(),
          payload: row.payload,
        });
        sub.lastSeq = row.seq;
      }
      if (rows.length < 100) return;
    }
  }

  /** NOTIFY 唤醒：给该房间所有非同步中的订阅者补发。 */
  private async broadcastRoom(roomId: string): Promise<void> {
    for (const [client, state] of this.clientEntries()) {
      const sub = state.subscriptions.get(roomId);
      if (!sub || sub.syncing) continue;
      try {
        await this.deliverEvents(client, sub);
      } catch (error) {
        this.logger.warn('广播失败', error);
      }
    }
  }

  private async watermarksOf(roomIds: string[]): Promise<Array<{ roomId: string; seq: number }>> {
    if (roomIds.length === 0) return [];
    const rows = await app().db.db
      .select({ roomId: rooms.id, seq: rooms.lastSeq })
      .from(rooms)
      .where(inArray(rooms.id, roomIds));
    return rows.map((r) => ({ roomId: r.roomId, seq: r.seq }));
  }

  private async verifyTicket(ticket: string): Promise<string | null> {
    try {
      const secret = new TextEncoder().encode(app().env.REALTIME_TICKET_SECRET ?? app().env.AUTH_SECRET + ':rt');
      const result = await jwtVerify(ticket, secret);
      const payload = result.payload as { purpose?: string; jti?: string };
      if (payload.purpose !== 'realtime' || !payload.jti || !consumeJti(payload.jti)) return null;
      return result.payload.sub ?? null;
    } catch {
      return null;
    }
  }

  private async clearPresence(state: ClientState): Promise<void> {
    if (!state.userId) return;
    try {
      // 同用户可能还有其他连接（多标签页）：只要不剩本房连接就清 presence
      let remaining = false;
      for (const [, other] of this.clientEntries()) {
        if (other !== state && other.userId === state.userId) remaining = true;
      }
      if (!remaining) {
        await app().db.db.delete(presence).where(eq(presence.userId, state.userId));
      }
    } catch (error) {
      this.logger.warn('presence 清理失败', error);
    }
  }

  private send(client: WebSocket, frame: unknown): void {
    if (client.readyState === 1) {
      client.send(JSON.stringify(frame));
    }
  }
}
