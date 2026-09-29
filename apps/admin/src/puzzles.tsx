/** 题库与投稿审核：列表、详情、批准 / 退回 / 下架、署名审核（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §5）。 */
import { List, Datagrid, TextField, NumberField, BooleanField, Show, SimpleShowLayout, useRecordContext, useNotify, useRefresh, Button } from 'react-admin';
import { adminAction } from './data-provider.js';
import { copy } from './copy.js';
import { useLanguage } from './language.js';

export function PuzzleList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List sort={{ field: 'createdAt', order: 'DESC' }} perPage={25}>
      <Datagrid rowClick="show" bulkActionButtons={false}>
        <TextField source="title" label={c.puzzleCol} />
        <TextField source="language" label={c.languageCol} />
        <NumberField source="versionNo" label={c.versionCol} />
        <TextField source="status" label={c.statusCol} />
        <BooleanField source="unavailable" label={c.disabledCol} />
        <TextField source="rightsStatus" label={c.rightsCol} />
        {/* 真实投票计数只读展示；后台不能手填（11-VOTES-AND-AUTHORSHIP.md §5） */}
        <NumberField source="upCount" label={c.upCol} />
        <NumberField source="downCount" label={c.downCol} />
        <AuthorDisplayField />
        <AuthorInternalField />
        <PuzzleActionsField />
      </Datagrid>
    </List>
  );
}

/** 公开署名：署名显示已批准名；待审名单独提示。 */
function AuthorDisplayField() {
  const record = useRecordContext() as
    | { authorDisplayMode?: string; authorDisplayName?: string | null; authorPendingName?: string | null }
    | undefined;
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  const label =
    record.authorDisplayMode === 'signature' && record.authorDisplayName
      ? c.authorBy(record.authorDisplayName)
      : c.authorAnonymous;
  return (
    <span>
      {label}
      {record.authorPendingName ? c.authorPendingSuffix(record.authorPendingName) : ''}
    </span>
  );
}

/** 内部归属（审核核验用）；匿名作品不对外，但后台可见。 */
function AuthorInternalField() {
  const record = useRecordContext() as { authorUserId?: string | null } | undefined;
  if (!record?.authorUserId) return <span>—</span>;
  return <span>{record.authorUserId.slice(0, 8)}…</span>;
}

function PuzzleActionsField() {
  const record = useRecordContext() as
    | { versionId?: string; puzzleId?: string; status?: string; authorPendingName?: string | null }
    | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  const act = (path: string) =>
    void adminAction(path, { reason: window.prompt(c.promptReason) ?? '' })
      .then(() => {
        notify(c.done);
        refresh();
      })
      .catch((error: Error) => notify(error.message, { type: 'error' }));

  return (
    <>
      {record.status === 'pending_review' && (
        <>
          <Button label={c.approveLanguage} onClick={() => act(`/puzzle-versions/${record.versionId}/approve`)} />
          <Button label={c.reject} onClick={() => act(`/puzzle-versions/${record.versionId}/reject`)} />
        </>
      )}
      {record.status === 'published' && <Button label={c.takedown} onClick={() => act(`/puzzles/${record.puzzleId}/takedown`)} />}
      {record.authorPendingName && (
        <>
          <Button label={c.approveAttribution} onClick={() => act(`/puzzles/${record.puzzleId}/author-display/approve`)} />
          <Button label={c.rejectAttribution} onClick={() => act(`/puzzles/${record.puzzleId}/author-display/reject`)} />
        </>
      )}
    </>
  );
}

export function VersionDetail() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <Show>
      <SimpleShowLayout>
        <TextField source="title" label={c.puzzleCol} />
        <NumberField source="versionNo" label={c.versionCol} />
        <TextField source="language" label={c.languageCol} />
        <TextField source="surface" label={c.surfaceLabel} />
        <TextField source="answer" label={c.answerLabel} />
        <TextField source="status" label={c.statusCol} />
        <SameRevisionReview />
        <RightsReview />
        <AuthorMaterials />
        <PuzzleActionsField />
      </SimpleShowLayout>
    </Show>
  );
}

/** 授权依据和明确同意单独审核，通过后才能发布内容。 */
function RightsReview() {
  const record = useRecordContext() as { puzzleId: string; versionId: string; status: string; rights?: { status: string; licenseBasis: string; sourceUrl: string | null; agreementVersion: string; agreedAt: string | null } } | undefined;
  const notify = useNotify(); const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record?.rights) return null;
  const rights = record.rights;
  const decide = (decision: 'approve' | 'reject') => {
    const reason = window.prompt(c.promptRights);
    if (reason === null) return;
    void adminAction(`/puzzles/${record.puzzleId}/rights/${decision}`, { reason, expectedVersionId: record.versionId })
      .then(() => { notify(c.rightsSaved); refresh(); })
      .catch((error: Error) => notify(error.message, { type: 'error' }));
  };
  return <section><h3>{c.sectionRights}</h3><p>{c.rightsStatusLabel}：{rights.status}</p><p>{rights.licenseBasis}</p>
    {rights.sourceUrl && <a href={rights.sourceUrl} target="_blank" rel="noreferrer">{c.rightsViewSource}</a>}
    <p>{c.rightsAgreementVersion}：{rights.agreementVersion} · {c.rightsAgreedAt}：{rights.agreedAt ? new Date(rights.agreedAt).toLocaleString() : c.rightsNotAgreed}</p>
    <Button label={c.approveRights} disabled={!rights.agreedAt || !['pending_review', 'published'].includes(record.status)} onClick={() => decide('approve')} />
    <Button label={c.rejectRights} disabled={!['pending_review', 'published'].includes(record.status)} onClick={() => decide('reject')} />
  </section>;
}

/** 审核员可核对作者提交的事实、因果关系和标准判题用例。 */
function AuthorMaterials() {
  const record = useRecordContext() as { coreFacts?: string[]; causalChain?: string; testCases?: Array<{ id: string; versionId: string; input: string; expected: string; reason: string | null; criticality: string }>; reviews?: Array<{ id: string; stage: string; conclusion: string; reason: string | null; createdAt: string }> } | undefined;
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  return <section><h3>{c.sectionAuthorMaterials}</h3><ul>{record.coreFacts?.map((fact, index) => <li key={index}>{fact}</li>)}</ul><p>{record.causalChain}</p>
    {record.testCases?.map((item) => <article key={item.id}><p>{item.input}</p><p>{c.testCaseExpected}：{item.expected} · {item.criticality === 'critical' ? c.testCaseCritical : c.testCaseNormal}</p><p>{item.reason}</p></article>)}
    <h3>{c.sectionReviews}</h3>{record.reviews?.map((review) => <article key={review.id}><p>{review.stage} · {review.conclusion}</p><p style={{ whiteSpace: 'pre-wrap' }}>{review.reason}</p><small>{new Date(review.createdAt).toLocaleString()}</small></article>)}
  </section>;
}

/** 同版多语言内容在批准前一起展示，批量操作明确带上审核范围。 */
function SameRevisionReview() {
  const record = useRecordContext() as { versionId: string; versions?: Array<{ id: string; language: string; title: string; surface: string; answer: string; hints: string[]; moderationStatus: string }> } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record?.versions) return null;
  const ready = record.versions.every((version) => version.moderationStatus === 'pending_review' || version.moderationStatus === 'published');
  const pending = record.versions.some((version) => version.moderationStatus === 'pending_review');
  const approveAll = () => {
    const reason = window.prompt(c.promptRevision);
    if (reason === null) return;
    void adminAction(`/puzzle-versions/${record.versionId}/approve`, { reason, scope: 'revision' })
      .then(() => { notify(c.revisionApproved); refresh(); })
      .catch((error: Error) => notify(error.message, { type: 'error' }));
  };
  return <section>
    <h3>{c.sectionSameRevision}</h3>
    {record.versions.map((version) => <article key={version.id}>
      <h4>{version.language === 'en' ? (language === 'zh' ? '英文' : 'English') : (language === 'zh' ? '中文' : 'Chinese')} · {version.title} · {version.moderationStatus}</h4>
      <p><strong>{c.surfaceLabel}：</strong>{version.surface}</p>
      <p><strong>{c.answerLabel}：</strong>{version.answer}</p>
      <ol>{version.hints.map((hint, index) => <li key={index}>{hint}</li>)}</ol>
    </article>)}
    <Button label={c.approveAllLanguages} disabled={!ready || !pending} onClick={approveAll} />
  </section>;
}