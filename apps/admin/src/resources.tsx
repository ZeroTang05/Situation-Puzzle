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
    <List perPage={50} sort={{ field: 'createdAt', order: 'DESC' }}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="nickname" label={c.nicknameCol} />
        <TextField source="email" label={c.emailCol} />
        <BooleanField source="emailVerified" label={c.emailVerifiedCol} />
        <TextField source="status" label={c.statusCol} />
        <SponsorUntilField label={c.sponsorUntilCol} sortBy="sponsorUntil" />
        <DateField source="createdAt" label={c.createdAtCol} showTime />
        <UserActionsField />
      </Datagrid>
    </List>
  );
}

/** 生效会员到期展示：lifetime=永久会员，日期文本原样，空为无生效会员。 */
function SponsorUntilField({ label }: { label: string; sortBy?: string }) {
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
    <List perPage={50} sort={{ field: 'createdAt', order: 'DESC' }}>
      <Datagrid bulkActionButtons={false}>
        <TextField source="roomId" label={c.roomIdCol} />
        <TextField source="puzzleTitle" label={c.puzzleTitleCol} sortable={false} />
        <HostField label={c.hostCol} sortBy="hostNickname" />
        <HostModeField sortBy="hostMode" />
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

/** 房主：优先昵称，缺昵称退回截断 ID；悬停显示完整用户 ID。 */
function HostField({ label }: { label: string; sortBy?: string }) {
  const record = useRecordContext() as { hostNickname?: string | null; hostUserId?: string } | undefined;
  const name = record?.hostNickname || null;
  const id = record?.hostUserId ?? '';
  return <span aria-label={label} title={id}>{name || (id ? `${id.slice(0, 8)}…` : '—')}</span>;
}

/**
 * 主持人形态（17-USER-HOST-MODE）：AI 主持（Jev）或用户主持（玩家接管判题）。
 * 用户主持时显示主持人昵称——调查时能直接看到「谁在主持这局」。
 */
function HostModeField({ sortBy }: { sortBy?: string }) {
  const { language } = useLanguage(); const c = copy(language);
  const record = useRecordContext() as { hostMode?: string; userHostNickname?: string | null; userHostId?: string | null } | undefined;
  const userHost = record?.hostMode === 'user';
  const nickname = record?.userHostNickname || null;
  const id = record?.userHostId ?? '';
  if (!userHost) return <span>{c.aiHostLabel}</span>;
  return (
    <span aria-label={c.userHostLabel} title={id}>
      {c.userHostLabel}
      {nickname ? `：${nickname}` : id ? `：${id.slice(0, 8)}…` : ''}
    </span>
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
    <List perPage={50} sort={{ field: 'createdAt', order: 'DESC' }}>
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
    <List perPage={50} sort={{ field: 'createdAt', order: 'DESC' }}>
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
          .then((result) => {
            // 三种终态不同，别用一句「已登记退款」糊弄：
            // 线上通道退款成功 → 权益已撤销；线下通道无线上退款步骤 → 站内直接撤销；
            // 通道退款失败 → 权益保持冻结，必须人工跟进。
            const outcome = (result as { channelRefund?: string } | null)?.channelRefund;
            if (outcome === 'failed') notify(c.refundFailed, { type: 'warning' });
            else if (outcome === 'not_applicable') notify(c.refundOffline);
            else notify(c.refundDone);
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