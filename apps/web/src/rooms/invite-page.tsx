/** 邀请落地页：展示房间信息，登录后加入。 */
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import type { Session } from '../session.js';

interface InvitePreview {
  roomId: string;
  status: 'waiting' | 'playing' | 'closed';
  capacity: number;
  memberCount: number;
  hostNickname: string;
  currentPuzzleTitle: string | null;
}

export function InvitePage({ session }: { session: Session | null }) {
  const { token } = useParams();
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InvitePreview>(`/invites/${token}`),
    retry: false,
  });

  // 已登录且之前确认过：自动回房
  useEffect(() => {
    if (session && preview.data && sessionStorage.getItem(`jev.joined.${token}`) === '1') {
      navigate(`/rooms/${preview.data.roomId}`, { replace: true });
    }
  }, [session, preview.data, token, navigate]);

  const join = async () => {
    if (!preview.data) return;
    setJoining(true);
    setError(null);
    try {
      const result = await api<{ roomId: string; rejoined: boolean }>('/rooms/join', { method: 'POST', body: { token } });
      sessionStorage.setItem(`jev.joined.${token}`, '1');
      navigate(`/rooms/${result.roomId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加入失败，请稍后再试');
    } finally {
      setJoining(false);
    }
  };

  if (preview.isPending) return <main className="shell page-loading">加载中…</main>;
  if (preview.isError || !preview.data) {
    return (
      <main className="shell">
        <p className="error-text">邀请无效或已失效。</p>
        <button className="btn" onClick={() => navigate('/')}>{copy.back}</button>
      </main>
    );
  }
  const info = preview.data;

  return (
    <main className="shell narrow">
      <header className="topbar">
        <h1 className="brand">{copy.brand}</h1>
      </header>
      <section className="panel stack">
        <h2>{copy.waitingRoom}</h2>
        <p>
          {info.hostNickname} 的房间 · {info.memberCount}/{info.capacity} 人
        </p>
        {info.currentPuzzleTitle && <p className="muted">正在推理：{info.currentPuzzleTitle}</p>}
        {info.status === 'closed' ? (
          <p className="error-text">房间已关闭。</p>
        ) : session ? (
          <button className="btn btn-primary" disabled={joining} onClick={() => void join()}>
            {joining ? '加入中…' : '加入房间'}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}>
            {copy.login} 并加入
          </button>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}
