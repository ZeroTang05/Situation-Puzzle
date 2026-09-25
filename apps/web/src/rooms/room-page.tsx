/**
 * 房间页：等待室（成员/选题/邀请）与游戏区（成对问答、讨论、提示、还原），
 * 结算展示汤底与统计。所有写操作走 HTTP 命令；状态由 useRoomSync 权威同步。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { displayVerdict, verdictDetail, format, t } from '@jev/i18n';
import { useRoomSync } from './use-room-sync.js';
import type { Session } from '../session.js';

interface PuzzleItem {
  id: string;
  title: string;
}

export function RoomPage({ session }: { session: Session | null }) {
  const { roomId } = useParams();
  const { copy, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const me = session?.user.id ?? null;
  const { state, status, kicked, sendCommand, refresh } = useRoomSync(roomId ?? '', me !== null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'qa' | 'discuss'>('qa');
  const [inputMode, setInputMode] = useState<'ask' | 'solve'>('ask');
  const [text, setText] = useState('');
  const [inviteCopied, setInviteCopied] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const run = useCallback(
    async (type: string, payload?: Record<string, unknown>, roundId?: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await sendCommand({ type, ...(payload !== undefined ? { payload } : {}), ...(roundId !== undefined ? { roundId } : {}) });
        if (result.inviteToken) {
          await navigator.clipboard.writeText(`${location.origin}/invite/${result.inviteToken}`).catch(() => undefined);
          setInviteCopied(true);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '操作失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [busy, sendCommand],
  );

  // 选题回跳：/rooms/:id?selectPuzzle=xxx
  useEffect(() => {
    const selectPuzzle = params.get('selectPuzzle');
    if (!selectPuzzle || !state || !me || state.hostUserId !== me) return;
    void run('select_puzzle', { puzzleId: selectPuzzle, language }).then(() => {
      setParams({}, { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, state?.hostUserId]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state?.turns.length, state?.discussions.length]);

  const round = state?.round ?? null;
  const isHost = state !== null && me !== null && state.hostUserId === me;
  const memberCount = state?.members.length ?? 0;

  const puzzles = useQuery({
    queryKey: ['puzzles-for-select', language],
    queryFn: () => api<{ items: PuzzleItem[] }>(`/puzzles?language=${language}&limit=50`),
    enabled: isHost && state !== null && state.round === null,
  });

  const send = async () => {
    if (!state?.round || !text.trim() || busy) return;
    const type = inputMode === 'ask' ? 'ask' : 'solve';
    await run(type, { text: text.trim() }, state.round.roundId);
    setText('');
  };

  const inviteLink = useMemo(() => {
    // 邀请令牌只在建房响应出现；从本页发起复制由「邀请」按钮重新 rotate 前使用本地缓存
    return localStorage.getItem(`jev.invite.${roomId}`);
  }, [roomId]);

  const copyInvite = async () => {
    if (!inviteLink) {
      setError('请从建房页面复制邀请链接，或重置邀请生成新链接。');
      return;
    }
    await navigator.clipboard.writeText(`${location.origin}${inviteLink}`);
    setInviteCopied(true);
  };

  if (kicked) {
    return (
      <main className="shell">
        <p className="error-text">你已不在该房间。</p>
        <button className="btn" onClick={() => navigate('/')}>{copy.back}</button>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="shell">
        <p className="muted">查看房间需要先登录。</p>
        <button className="btn btn-primary" onClick={() => navigate(`/login?next=/rooms/${roomId}`)}>{copy.login}</button>
      </main>
    );
  }
  if (!state) {
    return (
      <main className="shell page-loading">
        <p className="muted">{status === 'offline' ? copy.offline : '加载中…'}</p>
      </main>
    );
  }

  const answered = round && (round.status === 'solved' || round.status === 'revealed');

  return (
    <main className="shell room-shell">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>{copy.back}</button>
        <h1 className="brand brand-sm">{round ? round.title : copy.waitingRoom}</h1>
        <span className="muted">
          {memberCount}/{state.capacity}
        </span>
      </header>

      {status !== 'ready' && <p className="offline-banner">{copy.offline}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {inviteCopied && <p className="accent">{copy.inviteCopied}</p>}

      {state.roomStatus === 'closed' && (
        <section className="panel">
          <p className="muted">房间已关闭。</p>
          <button className="btn" onClick={() => navigate('/')}>{copy.back}</button>
        </section>
      )}

      {/* ---------- 等待室 ---------- */}
      {state.roomStatus === 'waiting' && !answered && (
        <section className="panel stack">
          <h2>{copy.waitingRoom}</h2>
          <MemberList state={state} me={me} isHost={isHost} onKick={(userId) => void run('kick', { userId })} onTransfer={(userId) => void run('transfer_host', { userId })} />
          <div className="stack">
            {isHost && (
              <>
                <a className="btn" href={`/library?mode=select&roomId=${roomId}&lang=${language}`}>
                  {copy.selectPuzzle}
                </a>
                <button className="btn btn-primary" disabled={busy || !state.roomStatus} onClick={() => void run('start_round')}>
                  {copy.startRound}
                </button>
                <button className="btn" onClick={() => void copyInvite()}>{copy.invite}</button>
                {isHost && (
                  <button className="btn" onClick={() => void run('rotate_invite')} disabled={busy}>
                    重置邀请链接
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (window.confirm(copy.closeRoomConfirm)) void run('close_room').then(() => navigate('/'));
                  }}
                >
                  {copy.closeRoom}
                </button>
              </>
            )}
            {!isHost && <p className="muted">{copy.hintLocked}</p>}
          </div>
          {puzzles.data && isHost && (
            <p className="muted">
              题库有 {puzzles.data.items.length} 道题，去「选题」挑一碗汤。
            </p>
          )}
        </section>
      )}

      {/* ---------- 游戏区 ---------- */}
      {round && (
        <>
          <section className="hero-card">
            <p className="accent">{format(copy.roundNo, { n: round.roundNo })}</p>
            <p className="story">{round.surface}</p>
          </section>

          {round.hints.length > 0 && (
            <section className="hint-float" aria-label={copy.hint}>
              {round.hints.filter(Boolean).map((hint, i) => (
                <p key={i}>💡 {hint}</p>
              ))}
            </section>
          )}

          <div className="mode-tabs" role="tablist">
            <button className={`mode-tab ${tab === 'qa' ? 'active' : ''}`} role="tab" aria-selected={tab === 'qa'} onClick={() => setTab('qa')}>
              问答
            </button>
            <button className={`mode-tab ${tab === 'discuss' ? 'active' : ''}`} role="tab" aria-selected={tab === 'discuss'} onClick={() => setTab('discuss')}>
              讨论
            </button>
          </div>

          <section className="chat" aria-live="polite">
            {tab === 'qa' &&
              state.turns.map((turn) => (
                <div key={turn.turnId} className={`turn turn-${turn.kind}`}>
                  <p className="turn-text">
                    <strong>{turn.nickname}</strong>：{turn.text}
                  </p>
                  {turn.status === 'queued' && <p className="muted turn-status">{copy.queued}</p>}
                  {turn.status === 'processing' && <p className="muted turn-status">{copy.judging}</p>}
                  {turn.status === 'failed' && <p className="error-text turn-status">{copy.failed}</p>}
                  {turn.status === 'succeeded' && turn.result && (
                    <p className="turn-result">
                      <span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span>
                    </p>
                  )}
                </div>
              ))}
            {tab === 'discuss' &&
              state.discussions.map((d) => (
                <div key={d.eventId} className="turn turn-ask">
                  <p className="turn-text">
                    <strong>{d.nickname}</strong>：{d.text}
                  </p>
                </div>
              ))}
            <div ref={chatBottomRef} />
          </section>

          {/* ---------- 操作行 ---------- */}
          {round.status === 'active' && (
            <footer className="composer">
              <div className="mode-tabs" role="tablist">
                <button className={`mode-tab ${inputMode === 'ask' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'ask'} onClick={() => setInputMode('ask')}>
                  {copy.ask}
                </button>
                <button className={`mode-tab ${inputMode === 'solve' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'solve'} onClick={() => setInputMode('solve')}>
                  {copy.solve}
                </button>
                <button className="mode-tab" onClick={() => setTab('discuss')}>
                  {copy.discuss}
                </button>
              </div>
              <div className="composer-row">
                <textarea
                  className="field composer-input"
                  rows={2}
                  maxLength={inputMode === 'ask' ? 500 : 1500}
                  value={text}
                  placeholder={inputMode === 'ask' ? copy.askPlaceholder : copy.solvePlaceholder}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void send()}>
                  {busy ? copy.submitting : copy.send}
                </button>
              </div>
              <div className="hint-row">
                {isHost && (
                  <>
                    <button className="btn btn-sm" disabled={busy || round.hintsRevealed >= 3} onClick={() => void run('reveal_hint', undefined, round.roundId)}>
                      {copy.hint} +1
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        if (window.confirm(copy.revealConfirm)) void run('reveal_answer', undefined, round.roundId);
                      }}
                    >
                      {copy.reveal}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        if (window.confirm(copy.endRoundConfirm)) void run('end_round', undefined, round.roundId);
                      }}
                    >
                      {copy.endRound}
                    </button>
                  </>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => void run('leave').then(() => navigate('/'))}>
                  {copy.leave}
                </button>
              </div>
            </footer>
          )}
        </>
      )}

      {/* ---------- 结算 ---------- */}
      {answered && (
        <section className="panel stack">
          <p className={`verdict-badge verdict-${round.status === 'solved' ? 'solved' : 'close'}`}>
            {round.status === 'solved' ? copy.solvedByTeam : copy.revealedAnswer}
          </p>
          <AnswerBlock roundId={round.roundId} />
          <div className="hint-row">
            {isHost && (
              <button className="btn btn-primary" onClick={() => navigate(`/library?mode=select&roomId=${roomId}&lang=${language}`)}>
                {copy.nextRound}
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => navigate('/')}>{copy.back}</button>
          </div>
        </section>
      )}

      <button className="btn btn-sm btn-ghost lang-float" onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}>
        {language === 'zh' ? 'EN' : '中文'}
      </button>
      <span hidden>{t('zh').brand}</span>
    </main>
  );
}

function MemberList({
  state,
  me,
  isHost,
  onKick,
  onTransfer,
}: {
  state: { members: Array<{ userId: string; nickname: string; online: boolean; isHost: boolean }>; hostUserId: string };
  me: string | null;
  isHost: boolean;
  onKick: (userId: string) => void;
  onTransfer: (userId: string) => void;
}) {
  const { copy } = useLanguage();
  return (
    <ul className="member-list">
      {state.members.map((m) => (
        <li key={m.userId} className="member-row">
          <span className={`presence-dot ${m.online ? 'online' : ''}`} aria-hidden />
          <span>
            {m.nickname}
            {m.userId === me ? '（我）' : ''}
          </span>
          {m.isHost && <span className="verdict-badge verdict-solved">{copy.host}</span>}
          {isHost && !m.isHost && (
            <span className="member-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => onTransfer(m.userId)}>
                {copy.transfer}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => onKick(m.userId)}>
                {copy.kick}
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function AnswerBlock({ roundId }: { roundId: string }) {
  const { language } = useLanguage();
  const [answer, setAnswer] = useState<string | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    void api<{ answer: string; hints: string[] }>(`/rounds/${roundId}/answer`)
      .then((data) => {
        setAnswer(data.answer);
        setHints(data.hints);
      })
      .catch(() => setError(true));
  }, [roundId]);

  if (error) return <p className="muted">汤底加载失败。</p>;
  if (!answer) return <p className="muted">加载中…</p>;
  return (
    <div className="stack">
      <h3>{t(language).answer}</h3>
      <p>{answer}</p>
      {hints.length > 0 && (
        <details>
          <summary className="muted">{t(language).hint}（{hints.length}）</summary>
          {hints.map((h, i) => (
            <p key={i} className="muted">
              {i + 1}. {h}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

void verdictDetail;
