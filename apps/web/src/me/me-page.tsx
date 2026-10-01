/** 「我的」：账号卡片（头像 + 额度/赞助数字）、昵称编辑、退出、多人历史列表。 */
import { useNavigate, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, translateApiError } from '../api/client.js';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';
import { clearRoomLocal } from '../rooms/room-local.js';
import { useDialog } from '@jev/ui';
import { useBack } from '../back.js';
import { format } from '@jev/i18n';
import type { Language } from '@jev/i18n';
import type { Session } from '../session.js';
import { creationCopy } from '../creations/copy.js';

/** 把服务端 round.status 翻译成用户文案；未识别值回退到原值便于排查。 */
function roundStatusLabel(status: string, language: Language, copy: { roundStatusActive: string; roundStatusSolved: string; roundStatusRevealed: string; roundStatusAbandoned: string; roundStatusAborted: string }) {
  switch (status) {
    case 'active': return copy.roundStatusActive;
    case 'solved': return copy.roundStatusSolved;
    case 'revealed': return copy.roundStatusRevealed;
    case 'abandoned': return copy.roundStatusAbandoned;
    case 'aborted': return copy.roundStatusAborted;
    default: return status;
  }
}

/** round.status → 局状态文字颜色（进行中蓝 / 解开绿 / 公布金 / 停止灰）。 */
function roundStatusClass(status: string) {
  switch (status) {
    case 'active': return 'st-active';
    case 'solved': return 'st-solved';
    case 'revealed': return 'st-revealed';
    case 'abandoned':
    case 'aborted': return 'st-stopped';
    default: return '';
  }
}

/** 短日期：同年只显示月日，跨年补年份，列表里更省空间。 */
function shortDate(iso: string, language: Language) {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

interface MeResponse {
  userId: string;
  nickname: string;
  email: string;
  sponsorship: { monthlyUntil: string | null; lifetime: boolean };
  freeRooms: { total: number; consumed: number; reserved: number };
}

interface HistoryResponse {
  hasMore: boolean;
  rooms: Array<{
    roomId: string;
    roomStatus: string;
    createdAt: string;
    rounds: Array<{ roundId: string; roundNo: number; status: string; title: string | null }>;
  }>;
}

export function MePage({ session }: { session: Session | null }) {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [savingNickname, setSavingNickname] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/me'), enabled: session !== null, retry: false });
  const history = useQuery({ queryKey: ['me-history', session?.user.id, historyPage], queryFn: () => api<HistoryResponse>(`/me/history?page=${historyPage}&limit=5`), enabled: session !== null, retry: false });

  const saveNickname = async () => {
    setSavingNickname(true);
    setNicknameError(null);
    try {
      await api<{ nickname: string }>('/me/nickname', { method: 'PATCH', body: { nickname: nicknameDraft } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setEditingNickname(false);
    } catch (error) {
      setNicknameError(translateApiError(error, language, copy.saveFail));
    } finally {
      setSavingNickname(false);
    }
  };

  if (!session) {
    return (
      <main className="shell narrow">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <p className="muted">{copy.meRequiresLogin}</p>
        <button className="btn btn-primary" onClick={() => navigate('/login?next=/me')}>{copy.login}</button>
      </main>
    );
  }

  const freeRooms = me.data?.freeRooms;
  const lifetime = !!me.data?.sponsorship.lifetime;
  const monthlyUntil = me.data?.sponsorship.monthlyUntil ?? null;
  const monthlyExpired = monthlyUntil !== null && new Date(monthlyUntil) < new Date();
  // 到期的月度赞助不再给不限次数，展示成「已到期」
  const hasUnlimited = lifetime || (monthlyUntil !== null && !monthlyExpired);
  const remaining = freeRooms ? freeRooms.total - freeRooms.consumed - freeRooms.reserved : null;
  // 昵称链：/me 权威值 → 会话注入值（首屏即有）→ 邮箱兜底
  const displayName = me.data?.nickname || session.user.nickname || session.user.email;
  const roundCountLabel = (n: number) => (language === 'zh' ? `${n} 局` : n === 1 ? '1 round' : `${n} rounds`);
  const accountLoadFail = language === 'zh' ? '账号信息加载失败，请重试。' : 'Could not load your account. Please try again.';
  const logoutConfirmText = language === 'zh' ? '确定退出当前账号吗？' : 'Sign out of this account?';

  /** 退出登录走二次确认，避免误触后丢掉本地单人进度入口。 */
  const logout = async () => {
    if (!(await dialog.confirm(logoutConfirmText))) return;
    await clearRoomLocal(session.user.id);
    await authClient.signOut();
    queryClient.clear();
    navigate('/');
  };

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.me}</h1>
      </header>

      {/* 账号卡片：头像 + 昵称 + 额度/赞助两个关键数字 */}
      <section className="me-card">
        <div className="me-head">
          <span className="avatar me-avatar" aria-hidden>{displayName.trim().charAt(0).toUpperCase() || '·'}</span>
          <div className="me-id">
            <h2 className="me-name">{displayName}</h2>
            <p className="me-email muted">{session.user.email}</p>
          </div>
          {!editingNickname && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setNicknameDraft(me.data?.nickname ?? ''); setNicknameError(null); setEditingNickname(true); }}>{copy.modify}</button>
          )}
        </div>

        {editingNickname && (
          <form className="me-edit" onSubmit={(e) => { e.preventDefault(); if (!savingNickname && nicknameDraft.trim().length > 0) void saveNickname(); }}>
            <label className="field-label" htmlFor="nickname">
              <span className="muted">{copy.nickname}</span>
              <input id="nickname" className="field" type="text" value={nicknameDraft} maxLength={30} autoFocus onChange={(e) => setNicknameDraft(e.target.value)} />
              <span className="field-help muted">{copy.nicknameRule}</span>
            </label>
            {nicknameError && <p className="error-text" role="alert">{nicknameError}</p>}
            <div className="me-edit-actions">
              <button type="submit" className="btn btn-sm btn-primary" disabled={savingNickname || nicknameDraft.trim().length === 0}>{savingNickname ? copy.submitting : copy.saved}</button>
              <button type="button" className="btn btn-sm" disabled={savingNickname} onClick={() => setEditingNickname(false)}>{copy.cancelEdit}</button>
            </div>
          </form>
        )}

        <div className="me-stats">
          <div className="me-stat">
            <span className="me-stat-label">{copy.freeRooms}</span>
            <span className={`me-stat-value${hasUnlimited ? ' is-ok' : ''}`}>
              {hasUnlimited ? copy.unlimited : remaining === null ? '—' : <>{remaining}<span className="me-stat-sub"> / {freeRooms!.total}</span></>}
            </span>
          </div>
          {(lifetime || monthlyUntil !== null) && (
            <div className="me-stat">
              <span className="me-stat-label">{copy.sponsorship}</span>
              <span className={`me-stat-value${lifetime || !monthlyExpired ? ' is-ok' : ' is-expired'}`}>
                {lifetime
                  ? copy.lifetime
                  : monthlyExpired
                    ? copy.expired
                    : `${language === 'zh' ? '至 ' : 'until '}${shortDate(monthlyUntil!, language)}`}
              </span>
            </div>
          )}
        </div>

        {me.isError && (
          <div className="me-load-error">
            <p className="error-text" role="alert">{translateApiError(me.error, language, accountLoadFail)}</p>
            <button className="btn btn-ghost btn-sm" onClick={() => void me.refetch()}>{copy.retry}</button>
          </div>
        )}

        <div className="me-card-actions">
          <button className="btn btn-primary" onClick={() => navigate('/creations')}>{creationCopy(language).works}</button>
        </div>
      </section>

      <button className="btn me-logout" onClick={() => void logout()}>{copy.logout}</button>

      {/* 房间历史：整行可点进房间，局状态用颜色区分 */}
      <section className="me-section">
        <div className="me-section-head">
          <h3 className="me-section-title">{copy.history}</h3>
          {(historyPage > 1 || history.data?.hasMore) && (
            <div className="me-pager">
              <button className="btn btn-ghost btn-sm" disabled={historyPage === 1 || history.isFetching} onClick={() => setHistoryPage((p) => p - 1)}>{copy.previousPage}</button>
              <span className="me-pager-page">{format(copy.pageNumber, { n: historyPage })}</span>
              <button className="btn btn-ghost btn-sm" disabled={!history.data?.hasMore || history.isFetching} onClick={() => setHistoryPage((p) => p + 1)}>{copy.nextPage}</button>
            </div>
          )}
        </div>

        {history.isPending && (
          <div className="me-skeleton" aria-hidden>
            {[0, 1, 2].map((row) => (
              <div key={row} className="me-skeleton-row">
                <span className="me-skeleton-bar" />
                <span className="me-skeleton-bar" />
              </div>
            ))}
          </div>
        )}
        {history.isError && <p className="error-text" role="alert">{copy.historyLoadFail}</p>}
        {history.data?.rooms.length === 0 && <p className="muted me-history-empty">{copy.noRoomHistory}</p>}

        <ul className="me-history">
          {history.data?.rooms.map((room) => (
            <li key={room.roomId} className="me-history-item">
              <Link className="me-history-room" to={`/rooms/${room.roomId}`}>
                <div className="me-history-room-main">
                  <span className="me-history-date">{shortDate(room.createdAt, language)}</span>
                  <span className={`creation-status${room.roomStatus === 'closed' ? ' me-badge-closed' : ''}`}>{room.roomStatus === 'closed' ? copy.roomStatusClosed : copy.roomStatusActive}</span>
                </div>
                {room.rounds.length > 0 && <span className="me-history-count">{roundCountLabel(room.rounds.length)}</span>}
                <span className="me-history-chevron" aria-hidden>›</span>
              </Link>
              {room.rounds.length > 0 && (
                <ul className="me-history-rounds">
                  {room.rounds.map((r) => (
                    <li key={r.roundId}>
                      <span className="muted">{format(copy.roundX, { n: r.roundNo })}</span>
                      {r.title && <span className="me-round-title">{r.title}</span>}
                      <span className={`me-round-status ${roundStatusClass(r.status)}`}>{roundStatusLabel(r.status, language, copy)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
