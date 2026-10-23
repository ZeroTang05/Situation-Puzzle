/**
 * 大厅页（docs/rebuild/18-HALL-PUBLIC-ROOMS.md）：
 * 列出所有公开房间（房主昵称 / 当前人数 / 当前汤题），点「加入」直接进房。
 *
 * 轮询而非 WebSocket：大厅是全局视图，没有房间级事件流；5 秒一次足够，
 * 且与服务端「每用户每分钟 60 次」的限额对齐（见 16-CONCURRENCY-LIMITS.md）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { format } from '@jev/i18n';

interface HallRoom {
  roomId: string;
  title: string | null;
  language: 'zh' | 'en' | null;
  hostNickname: string;
  memberCount: number;
  capacity: number;
  full: boolean;
  status: 'waiting' | 'playing';
  createdAt: string;
}

const POLL_MS = 5000;

export function HallPage() {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hall = useQuery({
    queryKey: ['hall'],
    queryFn: () => api<{ rooms: HallRoom[] }>('/hall'),
    // 出错就停轮询，避免刷屏；重进页面自然会重试
    refetchInterval: (q) => (q.state.error ? false : POLL_MS),
    retry: false,
  });

  const rooms = hall.data?.rooms ?? [];

  const join = async (roomId: string) => {
    if (joining) return;
    setJoining(roomId);
    setError(null);
    try {
      await api<{ roomId: string; joined: boolean }>(`/rooms/${roomId}/join-public`, { method: 'POST' });
      navigate(`/rooms/${roomId}`);
    } catch (err) {
      setError(translateApiError(err, language, copy.hallLoadFail));
      // 房态可能刚变（已满 / 已关闭 / 房主切回私人）：立刻刷新一次列表
      void hall.refetch();
    } finally {
      setJoining(null);
    }
  };

  return (
    <main className="shell narrow">
      <header className="topbar topbar-title">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.hallTitle}</h1>
      </header>

      <section className="panel stack">
        {hall.isPending ? (
          <p className="muted">{copy.loadingRound}</p>
        ) : hall.isError ? (
          <p className="error-text" role="alert">{copy.hallLoadFail}</p>
        ) : rooms.length === 0 ? (
          <p className="muted">{copy.hallEmpty}</p>
        ) : (
          <ul className="hall-list">
            {rooms.map((room) => (
              <li key={room.roomId} className="hall-row">
                <div className="hall-row-main">
                  <p className="hall-row-title">{room.title ?? copy.hallNoTitle}</p>
                  <p className="hall-row-meta">
                    <span>{copy.host}：{room.hostNickname}</span>
                    <span aria-hidden>·</span>
                    <span>{format(copy.hallPlayers, { n: room.memberCount, cap: room.capacity })}</span>
                    <span aria-hidden>·</span>
                    <span>{room.status === 'waiting' ? copy.hallWaiting : copy.hallPlaying}</span>
                  </p>
                </div>
                {room.full ? (
                  <span className="verdict-badge verdict-uncertain">{copy.hallFull}</span>
                ) : (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={joining !== null}
                    onClick={() => void join(room.roomId)}
                  >
                    {joining === room.roomId ? copy.hallJoining : copy.hallJoin}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}
