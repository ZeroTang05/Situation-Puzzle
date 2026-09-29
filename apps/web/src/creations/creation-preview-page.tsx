/** 私人试题复用真实单人接口；凭证来自作者鉴权，问答只写浏览器。 */
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { creationPreviewSchema, type CreationPreview } from '@jev/contracts';
import { displayVerdict } from '@jev/i18n';
import { api } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import type { Session } from '../session.js';
import { soloStore, type SoloSessionRow } from '../solo/local-store.js';
import { HintCapsule } from '../game/hint-capsule.js';
import { confidenceLabel } from '../game/game-display.js';
import { creationCopy } from './copy.js';

type Turn = Awaited<ReturnType<typeof soloStore.listTurns>>[number];

export function CreationPreviewPage({ session: account }: { session: Session | null }) {
  const { puzzleId } = useParams(); const { language } = useLanguage(); const text = creationCopy(language);
  const [preview, setPreview] = useState<CreationPreview | null>(null); const [local, setLocal] = useState<SoloSessionRow | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]); const [input, setInput] = useState(''); const [mode, setMode] = useState<'ask' | 'solve'>('ask');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [revision, setRevision] = useState(0);
  const forceNew = useRef(false); const bottom = useRef<HTMLDivElement>(null);
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
        const records = await soloStore.listTurns(row.localSessionId); const draft = await soloStore.loadDraft(row.localSessionId);
        if (cancelled) return;
        forceNew.current = false; setPreview(token); setLocal(row); setTurns(records); setInput(draft?.text ?? ''); setMode(draft?.inputMode ?? 'ask');
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); }
    })();
    return () => { cancelled = true; };
  }, [account?.user.id, puzzleId, revision]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [turns.length]);

  const ask = async () => {
    if (!local || !preview || !input.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const question = input.trim();
      const id = await soloStore.addTurn({ localSessionId: local.localSessionId, kind: mode, text: question });
      setTurns(await soloStore.listTurns(local.localSessionId));
      try {
        const result = await api<{ result: string; confidence: number; answer?: string }>(mode === 'ask' ? '/solo/judge' : '/solo/solve', { method: 'POST', body: mode === 'ask' ? { token: preview.token, question } : { token: preview.token, solution: question }, credentials: 'omit' });
        await soloStore.finishTurn(id, { status: 'succeeded', result: result.result, confidence: result.confidence });
        if (result.answer) { await soloStore.updateSession(local.localSessionId, { revealedAnswer: result.answer }); setLocal({ ...local, revealedAnswer: result.answer }); }
        await soloStore.saveDraft(local.localSessionId, mode, ''); setInput('');
      } catch (error) {
        await soloStore.finishTurn(id, { status: 'failed', failNote: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally { setTurns(await soloStore.listTurns(local.localSessionId)); }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
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
      setLocal({ ...local, hintsUnlocked: [...local.hintsUnlocked, index] }); setTurns(await soloStore.listTurns(local.localSessionId));
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
  if (!account) return <Navigate to={`/login?next=${encodeURIComponent(`/creations/${puzzleId}/preview`)}`} replace />;
  return <main className="shell">
    <header className="topbar"><Link className="btn btn-ghost btn-sm" to={`/creations/${puzzleId}`}>{text.backEditor}</Link><h1 className="brand brand-sm">{text.previewTitle}</h1></header>
    {error && <p className="error-text" role="alert">{error}</p>}
    {!local && !error && <p role="status">{text.loading}</p>}
    {local && preview && <><section className="hero-card"><h2>{preview.title}</h2><p className="story">{preview.surface}</p></section>
      <section className="chat" aria-live="polite">{turns.filter((turn) => turn.result !== 'hint').map((turn) => <article key={turn.localTurnId} className={`turn turn-${turn.kind}`}><p className="turn-text">{turn.text}</p>{turn.status === 'sending' && <p className="muted">{text.judging}</p>}{turn.status === 'failed' && <p className="error-text">{turn.failNote ?? text.failed}</p>}{turn.result && <p className="turn-result"><span className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</span><small className="confidence">{confidenceLabel(turn.confidence, language)}</small></p>}</article>)}<div ref={bottom} /></section>
      <HintCapsule hints={turns.filter((turn) => turn.result === 'hint').map((turn) => turn.text)} total={preview.hintsTotal} />
      {local.revealedAnswer && <section className="panel answer-panel"><h3>{text.answer}</h3><p>{local.revealedAnswer}</p></section>}
      <div className="hint-row"><button className="btn btn-sm" disabled={busy || local.hintsUnlocked.length >= preview.hintsTotal} onClick={() => void hint()}>{text.hint} {local.hintsUnlocked.length}/{preview.hintsTotal}</button><button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void reveal()}>{text.reveal}</button><button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { forceNew.current = true; setRevision((value) => value + 1); }}>{text.reset}</button></div>
      <footer className="composer"><div className="mode-tabs" role="tablist">{(['ask', 'solve'] as const).map((value) => <button className={`mode-tab ${mode === value ? 'active' : ''}`} key={value} role="tab" aria-selected={mode === value} disabled={busy} onClick={() => setMode(value)}>{text[value]}</button>)}</div>
        <div className="composer-row"><textarea aria-label={text.question} className="field composer-input" rows={2} disabled={busy} maxLength={mode === 'ask' ? 500 : 1500} placeholder={mode === 'ask' ? text.placeholder : text.solvePlaceholder} value={input} onChange={(event) => { setInput(event.target.value); void soloStore.saveDraft(local.localSessionId, mode, event.target.value).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error))); }} /><button className="btn btn-primary" disabled={busy || !input.trim()} onClick={() => void ask()}>{text.send}</button></div>
      </footer></>}
  </main>;
}
