/** 题库与投稿审核：列表、详情、批准 / 退回 / 下架、署名审核（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §5）。 */
import { List, Datagrid, TextField, NumberField, BooleanField, Show, SimpleShowLayout, useRecordContext, useNotify, useRefresh, Button } from 'react-admin';
import { adminAction } from './data-provider.js';

export const PuzzleList = () => (
  <List sort={{ field: 'createdAt', order: 'DESC' }} perPage={25}>
    <Datagrid rowClick="show" bulkActionButtons={false}>
      <TextField source="title" label="标题" />
      <TextField source="language" label="语言" />
      <NumberField source="versionNo" label="版号" />
      <TextField source="status" label="状态" />
      <BooleanField source="unavailable" label="已停用" />
      <TextField source="rightsStatus" label="授权" />
      {/* 真实投票计数只读展示；后台不能手填（11-VOTES-AND-AUTHORSHIP.md §5） */}
      <NumberField source="upCount" label="赞" />
      <NumberField source="downCount" label="踩" />
      <AuthorDisplayField />
      <AuthorInternalField />
      <PuzzleActionsField />
    </Datagrid>
  </List>
);

/** 公开署名：署名显示已批准名；待审名单独提示。 */
function AuthorDisplayField() {
  const record = useRecordContext() as
    | { authorDisplayMode?: string; authorDisplayName?: string | null; authorPendingName?: string | null }
    | undefined;
  if (!record) return null;
  const label =
    record.authorDisplayMode === 'signature' && record.authorDisplayName
      ? `署名：${record.authorDisplayName}`
      : '匿名';
  return (
    <span>
      {label}
      {record.authorPendingName ? `（待审：${record.authorPendingName}）` : ''}
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
  if (!record) return null;
  const act = (path: string) =>
    void adminAction(path, { reason: window.prompt('请输入操作理由') ?? '' })
      .then(() => {
        notify('已完成');
        refresh();
      })
      .catch((error: Error) => notify(error.message, { type: 'error' }));

  return (
    <>
      {record.status === 'pending_review' && (
        <>
          <Button label="批准当前语言" onClick={() => act(`/puzzle-versions/${record.versionId}/approve`)} />
          <Button label="退回" onClick={() => act(`/puzzle-versions/${record.versionId}/reject`)} />
        </>
      )}
      {record.status === 'published' && <Button label="下架" onClick={() => act(`/puzzles/${record.puzzleId}/takedown`)} />}
      {record.authorPendingName && (
        <>
          <Button label="署名批准" onClick={() => act(`/puzzles/${record.puzzleId}/author-display/approve`)} />
          <Button label="署名拒绝" onClick={() => act(`/puzzles/${record.puzzleId}/author-display/reject`)} />
        </>
      )}
    </>
  );
}

export const VersionDetail = () => (
  <Show>
    <SimpleShowLayout>
      <TextField source="title" label="标题" />
      <NumberField source="versionNo" label="版号" />
      <TextField source="language" label="语言" />
      <TextField source="surface" label="汤面" />
      <TextField source="answer" label="汤底" />
      <TextField source="status" label="状态" />
      <SameRevisionReview />
      <RightsReview />
      <AuthorMaterials />
      <PuzzleActionsField />
    </SimpleShowLayout>
  </Show>
);

/** 授权依据和明确同意单独审核，通过后才能发布内容。 */
function RightsReview() {
  const record = useRecordContext() as { puzzleId: string; versionId: string; status: string; rights?: { status: string; licenseBasis: string; sourceUrl: string | null; agreementVersion: string; agreedAt: string | null } } | undefined;
  const notify = useNotify(); const refresh = useRefresh();
  if (!record?.rights) return null;
  const rights = record.rights;
  const decide = (decision: 'approve' | 'reject') => {
    const reason = window.prompt('请输入授权审核理由');
    if (reason === null) return;
    void adminAction(`/puzzles/${record.puzzleId}/rights/${decision}`, { reason, expectedVersionId: record.versionId })
      .then(() => { notify('授权审核已保存'); refresh(); })
      .catch((error: Error) => notify(error.message, { type: 'error' }));
  };
  return <section><h3>作品授权</h3><p>状态：{rights.status}</p><p>{rights.licenseBasis}</p>
    {rights.sourceUrl && <a href={rights.sourceUrl} target="_blank" rel="noreferrer">查看来源</a>}
    <p>授权文本版本：{rights.agreementVersion} · 同意时间：{rights.agreedAt ? new Date(rights.agreedAt).toLocaleString() : '尚未同意'}</p>
    <Button label="批准授权" disabled={!rights.agreedAt || !['pending_review', 'published'].includes(record.status)} onClick={() => decide('approve')} />
    <Button label="拒绝授权" disabled={!['pending_review', 'published'].includes(record.status)} onClick={() => decide('reject')} />
  </section>;
}

/** 审核员可核对作者提交的事实、因果关系和标准判题用例。 */
function AuthorMaterials() {
  const record = useRecordContext() as { coreFacts?: string[]; causalChain?: string; testCases?: Array<{ id: string; versionId: string; input: string; expected: string; reason: string | null; criticality: string }>; reviews?: Array<{ id: string; stage: string; conclusion: string; reason: string | null; createdAt: string }> } | undefined;
  if (!record) return null;
  return <section><h3>审核材料</h3><ul>{record.coreFacts?.map((fact, index) => <li key={index}>{fact}</li>)}</ul><p>{record.causalChain}</p>
    {record.testCases?.map((item) => <article key={item.id}><p>{item.input}</p><p>预期判定：{item.expected} · {item.criticality === 'critical' ? '关键用例' : '普通用例'}</p><p>{item.reason}</p></article>)}
    <h3>检查与审核记录</h3>{record.reviews?.map((review) => <article key={review.id}><p>{review.stage} · {review.conclusion}</p><p style={{ whiteSpace: 'pre-wrap' }}>{review.reason}</p><small>{new Date(review.createdAt).toLocaleString()}</small></article>)}
  </section>;
}

/** 同版多语言内容在批准前一起展示，批量操作明确带上审核范围。 */
function SameRevisionReview() {
  const record = useRecordContext() as { versionId: string; versions?: Array<{ id: string; language: string; title: string; surface: string; answer: string; hints: string[]; moderationStatus: string }> } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  if (!record?.versions) return null;
  const ready = record.versions.every((version) => version.moderationStatus === 'pending_review' || version.moderationStatus === 'published');
  const pending = record.versions.some((version) => version.moderationStatus === 'pending_review');
  const approveAll = () => {
    const reason = window.prompt('请输入同版全部语言的审核理由');
    if (reason === null) return;
    void adminAction(`/puzzle-versions/${record.versionId}/approve`, { reason, scope: 'revision' })
      .then(() => { notify('同版全部语言已发布'); refresh(); })
      .catch((error: Error) => notify(error.message, { type: 'error' }));
  };
  return <section>
    <h3>同版语言审核</h3>
    {record.versions.map((version) => <article key={version.id}>
      <h4>{version.language === 'en' ? '英文' : '中文'} · {version.title} · {version.moderationStatus}</h4>
      <p><strong>汤面：</strong>{version.surface}</p>
      <p><strong>汤底：</strong>{version.answer}</p>
      <ol>{version.hints.map((hint, index) => <li key={index}>{hint}</li>)}</ol>
    </article>)}
    <Button label="批准同版全部语言" disabled={!ready || !pending} onClick={approveAll} />
  </section>;
}
