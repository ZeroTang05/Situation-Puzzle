/** 创作编辑页：分次保存草稿、明确授权提交、版本编辑与审核反馈。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useBeforeUnload, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { creationDraftSchema, creationCompleteSchema, creationDetailSchema, creationLicenseText, creationLicenseVersion, type CreationDraft, type CreationDetail } from '@jev/contracts';
import { api } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { displayVerdict } from '@jev/i18n';
import type { Session } from '../session.js';
import { creationCopy, creationStatusLabel } from './copy.js';

/** 新稿只要求标题，正文与审核材料可分次保存。 */
function emptyDraft(language: 'zh' | 'en'): CreationDraft {
  return { title: '', surface: '', answer: '', hints: ['', '', ''], language, difficulty: 'medium', licenseBasis: '', sourceUrl: '', coreFacts: [], causalChain: '', testCases: [], authorDisplay: { mode: 'anonymous' } };
}

export function CreationEditorPage({ session }: { session: Session | null }) {
  const { puzzleId } = useParams(); const { language, copy } = useLanguage(); const text = creationCopy(language);
  const query = useQuery({ queryKey: ['creation', session?.user.id, puzzleId], enabled: !!session && !!puzzleId,
    queryFn: async () => creationDetailSchema.parse(await api(`/creations/${puzzleId}`)), retry: false, refetchOnWindowFocus: false,
    refetchInterval: (query) => ['submitted', 'checking', 'pending_review'].includes(query.state.data?.status ?? '') ? 5000 : false,
  });
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(puzzleId ? `/creations/${puzzleId}` : '/creations/new')}`} replace />;
  if (puzzleId && query.isPending) return <main className="shell page-loading">{text.loading}</main>;
  if (puzzleId && query.error) return <main className="shell"><Link className="btn" to="/creations">{text.works}</Link><p className="error-text" role="alert">{query.error.message}</p></main>;
  return <Editor key={query.data ? `${query.data.versionId}:${query.data.updatedAt}:${query.data.status}` : 'new'} session={session} detail={query.data} />;
}

/** 表单与已保存版本分开，后台状态刷新只发生在只读审核阶段。 */
function Editor({ session, detail }: { session: Session; detail: CreationDetail | undefined }) {
  const { language } = useLanguage(); const text = creationCopy(language); const navigate = useNavigate(); const client = useQueryClient();
  const [draft, setDraft] = useState<CreationDraft>(detail?.draft ?? emptyDraft(language));
  const [factsText, setFactsText] = useState(draft.coreFacts.join('\n'));
  const [agreed, setAgreed] = useState(false); const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const savedVersion = useRef(detail);
  const editable = !detail || detail.status === 'draft';
  useBeforeUnload((event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  useEffect(() => { document.title = `${text.edit} · ${draft.title}`; }, [draft.title, text.edit]);
  const change = <K extends keyof CreationDraft>(key: K, value: CreationDraft[K]) => { setDraft((current) => ({ ...current, [key]: value })); setDirty(true); setNotice(null); };
  const body = { ...draft, coreFacts: factsText.split(/\r?\n/).map((fact) => fact.trim()).filter(Boolean) };
  const condition = detail ? { expectedVersionId: detail.versionId, expectedUpdatedAt: detail.updatedAt } : null;

  /** 保存成功后读取服务器版本条件，后续提交使用这次保存的版本。 */
  const persist = async (): Promise<CreationDetail> => {
    const parsed = creationDraftSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
    let puzzleId = savedVersion.current?.puzzleId;
    if (puzzleId) await api(`/creations/${puzzleId}`, { method: 'PATCH', body: { ...parsed.data, expectedVersionId: savedVersion.current!.versionId, expectedUpdatedAt: savedVersion.current!.updatedAt } });
    else puzzleId = (await api<{ puzzleId: string }>('/creations', { method: 'POST', body: parsed.data })).puzzleId;
    const saved = creationDetailSchema.parse(await api(`/creations/${puzzleId}`));
    savedVersion.current = saved;
    return saved;
  };
  const refresh = async (puzzleId: string) => {
    await client.invalidateQueries({ queryKey: ['creations', session.user.id] });
    await client.invalidateQueries({ queryKey: ['creation', session.user.id, puzzleId] });
    navigate(`/creations/${puzzleId}`, { replace: true });
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { const saved = await persist(); setDirty(false); client.setQueryData(['creation', session.user.id, saved.puzzleId], saved); navigate(`/creations/${saved.puzzleId}`, { replace: true }); setNotice(text.saved); await client.invalidateQueries({ queryKey: ['creations', session.user.id] }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    const parsed = creationCompleteSchema.safeParse(body);
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')); return; }
    if (!agreed || !window.confirm(text.submitConfirm)) return;
    setBusy(true); setError(null);
    try {
      const saved = await persist(); setDirty(false);
      // 提交失败时保留表单与保存后的版本条件，避免重复创建作品。
      await api(`/creations/${saved.puzzleId}/submit`, { method: 'POST', body: { expectedVersionId: saved.versionId, expectedUpdatedAt: saved.updatedAt, agreementAccepted: true, agreementVersion: creationLicenseVersion } });
      await refresh(saved.puzzleId);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const revise = async (action: 'revise' | 'withdraw') => {
    if (!detail || (action === 'withdraw' && !window.confirm(text.withdrawConfirm))) return;
    setBusy(true); setError(null);
    try { await api(`/creations/${detail.puzzleId}/${action}`, { method: 'POST', body: condition }); await refresh(detail.puzzleId); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    setBusy(true); setError(null);
    try { const saved = editable ? await persist() : detail!; setDirty(false); navigate(`/creations/${saved.puzzleId}/preview`); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const changeCase = (index: number, values: Partial<CreationDraft['testCases'][number]>) => change('testCases', draft.testCases.map((item, i) => i === index ? { ...item, ...values } : item));

  return <main className="shell creation-shell">
    <header className="topbar"><button className="btn btn-ghost btn-sm" onClick={() => { if (!dirty || window.confirm(text.leaveConfirm)) navigate('/creations'); }}>{text.works}</button><h1 className="brand brand-sm">{detail ? text.edit : text.create}</h1>{detail && <span className={`creation-status status-${detail.status}`}>{creationStatusLabel(detail.status, language)}</span>}</header>
    {detail && <p className="muted">{text.version} {detail.versionNo} · {text.rights}：{creationStatusLabel(detail.rights.status, language)}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="creation-editor">
      <fieldset disabled={!editable || busy}>
        <section className="creation-section"><h2>{text.story}</h2>
          <Field label={text.title}><input className="field" required maxLength={60} value={draft.title} onChange={(event) => change('title', event.target.value)} /></Field>
          <div className="creation-fields"><Field label={text.language}><select className="field" value={draft.language} onChange={(event) => change('language', event.target.value as 'zh' | 'en')}><option value="zh">{copy.languageZh}</option><option value="en">{copy.languageEn}</option></select></Field>
            <Field label={text.difficulty}><select className="field" value={draft.difficulty} onChange={(event) => change('difficulty', event.target.value as CreationDraft['difficulty'])}><option value="easy">{text.easy}</option><option value="medium">{text.medium}</option><option value="hard">{text.hard}</option></select></Field></div>
          <Field label={text.surface}><textarea className="field" rows={5} maxLength={2000} value={draft.surface} onChange={(event) => change('surface', event.target.value)} /></Field>
        </section>
        <section className="creation-section"><h2>{text.truth}</h2>
          <Field label={text.answer}><textarea className="field" rows={6} maxLength={4000} value={draft.answer} onChange={(event) => change('answer', event.target.value)} /></Field>
          {[0, 1, 2].map((index) => <Field key={index} label={`${text.hint} ${index + 1}`}><textarea className="field" rows={2} maxLength={500} value={draft.hints[index] ?? ''} onChange={(event) => change('hints', [0, 1, 2].map((i) => i === index ? event.target.value : draft.hints[i] ?? ''))} /></Field>)}
        </section>
        <section className="creation-section"><h2>{text.materials}</h2>
          <Field label={text.facts}><textarea className="field" rows={4} value={factsText} onChange={(event) => { setFactsText(event.target.value); setDirty(true); }} /><small className="muted">{text.factHelp}</small></Field>
          <Field label={text.chain}><textarea className="field" rows={4} maxLength={2000} value={draft.causalChain} onChange={(event) => change('causalChain', event.target.value)} /></Field>
          <h3>{text.cases}</h3><p className="muted">{text.caseHelp}</p>
          {draft.testCases.map((item, index) => <section key={index} className="creation-case" aria-label={`${text.cases} ${index + 1}`}>
            <div className="creation-fields"><Field label={text.question}><select className="field" value={item.kind} onChange={(event) => changeCase(index, { kind: event.target.value as 'ask' | 'solve', expected: event.target.value === 'ask' ? 'yes' : 'solved' })}><option value="ask">{text.ask}</option><option value="solve">{text.solve}</option></select></Field>
              <Field label={text.expected}><select className="field" value={item.expected} onChange={(event) => changeCase(index, { expected: event.target.value as typeof item.expected })}>{(item.kind === 'ask' ? ['yes', 'no', 'irrelevant', 'uncertain'] : ['solved', 'close', 'not_yet', 'uncertain']).map((value) => <option key={value} value={value}>{displayVerdict(value, language)}</option>)}</select></Field></div>
            <Field label={text.question}><textarea className="field" rows={2} maxLength={item.kind === 'ask' ? 500 : 1500} value={item.input} onChange={(event) => changeCase(index, { input: event.target.value })} /></Field>
            <Field label={text.reason}><input className="field" maxLength={500} value={item.reason} onChange={(event) => changeCase(index, { reason: event.target.value })} /></Field>
            <label className="creation-check"><input type="checkbox" checked={item.criticality === 'critical'} onChange={(event) => changeCase(index, { criticality: event.target.checked ? 'critical' : 'normal' })} />{text.critical}</label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => change('testCases', draft.testCases.filter((_, i) => i !== index))}>{text.remove}</button>
          </section>)}
          <button type="button" className="btn btn-sm" disabled={draft.testCases.length >= 10} onClick={() => change('testCases', [...draft.testCases, { kind: 'ask', input: '', expected: 'yes', reason: '', criticality: 'normal' }])}>{text.addCase}</button>
        </section>
        <section className="creation-section"><h2>{text.rights}</h2>
          <Field label={text.licenseBasis}><textarea className="field" rows={3} maxLength={500} value={draft.licenseBasis} onChange={(event) => change('licenseBasis', event.target.value)} /></Field>
          <Field label={text.sourceUrl}><input className="field" type="url" value={draft.sourceUrl} onChange={(event) => change('sourceUrl', event.target.value)} /></Field>
          <Field label={text.attribution}><select className="field" value={draft.authorDisplay.mode} onChange={(event) => change('authorDisplay', event.target.value === 'anonymous' ? { mode: 'anonymous' } : { mode: 'signature', name: session.user.name })}><option value="anonymous">{text.anonymous}</option><option value="signature">{text.signature}</option></select></Field>
          {draft.authorDisplay.mode === 'signature' && <Field label={text.displayName}><input className="field" maxLength={30} value={draft.authorDisplay.name} onChange={(event) => change('authorDisplay', { mode: 'signature', name: event.target.value })} /></Field>}
        </section>
      </fieldset>
      {detail?.authorDisplay.pendingName && <p className="muted">{text.pendingName}：{detail.authorDisplay.pendingName}</p>}
      {detail?.authorDisplay.name && <p className="muted">{text.publishedName}：{detail.authorDisplay.name}</p>}
      {editable && <label className="creation-check creation-license"><input type="checkbox" checked={agreed} disabled={busy} onChange={(event) => setAgreed(event.target.checked)} />{creationLicenseText[language]}</label>}
      {error && <p className="error-text creation-error" role="alert">{error}</p>}{notice && <p className="accent" role="status">{notice}</p>}
      <footer className="creation-actions">
        {editable && <><button className="btn" type="submit" disabled={busy}>{busy ? text.saving : text.save}</button><button className="btn btn-primary" type="button" disabled={busy || !agreed} onClick={() => void submit()}>{text.submit}</button></>}
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void preview()}>{text.preview}</button>
        {detail && ['submitted', 'checking', 'pending_review'].includes(detail.status) && <button className="btn" type="button" disabled={busy} onClick={() => void revise('withdraw')}>{text.withdraw}</button>}
        {detail && ['changes_requested', 'published', 'taken_down'].includes(detail.status) && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void revise('revise')}>{text.revise}</button>}
      </footer>
    </form>
    {detail && <section className="creation-section"><h2>{text.review}</h2>{detail.reviews.length === 0 && <p className="muted">{text.noReviews}</p>}{detail.reviews.map((review, index) => <article className="creation-review" key={`${review.versionId}:${index}`}><strong>{creationStatusLabel(review.conclusion, language)}</strong><p>{review.reason}</p><small className="muted">{new Date(review.createdAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</small></article>)}<h3>{text.versions}</h3>{detail.versions.map((version) => <p className="muted" key={version.versionId}>{text.version} {version.versionNo} · {version.language} · {creationStatusLabel(version.status, language)}</p>)}
      <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { if (!dirty || window.confirm(text.leaveConfirm)) void client.invalidateQueries({ queryKey: ['creation', session.user.id, detail.puzzleId] }); }}>{text.refresh}</button>
    </section>}
  </main>;
}

/** 使用包裹式 label，让所有表单字段都有可访问的名称。 */
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field-label creation-field"><span>{label}</span>{children}</label>; }
