/** 「我的」：账号、赞助有效期、免费开房余量、多人历史；统一单面板紧凑布局。 */
import { useNavigate, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, translateApiError } from '../api/client.js';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';
import { clearRoomLocal } from '../rooms/room-local.js';
import { format } from '@jev/i18n';
import type { Language } from '@jev/i18n';
import type { Session } from '../session.js';
import { creationCopy } from '../creations/copy.js';

/** 把服务端 round.status 翻译成中文/英文用户文案；未识别值回退到原值便于排查。 */
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
  const queryClient = useQueryClient();
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
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>{copy.back}</button>
        <p className="muted">{copy.meRequiresLogin}</p>
        <button className="btn btn-primary" onClick={() => navigate('/login?next=/me')}>{copy.login}</button>
      </main>
    );
  }

  const freeRooms = me.data?.freeRooms;
  const hasUnlimited = me.data?.sponsorship.lifetime || me.data?.sponsorship.monthlyUntil;
  const freeRoomsLabel = freeRooms ? (hasUnlimited ? copy.unlimited : `${freeRooms.total - freeRooms.consumed - freeRooms.reserved} / ${freeRooms.total}`) : '—';

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.me}</h1>
      </header>

      {/* 账号信息：单条扁平分组，标题 + 元信息 */}
      <section className="me-section">
        <div className="me-row me-row-head">
          <div className="me-row-main">
            {editingNickname ? (
              <span className="me-row-label muted">{copy.nickname}</span>
            ) : (
              <h2 className="me-name">{me.data?.nickname ?? session.user.email}</h2>
            )}
            <div className="me-row-meta">
              <span className="muted">{session.user.email}</span>
              <span className="dot" aria-hidden>·</span>
              <span className="muted">{copy.freeRooms} {freeRoomsLabel}</span>
              {me.data?.sponsorship.lifetime && <><span className="dot" aria-hidden>·</span><span className="me-row-pill">{copy.lifetime}{copy.sponsored}</span></>}
              {me.data?.sponsorship.monthlyUntil && !me.data.sponsorship.lifetime && <><span className="dot" aria-hidden>·</span><span className="muted">{copy.sponsored}至 {new Date(me.data.sponsorship.monthlyUntil).toLocaleDateString()}</span></>}
            </div>
          </div>
          <div className="me-row-actions">
            <button className="btn btn-sm btn-primary" onClick={() => navigate('/creations')}>{creationCopy(language).works}</button>
            {!editingNickname && <button className="creation-item-link" onClick={() => { setNicknameDraft(me.data?.nickname ?? ''); setEditingNickname(true); }}>{copy.modify}</button>}
          </div>
        </div>

        {editingNickname && (
          <div className="me-row me-row-edit">
            <label className="field-label" htmlFor="nickname">
              <span className="muted">{copy.nickname}</span>
              <input id="nickname" className="field" type="text" value={nicknameDraft} maxLength={30} onChange={(e) => setNicknameDraft(e.target.value)} />
            </label>
            {nicknameError && <p className="error-text" role="alert">{nicknameError}</p>}
            <div className="me-row-actions">
              <button className="btn btn-sm btn-primary" disabled={savingNickname || nicknameDraft.trim().length === 0} onClick={() => void saveNickname()}>{copy.saved}</button>
              <button className="btn btn-sm" disabled={savingNickname} onClick={() => setEditingNickname(false)}>{copy.cancelEdit}</button>
            </div>
          </div>
        )}

        <div className="me-row me-row-footer">
          <button className="creation-item-link creation-item-link-danger" onClick={() => void clearRoomLocal(session.user.id).then(() => authClient.signOut()).then(() => { queryClient.clear(); navigate('/'); })}>{copy.logout}</button>
        </div>
      </section>

      {/* 房间历史：紧凑行项列表，无卡片框 */}
      <section className="me-section">
        <div className="me-section-head">
          <h3 className="me-section-title">{copy.history}</h3>
          {(historyPage > 1 || history.data?.hasMore) && (
            <div className="me-section-pager">
              <button className="creation-item-link" disabled={historyPage === 1 || history.isFetching} onClick={() => setHistoryPage((p) => p - 1)}>{copy.previousPage}</button>
              <span className="muted">{format(copy.pageNumber, { n: historyPage })}</span>
              <button className="creation-item-link" disabled={!history.data?.hasMore || history.isFetching} onClick={() => setHistoryPage((p) => p + 1)}>{copy.nextPage}</button>
            </div>
          )}
        </div>
        {history.isPending && <p className="muted">{copy.loadingRound}</p>}
        {history.isError && <p className="error-text" role="alert">{copy.historyLoadFail}</p>}
        {history.data?.rooms.length === 0 && <p className="muted">{copy.noRoomHistory}</p>}
        <ul className="me-history">
          {history.data?.rooms.map((room) => (
            <li key={room.roomId} className="me-history-item">
              <Link className="creation-item-link" to={`/rooms/${room.roomId}`}>{new Date(room.createdAt).toLocaleDateString()} · {room.roomStatus === 'closed' ? copy.roomStatusClosed : copy.roomStatusActive}</Link>
              {room.rounds.length > 0 && (
                <ul className="me-history-rounds">
                  {room.rounds.map((r) => (
                    <li key={r.roundId} className="muted">{format(copy.roundX, { n: r.roundNo })} {r.title ?? ''} · {roundStatusLabel(r.status, language, copy)}</li>
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
