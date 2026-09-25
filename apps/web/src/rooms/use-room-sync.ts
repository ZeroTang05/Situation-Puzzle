/**
 * 房间同步（docs/rebuild/04-ROOM-JEV.md §5）：
 * 快照是权威状态 → WebSocket 订阅 → 事件按 seq 应用（重复忽略、缺口补齐）→
 * 断线重连携带 lastSeq 续传；补不齐（410）就重新拉快照。
 * 写操作统一走 HTTP 命令接口，WebSocket 只负责接收。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { roomEventSchema, wsClientFrameSchema, type RoomEvent, type WsServerFrame } from '@jev/contracts';
import { api, ApiError } from '../api/client.js';

export interface RoomTurn {
  turnId: string;
  seq: number;
  userId: string;
  nickname: string;
  kind: 'ask' | 'solve';
  text: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  result: string | null;
}

export interface RoomMember {
  userId: string;
  nickname: string;
  online: boolean;
  isHost: boolean;
}

export interface RoomRound {
  roundId: string;
  roundNo: number;
  puzzleId: string;
  versionId: string;
  language: 'zh' | 'en';
  title: string;
  surface: string;
  hintsRevealed: number;
  hints: string[];
  status: 'active' | 'solved' | 'revealed' | 'abandoned' | 'aborted';
  answer: string | null;
}

export interface DiscussionMessage {
  eventId: string;
  userId: string;
  nickname: string;
  text: string;
  at: number;
}

export interface RoomState {
  roomId: string;
  roomStatus: 'waiting' | 'playing' | 'closed';
  hostUserId: string;
  controlVersion: number;
  capacity: number;
  round: RoomRound | null;
  members: RoomMember[];
  turns: RoomTurn[];
  discussions: DiscussionMessage[];
  lastSeq: number;
}

type SyncStatus = 'connecting' | 'syncing' | 'ready' | 'offline';

function applyEvent(state: RoomState, event: RoomEvent): RoomState {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'room.member_joined':
    case 'room.member_unrestricted': {
      if (state.members.some((m) => m.userId === p.userId)) return state;
      return { ...state, members: [...state.members, { userId: String(p.userId), nickname: String(p.nickname ?? p.userId), online: true, isHost: state.hostUserId === p.userId }] };
    }
    case 'room.member_left': {
      return { ...state, members: state.members.filter((m) => m.userId !== p.userId) };
    }
    case 'room.member_kicked': {
      return { ...state, members: state.members.filter((m) => m.userId !== p.userId) };
    }
    case 'room.host_changed': {
      const userId = String(p.userId);
      return {
        ...state,
        hostUserId: userId,
        members: state.members.map((m) => ({ ...m, isHost: m.userId === userId })),
      };
    }
    case 'round.started': {
      return {
        ...state,
        roomStatus: 'playing',
        round: {
          roundId: String(p.roundId),
          roundNo: Number(p.roundNo),
          puzzleId: String(p.puzzleId),
          versionId: '',
          language: p.language === 'en' ? 'en' : 'zh',
          title: String(p.title),
          surface: String(p.surface),
          hintsRevealed: 0,
          hints: [],
          status: 'active',
          answer: null,
        },
        turns: [],
      };
    }
    case 'round.ended': {
      if (!state.round || state.round.roundId !== event.roundId) return state;
      const status = p.status as RoomRound['status'];
      return { ...state, roomStatus: 'waiting', round: { ...state.round, status } };
    }
    case 'turn.accepted': {
      const turn: RoomTurn = {
        turnId: String(p.turnId),
        seq: event.seq,
        userId: String(p.userId),
        nickname: String(p.nickname),
        kind: p.kind === 'solve' ? 'solve' : 'ask',
        text: String(p.text),
        status: 'queued',
        result: null,
      };
      if (state.turns.some((t) => t.turnId === turn.turnId)) return state;
      return { ...state, turns: [...state.turns, turn] };
    }
    case 'turn.started':
    case 'turn.completed':
    case 'turn.failed':
    case 'turn.cancelled': {
      const status = event.type === 'turn.started' ? 'processing' : event.type === 'turn.completed' ? 'succeeded' : event.type === 'turn.failed' ? 'failed' : 'cancelled';
      return {
        ...state,
        turns: state.turns.map((t) => (t.turnId === p.turnId ? { ...t, status, result: p.result ? String(p.result) : t.result } : t)),
      };
    }
    case 'hint.revealed': {
      if (!state.round) return state;
      const hints = state.round.hints.slice();
      const index = Number(p.index);
      while (hints.length <= index) hints.push('');
      hints[index] = String(p.text);
      return { ...state, round: { ...state.round, hints, hintsRevealed: Math.max(state.round.hintsRevealed, index + 1) } };
    }
    case 'discussion.created': {
      const message: DiscussionMessage = {
        eventId: event.eventId,
        userId: String(p.userId),
        nickname: String(p.nickname),
        text: String(p.text),
        at: Date.parse(event.occurredAt),
      };
      if (state.discussions.some((d) => d.eventId === message.eventId)) return state;
      return { ...state, discussions: [...state.discussions, message] };
    }
    case 'room.closed': {
      return { ...state, roomStatus: 'closed' };
    }
    case 'room.invite_rotated': {
      // 邀请令牌刷新后需要房主重新查看邀请链接（通过 HTTP 拉取）
      return state;
    }
    default:
      return state;
  }
}

async function fetchSnapshot(roomId: string): Promise<{ state: RoomState; answer: string | null }> {
  const snap = await api<{
    roomId: string;
    roomStatus: RoomState['roomStatus'];
    hostUserId: string;
    controlVersion: number;
    capacity: number;
    round: RoomRound | null;
    members: RoomMember[];
    turns: RoomTurn[];
    lastSeq: number;
  }>(`/rooms/${roomId}/snapshot`);
  return {
    state: {
      roomId: snap.roomId,
      roomStatus: snap.roomStatus,
      hostUserId: snap.hostUserId,
      controlVersion: snap.controlVersion,
      capacity: snap.capacity,
      round: snap.round,
      members: snap.members,
      turns: snap.turns,
      discussions: [],
      lastSeq: snap.lastSeq,
    },
    answer: snap.round?.answer ?? null,
  };
}

export function useRoomSync(roomId: string, enabled: boolean) {
  const [state, setState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const [kicked, setKicked] = useState(false);
  const stateRef = useRef<RoomState | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setStateSafe = useCallback((next: RoomState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const resync = useCallback(async () => {
    const { state: snap } = await fetchSnapshot(roomId);
    setStateSafe(snap);
    return snap.lastSeq;
  }, [roomId, setStateSafe]);

  /** 快照 → 补事件 → sync.ready 的完整握手。 */
  const handshake = useCallback(
    async (socket: WebSocket) => {
      setStatus('syncing');
      const lastSeq = await resync();
      socket.send(JSON.stringify({ type: 'subscribe', roomId, lastSeq } satisfies import('@jev/contracts').WsClientFrame));
    },
    [roomId, resync],
  );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;

    async function connect(): Promise<void> {
      try {
        const { ticket } = await api<{ ticket: string; expiresInSeconds: number }>('/realtime/tickets', { method: 'POST' });
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        socketRef.current = socket;

        const authTimer = setTimeout(() => {
          if (socket.readyState === 0) socket.close();
        }, 5000);

        socket.onopen = () => {
          clearTimeout(authTimer);
          socket.send(JSON.stringify({ type: 'auth', ticket }));
        };

        socket.onmessage = async (raw) => {
          let frame: WsServerFrame;
          try {
            frame = JSON.parse(String(raw.data)) as WsServerFrame;
          } catch {
            return;
          }
          if (frame.type === 'ack' && frame.userId) {
            await handshake(socket);
            return;
          }
          if (frame.type === 'sync.ready') {
            setStatus('ready');
            reconnectAttempt.current = 0;
            // 应用层心跳：每 15 秒 ping，服务端据此维护 presence（在线状态）
            if (pingTimerRef.current) clearInterval(pingTimerRef.current);
            pingTimerRef.current = setInterval(() => {
              if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping' }));
            }, 15_000);
            return;
          }
          if (frame.type === 'heartbeat') {
            const current = stateRef.current;
            if (!current) return;
            const sub = frame.watermarks.find((w) => w.roomId === roomId);
            if (sub && sub.seq > current.lastSeq) {
              // 发现高水位领先但未收到事件：主动补齐
              socket.send(JSON.stringify({ type: 'subscribe', roomId, lastSeq: current.lastSeq }));
            }
            return;
          }
          if (frame.type === 'error') {
            if (frame.code === 'FORBIDDEN') {
              setKicked(true);
              socket.close();
            }
            return;
          }
          // 房间事件：按 seq 应用
          const parsed = roomEventSchema.safeParse(frame);
          if (!parsed.success) return;
          const event = parsed.data as RoomEvent;
          const current = stateRef.current;
          if (!current) return;
          if (event.seq <= current.lastSeq) return; // 重复忽略
          if (event.seq > current.lastSeq + 1) {
            // 缺口：主动补齐
            socket.send(JSON.stringify({ type: 'subscribe', roomId, lastSeq: current.lastSeq }));
            return;
          }
          if (event.type === 'room.member_kicked' && (event.payload as { userId?: string }).userId === (await myUserId())) {
            setKicked(true);
            socket.close();
            return;
          }
          setStateSafe(applyEvent(current, event));
        };

        socket.onclose = () => {
          if (disposed) return;
          if (pingTimerRef.current) {
            clearInterval(pingTimerRef.current);
            pingTimerRef.current = null;
          }
          setStatus('offline');
          // 带随机抖动的指数退避，最大 15 秒
          const delay = Math.min(15_000, 500 * 2 ** reconnectAttempt.current) + Math.random() * 500;
          reconnectAttempt.current += 1;
          setTimeout(() => {
            if (!disposed) void connect();
          }, delay);
        };
      } catch (error) {
        if (disposed) return;
        setStatus('offline');
        if (error instanceof ApiError && error.status === 401) return; // 未登录：由页面处理
        setTimeout(() => {
          if (!disposed) void connect();
        }, 3000);
      }
    }

    // 浏览器重新可见时立即补同步（docs/rebuild/04-ROOM-JEV.md §5：后台节流期间
    // 心跳被暂停，连接可能已被服务端按 45 秒超时关闭）
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const socket = socketRef.current;
      const current = stateRef.current;
      if (socket && socket.readyState === 1 && current) {
        socket.send(JSON.stringify({ type: 'subscribe', roomId, lastSeq: current.lastSeq }));
        return;
      }
      // 连接已死：立即重连（跳过退避等待）
      reconnectAttempt.current = 0;
      socketRef.current?.close();
    };
    document.addEventListener('visibilitychange', onVisible);

    void connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, handshake, roomId, setStateSafe]);

  /** 发送命令：clientRequestId 在点击时生成；网络重发沿用同一编号。 */
  const sendCommand = useCallback(
    async (input: { type: string; roundId?: string; payload?: Record<string, unknown>; expectedControlVersion?: number; clientRequestId?: string }) => {
      const clientRequestId = input.clientRequestId ?? crypto.randomUUID();
      const result = await api<{ status: 'accepted' | 'duplicate'; turnId?: string; acceptedSeq?: number; controlVersion: number; inviteToken?: string }>(
        `/rooms/${roomId}/commands`,
        {
          method: 'POST',
          body: {
            clientRequestId,
            type: input.type,
            roundId: input.roundId,
            expectedControlVersion: input.expectedControlVersion ?? stateRef.current?.controlVersion,
            payload: input.payload ?? {},
          },
        },
      );
      if (result.controlVersion !== undefined && stateRef.current) {
        setStateSafe({ ...stateRef.current, controlVersion: result.controlVersion });
      }
      return result;
    },
    [roomId, setStateSafe],
  );

  return useMemo(
    () => ({
      state,
      status,
      kicked,
      sendCommand,
      refresh: resync,
    }),
    [state, status, kicked, sendCommand, resync],
  );
}

/** 当前登录用户 ID：会话来自 Better Auth；匿名时为 null。 */
async function myUserId(): Promise<string | null> {
  try {
    const me = await api<{ userId: string }>('/me');
    return me.userId;
  } catch {
    return null;
  }
}

void wsClientFrameSchema;
