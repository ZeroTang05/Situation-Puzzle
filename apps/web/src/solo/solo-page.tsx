/**
 * 单人游戏页（docs/rebuild/08-SOLO.md）：
 * 会话与问答只存浏览器 IndexedDB；刷新恢复；断网保留输入；服务端不存任何单人对话。
 */
import { useDialog } from '@jev/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, ApiError, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { displayVerdict, verdictDetail } from '@jev/i18n';
import { soloStore, type SoloSessionRow } from './local-store.js';
import type { Session } from '../session.js';
import { HintCapsule } from '../game/hint-capsule.js';
import { confidenceLabel } from '../game/game-display.js';
import { VoteButtons } from '../catalog/vote-buttons.js';
import { canRateSoloPuzzle } from './rating-visibility.js';
import { selectUnplayedPuzzle } from './unplayed-puzzle.js';
import { GameHeader } from '../game/game-header.js';
import { ChatInput } from '../game/chat-input.js';
import { TurnCard } from '../game/turn-card.js';

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
  const dialog = useDialog();
  const { copy, language } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/library');

  const [session, setSession] = useState<SoloSessionRow | null>(null);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [hintBusy, setHintBusy] = useState(false);
  const [changingPuzzle, setChangingPuzzle] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('ask');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [publicStats, setPublicStats] = useState<{ upCount: number; downCount: number } | null>(null);
  const chatRef = useRef<HTMLElement>(null);
  const randomRequestRef = useRef<AbortController | null>(null);

  // 公开计数与署名（题目详情）：未登录也能看；投票组件内部再取本人选择
  useEffect(() => {
    if (!puzzleId) return;
    let cancelled = false;
    setPublicStats(null);
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
    let cancelled = false;
    setSession(null);
    setTurns([]);
    setText('');
    setInputMode('ask');
    setError(null);
    void (async () => {
      try {
        const existing = await soloStore.latestSessionForPuzzle(puzzleId, language);
        if (existing && existing.status === 'active') {
          const savedTurns = (await soloStore.listTurns(existing.localSessionId)) as TurnRow[];
          const draft = await soloStore.loadDraft(existing.localSessionId);
          if (cancelled) return;
          setSession(existing);
          setTurns(savedTurns);
          if (draft) {
            setInputMode(draft.inputMode);
            setText(draft.text);
          }
          return;
        }
        const created = await api<{ token: string; puzzleId: string; versionId: string; language: 'zh' | 'en'; title: string; surface: string; difficulty: 'easy' | 'medium' | 'hard' | null; category: 'honkaku' | 'henkaku' | null; hintsTotal: number; configVersion: string }>('/solo/sessions', {
          method: 'POST',
          body: { puzzleId, language },
          credentials: 'omit',
        });
        if (cancelled) return;
        const row = await soloStore.createSession({
          puzzleId,
          versionId: created.versionId,
          language,
          title: created.title,
          surface: created.surface,
          difficulty: created.difficulty,
          category: created.category,
          token: created.token,
          configVersion: created.configVersion,
        });
        if (cancelled) return;
        setSession(row);
        setTurns([]);
      } catch (err) {
        if (!cancelled) setError(translateApiError(err, language, copy.soloLoadFail));
      }
    })();
    return () => {
      cancelled = true;
      randomRequestRef.current?.abort();
    };
  }, [puzzleId, language, copy.soloLoadFail]);

  useEffect(() => {
    const chat = chatRef.current;
    if (chat) chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
  }, [turns.length, session?.revealedAnswer]);

  const persistDraft = useCallback(
    (mode: InputMode, value: string) => {
      if (session) void soloStore.saveDraft(session.localSessionId, mode, value);
    },
    [session],
  );

  const submit = async () => {
    if (!session || !text.trim() || sending || changingPuzzle) return;
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
        await soloStore.bumpProgress(session.puzzleId, { solved: true });
      } else if (inputMode === 'solve') {
        // 一次还原完成后回到普通提问；未答对时仍可继续推理。
        setInputMode('ask');
        await soloStore.saveDraft(session.localSessionId, 'ask', '');
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
    if (!session || hintBusy || changingPuzzle || session.hintsUnlocked.includes(index)) return;
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
    if (!session || session.revealedAnswer || revealing || changingPuzzle) return;
    setRevealing(true);
    try {
      const { answer } = await api<{ answer: string }>('/solo/reveal', {
        method: 'POST',
        body: { token: session.token, confirmed: true },
        credentials: 'omit',
      });
      await soloStore.updateSession(session.localSessionId, { status: 'revealed', revealedAnswer: answer });
      setSession({ ...session, status: 'revealed', revealedAnswer: answer });
      await soloStore.bumpProgress(session.puzzleId, { revealed: true });
    } catch {
      setError(copy.revealFail);
    } finally {
      setRevealing(false);
    }
  };

  /** 服务端从完整已发布题库随机选题；切换后本地记录按题目独立恢复。 */
  const changePuzzle = async () => {
    if (!session || changingPuzzle || sending || hintBusy || revealing) return;
    setChangingPuzzle(true);
    setError(null);
    const controller = new AbortController();
    randomRequestRef.current = controller;
    try {
      const playedIds = await soloStore.listPlayedPuzzleIds();
      const puzzleIds: string[] = [];
      let cursor: string | null = null;
      // 按公开题库游标读取全部候选，避免只在第一页抽题；已玩记录不出浏览器。
      do {
        const query = new URLSearchParams({ language, limit: '100', sort: 'latest' });
        if (cursor) query.set('cursor', cursor);
        const page = await api<{ items: Array<{ id: string }>; nextCursor: string | null }>(`/puzzles?${query}`, { credentials: 'omit', signal: controller.signal });
        puzzleIds.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      if (controller.signal.aborted) return;
      const selectedId = selectUnplayedPuzzle(puzzleIds, playedIds, session.puzzleId);
      if (selectedId === null) {
        setError(copy.noOtherPuzzle);
        return;
      }
      // replace 不堆叠历史：连换多题后按「返回」直接回到单人模式入口，不落回旧题
      navigate(`/solo/${selectedId}?lang=${language}`, { replace: true });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof ApiError && err.code === 'NOT_FOUND' ? copy.noOtherPuzzle : translateApiError(err, language, copy.changePuzzleFail));
    } finally {
      if (randomRequestRef.current === controller) randomRequestRef.current = null;
      setChangingPuzzle(false);
    }
  };

  if (error && !session) {
    return (
      <main className="shell">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        </header>
        <p className="error-text">{error}</p>
      </main>
    );
  }
  if (!session) return <main className="shell page-loading">{copy.loadingRound}</main>;

  const solved = session.status === 'solved';
  const canRate = canRateSoloPuzzle(session.revealedAnswer, turns);

  return (
    <main className="shell solo-shell">
      <GameHeader
        title={session.title}
        back={<button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>}
        action={<button className="btn btn-ghost btn-sm" disabled={changingPuzzle || sending || hintBusy || revealing} onClick={() => void changePuzzle()}>{changingPuzzle ? copy.changingPuzzle : copy.changePuzzle}</button>}
      />

      <section className="story-card solo-story game-scroll">
        {session.category && (
          <span className="puzzle-card-category" style={{ marginBottom: '12px' }}>
            {session.category === 'honkaku' ? copy.honkaku : copy.henkaku}
          </span>
        )}
        {session.difficulty && (
          <span className={`puzzle-card-difficulty puzzle-card-difficulty-${session.difficulty}`} style={{ marginBottom: '12px' }}>
            {session.difficulty === 'easy' ? copy.easy : session.difficulty === 'hard' ? copy.hard : copy.medium}
          </span>
        )}
        <p className="story">{session.surface}</p>
      </section>

      <section className="chat solo-chat game-scroll" ref={chatRef} aria-live="polite">
        {turns.filter((turn) => turn.result !== 'hint').map((turn) => (
          <TurnCard key={turn.localTurnId} turn={turn} copy={copy} language={language} />
        ))}
        {solved && (
          <section className="panel verdict-panel">
            <p className="verdict-badge verdict-solved">{displayVerdict('solved', language)}</p>
            <p>{verdictDetail('solved', language)}</p>
          </section>
        )}

        {session.revealedAnswer && (
          <section className="panel answer-panel">
            <h3>{copy.answer}</h3>
            <p>{session.revealedAnswer}</p>
          </section>
        )}

        {/* 首次提交还原或公布汤底后才开放评价。 */}
        {canRate && publicStats && (
          <section className="panel">
            <p className="muted">{copy.rateYourPuzzle}</p>
            <VoteButtons puzzleId={puzzleId!} session={authSession} initialUp={publicStats.upCount} initialDown={publicStats.downCount} />
          </section>
        )}
      </section>

      <div className="solo-bottom game-scroll">
        {storageWarning && <p className="error-text">{copy.storageNotSaved}</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <HintCapsule hints={turns.filter((turn) => turn.result === 'hint').map((turn) => turn.text)} />
        <section className="solo-action-row" role="group" aria-label={copy.hint}>
          <button className="btn btn-sm" disabled={changingPuzzle || hintBusy || session.status !== 'active' || session.hintsUnlocked.length >= 3} onClick={() => void unlockHint(session.hintsUnlocked.length)}>
            {copy.hint} {session.hintsUnlocked.length}/3
          </button>
          <button className="btn btn-sm" aria-pressed={inputMode === 'solve'} disabled={changingPuzzle || sending || solved || Boolean(session.revealedAnswer)} onClick={() => {
            const next = inputMode === 'solve' ? 'ask' : 'solve';
            setInputMode(next);
            setText('');
            persistDraft(next, '');
          }}>{copy.solve}</button>
          <button className="btn btn-sm" disabled={changingPuzzle || sending || revealing || Boolean(session.revealedAnswer)} onClick={async () => {
            if (await dialog.confirm(copy.revealConfirm)) void reveal();
          }}>{copy.soloViewAnswer}</button>
        </section>

        {!solved && !session.revealedAnswer && (
          <footer className="composer solo-composer">
            <div className="composer-row">
              <ChatInput
                aria-label={inputMode === 'ask' ? copy.ask : copy.solve}
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
              <button className="btn btn-primary" disabled={changingPuzzle || sending || !text.trim()} onClick={() => void submit()}>
                {sending ? copy.submitting : copy.send}
              </button>
            </div>
          </footer>
        )}
      </div>
    </main>
  );
}
