/**
 * 房间页：游戏区（成对问答、讨论、提示、还原）与结算，成员管理与邀请。
 * 组队阶段在等待室页（/lobbies/:id）；本页从开局后的快照开始。所有写操作走 HTTP 命令。
 */
import { Modal, useDialog } from '@jev/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { displayVerdict, format } from '@jev/i18n';
import { canRateRoomPuzzle, type HostVerdict } from '@jev/contracts';
import { useRoomSync } from './use-room-sync.js';
import { useRoomOutbox } from './use-room-outbox.js';
import type { InputMode } from './room-local.js';
import { HintCapsule, useHintPlayer } from '../game/hint-capsule.js';
import { GameHeader } from '../game/game-header.js';
import { ChatInput } from '../game/chat-input.js';
import { LargeModelToggle } from '../game/large-model-toggle.js';
import { inviteUrl, confidenceLabel } from '../game/game-display.js';
import { StoryCard } from '../game/story-card.js';
import { VoteButtons } from '../catalog/vote-buttons.js';
import type { Session } from '../session.js';
import { MessageDelivery } from './message-delivery.js';
import { RoomShell } from './room-shell.js';
import { VisibilityToggle } from './visibility-toggle.js';
import { Toast } from '../toast.js';
import { loginHref } from '../auth/login-navigation.js';

export function RoomPage({ session }: { session: Session | null }) {
  const { roomId } = useParams();
  const dialog = useDialog();
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const login = loginHref(useLocation());
  // 房间页的"返回"键严格走 history 栈：
  // - 从 lobby start 过来：栈里有 lobby，按返回回 lobby（栈自然行为，无需硬塞 state）
  // - 从「我的」/首页/继续我的房间 进来：栈里只有上一页，按返回回那一页
  // - 直达链接：idx=0，useBack 兜底到首页
  const back = useBack('/');
  const me = session?.user.id ?? null;
  const { state, status, kicked, sendCommand, confirmResult } = useRoomSync(roomId ?? '', me);
  const outbox = useRoomOutbox(me, roomId ?? '', state, status, sendCommand, confirmResult);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useLargeModel, setUseLargeModel] = useState(false);
  const tab = outbox.local?.tab ?? 'qa';
  const inputMode = outbox.local?.mode ?? 'ask';
  const text = outbox.local?.drafts[inputMode] ?? '';
  const setInputMode = (next: InputMode) => { void outbox.update((value) => ({ ...value, mode: next, tab: next === 'discussion' ? 'discuss' : 'qa' })).catch(() => undefined); };
  const setText = (next: string) => { void outbox.update((value) => ({ ...value, drafts: { ...value.drafts, [inputMode]: next } })).catch(() => undefined); };
  const [managementOpen, setManagementOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const managementRef = useRef<HTMLElement>(null);
  const managementToggleRef = useRef<HTMLButtonElement>(null);
  const answeredRef = useRef<HTMLElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [newMessages, setNewMessages] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const pendingCurrent = outbox.local?.pending.some((p) => p.input.type === inputMode && (p.status === 'sending' || p.status === 'confirming')) ?? false;

  // 被拒绝的操作（房间已关闭等）改走悬浮条：只提示一次，不占状态槽、不挤动游戏区
  const [rejectedNotice, setRejectedNotice] = useState<string | null>(null);
  const shownRejectsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(false);
  const pendingList = outbox.local?.pending ?? [];
  const lastRejected = useMemo(() => {
    for (let index = pendingList.length - 1; index >= 0; index -= 1) {
      const item = pendingList[index]!;
      if (['ask', 'solve', 'discussion'].includes(item.input.type)) continue;
      if (item.status !== 'rejected') continue;
      return item;
    }
    return null;
  }, [pendingList]);
  useEffect(() => {
    if (!mountedRef.current) {
      // 首帧不弹：上一次会话遗留的拒绝记录不该在进页面时再报一遍
      mountedRef.current = true;
      return;
    }
    if (!lastRejected) return;
    const id = lastRejected.input.clientRequestId;
    if (shownRejectsRef.current.has(id)) return;
    shownRejectsRef.current.add(id);
    setRejectedNotice(lastRejected.error ?? copy.confirm);
  }, [lastRejected, copy.confirm]);

  // 输入框预提示：随机抽一条常见问题，给不会玩的用户一个起点（进入页面时定一次）
  const askPlaceholder = useMemo(() => {
    const list = copy.askPlaceholderExamples;
    return list.length > 0 ? list[Math.floor(Math.random() * list.length)]! : copy.askPlaceholder;
  }, [copy.askPlaceholderExamples, copy.askPlaceholder]);

  // 成员面板是悬浮卡片：点面板与右上角入口以外的位置收起，不用再点一次按钮
  useEffect(() => {
    if (!managementOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (managementRef.current?.contains(target) || managementToggleRef.current?.contains(target)) return;
      setManagementOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [managementOpen]);

  const run = useCallback(
    async (type: string, payload?: Record<string, unknown>, roundId?: string) => {
      if (busy || status !== 'ready') return;
      setBusy(true);
      setError(null);
      try {
        const result = await outbox.submit({ type, ...(payload !== undefined ? { payload } : {}), ...(roundId !== undefined ? { roundId } : {}), expectedControlVersion: state?.controlVersion ?? 0 });
        if (result?.inviteToken) {
          localStorage.setItem(`jev.invite.${roomId}`, result.inviteToken);
          await navigator.clipboard.writeText(inviteUrl(location.origin, result.inviteToken, 'room'));
          setInviteCopied(true);
        }
        return result;
      } catch (err) {
        setError(translateApiError(err, language, copy.confirm /* 操作失败 fallback */));
      } finally {
        setBusy(false);
      }
    },
    [busy, status, outbox.submit, state?.controlVersion, roomId, copy.confirm],
  );

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
  const answered = round && canRateRoomPuzzle(round.status);
  const hints = round ? round.hints.filter(Boolean) : [];
  // 提示悬浮播放器：房主解锁时展示新提示，其余角色用按钮循环翻阅已开放的提示
  const hintPlayer = useHintPlayer(hints);
  // 公布答案/破解后结算面板排在聊天下方，页面不会自动滚过去：这里主动带到视野里
  useEffect(() => {
    if (answered) answeredRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [answered]);
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
  // 用户主持人形态（17-USER-HOST-MODE）：本房间由玩家主持，Jev 不再自动回答问题
  const isUserHost = state !== null && me !== null && state.userHostId === me;
  const userHostMode = (state?.hostMode ?? 'ai') === 'user';
  const hostView = userHostMode && isUserHost;
  /** 等待用户主持人回答的提问数 */
  const pendingHostQuestions = state?.turns.filter((t) => t.kind === 'ask' && t.status === 'queued').length ?? 0;
  const [hostPrompt, setHostPrompt] = useState<{ userId: string; nickname: string } | null>(null);
  const promptedRequests = useRef(new Set<string>());

  // 房主收到主持申请时弹审核提示（同一申请只提示一次；申请消失后允许再次提示）
  useEffect(() => {
    if (!state) return;
    const current = new Set(state.hostRequests.map((r) => r.userId));
    for (const id of [...promptedRequests.current]) if (!current.has(id)) promptedRequests.current.delete(id);
    if (!isHost) return;
    const next = state.hostRequests.find((r) => !promptedRequests.current.has(r.userId));
    if (!next) return;
    promptedRequests.current.add(next.userId);
    setHostPrompt(next);
  }, [isHost, state]);

  const requestHost = useCallback(() => { void run('request_host'); }, [run]);
  const approveHost = useCallback((userId: string) => { void run('approve_host', { userId }); }, [run]);
  const rejectHost = useCallback((userId: string) => { void run('reject_host', { userId }); }, [run]);
  const revokeHost = useCallback((userId: string) => { void run('revoke_host', { userId }); }, [run]);
  const resignHost = useCallback(() => { void run('resign_host'); }, [run]);
  const answerTurn = useCallback(
    (turnId: string, verdict: HostVerdict) => {
      void run('host_answer', { turnId, verdict }, state?.round?.roundId);
    },
    [run, state?.round?.roundId],
  );

  const send = async () => {
    if (!state?.round || !text.trim() || busy || pendingCurrent || status !== 'ready') return;
    await run(inputMode, { text: text.trim(), ...(inputMode === 'solve' ? { useLargeModel } : {}) }, state.round.roundId);
  };

  // 每次读取最新令牌，重置邀请后立即使用新链接。
  const copyInvite = async () => {
    try {
      const token = localStorage.getItem(`jev.invite.${roomId}`);
      if (!token) { await run('rotate_invite'); return; }
      await navigator.clipboard.writeText(inviteUrl(location.origin, token, 'room'));
      setInviteCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (kicked) {
    return (
      <main className="shell">
        <p className="error-text">{copy.kickedFromRoom}</p>
        {text && <textarea className="field" aria-label={copy.draftKept} readOnly value={text} />}
        <button className="btn" onClick={() => navigate('/')}>{copy.back}</button>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="shell">
        <p className="muted">{copy.needLoginForRoom}</p>
        <button className="btn btn-primary" onClick={() => navigate(login)}>{copy.login}</button>
      </main>
    );
  }
  if (!state) {
    return (
      <main className="shell page-loading">
        <p className="muted">{status === 'auth_required' ? copy.authExpired : status === 'offline' ? copy.offline : copy.loadingRound}</p>
        {status === 'auth_required' && <a className="btn" href={login}>{copy.reconnect}</a>}
      </main>
    );
  }

  // 头部状态行（掉线/存储错误/进行中的非聊天操作）：任一存在即展开状态槽，收起时不顶动游戏区
  // 主持形态提示与操作错误已改为悬浮条，不再占状态槽
  const pendingNotices = (outbox.local?.pending ?? []).filter((p) => !['ask', 'solve', 'discussion'].includes(p.input.type) && p.status !== 'sent');
  // 被拒绝的不进状态槽：改由悬浮条提示
  const inlineNotices = pendingNotices.filter((p) => p.status !== 'rejected');
  const hasStatus = (showConnection && status !== 'ready') || Boolean(outbox.storageError || translatedPuzzle.isError) || inlineNotices.length > 0;

  return (
    <RoomShell playing={round?.status === 'active' && state.roomStatus === 'playing'}>
      <GameHeader
        title={displayedTitle ?? copy.loadingRound}
        back={<button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>}
        action={<button ref={managementToggleRef} className="btn btn-ghost btn-sm" onClick={() => setManagementOpen((open) => !open)} aria-expanded={managementOpen}>
          {format(language === 'zh' ? copy.playersCount : copy.playersCountEn, { n: memberCount, cap: state.capacity })}
        </button>}
      />

      <div className={`appear-slot${hasStatus ? ' open' : ''}`}>
        <div className="status-lines">
          {showConnection && status !== 'ready' && <p className="offline-banner" role="status">{status === 'auth_required' ? copy.authExpired : status === 'offline' ? copy.networkKeptDraft : copy.reconnecting}{status === 'auth_required' && <a href={`/login?next=/rooms/${roomId}`}>{copy.reconnect}</a>}</p>}
          {outbox.storageError && <p className="error-text" role="alert">{outbox.storageError}</p>}
          {translatedPuzzle.isError && <p className="error-text" role="alert">{language === 'zh' ? copy.translatedFail : copy.translatedFailEn}</p>}
          {inlineNotices.map((p) => <div key={p.input.clientRequestId} role="status">
            <p>{p.status === 'sending' ? copy.operationSubmitting : copy.confirming}</p>
            {p.status === 'confirming' && <button className="btn btn-sm" disabled={status !== 'ready'} onClick={() => void outbox.retry(p).catch(() => undefined)}>{copy.keepConfirming}</button>}
          </div>)}
        </div>
      </div>
      {/* 操作反馈改为悬浮条：不挤占布局，到点自动消失 */}
      {error && <Toast message={error} tone="error" durationMs={4000} onDone={() => setError(null)} />}
      {rejectedNotice && <Toast message={rejectedNotice} tone="error" durationMs={4000} onDone={() => setRejectedNotice(null)} />}
      {managementOpen && <section ref={managementRef} className="panel stack room-management game-scroll" aria-label={copy.membersManagement}>
        <h2>{copy.membersHeader}</h2>
        <MemberList
          state={state}
          me={me}
          isHost={isHost && state.roomStatus !== 'closed'}
          onKick={(userId) => void run('kick', { userId })}
          onRequestHost={requestHost}
          onApproveHost={approveHost}
          onRejectHost={rejectHost}
          onRevokeHost={revokeHost}
          onResignHost={resignHost}
        />
        {isHost && state.roomStatus !== 'closed' && <>
          <div className="visibility-box">
            <VisibilityToggle checked={state.isPublic} disabled={busy} onChange={(next) => void run('set_visibility', { isPublic: next })} />
          </div>
          <div className="room-management-actions">
            <button className="btn room-management-wide" disabled={busy} onClick={() => void copyInvite()}>{copy.invite}</button>
            <button className="btn" disabled={busy} onClick={() => void run('rotate_invite')}>{language === 'zh' ? copy.resettingInvite : copy.resetInviteEn}</button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                if (await dialog.confirm(copy.closeRoomConfirm, copy.closeRoom)) void run('close_room').then((result) => { if (result) navigate('/'); });
              }}
            >
              {copy.closeRoom}
            </button>
          </div>
        </>}
        {/* 离开房间收进管理面板：底部操作行只留给本局相关的操作，窄屏不再挤成一排小字按钮 */}
        {state.roomStatus !== 'closed' && (
          <button className="btn btn-ghost room-management-wide" disabled={busy} onClick={() => void run('leave').then((result) => { if (result) navigate('/'); })}>
            {copy.leave}
          </button>
        )}
      </section>}
      {/* 邀请链接已复制：悬浮提示，2 秒后自动消失 */}
      {inviteCopied && <Toast message={copy.inviteCopied} onDone={() => setInviteCopied(false)} />}

      {/* ---------- 游戏区 ---------- */}
      {round && (
        <>
          <StoryCard>
              {round.category && (
                <span className="puzzle-card-category" style={{ marginBottom: '12px' }}>
                  {round.category === 'honkaku' ? copy.honkaku : copy.henkaku}
                </span>
              )}
              {round.difficulty && (
                <span className={`puzzle-card-difficulty puzzle-card-difficulty-${round.difficulty}`} style={{ marginBottom: '12px' }}>
                  {round.difficulty === 'easy' ? copy.easy : round.difficulty === 'hard' ? copy.hard : copy.medium}
                </span>
              )}
              <p className="story">{displayedSurface}</p>
          </StoryCard>

          {/* 对话区：提示胶囊挂在区顶（题面下方），只遮对话流、不遮 mode-tabs 与输入区 */}
          <div className="chat-area">
            {/* 提示悬浮胶囊：10 秒自动收起 */}
            <HintCapsule hints={hints} open={hintPlayer.open} index={hintPlayer.index} onIndex={hintPlayer.show} />
            <section className="chat game-scroll" aria-live="polite">
            <div className="chat-stream">
            {/* 用户主持人的「查看汤底」子页面：直接展示汤底，不弹确认框 */}
            {hostView && inputMode === 'solve' && round && <HostSecret roundId={round.roundId} />}
            {tab === 'qa' &&
              state.turns.map((turn) => (
                <div key={turn.turnId} data-message-id={turn.turnId} className={`turn turn-${turn.kind}`}>
                  <div className="turn-bubble">
                    <p className="turn-text">
                      <strong>{turn.nickname}</strong>：{turn.text}
                    </p>
                    {turn.status === 'queued' && <p className="muted turn-status">{userHostMode ? copy.hostWaitingAnswer : copy.queued}</p>}
                    {turn.status === 'processing' && <p className="muted turn-status">{copy.judging}</p>}
                    {turn.status === 'failed' && <p className="error-text turn-status">{copy.failed}</p>}
                    {turn.status === 'succeeded' && turn.result && (
                      <p className="turn-result">
                        <span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span>
                        {turn.source === 'host' && <span className="verdict-badge verdict-uncertain">{copy.hostAnsweredByHost}</span>}
                        <small className="confidence">{confidenceLabel(turn.confidence, language)}</small>
                      </p>
                    )}
                  </div>
                  {/* 用户主持人：待判定的提交底部给出快捷判定（提问：是/否/无关；还原：破解成功/接近真相/还没猜对） */}
                  {hostView && turn.status === 'queued' && turn.kind === 'ask' && inputMode === 'ask' && (
                    <HostVerdictButtons disabled={busy || status !== 'ready'} onAnswer={(verdict) => answerTurn(turn.turnId, verdict)} />
                  )}
                  {hostView && turn.status === 'queued' && turn.kind === 'solve' && inputMode === 'solve' && (
                    <HostVerdictButtons disabled={busy || status !== 'ready'} onAnswer={(verdict) => answerTurn(turn.turnId, verdict)} verdicts={['solved', 'close', 'not_yet']} />
                  )}
                </div>
              ))}
            {tab === 'discuss' &&
              state.discussions.map((d) => (
                <div key={d.eventId} data-message-id={d.eventId} className="turn turn-ask">
                  <div className="turn-bubble">
                    <p className="turn-text">
                      {/* 用户主持人标记放在昵称前面，与昵称同行 */}
                      {d.userId === state.userHostId && <span className="verdict-badge verdict-uncertain host-tag">{copy.userHost}</span>}
                      <strong>{d.nickname}</strong>：{d.text}
                    </p>
                  </div>
                </div>
              ))}
            {outbox.local?.pending.filter((p) => {
              if (!['ask', 'solve', 'discussion'].includes(p.input.type) || (tab === 'discuss') !== (p.input.type === 'discussion')) return false;
              return !state.turns.some((t) => t.clientRequestId === p.input.clientRequestId || t.turnId === p.result?.turnId)
                && !state.discussions.some((d) => d.clientRequestId === p.input.clientRequestId || d.eventId === p.result?.discussionId);
            }).map((p) => {
              const kindClass = p.input.type === 'solve' ? 'turn-solve' : 'turn-ask';
              const self = state.members.find((m) => m.userId === me);
              return <div className={`turn ${kindClass}`} key={p.input.clientRequestId} data-pending-id={p.input.clientRequestId}>
                <div className="turn-bubble">
                  <p className="turn-text">{self ? <><strong>{self.nickname}</strong>：</> : null}{String(p.input.payload?.text ?? '')}</p>
                  <MessageDelivery status={p.status} {...(p.error !== undefined ? { error: p.error } : {})} />
                </div>
                {p.status === 'confirming' && <button className="btn btn-sm" disabled={status !== 'ready'} onClick={() => void outbox.retry(p).catch(() => undefined)}>{copy.keepConfirming}</button>}
              </div>;
            })}
            <div ref={chatBottomRef} />
            </div>
          </section>
          </div>
          <div className={`appear-slot${newMessages ? ' open' : ''}`} inert={!newMessages}>
            <button className="btn btn-sm" onClick={() => { chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); atBottom.current = true; setNewMessages(false); }}>{copy.newMessages} ↓</button>
          </div>

          {/* ---------- 操作行 ---------- */}
          {round.status === 'active' && (
            <footer className="composer">
              {!hostView && (
                <div className={`appear-slot${inputMode === 'solve' ? ' open' : ''}`} inert={inputMode !== 'solve'}>
                  <LargeModelToggle checked={useLargeModel} disabled={busy || pendingCurrent || status !== 'ready'} onChange={setUseLargeModel} />
                </div>
              )}
              <div className="mode-tabs" role="tablist">
                <button className={`mode-tab ${inputMode === 'ask' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'ask'} onClick={() => setInputMode('ask')}>
                  {copy.askTab}
                </button>
                <button className={`mode-tab ${inputMode === 'solve' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'solve'} onClick={() => setInputMode('solve')}>
                  {hostView ? copy.hostViewAnswer : copy.solve}
                </button>
                <button className={`mode-tab ${inputMode === 'discussion' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'discussion'} onClick={() => setInputMode('discussion')}>
                  {copy.discuss}
                </button>
              </div>
              <div className="composer-row">
                {/* 用户主持人：提问页由主持形态接管；查看汤底页直接展示汤底，输入区留空；讨论页照常发言 */}
                {hostView && inputMode === 'ask' ? (
                  <p className="muted host-mode-note">
                    {pendingHostQuestions > 0 ? `${format(copy.hostAnswerTitle, { n: pendingHostQuestions })} · ${copy.hostAnswerHint}` : copy.hostAnswerEmpty}
                  </p>
                ) : hostView && inputMode === 'solve' ? null : (
                  <>
                    <ChatInput
                      maxLength={inputMode === 'ask' ? 500 : inputMode === 'discussion' ? 1000 : 1500}
                      disabled={!outbox.local}
                      value={text}
                      placeholder={inputMode === 'ask' ? askPlaceholder : inputMode === 'discussion' ? copy.discussPlaceholder : copy.solvePlaceholder}
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
                  </>
                )}
              </div>
              <div className="room-actions">
                {/* 玩家/用户主持人：房主开放提示后，用按钮循环翻阅悬浮窗里的已开放提示 */}
                {!isHost && hints.length > 0 && (
                  <button className="btn btn-sm" onClick={() => hintPlayer.cycle()}>
                    {copy.hint} {hints.length}/3
                  </button>
                )}
                {isHost && (
                  <>
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => {
                        // 还有未开放的提示：开放并悬浮展示新一条；全部开放后：按钮变成循环翻阅
                        if (round.hintsRevealed < 3) {
                          void run('reveal_hint', undefined, round.roundId).then(() => hintPlayer.show(hints.length));
                        } else {
                          hintPlayer.cycle();
                        }
                      }}
                    >
                      {copy.hint} {round.hintsRevealed}/3
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={async () => {
                        if (await dialog.confirm(copy.revealConfirm, copy.reveal)) void run('reveal_answer', undefined, round.roundId);
                      }}
                    >
                      {copy.reveal}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={async () => {
                        if (await dialog.confirm(copy.endRoundConfirm, copy.endRound)) void run('end_round', undefined, round.roundId);
                      }}
                    >
                      {copy.endRound}
                    </button>
                  </>
                )}
              </div>
            </footer>
          )}
        </>
      )}

      {/* 已结束且未出汤底：输入区原位换成单个继续操作（返回走顶部返回键）；成员无可操作时不渲染 */}
      {state.roomStatus === 'closed' && !answered && (isHost || state.followupTargetRoomId) && (
        <footer className="room-closed-bar">
          {state.followupTargetRoomId ? (
            // 续局新房替换旧房（v3 一房一题，旧房已归档）：新房的返回跳过旧房直接回到上一级。
            <button className="btn btn-primary" onClick={() => navigate(`/rooms/${state.followupTargetRoomId}`, { replace: true })}>
              {copy.enterNewRoom}
            </button>
          ) : (
            // 已归档房间是过渡态：跳 library 时把旧房从 history 移除，避免选完题回退时落到旧房结算页。
            <button className="btn btn-primary" onClick={() => navigate(`/library?mode=select&followup=${roomId}&lang=${language}`, { replace: true })}>
              {copy.nextPuzzle}
            </button>
          )}
        </footer>
      )}

      {/* ---------- 结算（房间已归档：一房一题，历史保留可查） ---------- */}
      {answered && (
        <section ref={answeredRef} className="panel stack">
          <p className={`verdict-badge verdict-${round.status === 'solved' ? 'solved' : 'close'}`}>
            {round.status === 'solved' ? copy.solvedByTeam : copy.revealedAnswer}
          </p>
          <AnswerBlock roundId={round.roundId} />
          {/* 结算投票：多人各账号独立投票（11-VOTES-AND-AUTHORSHIP.md §5） */}
          <VoteButtons puzzleId={round.puzzleId} session={session} initialUp={0} initialDown={0} />
          <div className="hint-row">
            {isHost && (
              // 已归档房间是过渡态：跳 library 时把旧房从 history 移除。
              <button className="btn btn-primary" onClick={() => navigate(`/library?mode=select&followup=${roomId}&lang=${language}`, { replace: true })}>
                {copy.nextPuzzle}
              </button>
            )}
            {state.followupTargetRoomId && (
              // 续局新房替换旧房（v3 一房一题，旧房已归档）。
              <button className="btn btn-primary" onClick={() => navigate(`/rooms/${state.followupTargetRoomId}`, { replace: true })}>
                {copy.enterNewRoom}
              </button>
            )}
            <button className="btn btn-ghost" onClick={back}>{copy.back}</button>
          </div>
        </section>
      )}

      {/* 房主审核主持申请：批准后对方接管本局判定，拒绝只清掉申请 */}
      <Modal
        open={hostPrompt !== null}
        onOpenChange={(open) => { if (!open) setHostPrompt(null); }}
        title={format(copy.hostRequestNotice, { name: hostPrompt?.nickname ?? '' })}
        closeLabel={copy.cancel}
      >
        <p>{format(copy.hostRequestConfirm, { name: hostPrompt?.nickname ?? '' })}</p>
        <div className="hint-row">
          <button
            className="btn btn-primary"
            onClick={() => {
              const target = hostPrompt;
              setHostPrompt(null);
              if (target) approveHost(target.userId);
            }}
          >
            {copy.hostApprove}
          </button>
          <button
            className="btn"
            onClick={() => {
              const target = hostPrompt;
              setHostPrompt(null);
              if (target) rejectHost(target.userId);
            }}
          >
            {copy.hostReject}
          </button>
        </div>
      </Modal>

    </RoomShell>
  );
}

export function MemberList({
  state,
  me,
  isHost,
  onKick,
  onRequestHost,
  onApproveHost,
  onRejectHost,
  onRevokeHost,
  onResignHost,
}: {
  state: {
    members: Array<{ userId: string; nickname: string; online: boolean; isHost: boolean; isUserHost?: boolean }>;
    hostRequests?: Array<{ userId: string; nickname: string }>;
  };
  me: string | null;
  isHost: boolean;
  onKick: (userId: string) => void;
  onRequestHost?: () => void;
  onApproveHost?: (userId: string) => void;
  onRejectHost?: (userId: string) => void;
  onRevokeHost?: (userId: string) => void;
  onResignHost?: () => void;
}) {
  const { copy } = useLanguage();
  const pending = new Set((state.hostRequests ?? []).map((r) => r.userId));
  return (
    <ul className="member-list">
      {state.members.map((m) => (
        <li key={m.userId} className="member-row">
          <span className={`presence-dot ${m.online ? 'online' : ''}`} aria-hidden />
          <span className={`member-name${m.userId === me ? ' member-name-self' : ''}`}>{m.nickname}</span>
          {m.isHost && <span className="verdict-badge verdict-solved">{copy.host}</span>}
          {m.isUserHost && <span className="verdict-badge verdict-uncertain">{copy.userHost}</span>}
          {isHost && !m.isHost && (
            <span className="member-actions">
              <button className="btn btn-sm btn-danger" onClick={() => onKick(m.userId)}>
                {copy.kick}
              </button>
            </span>
          )}
          {/* 房主审核：待审成员行内直接批准或拒绝 */}
          {isHost && pending.has(m.userId) && onApproveHost && onRejectHost && (
            <span className="member-actions">
              <button className="btn btn-sm" onClick={() => onApproveHost(m.userId)}>
                {copy.hostApprove}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => onRejectHost(m.userId)}>
                {copy.hostReject}
              </button>
            </span>
          )}
          {/* 房主可撤销他人已有的主持身份：降级为普通玩家 */}
          {isHost && m.isUserHost && m.userId !== me && onRevokeHost && (
            <span className="member-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => onRevokeHost(m.userId)}>
                {copy.hostRevoke}
              </button>
            </span>
          )}
          {/* 本人入口：申请成为主持人 / 退出主持人（房主自申请服务端直接通过） */}
          {m.userId === me && !m.isUserHost && onRequestHost && (
            <span className="member-actions">
              <button className="btn btn-sm" onClick={onRequestHost} disabled={pending.has(m.userId)}>
                {pending.has(m.userId) ? copy.hostApplyPending : copy.hostApply}
              </button>
            </span>
          )}
          {m.userId === me && m.isUserHost && onResignHost && (
            <span className="member-actions">
              <button className="btn btn-sm" onClick={onResignHost}>
                {copy.hostResign}
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 用户主持人的快捷判定按钮（17-USER-HOST-MODE §6.1）：
 * 提问给「是 / 否 / 无关」，还原给「破解成功 / 接近真相 / 还没猜对」。
 */
export function HostVerdictButtons({
  onAnswer,
  disabled,
  verdicts = ['yes', 'no', 'irrelevant'],
}: {
  onAnswer: (verdict: HostVerdict) => void;
  disabled?: boolean;
  verdicts?: HostVerdict[];
}) {
  const { copy, language } = useLanguage();
  return (
    <div className="host-verdict-row">
      {verdicts.map((verdict) => (
        <button key={verdict} className="btn btn-sm" disabled={disabled} onClick={() => onAnswer(verdict)}>
          {displayVerdict(verdict, language)}
        </button>
      ))}
    </div>
  );
}

/**
 * 用户主持人的汤底视角（17-USER-HOST-MODE §4.3）：
 * 走专用接口，服务端只放行本房间的用户主持人；汤底不进快照与事件。
 */
function HostSecret({ roundId }: { roundId: string }) {
  const { copy } = useLanguage();
  const [answer, setAnswer] = useState<string | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    void api<{ answer: string; hints: string[] }>(`/rounds/${roundId}/host-view`)
      .then((data) => {
        setAnswer(data.answer);
        setHints(data.hints);
      })
      .catch(() => setError(true));
  }, [roundId]);

  if (error) return <p className="muted">{copy.hostSecretLoadFail}</p>;
  if (!answer) return <p className="muted">{copy.loadingRound}</p>;
  return (
    <div className="stack host-secret">
      <h3>{copy.hostSecretTitle}</h3>
      <p className="muted">{copy.hostSecretHint}</p>
      <p>{answer}</p>
      {hints.length > 0 && (
        <details>
          <summary className="muted">{copy.hint}（{hints.length}）</summary>
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

function AnswerBlock({ roundId }: { roundId: string }) {
  const { copy } = useLanguage();
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

  if (error) return <p className="muted">{copy.answerLoadFail}</p>;
  if (!answer) return <p className="muted">{copy.loadingRound}</p>;
  return (
    <div className="stack">
      <h3>{copy.answer}</h3>
      <p>{answer}</p>
      {hints.length > 0 && (
        <details>
          <summary className="muted">{copy.hint}（{hints.length}）</summary>
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
