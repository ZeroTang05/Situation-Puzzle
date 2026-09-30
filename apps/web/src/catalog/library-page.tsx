/** 题库：筛选、最新发布/受欢迎排序、署名与赞踩计数、单人开始或房主选题（11-VOTES-AND-AUTHORSHIP.md §3/§5）。 */
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { soloStore } from '../solo/local-store.js';
import { useEffect, useState } from 'react';
import type { Session } from '../session.js';
import { AuthorLabel } from './vote-buttons.js';
import { createRoom } from '../rooms/create-room.js';
import { compactVoteCount } from './vote-count.js';

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
  authorDisplay: { mode: 'anonymous' | 'signature'; name: string | null };
  upCount: number;
  downCount: number;
}

export function LibraryPage({ session }: { session: Session | null }) {
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const mode = params.get('mode') === 'select' ? 'select' : 'solo';
  const sort = params.get('sort') === 'popular' ? 'popular' : 'latest';
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set());
  const [followupError, setFollowupError] = useState<string | null>(null);
  const [openingPuzzleId, setOpeningPuzzleId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['puzzles', language, sort],
    queryFn: () => api<{ items: PuzzleItem[]; nextCursor: string | null }>(`/puzzles?language=${language}&limit=50&sort=${sort}`),
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
        setFollowupError(null);
        void api<{ targetRoomId: string }>('/rooms/followup', {
          method: 'POST',
          body: { sourceRoomId: followupRoomId, puzzleId: puzzle.id, language },
        })
          .then((result) => navigate(`/rooms/${result.targetRoomId}`))
          .catch((err: unknown) => setFollowupError(translateApiError(err, language, copy.createRoomFail)));
        return;
      }
      if (roomId) {
        navigate(`/rooms/${roomId}?selectPuzzle=${puzzle.id}&lang=${language}`);
      }
      return;
    }
    navigate(`/solo/${puzzle.id}?lang=${language}`);
  };

  /** 建房后交给房间页选择这道题；登录回跳保留题目与语言。 */
  const openRoomWithPuzzle = async (puzzle: PuzzleItem) => {
    const selection = `/library?mode=select&pick=${encodeURIComponent(puzzle.id)}&lang=${language}`;
    if (!session) {
      navigate(`/login?next=${encodeURIComponent(selection)}`);
      return;
    }
    if (openingPuzzleId) return;
    setOpeningPuzzleId(puzzle.id);
    setFollowupError(null);
    try {
      const room = await createRoom();
      navigate(`/rooms/${room.roomId}?selectPuzzle=${encodeURIComponent(puzzle.id)}&lang=${language}`);
    } catch (err) {
      setFollowupError(translateApiError(err, language, copy.createRoomFail));
      setOpeningPuzzleId(null);
    }
  };

  useEffect(() => {
    const pick = params.get('pick');
    if (!pick || !session || !data?.items.some((item) => item.id === pick)) return;
    const puzzle = data.items.find((item) => item.id === pick)!;
    const next = new URLSearchParams(params);
    next.delete('pick');
    setParams(next, { replace: true });
    void openRoomWithPuzzle(puzzle);
    // 登录回跳只处理一次，按钮仍由用户主动触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, session, params]);

  const setSort = (value: 'latest' | 'popular') => {
    const next = new URLSearchParams(params);
    next.set('sort', value);
    setParams(next, { replace: true });
  };

  return (
    <main className="shell">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          {copy.back}
        </button>
        <h1 className="brand">{copy.library}</h1>
      </header>
      {/* 排序：最新发布 / 最受欢迎（得分 = 赞 − 踩）；零票作品显示 0 */}
      <div className="mode-tabs" role="tablist" aria-label={copy.sort}>
        <button className={`mode-tab ${sort === 'latest' ? 'active' : ''}`} role="tab" aria-selected={sort === 'latest'} onClick={() => setSort('latest')}>
          {copy.sortLatest}
        </button>
        <button className={`mode-tab ${sort === 'popular' ? 'active' : ''}`} role="tab" aria-selected={sort === 'popular'} onClick={() => setSort('popular')}>
          {copy.sortPopular}
        </button>
      </div>
      {isLoading && <p className="muted">{copy.libraryLoading}</p>}
      {error && <p className="error-text">{copy.libraryLoadFail}</p>}
      {followupError && <p className="error-text" role="alert">{followupError}</p>}
      <div className="puzzle-grid">
        {data?.items.map((puzzle) => (
          <article key={puzzle.id} className="panel puzzle-card">
            <div className="puzzle-card-heading"><h2>{puzzle.title}</h2>{playedIds.has(puzzle.id) && <span className="puzzle-played">{copy.played}</span>}</div>
            <p className="puzzle-surface">{puzzle.surface}</p>
            <footer className="puzzle-card-footer">
              <div className="puzzle-card-meta">
                <span className="puzzle-card-author"><AuthorLabel mode={puzzle.authorDisplay.mode} name={puzzle.authorDisplay.name} /></span>
                <span className="puzzle-card-votes" aria-label={copy.voteGroup}>
                  <span aria-label={`${copy.voteUp} ${puzzle.upCount}`}>👍 {compactVoteCount(puzzle.upCount)}</span>
                  <span aria-label={`${copy.voteDown} ${puzzle.downCount}`}>👎 {compactVoteCount(puzzle.downCount)}</span>
                </span>
              </div>
              <div className="puzzle-card-actions">
                <button className="btn btn-sm btn-primary" onClick={() => onPick(puzzle)}>{mode === 'select' ? copy.selectPuzzle : copy.solo}</button>
                {mode !== 'select' && <button className="btn btn-sm" disabled={openingPuzzleId !== null} onClick={() => void openRoomWithPuzzle(puzzle)}>{openingPuzzleId === puzzle.id ? copy.creating : copy.catalogOpenRoom}</button>}
              </div>
            </footer>
          </article>
        ))}
      </div>
      {!session && mode === 'select' && (
        <p className="muted">{copy.libraryNeedLogin}</p>
      )}
    </main>
  );
}
