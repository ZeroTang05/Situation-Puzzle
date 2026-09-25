/** 「我的」：账号、赞助有效期、免费开房余量、多人历史、订单、单人本地记录管理。 */
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';
import { soloStore } from '../solo/local-store.js';
import type { Session } from '../session.js';

interface MeResponse {
  userId: string;
  nickname: string;
  email: string;
  sponsorship: { monthlyUntil: string | null; lifetime: boolean };
  freeRooms: { total: number; consumed: number; reserved: number };
}

interface HistoryResponse {
  rooms: Array<{
    roomId: string;
    roomStatus: string;
    createdAt: string;
    rounds: Array<{ roundId: string; roundNo: number; status: string; title: string | null }>;
  }>;
}

export function MePage({ session }: { session: Session | null }) {
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [localCount, setLocalCount] = useState<number | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/me'), enabled: session !== null, retry: false });
  const history = useQuery({ queryKey: ['me-history'], queryFn: () => api<HistoryResponse>('/me/history'), enabled: session !== null, retry: false });

  useEffect(() => {
    void soloStore.listSessions().then((rows) => setLocalCount(rows.length));
  }, []);

  if (!session) {
    return (
      <main className="shell narrow">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>{copy.back}</button>
        <p className="muted">{copy.login}后查看账号与赞助状态。单人游玩无需登录。</p>
        <button className="btn btn-primary" onClick={() => navigate('/login?next=/me')}>{copy.login}</button>
      </main>
    );
  }

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.me}</h1>
      </header>

      <section className="panel stack">
        <h2>{me.data?.nickname ?? session.user.email}</h2>
        <p className="muted">{session.user.email}</p>
        {me.data && (
          <p>
            {copy.freeRooms}：
            {me.data.sponsorship.lifetime || me.data.sponsorship.monthlyUntil
              ? copy.unlimited
              : `${me.data.freeRooms.total - me.data.freeRooms.consumed - me.data.freeRooms.reserved} / ${me.data.freeRooms.total}`}
          </p>
        )}
        {me.data?.sponsorship.monthlyUntil && <p className="muted">{copy.sponsored}至 {new Date(me.data.sponsorship.monthlyUntil).toLocaleString()}</p>}
        {me.data?.sponsorship.lifetime && <p className="verdict-badge verdict-solved">{copy.lifetime}{copy.sponsored}</p>}
        <button
          className="btn btn-ghost"
          onClick={() =>
            void authClient.signOut().then(() => {
              queryClient.clear();
              navigate('/');
            })
          }
        >
          {copy.logout}
        </button>
      </section>

      <section className="panel stack">
        <h3>{copy.history}</h3>
        {history.data?.rooms.length === 0 && <p className="muted">还没有多人房间记录。</p>}
        {history.data?.rooms.map((room) => (
          <article key={room.roomId} className="stack-sm">
            <button className="btn btn-sm" onClick={() => navigate(`/rooms/${room.roomId}`)}>
              {new Date(room.createdAt).toLocaleDateString()} · {room.roomStatus === 'closed' ? '已结束' : '进行中'}
            </button>
            {room.rounds.map((r) => (
              <p key={r.roundId} className="muted">
                第 {r.roundNo} 局 {r.title ?? ''} · {r.status}
              </p>
            ))}
          </article>
        ))}
      </section>

      <section className="panel stack">
        <h3>{copy.soloRecords}</h3>
        <p className="muted">共 {localCount ?? 0} 局，仅保存在本浏览器。</p>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() =>
            void soloStore.exportAll().then((json) => {
              const blob = new Blob([json], { type: 'application/json' });
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = `jev-solo-records-${Date.now()}.json`;
              link.click();
            })
          }
        >
          导出记录
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (window.confirm('确定清空全部单人记录？此操作不可恢复。')) void soloStore.clearAll();
          }}
        >
          清空记录
        </button>
      </section>
    </main>
  );
}
