/** 「我的」：账号、赞助有效期、免费开房余量、多人历史与订单。 */
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, translateApiError } from '../api/client.js';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';
import { clearRoomLocal } from '../rooms/room-local.js';
import { format } from '@jev/i18n';
import type { Session } from '../session.js';
import { creationCopy } from '../creations/copy.js';

interface MeResponse {
  userId: string;
  nickname: string;
  email: string;
  sponsorship: { monthlyUntil: string | null; lifetime: boolean };
  freeRooms: { total: number; consumed: number; reserved: number };
}

interface HistoryResponse {
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
  // 昵称修改：允许重名，保存后让 /me 重新拉取
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [savingNickname, setSavingNickname] = useState(false);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/me'), enabled: session !== null, retry: false });
  const history = useQuery({ queryKey: ['me-history'], queryFn: () => api<HistoryResponse>('/me/history'), enabled: session !== null, retry: false });

  const saveNickname = async () => {
    setSavingNickname(true);
    setNicknameError(null);
    try {
      await api<{ nickname: string }>('/me/nickname', { method: 'PATCH', body: { nickname: nicknameDraft } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setEditingNickname(false);
    } catch (error) {
      setNicknameError(translateApiError(error, language, copy.saveFail));
      return;
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

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.me}</h1>
      </header>

      <button className="btn btn-primary" onClick={() => navigate('/creations')}>{creationCopy(language).works}</button>
      <section className="panel stack">
        {editingNickname ? (
          <>
            <label className="field-label" htmlFor="nickname">
              {copy.nickname}
              <input
                id="nickname"
                className="field"
                type="text"
                value={nicknameDraft}
                maxLength={30}
                onChange={(e) => setNicknameDraft(e.target.value)}
                placeholder={copy.nicknameRule}
              />
            </label>
            {nicknameError && <p className="error-text" role="alert">{nicknameError}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={savingNickname || nicknameDraft.trim().length === 0}
                onClick={() => void saveNickname()}
              >
                {copy.saved}
              </button>
              <button className="btn" disabled={savingNickname} onClick={() => setEditingNickname(false)}>
                {copy.cancelEdit}
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>{me.data?.nickname ?? session.user.email}</h2>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setNicknameDraft(me.data?.nickname ?? '');
                setEditingNickname(true);
              }}
            >
              {copy.modify}
            </button>
          </div>
        )}
        <p className="muted">{session.user.email}</p>
        {me.data && (
          <p>
            {copy.freeRooms}：
            {me.data.sponsorship.lifetime || me.data.sponsorship.monthlyUntil
              ? copy.unlimited
              : `${me.data.freeRooms.total - me.data.freeRooms.consumed - me.data.freeRooms.reserved} / ${me.data.freeRooms.total}`}
          </p>
        )}
        {me.data?.sponsorship.monthlyUntil && <p className="muted">{copy.sponsored}至 {new Date(me.data.sponsorship.monthlyUntil).toLocaleString()}</p>}
        {me.data?.sponsorship.lifetime && <p className="verdict-badge verdict-solved">{copy.lifetime}{copy.sponsored}</p>}
        <button
          className="btn btn-ghost"
          onClick={() =>
            void clearRoomLocal(session.user.id).then(() => authClient.signOut()).then(() => {
              queryClient.clear();
              navigate('/');
            })
          }
        >
          {copy.logout}
        </button>
      </section>

      <section className="panel stack">
        <h3>{copy.history}</h3>
        {history.data?.rooms.length === 0 && <p className="muted">{copy.noRoomHistory}</p>}
        {history.data?.rooms.map((room) => (
          <article key={room.roomId} className="stack-sm">
            <button className="btn btn-sm" onClick={() => navigate(`/rooms/${room.roomId}`)}>
              {new Date(room.createdAt).toLocaleDateString()} · {room.roomStatus === 'closed' ? copy.roomStatusClosed : copy.roomStatusActive}
            </button>
            {room.rounds.map((r) => (
              <p key={r.roundId} className="muted">
                {format(copy.roundX, { n: r.roundNo })} {r.title ?? ''} · {r.status}
              </p>
            ))}
          </article>
        ))}
      </section>

    </main>
  );
}
