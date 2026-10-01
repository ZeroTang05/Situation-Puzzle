/** 首页：产品入口（单人 / 开房间 / 题库 / 我的）与品牌区。 */
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, translateApiError } from '../api/client.js';
import { createLobby } from '../rooms/create-lobby.js';
import { useLanguage } from '../state/language.js';
import type { Session } from '../session.js';
import { creationCopy } from '../creations/copy.js';

export function HomePage({ session }: { session: Session | null }) {
  const { copy, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 开房额度与当前加入的房间分别读取，开房按钮始终创建新房。
  const entitlement = useQuery({
    queryKey: ['entitlement-preview'],
    queryFn: () => api<{ sponsored: boolean; freeRemaining: number }>('/rooms/entitlement-preview'),
    enabled: session !== null,
    retry: false,
  });
  const activeRooms = useQuery({
    queryKey: ['me-active-rooms'],
    queryFn: () => api<{ rooms: Array<{ roomId: string; createdAt: string; title: string | null }> }>('/me/active-rooms'),
    enabled: session !== null,
    retry: false,
  });
  const joinedRooms = activeRooms.data?.rooms ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <h1 className="brand">{copy.brand}</h1>
        <div className="topbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}>
            {language === 'zh' ? copy.languageSwitchToEn : copy.languageSwitchToZh}
          </button>
          {session ? (
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/me')}>
              {copy.me}
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => navigate('/login')}>
              {copy.login}
            </button>
          )}
        </div>
      </header>

      <section className="hero-card">
        <p className="accent tagline">🐢 {copy.tagline}</p>
        <div className="stack">
          <button className="btn btn-primary btn-lg" onClick={() => navigate('/library?mode=solo')}>
            {copy.solo}
          </button>
          {session ? (
            <button
              className="btn btn-lg"
              disabled={creating}
              onClick={() => {
                setCreating(true);
                setCreateError(null);
                createLobby()
                  .then((lobby) => navigate(`/lobbies/${lobby.lobbyId}`))
                  .catch((err: unknown) => setCreateError(translateApiError(err, language, copy.createRoomFail)))
                  .finally(() => setCreating(false));
              }}
            >
              {creating ? copy.creating : copy.multi}
            </button>
          ) : (
            <button className="btn btn-lg" onClick={() => navigate('/login?next=%2Flibrary%3Fmode%3Dselect')}>
              {copy.multi}（{copy.login}）
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => navigate('/library')}>
            {copy.library}
          </button>
          <button className="btn btn-ghost" onClick={() => navigate('/creations')}>
            {creationCopy(language).works}
          </button>
        </div>
      </section>

      {createError && <p className="error-text" role="alert">{createError}</p>}

      {joinedRooms.length > 0 && (
        <section className="panel stack" aria-label={copy.activeRooms}>
          <h2>{copy.activeRooms}</h2>
          {joinedRooms.map((room) => (
            <button key={room.roomId} className="btn" onClick={() => navigate(`/rooms/${room.roomId}`)}>
              {room.title ?? new Date(room.createdAt).toLocaleString()}
            </button>
          ))}
        </section>
      )}

      {session && entitlement.data && (
        <section className="panel entitlement-row">
          <span>
            {copy.freeRooms}：{entitlement.data.sponsored ? copy.unlimited : `${entitlement.data.freeRemaining} / 10`}
          </span>
          {entitlement.data.sponsored && <span className="verdict-badge verdict-solved">{copy.sponsored}</span>}
        </section>
      )}
    </main>
  );
}
