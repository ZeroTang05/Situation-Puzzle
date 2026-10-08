/** 创作编辑页：分次保存草稿、提交 Jev 初审、版本编辑与审核反馈。 */
import { useDialog } from '@jev/ui';
import React, { cloneElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useBeforeUnload, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { creationDraftSchema, creationCompleteSchema, creationDetailSchema, type CreationDraft, type CreationDetail } from '@jev/contracts';
import { api } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import type { Session } from '../session.js';
import { creationCopy, creationStatusLabel } from './copy.js';

/** 新稿只要求标题，正文可分次保存。 */
function emptyDraft(language: 'zh' | 'en'): CreationDraft {
  return { title: '', surface: '', answer: '', hints: ['', '', ''], language, difficulty: 'medium', category: 'honkaku', origin: 'original', sourceUrl: '', authorDisplay: { mode: 'anonymous' } };
}

/** 把 hints 补齐到 3 项以便稳定渲染；服务端读取时只有非空条目会被保留 */
function padHints(hints: string[]): string[] {
  return [0, 1, 2].map((i) => hints[i] ?? '');
}

/** 字段错误：按 zod path 索引的字符串映射，未出现即无错。 */
type FieldErrors = Partial<Record<string, string>>;

/** 把 zod 的 issues 转成字段错误 path → 用户可读文案。issues.path 形如 ['title']、['hints', 0]。 */
function mapIssuesToFields(issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message?: string }>, draft: CreationDraft, t: ReturnType<typeof creationCopy>): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.map((p) => String(p)).join('.');
    if (out[path]) continue;
    if (path === 'title') out.title = t.requiredField;
    else if (path === 'surface') out.surface = t.requiredField;
    else if (path === 'answer') out.answer = t.requiredField;
    else if (path === 'hints.0') out['hints.0'] = t.requiredField;
    else if (path === 'hints.1') out['hints.1'] = t.requiredField;
    else if (path === 'hints.2') out['hints.2'] = t.requiredField;
    else if (path === 'sourceUrl') {
      out.sourceUrl = draft.origin === 'repost' && !draft.sourceUrl ? t.requiredRepostUrl : t.invalidUrlField;
    } else if (path === 'authorDisplay.name') out['authorDisplay.name'] = t.invalidDisplayName;
  }
  return out;
}

/** 按视觉顺序排列的字段 id：用于首个错误自动滚动 + 聚焦。 */
const FIELD_ORDER = ['title', 'language', 'difficulty', 'category', 'surface', 'answer', 'hints.0', 'hints.1', 'hints.2', 'origin', 'sourceUrl', 'attribution', 'authorDisplay.name'] as const;

/** 字段节点注册表：Field 组件把自身的 ref 写进来，Editor 通过 id 取节点做滚动聚焦。 */
const fieldRefs: Record<string, HTMLElement | null> = {};

/** 审核结论 → 颜色：通过绿、驳回红、存疑金，其余用默认墨色。 */
function reviewConclusionClass(conclusion: string) {
  switch (conclusion) {
    case 'review_pass': return 'is-pass';
    case 'review_reject': return 'is-reject';
    case 'review_uncertain': return 'is-uncertain';
    default: return '';
  }
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
  const dialog = useDialog();
  const { language, copy } = useLanguage(); const text = creationCopy(language); const navigate = useNavigate(); const client = useQueryClient();
  const back = useBack('/creations');
  const [draft, setDraft] = useState<CreationDraft>(detail ? { ...detail.draft, hints: padHints(detail.draft.hints) } : emptyDraft(language));
  const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savedVersion = useRef(detail);
  const editable = !detail || detail.status === 'draft';
  useBeforeUnload((event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  useEffect(() => { document.title = `${text.edit} · ${draft.title}`; }, [draft.title, text.edit]);
  const change = <K extends keyof CreationDraft>(key: K, value: CreationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true); setNotice(null);
    // 编辑即清掉自身字段的报错，避免错误一直挂着不消失
    setFieldErrors((prev) => {
      const path = key as string;
      if (!prev[path] && !prev[`${path}.name`]) return prev;
      const next = { ...prev };
      delete next[path]; delete next[`${path}.name`];
      return next;
    });
  };
  /** 题目表面的 change：清掉同名字段错误 */
  const clearField = (path: string) => setFieldErrors((prev) => {
    if (!prev[path]) return prev;
    const next = { ...prev }; delete next[path]; return next;
  });
  const body = draft;
  const condition = detail ? { expectedVersionId: detail.versionId, expectedUpdatedAt: detail.updatedAt } : null;
  /** 把错误聚焦到第一个出错字段（按视觉顺序），便于用户立即修改。 */
  const focusFirstError = (errors: FieldErrors) => {
    const first = FIELD_ORDER.find((id) => errors[id]);
    if (!first) return;
    queueMicrotask(() => {
      const node = fieldRefs[first];
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const focusable = node?.querySelector<HTMLElement>('input, select, textarea');
      focusable?.focus();
    });
  };

  /** 保存成功后读取服务器版本条件，后续提交使用这次保存的版本。 */
  const persist = async (): Promise<CreationDetail> => {
    const parsed = creationDraftSchema.safeParse({ ...body, hints: body.hints.map((h) => h.trim()).filter(Boolean) });
    if (!parsed.success) {
      const fields = mapIssuesToFields(parsed.error.issues, draft, text);
      setFieldErrors(fields);
      focusFirstError(fields);
      throw new Error('字段未通过校验');
    }
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
    setBusy(true); setFieldErrors({}); setSubmitError(null);
    try { const saved = await persist(); setDirty(false); client.setQueryData(['creation', session.user.id, saved.puzzleId], saved); navigate(`/creations/${saved.puzzleId}`, { replace: true }); setNotice(text.saved); await client.invalidateQueries({ queryKey: ['creations', session.user.id] }); }
    catch (error) { if (!(error instanceof Error) || error.message !== '字段未通过校验') setSubmitError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    const parsed = creationCompleteSchema.safeParse(body);
    if (!parsed.success) {
      const fields = mapIssuesToFields(parsed.error.issues, draft, text);
      setFieldErrors(fields);
      focusFirstError(fields);
      return;
    }
    if (!(await dialog.confirm(text.submitConfirm))) return;
    setBusy(true); setFieldErrors({}); setSubmitError(null);
    try {
      const saved = await persist(); setDirty(false);
      // 提交失败时保留表单与保存后的版本条件，避免重复创建作品。
      await api(`/creations/${saved.puzzleId}/submit`, { method: 'POST', body: { expectedVersionId: saved.versionId, expectedUpdatedAt: saved.updatedAt } });
      await refresh(saved.puzzleId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '字段未通过校验') setSubmitError(error instanceof Error ? error.message : String(error));
    }
    finally { setBusy(false); }
  };
  const revise = async (action: 'revise' | 'withdraw') => {
    if (!detail || (action === 'withdraw' && !(await dialog.confirm(text.withdrawConfirm)))) return;
    setBusy(true); setSubmitError(null);
    try { await api(`/creations/${detail.puzzleId}/${action}`, { method: 'POST', body: condition }); await refresh(detail.puzzleId); }
    catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    setBusy(true); setFieldErrors({}); setSubmitError(null);
    try { const saved = editable ? await persist() : detail!; setDirty(false); navigate(`/creations/${saved.puzzleId}/preview`); }
    catch (error) { if (!(error instanceof Error) || error.message !== '字段未通过校验') setSubmitError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <main className="shell creation-shell">
    <header className="topbar">
      <button className="btn btn-ghost btn-sm" onClick={async () => { if (!dirty || await dialog.confirm(text.leaveConfirm)) back(); }}>{copy.back}</button>
      <h1 className="brand brand-sm creation-title">{detail ? text.edit : text.create}</h1>
      {detail && (
        <span className="creation-topbar-meta">
          <span className="creation-version-badge">v{detail.versionNo}</span>
          <span className={`creation-status status-${detail.status}`}>{creationStatusLabel(detail.status, language)}</span>
        </span>
      )}
    </header>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="creation-editor">
      <fieldset disabled={!editable || busy}>
        <section className="creation-section"><h2>{text.story}</h2>
          <Field id="title" label={text.title} required error={fieldErrors.title}><input className="field" required maxLength={60} value={draft.title} onChange={(event) => change('title', event.target.value)} /></Field>
          <div className="creation-fields"><Field id="language" label={text.language}><Segmented value={draft.language} options={[{ value: 'zh', label: copy.languageZh }, { value: 'en', label: copy.languageEn }]} onChange={(value) => change('language', value as 'zh' | 'en')} /></Field>
            <Field id="difficulty" label={text.difficulty}><Segmented value={draft.difficulty} options={[{ value: 'easy', label: text.easy }, { value: 'medium', label: text.medium }, { value: 'hard', label: text.hard }]} onChange={(value) => change('difficulty', value as CreationDraft['difficulty'])} /></Field>
            <Field id="category" label={text.category}><Segmented value={draft.category} options={[{ value: 'honkaku', label: text.honkaku }, { value: 'henkaku', label: text.henkaku }]} onChange={(value) => change('category', value as CreationDraft['category'])} /></Field></div>
          <Field id="surface" label={text.surface} required error={fieldErrors.surface}><textarea className="field" rows={5} maxLength={2000} value={draft.surface} onChange={(event) => change('surface', event.target.value)} /></Field>
        </section>
        <section className="creation-section"><h2>{text.truth}</h2>
          <Field id="answer" label={text.answer} required error={fieldErrors.answer}><textarea className="field" rows={6} maxLength={4000} value={draft.answer} onChange={(event) => change('answer', event.target.value)} /></Field>
          {[0, 1, 2].map((index) => <Field key={index} id={`hints.${index}`} label={`${text.hint} ${index + 1}${index === 0 ? (language === 'zh' ? '（必填）' : ' (required)') : language === 'zh' ? '（可选）' : ' (optional)'}`} required={index === 0} error={fieldErrors[`hints.${index}`]}><textarea className="field field-hint" rows={1} maxLength={500} value={draft.hints[index] ?? ''} onChange={(event) => { change('hints', [0, 1, 2].map((i) => i === index ? event.target.value : draft.hints[i] ?? '')); clearField(`hints.${index}`); }} /></Field>)}
        </section>
        <section className="creation-section"><h2>{text.origin}</h2>
          <Field id="origin" label={text.origin}><Segmented value={draft.origin} options={[{ value: 'original', label: text.original }, { value: 'repost', label: text.repost }]} onChange={(value) => { change('origin', value as CreationDraft['origin']); if (value === 'original') change('sourceUrl', ''); }} /></Field>
          {draft.origin === 'repost' && <Field id="sourceUrl" label={text.sourceUrl} required error={fieldErrors.sourceUrl}><input className="field" type="url" value={draft.sourceUrl} onChange={(event) => change('sourceUrl', event.target.value)} /></Field>}
          <Field id="attribution" label={text.attribution}><Segmented value={draft.authorDisplay.mode} options={[{ value: 'anonymous', label: text.anonymous }, { value: 'signature', label: text.signature }]} onChange={(value) => change('authorDisplay', value === 'anonymous' ? { mode: 'anonymous' } : { mode: 'signature', name: session.user.name })} /></Field>
          {draft.authorDisplay.mode === 'signature' && <Field id="authorDisplay.name" label={text.displayName} required error={fieldErrors['authorDisplay.name']}><input className="field" maxLength={30} value={draft.authorDisplay.name} onChange={(event) => change('authorDisplay', { mode: 'signature', name: event.target.value })} /></Field>}
          {/* 署名现状跟署名字段放在一起：已生效的展示名 + 待审核的改名 */}
          {(detail?.authorDisplay.name || detail?.authorDisplay.pendingName) && (
            <div className="creation-attribution-note">
              {detail?.authorDisplay.name && <p className="muted">{text.publishedName}{language === 'zh' ? '：' : ': '}{detail.authorDisplay.name}</p>}
              {detail?.authorDisplay.pendingName && <p className="creation-item-pending">{text.pendingName}{language === 'zh' ? '：' : ': '}{detail.authorDisplay.pendingName}</p>}
            </div>
          )}
        </section>
      </fieldset>
      {submitError && <p className="error-text creation-error" role="alert">{submitError}</p>}
      {notice && <p className="accent" role="status">{notice}</p>}
      <footer className="creation-actions">
        {editable && <><button className="btn" type="submit" disabled={busy}>{busy ? text.saving : text.save}</button><button className="btn btn-primary" type="button" disabled={busy} onClick={() => void submit()}>{text.submit}</button></>}
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void preview()}>{text.preview}</button>
        {detail && ['submitted', 'checking', 'pending_review'].includes(detail.status) && <button className="btn" type="button" disabled={busy} onClick={() => void revise('withdraw')}>{text.withdraw}</button>}
        {detail && ['changes_requested', 'published', 'taken_down'].includes(detail.status) && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void revise('revise')}>{text.revise}</button>}
      </footer>
    </form>
    {detail && <section className="creation-section">
      <div className="creation-section-head">
        <h2>{text.review}</h2>
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={async () => { if (!dirty || await dialog.confirm(text.leaveConfirm)) void client.invalidateQueries({ queryKey: ['creation', session.user.id, detail.puzzleId] }); }}>{text.refresh}</button>
      </div>
      {detail.reviews.length === 0 && <p className="muted creation-review-empty">{text.noReviews}</p>}
      {detail.reviews.map((review, index) => (
        <article className="creation-review" key={`${review.versionId}:${index}`}>
          <div className="creation-review-head">
            <strong className={`creation-review-conclusion ${reviewConclusionClass(review.conclusion)}`}>{creationStatusLabel(review.conclusion, language)}</strong>
            <small className="muted">{new Date(review.createdAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</small>
          </div>
          {review.reason && <p>{review.reason}</p>}
        </article>
      ))}
      <h3 className="creation-versions-title">{text.versions}</h3>
      <ul className="creation-versions">
        {detail.versions.map((version) => (
          <li key={version.versionId}>
            <span className="creation-versions-no">v{version.versionNo}</span>
            <span className={`creation-status status-${version.status}`}>{creationStatusLabel(version.status, language)}</span>
            <span className="creation-versions-lang muted">{version.language === 'zh' ? copy.languageZh : copy.languageEn}</span>
          </li>
        ))}
      </ul>
    </section>}
  </main>;
}

/** 使用包裹式 label，让所有表单字段都有可访问的名称。支持字段级错误展示与必填标记。 */
function Field({ id, label, required, error, children }: { id?: string; label: string; required?: boolean; error?: string | undefined; children: ReactNode }) {
  const setRef = (node: HTMLElement | null) => { if (id) fieldRefs[id] = node; };
  return (
    <label ref={setRef} className={`field-label creation-field${error ? ' creation-field-invalid' : ''}`}>
      <span>{label}{required && <span className="creation-required" aria-hidden> *</span>}</span>
      <FieldChild invalid={Boolean(error)}>{children}</FieldChild>
      {error && <span className="creation-field-error" role="alert">{error}</span>}
    </label>
  );
}

/** 给 Field 内的唯一表单控件注入 aria-invalid；克隆而非额外包装，避免破坏 grid 布局。 */
function FieldChild({ invalid, children }: { invalid: boolean; children: ReactNode }) {
  // children 通常是单个 ReactElement(input/textarea/select)；直接克隆挂属性。
  if (!React.isValidElement(children)) return <>{children}</>;
  const element = children as React.ReactElement<{ 'aria-invalid'?: boolean }>;
  if (element.props['aria-invalid'] !== undefined) return <>{children}</>;
  return <>{invalid ? cloneElement(element, { 'aria-invalid': true }) : children}</>;
}

/** 分段按钮组：替代 native select，避免 Android 原生选择弹窗；选项少时更直观。 */
function Segmented({ value, options, onChange }: { value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <div className="creation-segmented" role="radiogroup">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`creation-segmented-item${active ? ' active' : ''}`}
            onClick={() => { if (!active) onChange(option.value); }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
