/** 私人试题复用真实单人接口；UI 与单人页保持一致（顶部栏 / 题面卡 / 聊天 / 操作行）。 */
import { useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { creationPreviewSchema, type CreationPreview } from '@jev/contracts';
import { api } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import type { Session } from '../session.js';
import { soloStore, type SoloSessionRow } from '../solo/local-store.js';
import { HintCapsule } from '../game/hint-capsule.js';
import { TurnCard, type PreviewTurn } from '../game/turn-card.js';
import { GameHeader } from '../game/game-header.js';
import { ChatInput } from '../game/chat-input.js';
import { creationCopy } from './copy.js';

export function CreationPreviewPage({ session: account }: { session: Session | null }) {
  const { puzzleId } = useParams(); const { copy, language } = useLanguage(); const text = creationCopy(language);
  const back = useBack(`/creations/${puzzleId ?? ''}`);
  const [preview, setPreview] = useState<CreationPreview | null>(null); const [local, setLocal] = useState<SoloSessionRow | null>(null);
  const [turns, setTurns] = useState<PreviewTurn[]>([]); const [input, setInput] = useState(''); const [mode, setMode] = useState<'ask' | 'solve'>('ask');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [revision, setRevision] = useState(0);
  const forceNew = useRef(false); const chatRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!account || !puzzleId) return;
    let cancelled = false;
    setLocal(null); setError(null);
    void (async () => {
      try {
        const token = creationPreviewSchema.parse(await api(`/creations/${puzzleId}/test-session`, { method: 'POST' }));
        const key = `preview:${account.user.id}:${puzzleId}`;
        const existing = await soloStore.latestSessionForPuzzle(key, token.language);
        const reuse = !forceNew.current && existing?.versionId === token.versionId && existing.previewDigest === token.contentHash;
        const row = reuse ? { ...existing!, token: token.token } : await soloStore.createSession({ puzzleId: key, versionId: token.versionId, language: token.language, title: token.title, surface: token.surface, token: token.token, configVersion: token.configVersion, previewDigest: token.contentHash });
        if (reuse) await soloStore.updateSession(row.localSessionId, { token: token.token });
        const records = await soloStore.listTurns(row.localSessionId) as PreviewTurn[]; const draft = await soloStore.loadDraft(row.localSessionId);
        if (cancelled) return;
        forceNew.current = false; setPreview(token); setLocal(row); setTurns(records); setInput(draft?.text ?? ''); setMode(draft?.inputMode ?? 'ask');
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); }
    })();
    return () => { cancelled = true; };
  }, [account?.user.id, puzzleId, revision]);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' }); }, [turns.length, local?.revealedAnswer]);

  const ask = async () => {
    if (!local || !preview || !input.trim() || busy) return;
    setBusy(true); setError(null);
    const question = input.trim();
    const id = await soloStore.addTurn({ localSessionId: local.localSessionId, kind: mode, text: question });
    setTurns(await soloStore.listTurns(local.localSessionId) as PreviewTurn[]);
    try {
      const result = await api<{ result: string; confidence: number; answer?: string }>(mode === 'ask' ? '/solo/judge' : '/solo/solve', { method: 'POST', body: mode === 'ask' ? { token: preview.token, question } : { token: preview.token, solution: question }, credentials: 'omit' });
      await soloStore.finishTurn(id, { status: 'succeeded', result: result.result, confidence: result.confidence });
      if (result.answer) { await soloStore.updateSession(local.localSessionId, { revealedAnswer: result.answer }); setLocal({ ...local, revealedAnswer: result.answer }); }
      await soloStore.saveDraft(local.localSessionId, mode, ''); setInput('');
    } catch (error) {
      await soloStore.finishTurn(id, { status: 'failed', failNote: error instanceof Error ? error.message : String(error) });
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setTurns(await soloStore.listTurns(local.localSessionId) as PreviewTurn[]);
      setBusy(false);
    }
  };
  const hint = async () => {
    if (!local || !preview || busy) return;
    setBusy(true); setError(null);
    try {
      const index = local.hintsUnlocked.length;
      const result = await api<{ text: string }>('/solo/hints', { method: 'POST', body: { token: preview.token, index }, credentials: 'omit' });
      const id = await soloStore.addTurn({ localSessionId: local.localSessionId, kind: 'ask', text: result.text });
      await soloStore.finishTurn(id, { status: 'succeeded', result: 'hint' });
      await soloStore.updateSession(local.localSessionId, { hintsUnlocked: [...local.hintsUnlocked, index] });
      setLocal({ ...local, hintsUnlocked: [...local.hintsUnlocked, index] });
      setTurns(await soloStore.listTurns(local.localSessionId) as PreviewTurn[]);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reveal = async () => {
    if (!local || !preview) return;
    setBusy(true); setError(null);
    try { const result = await api<{ answer: string }>('/solo/reveal', { method: 'POST', body: { token: preview.token, confirmed: true }, credentials: 'omit' }); await soloStore.updateSession(local.localSessionId, { revealedAnswer: result.answer }); setLocal({ ...local, revealedAnswer: result.answer }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reset = () => { forceNew.current = true; setRevision((value) => value + 1); };

  if (!account) return <Navigate to={`/login?next=${encodeURIComponent(`/creations/${puzzleId}/preview`)}`} replace />;
  if (error && !local) {
    return (
      <main className="shell">
        <header className="topbar"><button className="btn btn-ghost btn-sm" onClick={back}>{text.backEditor}</button></header>
        <p className="error-text">{error}</p>
      </main>
    );
  }
  if (!local || !preview) return <main className="shell page-loading">{text.loading}</main>;

  const solved = local.status === 'solved';
  const hintProgress = `${local.hintsUnlocked.length}/${preview.hintsTotal}`;
  return (
    <main className="shell solo-shell">
      <GameHeader
        title={text.previewTitle}
        back={<button className="btn btn-ghost btn-sm" onClick={back}>{text.backEditor}</button>}
        action={<button className="btn btn-ghost btn-sm" disabled={busy} onClick={reset}>{text.reset}</button>}
      />

      <section className="story-card solo-story game-scroll">
        <p className="accent">{preview.title}</p>
        <p className="story">{preview.surface}</p>
      </section>

      <section className="chat solo-chat game-scroll" ref={chatRef} aria-live="polite">
        {turns.filter((turn) => turn.result !== 'hint').map((turn) => (
          <TurnCard key={turn.localTurnId} turn={turn} copy={copy} language={language} />
        ))}
        {solved && (
          <section className="panel verdict-panel">
            <p className="verdict-badge verdict-solved">✓</p>
            <p className="muted">{text.previewTitle}</p>
          </section>
        )}
        {local.revealedAnswer && (
          <section className="panel answer-panel">
            <h3>{text.answer}</h3>
            <p>{local.revealedAnswer}</p>
          </section>
        )}
      </section>

      <div className="solo-bottom game-scroll">
        {error && <p className="error-text" role="alert">{error}</p>}
        <HintCapsule hints={turns.filter((turn) => turn.result === 'hint').map((turn) => turn.text)} total={preview.hintsTotal} />
        <section className="solo-action-row" role="group" aria-label={text.hint}>
          <button className="btn btn-sm" disabled={busy || local.hintsUnlocked.length >= preview.hintsTotal} onClick={() => void hint()}>
            {text.hint} {hintProgress}
          </button>
          <button className="btn btn-sm" aria-pressed={mode === 'solve'} disabled={busy || solved || Boolean(local.revealedAnswer)} onClick={() => {
            const next = mode === 'solve' ? 'ask' : 'solve';
            setMode(next);
            setInput('');
            void soloStore.saveDraft(local.localSessionId, next, '').catch(() => undefined);
          }}>{text.solve}</button>
          <button className="btn btn-sm" disabled={busy || Boolean(local.revealedAnswer)} onClick={() => void reveal()}>{text.reveal}</button>
        </section>

        {!solved && !local.revealedAnswer && (
          <footer className="composer solo-composer">
            <div className="composer-row">
              <ChatInput
                aria-label={mode === 'ask' ? text.ask : text.solve}
                maxLength={mode === 'ask' ? 500 : 1500}
                value={input}
                placeholder={mode === 'ask' ? text.placeholder : text.solvePlaceholder}
                onChange={(e) => {
                  setInput(e.target.value);
                  void soloStore.saveDraft(local.localSessionId, mode, e.target.value).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void ask();
                  }
                }}
              />
              <button className="btn btn-primary" disabled={busy || !input.trim()} onClick={() => void ask()}>{text.send}</button>
            </div>
          </footer>
        )}
      </div>
    </main>
  );
}
