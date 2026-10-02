/**
 * 邀请落地页：展示房间/等待室信息，登录后加入。
 * 路径 /lobby/invite/:token 与 /room/invite/:token 各自走固定的后端 endpoint，无 fallback。
 */
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { format } from '@jev/i18n';
import type { Session } from '../session.js';

interface LobbyPreview {
  lobbyId: string;
  hostNickname: string;
  memberCount: number;
  capacity: number;
}

interface RoomPreview {
  roomId: string;
  status: 'playing' | 'closed';
  capacity: number;
  memberCount: number;
  hostNickname: string;
  currentPuzzleTitle: string | null;
}

export function InvitePage({ session, kind }: { session: Session | null; kind: 'lobby' | 'room' }) {
  const { token } = useParams();
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['invite', kind, token],
    queryFn: (): Promise<LobbyPreview | RoomPreview> => {
      if (!token) throw new Error('token not ready');
      return kind === 'lobby'
        ? api<LobbyPreview>(`/invites/lobby/${token}`)
        : api<RoomPreview>(`/invites/room/${token}`);
    },
    retry: false,
  });

  const attempted = useRef<string | null>(null);
  // 登录返回后自动提交加入命令：lobby 邀请 join → 可能跳卧室（已开局）或 lobby；room 邀请 join → 跳卧室。
  useEffect(() => {
    if (!session || !token || !preview.data || attempted.current === `${kind}:${token}`) return;
    if (kind === 'room' && (preview.data as RoomPreview).status === 'closed') return;
    attempted.current = `${kind}:${token}`;
    void join();
  }, [session, token, preview.data, kind]);

  const join = async () => {
    if (!token) return;
    setJoining(true);
    setError(null);
    try {
      if (kind === 'lobby') {
        const result = await api<{ lobbyId: string }>('/lobbies/join', { method: 'POST', body: { token } });
        navigate(`/lobbies/${result.lobbyId}`, { replace: true });
      } else {
        const result = await api<{ roomId: string; rejoined: boolean }>('/rooms/join', { method: 'POST', body: { token } });
        navigate(`/rooms/${result.roomId}`, { replace: true });
      }
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

  const data = preview.data;
  const hostNickname = data.hostNickname;
  const memberCount = data.memberCount;
  const capacity = data.capacity;

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand">{copy.brand}</h1>
      </header>
      <section className="panel stack">
        <h2>{kind === 'lobby' ? copy.lobbyTitle : copy.waitingRoom}</h2>
        <p>{format(copy.roomOf, { name: hostNickname, n: memberCount, cap: capacity })}</p>
        {kind === 'room' && (data as RoomPreview).currentPuzzleTitle && (
          <p className="muted">{format(copy.playingRoom, { title: (data as RoomPreview).currentPuzzleTitle! })}</p>
        )}
        {kind === 'room' && (data as RoomPreview).status === 'closed' ? (
          <p className="error-text">{copy.roomClosedHint}</p>
        ) : session ? (
          <button className="btn btn-primary" disabled={joining} onClick={() => void join()}>
            {joining ? copy.joining : copy.joinRoom}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true })}>
            {copy.loginAndJoin}
          </button>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}
