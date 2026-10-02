/**
 * 会客厅实时通道：监听服务端推送的 lobby.started 事件。
 *
 * - 复用 POST /realtime/tickets 票据（30 秒一次性，与房间同步共用）。
 * - 收到 lobby.started 后调用 onStart({ roomId, inviteToken })；调用方负责 navigate。
 * - 网络故障 / 鉴权失败静默：轮询快照照常返回，lobby.started 推送丢了由调用方兜底（看 snapshot 状态）。
 */
import { useEffect, useRef } from 'react';
import { wsServerFrameSchema } from '@jev/contracts';
import { api } from '../api/client.js';

export interface LobbyStartEvent {
  lobbyId: string;
  roomId: string;
  inviteToken?: string;
}

export function useLobbySync(lobbyId: string | undefined, onStart: (event: LobbyStartEvent) => void): void {
  const handlerRef = useRef(onStart);
  handlerRef.current = onStart;

  useEffect(() => {
    if (!lobbyId) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const send = (frame: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    const connect = async () => {
      if (disposed) return;
      try {
        const { ticket } = await api<{ ticket: string }>('/realtime/tickets', { method: 'POST', timeoutMs: 10_000 });
        if (disposed) return;
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        socket = ws;
        ws.onopen = () => {
          if (disposed) return;
          send({ type: 'auth', ticket });
        };
        ws.onmessage = (raw) => {
          if (disposed) return;
          try {
            const frame = wsServerFrameSchema.parse(JSON.parse(String(raw.data)));
            if (frame.type === 'ack' && frame.userId) {
              send({ type: 'lobby.subscribe', lobbyId });
              return;
            }
            if (frame.type === 'lobby.started' && frame.lobbyId === lobbyId) {
              handlerRef.current({
                lobbyId: frame.lobbyId,
                roomId: frame.roomId,
                ...(frame.inviteToken ? { inviteToken: frame.inviteToken } : {}),
              });
              ws.close();
            }
          } catch {
            /* 解析失败忽略，不影响 lobby 页本身的轮询 */
          }
        };
        ws.onclose = () => {
          if (disposed) return;
          // 短退避重连（最多 5 次，避免离开页面后还刷日志）
          if (attempt++ < 5) retryTimer = setTimeout(() => void connect(), 2000);
        };
        ws.onerror = () => { /* close 触发兜底 */ };
      } catch {
        if (disposed) return;
        if (attempt++ < 5) retryTimer = setTimeout(() => void connect(), 3000);
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) { socket.onclose = null; socket.onmessage = null; socket.onerror = null; socket.close(); }
      socket = null;
    };
  }, [lobbyId]);
}
