/** 单连接状态机：保留页面、增量补齐、明确失联检测及代次隔离。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { wsServerFrameSchema, type RoomEvent, type WsClientFrame } from '@jev/contracts';
import { api, ApiError } from '../api/client.js';
import { applyEvent, fetchSnapshot, type RoomState } from './room-state.js';
export type { RoomState, RoomRound } from './room-state.js';

export type SyncStatus = 'connecting' | 'syncing' | 'ready' | 'reconnecting' | 'offline' | 'auth_required' | 'forbidden';
export interface CommandInput { type: string; roundId?: string; payload?: Record<string, unknown>; expectedControlVersion?: number; clientRequestId: string }
export interface CommandResult { clientRequestId: string; status: 'accepted' | 'duplicate'; turnId?: string; discussionId?: string; acceptedSeq?: number; controlVersion: number; inviteToken?: string }

export function useRoomSync(roomId: string, userId: string | null) {
  const [state, setState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const stateRef = useRef<RoomState | null>(null);
  const restartRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    stateRef.current = null;
    setState(null);
    setStatus('connecting');
    if (!userId) return;
    let disposed = false;
    let stopped = false;
    let socket: WebSocket | null = null;
    let controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastReceived = 0;
    let lastActivity = 0;
    let syncing = false;
    let buffering = new Map<number, RoomEvent>();
    const current = (generation: number) => !disposed && !stopped && generationRef.current === generation;
    const update = (next: RoomState) => { stateRef.current = next; setState(next); };
    const send = (frame: WsClientFrame) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };

    /** 旧连接的所有回调先失效，再关闭；close 不会触发第二个重试。 */
    const detach = () => {
      generationRef.current++;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
      if (socket) { socket.onclose = null; socket.onmessage = null; socket.onopen = null; socket.close(); }
      socket = null;
      syncing = false;
      buffering.clear();
    };
    const terminal = (next: 'auth_required' | 'forbidden') => { stopped = true; detach(); setStatus(next); };
    const fail = (error?: unknown) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        terminal(error.status === 401 ? 'auth_required' : 'forbidden'); return;
      }
      detach();
      if (disposed || stopped) return;
      setStatus(navigator.onLine ? 'reconnecting' : 'offline');
      if (navigator.onLine) timer = setTimeout(() => void connect(), Math.min(15_000, 500 * 2 ** Math.min(attempt++, 5) + Math.random() * 300));
    };
    const armDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => fail(), 10_000);
    };
    const subscribe = () => {
      if (syncing || !stateRef.current) return;
      syncing = true;
      setStatus('syncing');
      armDeadline();
      send({ type: 'subscribe', roomId, lastSeq: stateRef.current.lastSeq });
    };
    const snapshot = async (generation: number) => {
      syncing = true;
      setStatus('syncing');
      armDeadline();
      const { state: next } = await fetchSnapshot(roomId, controller.signal);
      if (!current(generation)) return;
      update(next);
      buffering.clear();
      syncing = false;
      subscribe();
    };
    const activity = () => {
      send({ type: 'ping', visible: document.visibilityState === 'visible' });
      lastActivity = Date.now();
    };

    async function connect() {
      if (disposed || stopped) return;
      detach();
      if (!navigator.onLine) { setStatus('offline'); return; }
      controller = new AbortController();
      const generation = generationRef.current;
      setStatus(stateRef.current ? 'reconnecting' : 'connecting');
      armDeadline();
      try {
        const { ticket } = await api<{ ticket: string }>('/realtime/tickets', { method: 'POST', timeoutMs: 10_000, signal: controller.signal });
        if (!current(generation)) return;
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        socket = ws;
        lastReceived = Date.now();
        ws.onopen = () => { if (current(generation)) send({ type: 'auth', ticket }); };
        ws.onerror = () => { /* close 统一触发恢复；连接截止时间处理无 close 的链路。 */ };
        ws.onclose = (event) => {
          if (!current(generation)) return;
          if (event.code === 4403) terminal('forbidden');
          else if (event.code === 4401) terminal('auth_required');
          else fail();
        };
        // 同一连接按消息到达顺序处理，快照请求期间也不交叉改写游标。
        let messages = Promise.resolve();
        ws.onmessage = (raw) => {
          if (!current(generation)) return;
          lastReceived = Date.now();
          messages = messages.then(async () => {
            if (!current(generation)) return;
            const frame = wsServerFrameSchema.parse(JSON.parse(String(raw.data)));
            if (frame.type === 'ack' && frame.userId) {
              if (stateRef.current) subscribe(); else await snapshot(generation);
              return;
            }
            if (frame.type === 'error') {
              if (frame.code === 'FORBIDDEN') terminal('forbidden');
              else if (frame.code === 'UNAUTHORIZED') terminal('auth_required');
              else if (frame.code === 'RESYNC_REQUIRED') await snapshot(generation);
              else fail();
              return;
            }
            if (frame.type === 'sync.ready') {
              if (frame.roomId !== roomId) return;
              syncing = false;
              if (stateRef.current?.lastSeq !== frame.watermark) { subscribe(); return; }
              clearTimeout(deadline);
              attempt = 0;
              setStatus('ready');
              activity();
              return;
            }
            if (frame.type === 'heartbeat') {
              const watermark = frame.watermarks.find((w) => w.roomId === roomId);
              if (watermark && stateRef.current && watermark.seq > stateRef.current.lastSeq) subscribe();
              return;
            }
            if (!('seq' in frame) || frame.roomId !== roomId || !stateRef.current) return;
            const event = frame as RoomEvent;
            if (event.seq <= stateRef.current.lastSeq) return;
            buffering.set(event.seq, event);
            if (buffering.size > 1000) { await snapshot(generation); return; }
            let next = stateRef.current;
            while (buffering.has(next.lastSeq + 1)) {
              const item = buffering.get(next.lastSeq + 1)!;
              buffering.delete(item.seq);
              next = { ...applyEvent(next, item), lastSeq: item.seq };
            }
            update(next);
            if (syncing) armDeadline();
            if (buffering.size) subscribe();
          }).catch((error: unknown) => { if (current(generation)) fail(error); });
        };
      } catch (error) { if (current(generation)) fail(error); }
    }

    const wake = () => {
      if (disposed || stopped || document.visibilityState !== 'visible') return;
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastReceived < 45_000) { activity(); subscribe(); }
      else { attempt = 0; void connect(); }
    };
    const visibility = () => { if (document.visibilityState === 'visible') wake(); else activity(); };
    const offline = () => { detach(); setStatus('offline'); };
    const watchdog = setInterval(() => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastReceived > 45_000) { fail(); return; }
      if (socket?.readyState === WebSocket.OPEN && !syncing && Date.now() - lastActivity >= 30_000) activity();
    }, 5_000);
    restartRef.current = () => { void connect(); };
    window.addEventListener('online', wake);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    void connect();
    return () => {
      disposed = true;
      detach();
      clearInterval(watchdog);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
      restartRef.current = null;
    };
  }, [roomId, userId]);

  const sendCommand = useCallback(async (input: CommandInput) => {
    const generation = generationRef.current;
    const result = await api<CommandResult>(`/rooms/${roomId}/commands`, { method: 'POST', body: input, timeoutMs: 10_000 });
    if (generation === generationRef.current && stateRef.current?.roomId === roomId) {
      const next = { ...stateRef.current, controlVersion: Math.max(stateRef.current.controlVersion, result.controlVersion) };
      stateRef.current = next;
      setState(next);
    }
    return result;
  }, [roomId]);

  return { state: state?.roomId === roomId ? state : null, status, kicked: status === 'forbidden', sendCommand, refresh: () => restartRef.current?.() };
}
