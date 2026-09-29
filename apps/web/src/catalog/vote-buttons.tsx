/**
 * 赞/踩投票按钮（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §2/§6）。
 *
 * 未登录显示计数、点击跳登录（成功后回原题）；登录后拉取本人选择。
 * 点击切换 = 明确的 PUT 或 DELETE（取消）；失败恢复原状态可重试，
 * 计数以服务端返回为准，不本地累加。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import type { Session } from '../session.js';
import { format } from '@jev/i18n';

interface RatingState {
  choice: 'up' | 'down' | null;
  upCount: number;
  downCount: number;
}

export function VoteButtons({
  puzzleId,
  session,
  initialUp,
  initialDown,
}: {
  puzzleId: string;
  session: Session | null;
  initialUp: number;
  initialDown: number;
}) {
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const [state, setState] = useState<RatingState>({ choice: null, upCount: initialUp, downCount: initialDown });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  // 登录用户进入页面时恢复本人选择（服务端权威；未登录显示公共计数）
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void api<RatingState>(`/ratings/${puzzleId}`)
      .then((data) => {
        if (!cancelled) setState(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [puzzleId, session]);

  const act = (value: 'up' | 'down') => {
    if (busy) return;
    if (!session) {
      // 未登录：去登录并回原题（保留当前路径）
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const previous = state;
    const next = previous.choice === value ? null : value;
    // 乐观更新：失败恢复原状态
    setState({ ...previous, choice: next });
    setBusy(true);
    setError(false);
    const request =
      next === null
        ? api<RatingState>(`/ratings/${puzzleId}`, { method: 'DELETE' })
        : api<RatingState>(`/ratings/${puzzleId}`, { method: 'PUT', body: { value: next } });
    void request
      .then((data) => setState(data))
      .catch(() => {
        setState(previous);
        setError(true);
      })
      .finally(() => setBusy(false));
  };

  return (
    <span className="vote-row" role="group" aria-label={copy.voteGroup}>
      <button
        className={`btn btn-sm ${state.choice === 'up' ? 'btn-primary' : 'btn-ghost'}`}
        disabled={busy}
        onClick={() => act('up')}
        aria-pressed={state.choice === 'up'}
        aria-label={copy.voteUp}
      >
        👍 {state.upCount}
      </button>
      <button
        className={`btn btn-sm ${state.choice === 'down' ? 'btn-primary' : 'btn-ghost'}`}
        disabled={busy}
        onClick={() => act('down')}
        aria-pressed={state.choice === 'down'}
        aria-label={copy.voteDown}
      >
        👎 {state.downCount}
      </button>
      {error && (
        <span className="error-text" role="alert">
          {copy.voteFail}
        </span>
      )}
    </span>
  );
}

/** 列表/详情里的只读署名展示：署名显示已批准名，匿名显示「匿名作者」。 */
export function AuthorLabel({ mode, name }: { mode: 'anonymous' | 'signature'; name: string | null }) {
  const { copy } = useLanguage();
  return (
    <span className="muted">
      {mode === 'signature' && name ? format(copy.byAuthor, { name }) : copy.anonymousAuthor}
    </span>
  );
}