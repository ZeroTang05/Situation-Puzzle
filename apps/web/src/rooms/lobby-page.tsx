/**
 * 等待室页（docs/rebuild/10-ROOM-LIFECYCLE-REVISION.md v2 §三）：
 * 内存临时态、2 秒轮询即心跳；开局后自动跳正式房间。
 * 房主：选题（跳题库带回）、开始本局、邀请、踢人、解散。非房主：离开。
 */
import { useDialog } from '@jev/ui';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { format } from '@jev/i18n';
import type { Session } from '../session.js';
import { PuzzleSelection } from './puzzle-selection.js';
import { inviteUrl } from '../game/game-display.js';

interface LobbySnapshot {
  lobbyId: string;
  hostUserId: string;
  capacity: number;
  members: Array<{ userId: string; nickname: string; online: boolean; isHost: boolean }>;
  selectedPuzzle: { puzzleId: string; title: string; language: 'zh' | 'en' } | null;
  startedRoomId: string | null;
}

const POLL_MS = 2000;

export function LobbyPage({ session }: { session: Session | null }) {
  const { lobbyId } = useParams();
  const dialog = useDialog();
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const me = session?.user.id ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  const poll = useQuery({
    queryKey: ['lobby', lobbyId],
    queryFn: () => api<LobbySnapshot>(`/lobbies/${lobbyId}`),
    refetchInterval: POLL_MS,
    enabled: session !== null,
    retry: false,
  });

  const data = poll.data ?? null;
  const isHost = data !== null && me !== null && data.hostUserId === me;

  // 选题回跳：/lobbies/:id?selectPuzzle=xxx 提交给等待室（只记内存）
  useEffect(() => {
    const selectPuzzle = params.get('selectPuzzle');
    if (!selectPuzzle || !lobbyId || !isHost) return;
    setParams({}, { replace: true });
    void api(`/lobbies/${lobbyId}/select`, { method: 'POST', body: { puzzleId: selectPuzzle, language } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['lobby', lobbyId] }))
      .catch((err: unknown) => setError(translateApiError(err, language, copy.selectPuzzleFail)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, isHost]);

  // 开局去向：等待室变成正式房间，全员自动跳转
  useEffect(() => {
    if (data?.startedRoomId) navigate(`/rooms/${data.startedRoomId}`, { replace: true });
  }, [data?.startedRoomId, navigate]);

  const startRound = async () => {
    if (!lobbyId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ roomId: string; inviteToken: string }>(`/lobbies/${lobbyId}/start`, { method: 'POST' });
      localStorage.setItem(`jev.invite.${result.roomId}`, result.inviteToken);
      navigate(`/rooms/${result.roomId}`, { replace: true });
    } catch (err) {
      setError(translateApiError(err, language, copy.startFail));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (!lobbyId || !(await dialog.confirm(copy.dismissLobbyConfirm))) return;
    await api(`/lobbies/${lobbyId}`, { method: 'DELETE' });
    navigate('/', { replace: true });
  };

  const leave = async () => {
    if (!lobbyId) return;
    await api(`/lobbies/${lobbyId}/leave`, { method: 'POST' });
    navigate('/', { replace: true });
  };

  const kick = (userId: string) => {
    if (!lobbyId) return;
    void api(`/lobbies/${lobbyId}/kick`, { method: 'POST', body: { userId } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['lobby', lobbyId] }))
      .catch((err: unknown) => setError(translateApiError(err, language, copy.startFail)));
  };

  const copyInvite = async () => {
    if (!lobbyId) return;
    const token = localStorage.getItem(`jev.lobby-invite.${lobbyId}`);
    if (!token) return;
    try {
      await navigator.clipboard.writeText(inviteUrl(location.origin, token));
      setInviteCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!session) {
    return (
      <main className="shell">
        <p className="muted">{copy.needLoginForRoom}</p>
        <button className="btn btn-primary" onClick={() => navigate(`/login?next=/lobbies/${lobbyId}`)}>{copy.login}</button>
      </main>
    );
  }

  if (poll.isPending) {
    return <main className="shell page-loading"><p className="muted">{copy.loadingRound}</p></main>;
  }

  // 等待室被解散 / 闲置回收 / 被移出
  if (poll.isError || !data) {
    const code = poll.error instanceof ApiError ? poll.error.code : null;
    return (
      <main className="shell">
        <p className="error-text" role="alert">
          {code === 'MEMBER_RESTRICTED' ? copy.kickedFromRoom : copy.lobbyDismissed}
        </p>
        <button className="btn" onClick={() => navigate('/')}>{copy.back}</button>
      </main>
    );
  }

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.lobbyTitle}</h1>
      </header>

      <section className="panel stack">
        <h2>{copy.lobbyTitle}</h2>
        <p className="muted">
          {format(copy.roomOf, { name: data.members.find((m) => m.isHost)?.nickname ?? '', n: data.members.length, cap: data.capacity })}
        </p>

        <ul className="member-list">
          {data.members.map((m) => (
            <li key={m.userId} className="member-row">
              <span className={`presence-dot ${m.online ? 'online' : ''}`} aria-hidden />
              <span className={`member-name${m.userId === me ? ' member-name-self' : ''}`}>{m.nickname}</span>
              {m.isHost && <span className="verdict-badge verdict-solved">{copy.host}</span>}
              {isHost && !m.isHost && (
                <span className="member-actions">
                  <button className="btn btn-sm btn-danger" onClick={() => kick(m.userId)}>{copy.kick}</button>
                </span>
              )}
            </li>
          ))}
        </ul>

        {isHost ? (
          <div className="stack">
            <PuzzleSelection title={data.selectedPuzzle?.title ?? null} href={`/library?mode=select&lobby=${lobbyId}&lang=${language}`} />
            <button className="btn btn-primary" disabled={busy || !data.selectedPuzzle} onClick={() => void startRound()}>
              {busy ? copy.submitting : copy.startRound}
            </button>
            <div className="hint-row">
              <button className="btn" disabled={busy} onClick={() => void copyInvite()}>{copy.invite}</button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void dismiss()}
              >
                {copy.dismissLobby}
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            {data.selectedPuzzle && <p>{copy.currentPuzzle}：{data.selectedPuzzle.title}</p>}
            <p className="muted">{copy.lobbyWaitingHint}</p>
            <button className="btn" onClick={() => void leave()}>{copy.leaveLobby}</button>
          </div>
        )}

        {inviteCopied && <p className="accent">{copy.inviteCopied}</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}
