/** 题库与投稿审核：列表、详情、批准 / 退回 / 下架。 */
import { List, Datagrid, TextField, Show, SimpleShowLayout, useRecordContext, useNotify, useRefresh, Button } from 'react-admin';
import { adminAction } from './data-provider.js';

export const PuzzleList = () => (
  <List sort={{ field: 'createdAt', order: 'DESC' }} perPage={25}>
    <Datagrid rowClick="show" bulkActionButtons={false}>
      <TextField source="title" label="标题" />
      <TextField source="language" label="语言" />
      <TextField source="status" label="状态" />
      <TextField source="rightsStatus" label="授权" />
      <PuzzleActionsField />
    </Datagrid>
  </List>
);

function PuzzleActionsField() {
  const record = useRecordContext() as { versionId?: string; puzzleId?: string; status?: string } | undefined;
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
          <Button label="批准" onClick={() => act(`/puzzle-versions/${record.versionId}/approve`)} />
          <Button label="退回" onClick={() => act(`/puzzle-versions/${record.versionId}/reject`)} />
        </>
      )}
      {record.status === 'published' && <Button label="下架" onClick={() => act(`/puzzles/${record.puzzleId}/takedown`)} />}
    </>
  );
}

export const VersionDetail = () => (
  <Show>
    <SimpleShowLayout>
      <TextField source="title" label="标题" />
      <TextField source="surface" label="汤面" />
      <TextField source="answer" label="汤底" />
      <TextField source="status" label="状态" />
    </SimpleShowLayout>
  </Show>
);
