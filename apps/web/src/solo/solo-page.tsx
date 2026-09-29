/**
 * 单人游戏页（docs/rebuild/08-SOLO.md）：
 * 会话与问答只存浏览器 IndexedDB；刷新恢复；断网保留输入；服务端不存任何单人对话。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, ApiError, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { displayVerdict, verdictDetail, format } from '@jev/i18n';
import { soloStore, type SoloSessionRow } from './local-store.js';
import type { Session } from '../session.js';
import { HintCapsule } from '../game/hint-capsule.js';
import { confidenceLabel } from '../game/game-display.js';
import { VoteButtons } from '../catalog/vote-buttons.js';

type InputMode = 'ask' | 'solve';

interface TurnRow {
  localTurnId: string;
  kind: InputMode | 'solve';
  text: string;
  status: 'sending' | 'succeeded' | 'failed';
  result: string | null;
  confidence?: number;
}

export function SoloPage({ session: authSession }: { session: Session | null }) {
  const { puzzleId } = useParams();
  const { copy, language } = useLanguage();
  const navigate = useNavigate();

  const [session, setSession] = useState<SoloSessionRow | null>(null);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [hintBusy, setHintBusy] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('ask');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [publicStats, setPublicStats] = useState<{ upCount: number; downCount: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 公开计数与署名（题目详情）：未登录也能看；投票组件内部再取本人选择
  useEffect(() => {
    if (!puzzleId) return;
    let cancelled = false;
    void api<{ upCount: number; downCount: number }>(`/puzzles/${puzzleId}`)
      .then((detail) => {
        if (!cancelled) setPublicStats({ upCount: detail.upCount, downCount: detail.downCount });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [puzzleId]);

  // 开局：向服务端取固定版本与凭证（无会话、不写服务端表）
  useEffect(() => {
    if (!puzzleId) return;
    void (async () => {
      try {
        const existing = await soloStore.latestSessionForPuzzle(puzzleId, language);
        if (existing && existing.status === 'active') {
          setSession(existing);
          setTurns((await soloStore.listTurns(existing.localSessionId)) as TurnRow[]);
          const draft = await soloStore.loadDraft(existing.localSessionId);
          if (draft) {
            setInputMode(draft.inputMode);
            setText(draft.text);
          }
          return;
        }
        const created = await api<{ token: string; puzzleId: string; versionId: string; language: 'zh' | 'en'; title: string; surface: string; hintsTotal: number; configVersion: string }>('/solo/sessions', {
          method: 'POST',
          body: { puzzleId, language },
          credentials: 'omit',
        });
        const row = await soloStore.createSession({
          puzzleId,
          versionId: created.versionId,
          language,
          title: created.title,
          surface: created.surface,
          token: created.token,
          configVersion: created.configVersion,
        });
        setSession(row);
        setTurns([]);
      } catch (err) {
        setError(translateApiError(err, language, copy.soloLoadFail));
      }
    })();
  }, [puzzleId, language, copy.soloLoadFail]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  const persistDraft = useCallback(
    (mode: InputMode, value: string) => {
      if (session) void soloStore.saveDraft(session.localSessionId, mode, value);
    },
    [session],
  );

  const submit = async () => {
    if (!session || !text.trim() || sending) return;
    setStorageWarning(false);
    setSending(true);
    setError(null);

    // 1. 先写本地 sending 状态
    const localTurnId = await soloStore.addTurn({ localSessionId: session.localSessionId, kind: inputMode, text: text.trim() });
    const optimistic: TurnRow = { localTurnId, kind: inputMode, text: text.trim(), status: 'sending', result: null };
    setTurns((prev) => [...prev, optimistic]);
    const submittedText = text.trim();
    setText('');
    await soloStore.saveDraft(session.localSessionId, inputMode, '');
    await soloStore.bumpProgress(session.puzzleId, { questionDelta: 1 });

    try {
      // 2. 请求模型（单人并发限制在服务端；繁忙时本地保留输入）
      const result =
        inputMode === 'ask'
          ? await api<{ result: string; confidence: number }>('/solo/judge', { method: 'POST', body: { token: session.token, question: submittedText }, credentials: 'omit' })
          : await api<{ result: string; confidence: number; answer?: string }>('/solo/solve', { method: 'POST', body: { token: session.token, solution: submittedText }, credentials: 'omit' });

      // 3. 回写结果
      await soloStore.finishTurn(localTurnId, { status: 'succeeded', result: result.result, confidence: result.confidence });
      setTurns((prev) => prev.map((t) => (t.localTurnId === localTurnId ? { ...t, status: 'succeeded', result: result.result, confidence: result.confidence } : t)));

      if (inputMode === 'solve' && result.result === 'solved') {
        const answer = (result as { answer?: string }).answer ?? null;
        await soloStore.updateSession(session.localSessionId, { status: 'solved', revealedAnswer: answer });
        setSession((prev) => (prev ? { ...prev, status: 'solved', revealedAnswer: answer } : prev));
        setShowAnswer(true);
        await soloStore.bumpProgress(session.puzzleId, { solved: true });
      }
    } catch (err) {
      const note = translateApiError(err, language, copy.networkError);
      await soloStore.finishTurn(localTurnId, { status: 'failed', failNote: note });
      setTurns((prev) => prev.map((t) => (t.localTurnId === localTurnId ? { ...t, status: 'failed' } : t)));
      // 失败后本地保留问题：重试按当前输入模式重新提交
      setText(submittedText);
      if (err instanceof ApiError && err.code === 'JEV_BUSY') setError(copy.jevBusy);
      else setError(note);
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        // 凭证过期：重新开局获取
        setError(copy.sessionExpired);
      }
    } finally {
      setSending(false);
    }
  };

  const unlockHint = async (index: number) => {
    if (!session || hintBusy || session.hintsUnlocked.includes(index)) return;
    setHintBusy(true);
    try {
      const { text: hint } = await api<{ text: string }>('/solo/hints', {
        method: 'POST',
        body: { token: session.token, index },
        credentials: 'omit',
      });
      const unlocked = [...session.hintsUnlocked, index];
      await soloStore.updateSession(session.localSessionId, { hintsUnlocked: unlocked });
      setSession({ ...session, hintsUnlocked: unlocked });
      // 提示以本地记录展示
      await soloStore.addTurn({ localSessionId: session.localSessionId, kind: 'ask', text: hint }).then(async (id) => {
        await soloStore.finishTurn(id, { status: 'succeeded', result: 'hint' });
        setTurns((await soloStore.listTurns(session.localSessionId)) as TurnRow[]);
      });
    } catch {
      setError(copy.hintFail);
    } finally {
      setHintBusy(false);
    }
  };

  const reveal = async () => {
    if (!session || session.revealedAnswer) return;
    try {
      const { answer } = await api<{ answer: string }>('/solo/reveal', {
        method: 'POST',
        body: { token: session.token, confirmed: true },
        credentials: 'omit',
      });
      await soloStore.updateSession(session.localSessionId, { status: 'revealed', revealedAnswer: answer });
      setSession({ ...session, status: 'revealed', revealedAnswer: answer });
      setShowAnswer(true);
      await soloStore.bumpProgress(session.puzzleId, { revealed: true });
    } catch {
      setError(copy.revealFail);
    }
  };

  const exportAndClear = async () => {
    const json = await soloStore.exportAll();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `jev-solo-records-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (error && !session) {
    return (
      <main className="shell">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>{copy.back}</button>
        </header>
        <p className="error-text">{error}</p>
      </main>
    );
  }
  if (!session) return <main className="shell page-loading">{copy.loadingRound}</main>;

  const solved = session.status === 'solved';

  return (
    <main className="shell">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/library')}>{copy.back}</button>
        <h1 className="brand brand-sm">{session.title}</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowAnswer((v) => !v)}>
          {copy.answer}
        </button>
      </header>

      <section className="hero-card">
        <p className="story">{session.surface}</p>
        {publicStats && (
          <div className="hint-row">
            <VoteButtons puzzleId={puzzleId!} session={authSession} initialUp={publicStats.upCount} initialDown={publicStats.downCount} />
          </div>
        )}
      </section>

      <section className="chat" aria-live="polite">
        <div className="host-intro">
          <span className="avatar">🐢</span>
          <p>{copy.jevIntro}</p>
        </div>
        {turns.filter((turn) => turn.result !== 'hint').map((turn) => (
          <TurnCard key={turn.localTurnId} turn={turn} />
        ))}
        <div ref={bottomRef} />
      </section>

      {storageWarning && <p className="error-text">{copy.storageNotSaved}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}

      {solved && (
        <section className="panel verdict-panel">
          <p className="verdict-badge verdict-solved">{displayVerdict('solved', language)}</p>
          <p>{verdictDetail('solved', language)}</p>
        </section>
      )}

      {(showAnswer || session.revealedAnswer) && session.revealedAnswer && (
        <section className="panel answer-panel">
          <h3>{copy.answer}</h3>
          <p>{session.revealedAnswer}</p>
        </section>
      )}

      {/* 结算投票：单人各账号独立，不改变他人选择（11-VOTES-AND-AUTHORSHIP.md §5） */}
      {(solved || session.revealedAnswer) && publicStats && (
        <section className="panel">
          <p className="muted">{copy.rateYourPuzzle}</p>
          <VoteButtons puzzleId={puzzleId!} session={authSession} initialUp={publicStats.upCount} initialDown={publicStats.downCount} />
        </section>
      )}

      <HintCapsule hints={turns.filter((turn) => turn.result === 'hint').map((turn) => turn.text)} />
      <section className="hint-row" role="group" aria-label={copy.hint}>
        <button className="btn btn-sm" disabled={hintBusy || session.status !== 'active' || session.hintsUnlocked.length >= 3} onClick={() => void unlockHint(session.hintsUnlocked.length)}>
          {copy.hint} {session.hintsUnlocked.length}/3
        </button>
        {!session.revealedAnswer && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              if (window.confirm(copy.revealConfirm)) void reveal();
            }}
          >
            {copy.reveal}
          </button>
        )}
      </section>

      {!solved && !session.revealedAnswer && (
        <footer className="composer">
          <div className="mode-tabs" role="tablist">
            <button className={`mode-tab ${inputMode === 'ask' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'ask'} onClick={() => setInputMode('ask')}>
              {copy.ask}
            </button>
            <button className={`mode-tab ${inputMode === 'solve' ? 'active' : ''}`} role="tab" aria-selected={inputMode === 'solve'} onClick={() => setInputMode('solve')}>
              {copy.solve}
            </button>
          </div>
          <div className="composer-row">
            <textarea
              className="field composer-input"
              rows={2}
              maxLength={inputMode === 'ask' ? 500 : 1500}
              value={text}
              placeholder={inputMode === 'ask' ? copy.askPlaceholder : copy.solvePlaceholder}
              onChange={(e) => {
                setText(e.target.value);
                persistDraft(inputMode, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button className="btn btn-primary" disabled={sending || !text.trim()} onClick={() => void submit()}>
              {sending ? copy.submitting : copy.send}
            </button>
          </div>
        </footer>
      )}

      <footer className="solo-tools">
        <button className="btn btn-sm btn-ghost" onClick={() => void exportAndClear()}>
          {copy.exportRecords}
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (window.confirm(copy.clearRecordsConfirm)) {
              void soloStore.clearAll().then(() => navigate('/library'));
            }
          }}
        >
          {copy.clearRecords}
        </button>
        <span className="muted">{format(copy.questions, { n: turns.filter((t) => t.status === 'succeeded' && t.kind === 'ask').length })}</span>
      </footer>
    </main>
  );
}

function TurnCard({ turn }: { turn: TurnRow }) {
  const { copy, language } = useLanguage();
  return (
    <div className={`turn turn-${turn.kind}`}>
      <p className="turn-text">{turn.text}</p>
      {turn.status === 'sending' && <p className="muted turn-status">{copy.judging}</p>}
      {turn.status === 'failed' && <p className="error-text turn-status">{copy.failed}</p>}
      {turn.status === 'succeeded' && turn.kind === 'ask' && turn.result && (
        <p className="turn-result">
          <span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span>
          <small className="confidence">{confidenceLabel(turn.confidence, language)}</small>
        </p>
      )}
      {turn.status === 'succeeded' && turn.kind === 'solve' && turn.result && (
        <p className="turn-result">
          <span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span>
          <small className="confidence">{confidenceLabel(turn.confidence, language)}</small>
          <span className="muted">{verdictDetail(turn.result, language)}</span>
        </p>
      )}
    </div>
  );
}