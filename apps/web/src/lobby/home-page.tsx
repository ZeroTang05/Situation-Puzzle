/** 首页：产品入口（单人 / 开房间 / 题库 / 我的）与品牌区。 */
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { createRoom } from '../rooms/create-room.js';
import { useLanguage } from '../state/language.js';
import type { Session } from '../session.js';

export function HomePage({ session }: { session: Session | null }) {
  const { copy, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 已开未关闭的房间入口
  const entitlement = useQuery({
    queryKey: ['entitlement-preview'],
    queryFn: () => api<{ openRoomId: string | null; sponsored: boolean; freeRemaining: number }>('/rooms/entitlement-preview'),
    enabled: session !== null,
    retry: false,
  });

  return (
    <main className="shell">
      <header className="topbar">
        <h1 className="brand">{copy.brand}</h1>
        <div className="topbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}>
            {language === 'zh' ? 'EN' : '中文'}
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
                if (entitlement.data?.openRoomId) {
                  navigate(`/rooms/${entitlement.data.openRoomId}`);
                  return;
                }
                setCreating(true);
                setCreateError(null);
                createRoom()
                  .then((room) => navigate(`/rooms/${room.roomId}`))
                  .catch((err: unknown) => setCreateError(err instanceof Error ? err.message : '开房失败，请稍后再试'))
                  .finally(() => setCreating(false));
              }}
            >
              {creating ? '正在创建…' : entitlement.data?.openRoomId ? '回到我的房间' : copy.multi}
            </button>
          ) : (
            <button className="btn btn-lg" onClick={() => navigate('/login?next=%2Flibrary%3Fmode%3Dselect')}>
              {copy.multi}（{copy.login}）
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => navigate('/library')}>
            {copy.library}
          </button>
        </div>
      </section>

      {createError && <p className="error-text" role="alert">{createError}</p>}

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
