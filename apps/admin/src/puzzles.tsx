/** 题库与投稿审核：列表、详情、批准 / 退回 / 下架、署名审核（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §5）。 */
import { List, Datagrid, TextField, NumberField, Show, SimpleShowLayout, useRecordContext, useNotify, useRefresh, Button } from 'react-admin';
import { adminAction } from './data-provider.js';

export const PuzzleList = () => (
  <List sort={{ field: 'createdAt', order: 'DESC' }} perPage={25}>
    <Datagrid rowClick="show" bulkActionButtons={false}>
      <TextField source="title" label="标题" />
      <TextField source="language" label="语言" />
      <NumberField source="versionNo" label="版号" />
      <TextField source="status" label="状态" />
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
      <PuzzleActionsField />
    </SimpleShowLayout>
  </Show>
);

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
