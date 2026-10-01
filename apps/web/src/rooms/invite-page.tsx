/**
 * 邀请落地页：展示房间/等待室信息，登录后加入。
 * 令牌按形状分流：JWT（含「.」）指向内存等待室，纯 hex 串指向正式房间。
 */
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { format } from '@jev/i18n';
import type { Session } from '../session.js';

interface InvitePreview {
  roomId: string;
  status: 'playing' | 'closed';
  capacity: number;
  memberCount: number;
  hostNickname: string;
  currentPuzzleTitle: string | null;
}

interface LobbyPreview {
  lobbyId: string;
  hostNickname: string;
  memberCount: number;
  capacity: number;
}

export function InvitePage({ session }: { session: Session | null }) {
  const { token } = useParams();
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLobby = (token ?? '').includes('.');

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: (): Promise<LobbyPreview | InvitePreview> =>
      isLobby ? api<LobbyPreview>(`/lobbies/by-invite/${token}`) : api<InvitePreview>(`/invites/${token}`),
    retry: false,
  });

  const attempted = useRef<string | null>(null);
  // 登录返回后直接提交加入命令，只有成功获得成员身份才跳转。
  useEffect(() => {
    if (!session || !token || !preview.data || attempted.current === token) return;
    if (!isLobby && (preview.data as InvitePreview).status === 'closed') return;
    attempted.current = token;
    void join();
  }, [session, token, preview.data]);

  const join = async () => {
    if (!token) return;
    setJoining(true);
    setError(null);
    try {
      if (isLobby) {
        const result = await api<{ lobbyId: string; startedRoomId: string | null }>('/lobbies/join', { method: 'POST', body: { token } });
        navigate(result.startedRoomId ? `/rooms/${result.startedRoomId}` : `/lobbies/${result.lobbyId}`, { replace: true });
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

  const hostNickname = isLobby ? (preview.data as LobbyPreview).hostNickname : (preview.data as InvitePreview).hostNickname;
  const memberCount = isLobby ? (preview.data as LobbyPreview).memberCount : (preview.data as InvitePreview).memberCount;
  const capacity = isLobby ? (preview.data as LobbyPreview).capacity : (preview.data as InvitePreview).capacity;

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand">{copy.brand}</h1>
      </header>
      <section className="panel stack">
        <h2>{isLobby ? copy.lobbyTitle : copy.waitingRoom}</h2>
        <p>{format(copy.roomOf, { name: hostNickname, n: memberCount, cap: capacity })}</p>
        {!isLobby && (preview.data as InvitePreview).currentPuzzleTitle && (
          <p className="muted">{format(copy.playingRoom, { title: (preview.data as InvitePreview).currentPuzzleTitle! })}</p>
        )}
        {!isLobby && (preview.data as InvitePreview).status === 'closed' ? (
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
