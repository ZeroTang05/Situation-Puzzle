/** 题库：筛选、本地已玩标记、单人开始或房主选题。 */
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { soloStore } from '../solo/local-store.js';
import { useEffect, useState } from 'react';
import type { Session } from '../session.js';

interface PuzzleItem {
  id: string;
  legacyId: string | null;
  title: string;
  surface: string;
  difficulty: string | null;
  durationMinutes: number | null;
  contentWarnings: string[];
  language: string;
  versionId: string;
}

export function LibraryPage({ session }: { session: Session | null }) {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = params.get('mode') === 'select' ? 'select' : 'solo';
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, error } = useQuery({
    queryKey: ['puzzles', language],
    queryFn: () => api<{ items: PuzzleItem[]; nextCursor: string | null }>(`/puzzles?language=${language}&limit=50`),
  });

  // 本地已玩标记：单人历史不上传，只在浏览器提示本人
  useEffect(() => {
    void soloStore.listSessions().then((rows) => {
      setPlayedIds(new Set(rows.map((r) => r.puzzleId)));
    });
  }, []);

  const onPick = (puzzle: PuzzleItem) => {
    if (mode === 'select') {
      const roomId = params.get('roomId');
      const followupRoomId = params.get('followup');
      if (followupRoomId) {
        // 再来一题：选定新题后创建独立新房并一键迁移合格成员（10-ROOM-LIFECYCLE-REVISION §一.2/3）
        void api<{ targetRoomId: string }>('/rooms/followup', {
          method: 'POST',
          body: { sourceRoomId: followupRoomId, puzzleId: puzzle.id, language },
        })
          .then((result) => navigate(`/rooms/${result.targetRoomId}`))
          .catch(() => undefined);
        return;
      }
      if (roomId) {
        navigate(`/rooms/${roomId}?selectPuzzle=${puzzle.id}&lang=${language}`);
      }
      return;
    }
    navigate(`/solo/${puzzle.id}?lang=${language}`);
  };

  return (
    <main className="shell">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          {copy.back}
        </button>
        <h1 className="brand">{copy.library}</h1>
      </header>
      <p className="muted library-intro">{copy.tagline}</p>
      {isLoading && <p className="muted">加载中…</p>}
      {error && <p className="error-text">题库加载失败，请刷新重试。</p>}
      <div className="puzzle-grid">
        {data?.items.map((puzzle) => (
          <article key={puzzle.id} className="panel puzzle-card">
            <h2>{puzzle.title}</h2>
            <p className="puzzle-surface">{puzzle.surface}</p>
            <footer className="puzzle-card-footer">
              <span className="muted">
                {playedIds.has(puzzle.id) ? `已玩 · ` : ''}
                {puzzle.difficulty ?? ''}
              </span>
              <button className="btn btn-sm btn-primary" onClick={() => onPick(puzzle)}>
                {mode === 'select' ? copy.selectPuzzle : copy.solo}
              </button>
            </footer>
          </article>
        ))}
      </div>
      {!session && mode === 'select' && (
        <p className="muted">开房间需要先登录。</p>
      )}
    </main>
  );
}
