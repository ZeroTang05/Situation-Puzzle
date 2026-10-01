/** 邀请落地页：展示房间信息，登录后加入。 */
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { format } from '@jev/i18n';
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
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InvitePreview>(`/invites/${token}`),
    retry: false,
  });

  const attempted = useRef<string | null>(null);
  // 登录返回后直接提交加入命令，只有成功获得成员身份才跳转房间。
  useEffect(() => {
    if (!session || !token || !preview.data || preview.data.status === 'closed' || attempted.current === token) return;
    attempted.current = token;
    void join();
  }, [session, token, preview.data]);

  const join = async () => {
    if (!preview.data) return;
    setJoining(true);
    setError(null);
    try {
      const result = await api<{ roomId: string; rejoined: boolean }>('/rooms/join', { method: 'POST', body: { token } });
      navigate(`/rooms/${result.roomId}`, { replace: true });
    } catch (err) {
      setError(translateApiError(err, language, copy.invitePreviewFail));
    } finally {
      setJoining(false);
    }
  };

  if (preview.isPending) return <main className="shell page-loading">{copy.loadingRound}</main>;
  if (preview.isError || !preview.data) {
    return (
      <main className="shell">
        <p className="error-text">{copy.inviteInvalid}</p>
        <button className="btn" onClick={back}>{copy.back}</button>
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
          {format(copy.roomOf, { name: info.hostNickname, n: info.memberCount, cap: info.capacity })}
        </p>
        {info.currentPuzzleTitle && <p className="muted">{format(copy.playingRoom, { title: info.currentPuzzleTitle })}</p>}
        {info.status === 'closed' ? (
          <p className="error-text">{copy.roomClosedHint}</p>
        ) : session ? (
          <button className="btn btn-primary" disabled={joining} onClick={() => void join()}>
            {joining ? copy.joining : copy.joinRoom}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}>
            {copy.loginAndJoin}
          </button>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}