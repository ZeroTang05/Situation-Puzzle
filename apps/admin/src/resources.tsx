/** 用户、房间、举报、订单列表与处置动作；总览页。 */
import { List, Datagrid, TextField, useRecordContext, useNotify, useRefresh, Button } from 'react-admin';
import { useEffect, useState } from 'react';
import { Card, CardContent, Typography } from '@mui/material';
import { adminAction } from './data-provider.js';
import { copy } from './copy.js';
import { useLanguage } from './language.js';

// ---------- 用户 ----------

export function UserList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List perPage={25}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="nickname" label={c.nicknameCol} />
        <TextField source="email" label={c.emailCol} />
        <TextField source="status" label={c.statusCol} />
        <UserActionsField />
      </Datagrid>
    </List>
  );
}

function UserActionsField() {
  const record = useRecordContext() as { userId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  const act = (path: string, body: Record<string, unknown>) =>
    void adminAction(path, body)
      .then(() => {
        notify(c.done);
        refresh();
      })
      .catch((error: Error) => notify(error.message, { type: 'error' }));
  return (
    <>
      {record.status === 'active' ? (
        <Button label={c.suspend} onClick={() => act(`/users/${record.userId}/suspend`, { reason: window.prompt(c.promptReasonSuspend) ?? '' })} />
      ) : (
        <Button label={c.unsuspend} onClick={() => act(`/users/${record.userId}/unsuspend`, { reason: window.prompt(c.promptReasonUnsuspend) ?? '' })} />
      )}
      <Button
        label={c.testSponsor}
        onClick={() => {
          const months = Number(window.prompt(c.promptTestSponsor) ?? '0');
          if (months > 0) act(`/users/${record.userId}/test-grant`, { months, reason: c.testSponsor });
        }}
      />
    </>
  );
}

export const TestGrantButton = () => null;

// ---------- 房间 ----------

export function RoomList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List perPage={25}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="roomId" label={c.roomIdCol} />
        <TextField source="status" label={c.statusCol} />
        <TextField source="memberCount" label={c.memberCol} />
        <TextField source="closeReason" label={c.closeReasonCol} />
        <RoomActionsField />
      </Datagrid>
    </List>
  );
}

function RoomActionsField() {
  const record = useRecordContext() as { roomId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record || record.status === 'closed') return null;
  return (
    <Button
      label={c.forceClose}
      onClick={() =>
        void adminAction(`/rooms/${record.roomId}/force-close`, { reason: window.prompt(c.promptForceClose) ?? '' })
          .then(() => {
            notify(c.forceCloseDone);
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }))
      }
    />
  );
}

export const ForceCloseButton = () => null;

// ---------- 举报 ----------

export function ReportList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List perPage={25}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="objectType" label={c.objectCol} />
        <TextField source="reason" label={c.reasonCol} />
        <TextField source="status" label={c.statusCol} />
        <TextField source="detail" label={c.detailCol} />
        <ResolveField />
      </Datagrid>
    </List>
  );
}

function ResolveField() {
  const record = useRecordContext() as { id?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record || record.status === 'resolved') return null;
  return (
    <Button
      label={c.markResolved}
      onClick={() =>
        void adminAction(`/reports/${record.id}/resolve`, { reason: window.prompt(c.promptResolve) ?? '' })
          .then(() => {
            notify(c.resolveDone);
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }))
      }
    />
  );
}

export const ResolveButton = () => null;

// ---------- 订单 ----------

export function OrderList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List perPage={25}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="orderId" label={c.orderIdCol} />
        <TextField source="status" label={c.statusCol} />
        <TextField source="amountMinor" label={c.amountCol} />
        <TextField source="channel" label={c.channelCol} />
        <RefundField />
      </Datagrid>
    </List>
  );
}

function RefundField() {
  const record = useRecordContext() as { orderId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record || record.status !== 'paid') return null;
  return (
    <Button
      label={c.reviewRefund}
      onClick={() =>
        void adminAction(`/orders/${record.orderId}/refund`, { reason: window.prompt(c.promptRefund) ?? '' })
          .then(() => {
            notify(c.refundDone);
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
  const { language } = useLanguage(); const c = copy(language);
  useEffect(() => {
    void fetch('/api/v1/admin/overview', { credentials: 'include' })
      .then((r) => r.json())
      .then((payload) => setData(payload.data ?? null));
  }, []);
  return (
    <Card>
      <CardContent>
        <Typography variant="h5">{c.dashboardTitle}</Typography>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(data, null, 2)}</pre>
      </CardContent>
    </Card>
  );
}

// ---------- 顶部语言切换 ----------

export function LangSwitch() {
  const { language, setLanguage } = useLanguage(); const c = copy(language);
  return (
    <button
      style={{ position: 'fixed', bottom: 16, right: 16, padding: '6px 12px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', zIndex: 1000 }}
      onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
    >
      {c.switchTo}
    </button>
  );
}