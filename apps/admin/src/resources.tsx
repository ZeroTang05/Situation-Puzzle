/** 用户、房间、举报、订单列表与处置动作；总览页。 */
import { useDialog } from '@jev/ui';
import { List, Datagrid, TextField, DateField, BooleanField, useRecordContext, useNotify, useRefresh, Button } from 'react-admin';
import { useEffect, useState } from 'react';
import { Card, CardContent, Typography } from '@mui/material';
import { adminAction } from './data-provider.js';
import { copy } from './copy.js';
import { useLanguage } from './language.js';

// ---------- 用户 ----------

export function UserList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List perPage={50}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="nickname" label={c.nicknameCol} />
        <TextField source="email" label={c.emailCol} />
        <BooleanField source="emailVerified" label={c.emailVerifiedCol} />
        <TextField source="status" label={c.statusCol} />
        <SponsorUntilField label={c.sponsorUntilCol} />
        <DateField source="createdAt" label={c.createdAtCol} showTime />
        <UserActionsField />
      </Datagrid>
    </List>
  );
}

/** 生效赞助到期展示：lifetime=永久赞助，日期文本原样，空为无生效赞助。 */
function SponsorUntilField({ label }: { label: string }) {
  const record = useRecordContext() as { sponsorUntil?: string | null } | undefined;
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  return <span aria-label={label}>{record.sponsorUntil === 'lifetime' ? c.sponsorLifetime : record.sponsorUntil ?? '—'}</span>;
}

function UserActionsField() {
  const dialog = useDialog();
  const record = useRecordContext() as { userId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  const act = async (path: string, message: string) => {
    const reason = await dialog.prompt(message);
    if (reason === null) return;
    await adminAction(path, { reason })
      .then(() => {
        notify(c.done);
        refresh();
      })
      .catch((error: Error) => notify(error.message, { type: 'error' }));
  };
  return (
    <>
      {record.status === 'active' ? (
        <Button label={c.suspend} onClick={() => act(`/users/${record.userId}/suspend`, c.promptReasonSuspend)} />
      ) : (
        <Button label={c.unsuspend} onClick={() => act(`/users/${record.userId}/unsuspend`, c.promptReasonUnsuspend)} />
      )}
      <Button
        label={c.testSponsor}
        onClick={async () => {
          const value = await dialog.prompt(c.promptTestSponsor);
          if (value === null) return;
          const months = Number(value);
          if (months > 0) void adminAction(`/users/${record.userId}/test-grant`, { months, reason: c.testSponsor })
            .then(() => { notify(c.done); refresh(); })
            .catch((error: Error) => notify(error.message, { type: 'error' }));
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
    <List perPage={50}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="roomId" label={c.roomIdCol} />
        <TextField source="puzzleTitle" label={c.puzzleTitleCol} />
        <TextField source="status" label={c.statusCol} />
        <TextField source="memberCount" label={c.memberCol} />
        <TextField source="capacity" label={c.capacityCol} />
        <DateField source="createdAt" label={c.createdAtCol} showTime />
        <DateField source="closedAt" label={c.closedAtCol} showTime />
        <TextField source="closeReason" label={c.closeReasonCol} />
        <RoomActionsField />
      </Datagrid>
    </List>
  );
}

function RoomActionsField() {
  const dialog = useDialog();
  const record = useRecordContext() as { roomId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record || record.status === 'closed') return null;
  return (
    <Button
      label={c.forceClose}
      onClick={async () => {
        const reason = await dialog.prompt(c.promptForceClose);
        if (reason === null) return;
        await adminAction(`/rooms/${record.roomId}/force-close`, { reason })
          .then(() => {
            notify(c.forceCloseDone);
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }));
      }}
    />
  );
}

export const ForceCloseButton = () => null;

// ---------- 举报 ----------

export function ReportList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List perPage={50}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="objectType" label={c.objectCol} />
        <TruncatedIdField source="objectId" label={c.objectIdCol} />
        <TruncatedIdField source="reporterUserId" label={c.reporterCol} />
        <TextField source="reason" label={c.reasonCol} />
        <TextField source="status" label={c.statusCol} />
        <TextField source="detail" label={c.detailCol} />
        <DateField source="createdAt" label={c.createdAtCol} showTime />
        <ResolveField />
      </Datagrid>
    </List>
  );
}

/** 长 UUID 截断展示，悬停可看完整值。 */
function TruncatedIdField({ source, label }: { source: string; label: string }) {
  const record = useRecordContext() as Record<string, unknown> | undefined;
  const value = record?.[source];
  return <span aria-label={label} title={typeof value === 'string' ? value : undefined}>{typeof value === 'string' && value ? `${value.slice(0, 8)}…` : '—'}</span>;
}

function ResolveField() {
  const dialog = useDialog();
  const record = useRecordContext() as { id?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record || record.status === 'resolved') return null;
  return (
    <Button
      label={c.markResolved}
      onClick={async () => {
        const reason = await dialog.prompt(c.promptResolve);
        if (reason === null) return;
        await adminAction(`/reports/${record.id}/resolve`, { reason })
          .then(() => {
            notify(c.resolveDone);
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }));
      }}
    />
  );
}

export const ResolveButton = () => null;

// ---------- 订单 ----------

export function OrderList() {
  const { language } = useLanguage(); const c = copy(language);
  return (
    <List perPage={50}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="orderId" label={c.orderIdCol} />
        <TruncatedIdField source="userId" label={c.userCol} />
        <TextField source="status" label={c.statusCol} />
        <TextField source="amountMinor" label={c.amountCol} />
        <TextField source="channel" label={c.channelCol} />
        <DateField source="createdAt" label={c.createdAtCol} showTime />
        <DateField source="paidAt" label={c.paidAtCol} showTime />
        <RefundField />
      </Datagrid>
    </List>
  );
}

function RefundField() {
  const dialog = useDialog();
  const record = useRecordContext() as { orderId?: string; status?: string } | undefined;
  const notify = useNotify();
  const refresh = useRefresh();
  const { language } = useLanguage(); const c = copy(language);
  if (!record || record.status !== 'paid') return null;
  return (
    <Button
      label={c.reviewRefund}
      onClick={async () => {
        const reason = await dialog.prompt(c.promptRefund);
        if (reason === null) return;
        await adminAction(`/orders/${record.orderId}/refund`, { reason })
          .then(() => {
            notify(c.refundDone);
            refresh();
          })
          .catch((error: Error) => notify(error.message, { type: 'error' }));
      }}
    />
  );
}

export const RefundButton = () => null;

// ---------- 总览 ----------

type OverviewData = {
  activeRooms?: number;
  activeRounds?: number;
  paidOrders?: number;
  paidAmountMinor?: number;
  jev?: { calls?: number; failures?: number; avgMs?: number };
};

/** 运营总览：关键指标卡片墙，数据来自 /admin/overview。 */
export function Dashboard() {
  const [data, setData] = useState<OverviewData | null>(null);
  const { language } = useLanguage(); const c = copy(language);
  useEffect(() => {
    void fetch('/api/v1/admin/overview', { credentials: 'include' })
      .then((r) => r.json())
      .then((payload) => setData(payload.data ?? null));
  }, []);
  const stats = [
    { label: c.activeRoomsStat, value: data?.activeRooms },
    { label: c.activeRoundsStat, value: data?.activeRounds },
    { label: c.paidOrdersStat, value: data?.paidOrders },
    { label: c.paidAmountStat, value: data?.paidAmountMinor != null ? (data.paidAmountMinor / 100).toFixed(2) : undefined },
    { label: c.jevCallsStat, value: data?.jev?.calls },
    { label: c.jevFailuresStat, value: data?.jev?.failures },
    { label: c.jevAvgMsStat, value: data?.jev?.avgMs },
  ];
  return (
    <Card>
      <CardContent>
        <Typography variant="h5">{c.dashboardTitle}</Typography>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginTop: 16 }}>
          {stats.map((stat) => (
            <div key={stat.label} style={{ border: '1px solid rgba(0, 0, 0, 0.12)', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: 26 }}>{stat.value ?? '—'}</div>
              <div style={{ color: 'rgba(0, 0, 0, 0.6)' }}>{stat.label}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- 顶栏语言切换（嵌在 AppBar 右侧） ----------

export function LangSwitch() {
  const { language, setLanguage } = useLanguage(); const c = copy(language);
  return (
    <button
      style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.45)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 14 }}
      onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
    >
      {c.switchTo}
    </button>
  );
}