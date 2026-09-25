/** 用户、房间、举报、订单列表与处置动作；总览页。 */
import { List, Datagrid, TextField, useRecordContext, useNotify, useRefresh, Button } from 'react-admin';
import { useEffect, useState } from 'react';
import { Card, CardContent, Typography } from '@mui/material';
import { adminAction } from './data-provider.js';

// ---------- 用户 ----------

export const UserList = () => (
  <List perPage={25}>
    <Datagrid bulkActionButtons={false}>
      <TextField source="nickname" label="昵称" />
      <TextField source="email" label="邮箱" />
      <TextField source="status" label="状态" />
      <UserActionsField />
    </Datagrid>
  </List>
);

function UserActionsField() {
  const record = useRecordContext() as { userId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  if (!record) return null;
  const act = (path: string, body: Record<string, unknown>) =>
    void adminAction(path, body)
      .then(() => {
        notify('已完成');
        refresh();
      })
      .catch((error: Error) => notify(error.message, { type: 'error' }));
  return (
    <>
      {record.status === 'active' ? (
        <Button label="停用" onClick={() => act(`/users/${record.userId}/suspend`, { reason: window.prompt('停用理由') ?? '' })} />
      ) : (
        <Button label="恢复" onClick={() => act(`/users/${record.userId}/unsuspend`, { reason: window.prompt('恢复理由') ?? '' })} />
      )}
      <Button
        label="测试赞助"
        onClick={() => {
          const months = Number(window.prompt('发放几个月的测试赞助？') ?? '0');
          if (months > 0) act(`/users/${record.userId}/test-grant`, { months, reason: '测试赞助授权' });
        }}
      />
    </>
  );
}

export const TestGrantButton = () => null;

// ---------- 房间 ----------

export const RoomList = () => (
  <List perPage={25}>
    <Datagrid bulkActionButtons={false}>
      <TextField source="roomId" label="房间" />
      <TextField source="status" label="状态" />
      <TextField source="memberCount" label="成员" />
      <TextField source="closeReason" label="关闭原因" />
      <RoomActionsField />
    </Datagrid>
  </List>
);

function RoomActionsField() {
  const record = useRecordContext() as { roomId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  if (!record || record.status === 'closed') return null;
  return (
    <Button
      label="强制关闭"
      onClick={() =>
        void adminAction(`/rooms/${record.roomId}/force-close`, { reason: window.prompt('强制关闭理由') ?? '' })
          .then(() => {
            notify('已关闭');
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }))
      }
    />
  );
}

export const ForceCloseButton = () => null;

// ---------- 举报 ----------

export const ReportList = () => (
  <List perPage={25}>
    <Datagrid bulkActionButtons={false}>
      <TextField source="objectType" label="对象" />
      <TextField source="reason" label="原因" />
      <TextField source="status" label="状态" />
      <TextField source="detail" label="详情" />
      <ResolveField />
    </Datagrid>
  </List>
);

function ResolveField() {
  const record = useRecordContext() as { id?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  if (!record || record.status === 'resolved') return null;
  return (
    <Button
      label="标记处理"
      onClick={() =>
        void adminAction(`/reports/${record.id}/resolve`, { reason: window.prompt('处理结论') ?? '' })
          .then(() => {
            notify('已处理');
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }))
      }
    />
  );
}

export const ResolveButton = () => null;

// ---------- 订单 ----------

export const OrderList = () => (
  <List perPage={25}>
    <Datagrid bulkActionButtons={false}>
      <TextField source="orderId" label="订单" />
      <TextField source="status" label="状态" />
      <TextField source="amountMinor" label="金额（分）" />
      <TextField source="channel" label="渠道" />
      <RefundField />
    </Datagrid>
  </List>
);

function RefundField() {
  const record = useRecordContext() as { orderId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  if (!record || record.status !== 'paid') return null;
  return (
    <Button
      label="审核退款"
      onClick={() =>
        void adminAction(`/orders/${record.orderId}/refund`, { reason: window.prompt('退款理由') ?? '' })
          .then(() => {
            notify('已登记退款并冻结授权');
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }))
      }
    />
  );
}

export const RefundButton = () => null;

// ---------- 总览 ----------

export function Dashboard() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void fetch('/api/v1/admin/overview', { credentials: 'include' })
      .then((r) => r.json())
      .then((payload) => setData(payload.data ?? null));
  }, []);
  return (
    <Card>
      <CardContent>
        <Typography variant="h5">运营总览</Typography>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(data, null, 2)}</pre>
      </CardContent>
    </Card>
  );
}
