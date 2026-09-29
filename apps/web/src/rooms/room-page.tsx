/**
 * 房间页：等待室（成员/选题/邀请）与游戏区（成对问答、讨论、提示、还原），
 * 结算展示汤底与统计。所有写操作走 HTTP 命令；状态由 useRoomSync 权威同步。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { displayVerdict, verdictDetail, format, t } from '@jev/i18n';
import { useRoomSync } from './use-room-sync.js';
import { useRoomOutbox } from './use-room-outbox.js';
import type { InputMode } from './room-local.js';
import { HintCapsule } from '../game/hint-capsule.js';
import { inviteUrl, confidenceLabel } from '../game/game-display.js';
import { VoteButtons } from '../catalog/vote-buttons.js';
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
  const { state, status, kicked, sendCommand, confirmResult } = useRoomSync(roomId ?? '', me);
  const outbox = useRoomOutbox(me, roomId ?? '', state, status, sendCommand, confirmResult);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tab = outbox.local?.tab ?? 'qa';
  const inputMode = outbox.local?.mode ?? 'ask';
  const text = outbox.local?.drafts[inputMode] ?? '';
  const setInputMode = (next: InputMode) => { void outbox.update((value) => ({ ...value, mode: next, tab: next === 'discussion' ? 'discuss' : 'qa' })).catch(() => undefined); };
  const setText = (next: string) => { void outbox.update((value) => ({ ...value, drafts: { ...value.drafts, [inputMode]: next } })).catch(() => undefined); };
  const [managementOpen, setManagementOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [newMessages, setNewMessages] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const pendingCurrent = outbox.local?.pending.some((p) => p.input.type === inputMode && (p.status === 'sending' || p.status === 'confirming')) ?? false;

  const run = useCallback(
    async (type: string, payload?: Record<string, unknown>, roundId?: string) => {
      if (busy || status !== 'ready') return;
      setBusy(true);
      setError(null);
      try {
        const result = await outbox.submit({ type, ...(payload !== undefined ? { payload } : {}), ...(roundId !== undefined ? { roundId } : {}), expectedControlVersion: state?.controlVersion ?? 0 });
        if (result?.inviteToken) {
          localStorage.setItem(`jev.invite.${roomId}`, result.inviteToken);
          await navigator.clipboard.writeText(inviteUrl(location.origin, result.inviteToken));
          setInviteCopied(true);
        }
        return result;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '操作失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [busy, status, outbox.submit, state?.controlVersion, roomId],
  );

  // 选题回跳：/rooms/:id?selectPuzzle=xxx
  useEffect(() => {
    const selectPuzzle = params.get('selectPuzzle');
    if (!selectPuzzle || !state || !me || state.hostUserId !== me || status !== 'ready') return;
    void run('select_puzzle', { puzzleId: selectPuzzle, language }).then((result) => {
      if (result) setParams({}, { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, state?.hostUserId, status, outbox.local?.key]);

  useEffect(() => {
    if (atBottom.current) chatBottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    else setNewMessages(true);
  }, [state?.turns.length, state?.discussions.length]);

  useEffect(() => {
    const onScroll = () => {
      atBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180;
      if (atBottom.current) setNewMessages(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (status === 'ready') { setShowConnection(false); return; }
    if (status === 'offline' || status === 'auth_required' || status === 'forbidden') { setShowConnection(true); return; }
    const timer = setTimeout(() => setShowConnection(true), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  const round = state?.round ?? null;
  const translatedPuzzle = useQuery({
    queryKey: ['room-puzzle', round?.puzzleId, language],
    queryFn: () => api<{ title: string; surface: string }>(`/puzzles/${round!.puzzleId}?language=${language}`),
    enabled: !!round && round.language !== language,
    retry: false,
  });
  const displayedTitle = round?.language === language ? round.title : translatedPuzzle.data?.title;
  const displayedSurface = round?.language === language ? round.surface : translatedPuzzle.data?.surface;
  const isHost = state !== null && me !== null && state.hostUserId === me;
  const memberCount = state?.members.length ?? 0;

  const puzzles = useQuery({
    queryKey: ['puzzles-for-select', language],
    queryFn: () => api<{ items: PuzzleItem[] }>(`/puzzles?language=${language}&limit=50`),
    enabled: isHost && state !== null && state.round === null,
  });

  const send = async () => {
    if (!state?.round || !text.trim() || busy || pendingCurrent || status !== 'ready') return;
    await run(inputMode, { text: text.trim() }, state.round.roundId);
  };

  // 每次读取最新令牌，重置邀请后立即使用新链接。
  const copyInvite = async () => {
    try {
      const token = localStorage.getItem(`jev.invite.${roomId}`);
      if (!token) { await run('rotate_invite'); return; }
      await navigator.clipboard.writeText(inviteUrl(location.origin, token));
      setInviteCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (kicked) {
    return (
      <main className="shell">
        <p className="error-text">你已不在该房间。</p>
        {text && <textarea className="field" aria-label="保留的草稿" readOnly value={text} />}
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
        <p className="muted">{status === 'auth_required' ? '登录已过期，请重新登录' : status === 'offline' ? copy.offline : '加载中…'}</p>
        {status === 'auth_required' && <a className="btn" href={`/login?next=/rooms/${roomId}`}>重新登录</a>}
      </main>
    );
  }

  const answered = round && (round.status === 'solved' || round.status === 'revealed');

  return (
    <main className="shell room-shell">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>{copy.back}</button>
        <h1 className="brand brand-sm">{round ? displayedTitle ?? (language === 'zh' ? '加载中…' : 'Loading…') : copy.waitingRoom}</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => setManagementOpen((open) => !open)} aria-expanded={managementOpen}>
          {language === 'zh' ? '玩家' : 'Players'} {memberCount}/{state.capacity}
        </button>
      </header>

      {showConnection && status !== 'ready' && <p className="offline-banner" role="status">{status === 'auth_required' ? '登录已过期，请重新登录' : status === 'offline' ? '网络已断开，草稿已保留' : '正在恢复连接…'}{status === 'auth_required' && <a href={`/login?next=/rooms/${roomId}`}>重新登录</a>}</p>}
      {outbox.storageError && <p className="error-text" role="alert">{outbox.storageError}</p>}
      {translatedPuzzle.isError && <p className="error-text" role="alert">{language === 'zh' ? '该题的中文版本暂不可用' : 'The English version is unavailable'}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {outbox.local?.pending.filter((p) => !['ask', 'solve', 'discussion'].includes(p.input.type) && p.status !== 'sent').map((p) => <div key={p.input.clientRequestId} role="status">
        <p>{p.status === 'rejected' ? p.error : p.status === 'sending' ? '操作提交中…' : '正在确认操作结果'}</p>
        {p.status === 'confirming' && <button className="btn btn-sm" disabled={status !== 'ready'} onClick={() => void outbox.retry(p).catch(() => undefined)}>继续确认</button>}
      </div>)}
      {managementOpen && <section className="panel stack" aria-label={language === 'zh' ? '玩家管理' : 'Player management'}>
        <h2>{language === 'zh' ? '房间成员' : 'Room members'}</h2>
        <MemberList state={state} me={me} isHost={isHost && state.roomStatus !== 'closed'} onKick={(userId) => void run('kick', { userId })} onTransfer={(userId) => void run('transfer_host', { userId })} />
        {isHost && state.roomStatus !== 'closed' && <div className="hint-row">
          <button className="btn" disabled={busy} onClick={() => void copyInvite()}>{copy.invite}</button>
          <button className="btn" disabled={busy} onClick={() => void run('rotate_invite')}>{language === 'zh' ? '重置邀请链接' : 'Reset invite link'}</button>
        </div>}
      </section>}
      {inviteCopied && <p className="accent">{copy.inviteCopied}</p>}

      {state.roomStatus === 'closed' && !answered && (
        <section className="panel stack">
          <p className="muted">房间已结束，历史记录保留可查。</p>
          <div className="hint-row">
            {isHost && (
              <button className="btn btn-primary" onClick={() => navigate(`/library?mode=select&followup=${roomId}&lang=${language}`)}>
                {copy.nextPuzzle}
              </button>
            )}
            {state.followupTargetRoomId && (
              <button className="btn btn-primary" onClick={() => navigate(`/rooms/${state.followupTargetRoomId}`)}>
                {copy.enterNewRoom}
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => navigate('/')}>{copy.back}</button>
          </div>
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
                    if (window.confirm(copy.closeRoomConfirm)) void run('close_room').then((result) => { if (result) navigate('/'); });
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
            <p className="story">{displayedSurface}</p>
          </section>

          <section className="chat" aria-live="polite">
            {tab === 'qa' &&
              state.turns.map((turn) => (
                <div key={turn.turnId} data-message-id={turn.turnId} className={`turn turn-${turn.kind}`}>
                  <p className="turn-text">
                    <strong>{turn.nickname}</strong>：{turn.text}
                  </p>
                  {turn.userId === me && <span className="muted">已发送</span>}
                  {turn.status === 'queued' && <p className="muted turn-status">{copy.queued}</p>}
                  {turn.status === 'processing' && <p className="muted turn-status">{copy.judging}</p>}
                  {turn.status === 'failed' && <p className="error-text turn-status">{copy.failed}</p>}
                  {turn.status === 'succeeded' && turn.result && (
                    <p className="turn-result">
                      <span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span>
                      <small className="confidence">{confidenceLabel(turn.confidence, language)}</small>
                    </p>
                  )}
                </div>
              ))}
            {tab === 'discuss' &&
              state.discussions.map((d) => (
                <div key={d.eventId} data-message-id={d.eventId} className="turn turn-ask">
                  <p className="turn-text">
                    <strong>{d.nickname}</strong>：{d.text}
                  </p>
                  {d.userId === me && <span className="muted">已发送</span>}
                </div>
              ))}
            {outbox.local?.pending.filter((p) => {
              if (!['ask', 'solve', 'discussion'].includes(p.input.type) || (tab === 'discuss') !== (p.input.type === 'discussion')) return false;
              return !state.turns.some((t) => t.clientRequestId === p.input.clientRequestId || t.turnId === p.result?.turnId)
                && !state.discussions.some((d) => d.clientRequestId === p.input.clientRequestId || d.eventId === p.result?.discussionId);
            }).map((p) => <div className="turn" key={p.input.clientRequestId} data-pending-id={p.input.clientRequestId}>
              <p className="turn-text">{String(p.input.payload?.text ?? '')}</p>
              <p className="muted" role="status">{p.status === 'sent' ? '已发送' : p.status === 'sending' ? '发送中…' : p.status === 'confirming' ? '正在确认发送结果' : `未发送：${p.error ?? ''}`}</p>
              {p.status === 'confirming' && <button className="btn btn-sm" disabled={status !== 'ready'} onClick={() => void outbox.retry(p).catch(() => undefined)}>继续确认</button>}
            </div>)}
            <div ref={chatBottomRef} />
          </section>
          {newMessages && <button className="btn btn-sm" onClick={() => { chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); atBottom.current = true; setNewMessages(false); }}>有新消息 ↓</button>}

          <HintCapsule hints={round.hints.filter(Boolean)} />

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
                <button className={`mode-tab ${inputMode === 'discussion' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'discussion'} onClick={() => setInputMode('discussion')}>
                  {copy.discuss}
                </button>
              </div>
              <div className="composer-row">
                <textarea
                  className="field composer-input"
                  rows={2}
                  maxLength={inputMode === 'ask' ? 500 : inputMode === 'discussion' ? 1000 : 1500}
                  disabled={!outbox.local}
                  value={text}
                  placeholder={inputMode === 'ask' ? copy.askPlaceholder : inputMode === 'discussion' ? '和大家讨论…' : copy.solvePlaceholder}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button className="btn btn-primary" disabled={busy || pendingCurrent || status !== 'ready' || !outbox.local || !text.trim()} onClick={() => void send()}>
                  {busy ? copy.submitting : copy.send}
                </button>
              </div>
              <div className="hint-row">
                {isHost && (
                  <>
                    <button className="btn btn-sm" disabled={busy || round.hintsRevealed >= 3} onClick={() => void run('reveal_hint', undefined, round.roundId)}>
                      {copy.hint} {round.hintsRevealed}/3
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
                <button className="btn btn-sm btn-ghost" onClick={() => void run('leave').then((result) => { if (result) navigate('/'); })}>
                  {copy.leave}
                </button>
              </div>
            </footer>
          )}
        </>
      )}

      {/* ---------- 结算（房间已归档：一房一题，历史保留可查） ---------- */}
      {answered && (
        <section className="panel stack">
          <p className={`verdict-badge verdict-${round.status === 'solved' ? 'solved' : 'close'}`}>
            {round.status === 'solved' ? copy.solvedByTeam : copy.revealedAnswer}
          </p>
          <AnswerBlock roundId={round.roundId} />
          {/* 结算投票：多人各账号独立投票（11-VOTES-AND-AUTHORSHIP.md §5） */}
          <VoteButtons puzzleId={round.puzzleId} session={session} initialUp={0} initialDown={0} />
          <div className="hint-row">
            {isHost && (
              <button className="btn btn-primary" onClick={() => navigate(`/library?mode=select&followup=${roomId}&lang=${language}`)}>
                {copy.nextPuzzle}
              </button>
            )}
            {state.followupTargetRoomId && (
              <button className="btn btn-primary" onClick={() => navigate(`/rooms/${state.followupTargetRoomId}`)}>
                {copy.enterNewRoom}
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

export function MemberList({
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
