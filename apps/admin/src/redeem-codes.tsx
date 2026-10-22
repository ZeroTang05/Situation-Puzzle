/** 赞助码管理：批量发码、批次对账（码数 / 会员时长）、码明细与作废。 */
import { useDialog } from '@jev/ui';
import { List, Datagrid, TextField, NumberField, DateField, useNotify, useRefresh, useRecordContext, Button } from 'react-admin';
import { useEffect, useState } from 'react';
import {
  Button as MuiButton,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField as MuiTextField,
  Typography,
} from '@mui/material';
import { adminAction, adminGet } from './data-provider.js';
import { copy } from './copy.js';
import { useLanguage } from './language.js';

type RedeemType = 'monthly' | 'lifetime';

type BatchRow = {
  batchId: string;
  type: RedeemType;
  title: string;
  priceMinor: number;
  currency: string;
  note: string | null;
  createdAt: string;
  totalCount: number;
  unusedCount: number;
  usedCount: number;
  revokedCount: number;
};

type CodeRow = {
  code: string;
  status: 'unused' | 'used' | 'revoked';
  note: string | null;
  usedBy: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  type: RedeemType;
  title: string;
  priceMinor: number;
};

type IssuedBatch = {
  batchId: string;
  type: RedeemType;
  title: string;
  priceMinor: number;
  currency: string;
  count: number;
  codes: string[];
};

export function RedeemCodeList() {
  const { language } = useLanguage(); const c = copy(language);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedBatch | null>(null);
  const [detailBatch, setDetailBatch] = useState<string | null>(null);
  return (
    <>
      <List
        perPage={50}
        sort={{ field: 'createdAt', order: 'DESC' }}
        // empty={false}：react-admin 默认在空列表时整页只渲染空状态（工具栏连同「新增兑换码」按钮一起消失），
        // 兑换码一开始就是空的，按钮必须一直够得着。
        empty={false}
        actions={<Button label={c.createRedeemCode} onClick={() => setCreating(true)} />}
      >
        <Datagrid bulkActionButtons={false}>
          <TextField source="batchId" label={c.batchCol} />
          <DurationField label={c.durationCol} />
          <TextField source="priceMinor" label={c.amountCol} />
          <NumberField source="totalCount" label={c.codeCountCol} />
          <NumberField source="unusedCount" label={c.unusedCol} />
          <NumberField source="usedCount" label={c.usedCol} />
          <NumberField source="revokedCount" label={c.revokedCol} />
          <TextField source="note" label={c.noteCol} />
          <DateField source="createdAt" label={c.createdAtCol} showTime />
          <BatchActionsField onOpen={setDetailBatch} />
        </Datagrid>
      </List>
      <CreateRedeemCodeDialog open={creating} onClose={() => setCreating(false)} onIssued={setIssued} />
      <IssuedCodesDialog issued={issued} onClose={() => setIssued(null)} />
      <BatchCodesDialog batchId={detailBatch} onClose={() => setDetailBatch(null)} />
    </>
  );
}

/** 会员时长：monthly = 1 个自然月，lifetime = 永久（与发码时的商品类型一致）。 */
function DurationField({ label }: { label: string; sortBy?: string }) {
  const record = useRecordContext() as BatchRow | undefined;
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  return <span aria-label={label}>{record.type === 'lifetime' ? c.durationLifetime : c.durationMonthly}</span>;
}

/** 批次操作：查看该批次的码明细。 */
function BatchActionsField({ onOpen }: { onOpen: (batchId: string) => void }) {
  const record = useRecordContext() as BatchRow | undefined;
  const { language } = useLanguage(); const c = copy(language);
  if (!record) return null;
  return <Button label={c.viewCodes} onClick={() => onOpen(record.batchId)} />;
}

// ---------- 新增兑换码 ----------

function CreateRedeemCodeDialog({ open, onClose, onIssued }: {
  open: boolean;
  onClose: () => void;
  onIssued: (issued: IssuedBatch) => void;
}) {
  const { language } = useLanguage(); const c = copy(language);
  const notify = useNotify();
  const refresh = useRefresh();
  const [type, setType] = useState<RedeemType>('monthly');
  const [count, setCount] = useState('10');
  const [note, setNote] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const amount = Number(count);
    if (!Number.isInteger(amount) || amount < 1 || amount > 500) {
      setError(c.countRangeHint);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { type, count: amount };
      if (note.trim()) body.note = note.trim();
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      const result = (await adminAction('/redeem-codes/generate', body)) as IssuedBatch;
      notify(c.generateDone);
      onIssued(result);
      onClose();
      // 新批次要立刻出现在列表里，否则运营会以为没发出去
      refresh();
      setCount('10');
      setNote('');
      setExpiresAt('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{c.createRedeemCode}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <MuiTextField select label={c.durationLabel} value={type} onChange={(event) => setType(event.target.value as RedeemType)}>
            <MenuItem value="monthly">{c.durationMonthly}</MenuItem>
            <MenuItem value="lifetime">{c.durationLifetime}</MenuItem>
          </MuiTextField>
          <MuiTextField
            label={c.countLabel}
            type="number"
            value={count}
            onChange={(event) => setCount(event.target.value)}
            inputProps={{ min: 1, max: 500 }}
            helperText={c.countRangeHint}
          />
          <MuiTextField label={c.noteCol} value={note} onChange={(event) => setNote(event.target.value)} />
          <MuiTextField
            label={c.expiresAtLabel}
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            helperText={c.expiresAtHint}
            InputLabelProps={{ shrink: true }}
          />
          {error && <Typography color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <MuiButton onClick={onClose}>{c.cancel}</MuiButton>
        <MuiButton variant="contained" disabled={busy} onClick={() => void submit()}>{c.generate}</MuiButton>
      </DialogActions>
    </Dialog>
  );
}

/** 发码结果：明文只在这一刻出现一次，运营方要立刻复制走。 */
function IssuedCodesDialog({ issued, onClose }: { issued: IssuedBatch | null; onClose: () => void }) {
  const { language } = useLanguage(); const c = copy(language);
  const notify = useNotify();
  if (!issued) return null;
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(issued.codes.join('\n'));
      notify(c.copied);
    } catch {
      notify(c.copyFailed, { type: 'warning' });
    }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{c.generatedCodes}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography>{c.generatedSummary(issued.count, issued.batchId)}</Typography>
          <Typography color="warning">{c.codesOnlyOnce}</Typography>
          <MuiTextField
            multiline
            minRows={6}
            maxRows={16}
            fullWidth
            value={issued.codes.join('\n')}
            inputProps={{ readOnly: true, style: { fontFamily: 'monospace' } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <MuiButton onClick={() => void copyAll()}>{c.copyAll}</MuiButton>
        <MuiButton variant="contained" onClick={onClose}>{c.close}</MuiButton>
      </DialogActions>
    </Dialog>
  );
}

// ---------- 批次码明细 ----------

function BatchCodesDialog({ batchId, onClose }: { batchId: string | null; onClose: () => void }) {
  const { language } = useLanguage(); const c = copy(language);
  const dialog = useDialog();
  const notify = useNotify();
  const refresh = useRefresh();
  const [codes, setCodes] = useState<CodeRow[] | null>(null);

  useEffect(() => {
    if (!batchId) {
      setCodes(null);
      return;
    }
    void adminGet(`/redeem-codes?batchId=${encodeURIComponent(batchId)}`)
      .then((data) => setCodes((data as { items: CodeRow[] }).items ?? []))
      .catch((error: Error) => {
        notify(error.message, { type: 'error' });
        setCodes([]);
      });
  }, [batchId, notify]);

  if (!batchId) return null;

  const revoke = async (code: string) => {
    const reason = await dialog.prompt(c.promptReasonRevoke);
    if (reason === null) return;
    try {
      await adminAction('/redeem-codes/revoke', { code, reason });
      notify(c.revokeDone);
      const data = await adminGet(`/redeem-codes?batchId=${encodeURIComponent(batchId)}`);
      setCodes((data as { items: CodeRow[] }).items ?? []);
      refresh();
    } catch (error) {
      notify((error as Error).message, { type: 'error' });
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{c.batchCodesTitle(batchId)}</DialogTitle>
      <DialogContent>
        {codes === null ? (
          <Typography>{c.loading}</Typography>
        ) : codes.length === 0 ? (
          <Typography>{c.noCodes}</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{c.codeCol}</TableCell>
                <TableCell>{c.statusCol}</TableCell>
                <TableCell>{c.durationCol}</TableCell>
                <TableCell>{c.usedByCol}</TableCell>
                <TableCell>{c.expiresCol}</TableCell>
                <TableCell align="right">{c.actionCol}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {codes.map((row) => (
                <TableRow key={row.code}>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{row.code}</TableCell>
                  <TableCell>{statusLabel(row.status, language)}</TableCell>
                  <TableCell>{row.type === 'lifetime' ? c.durationLifetime : c.durationMonthly}</TableCell>
                  <TableCell>{row.usedBy ? row.usedBy.slice(0, 8) : '—'}</TableCell>
                  <TableCell>{row.expiresAt ? new Date(row.expiresAt).toLocaleString() : '—'}</TableCell>
                  <TableCell align="right">
                    {row.status === 'unused' && (
                      <MuiButton size="small" onClick={() => void revoke(row.code)}>{c.revokeCode}</MuiButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions>
        <MuiButton variant="contained" onClick={onClose}>{c.close}</MuiButton>
      </DialogActions>
    </Dialog>
  );
}

/** 码状态本地化。 */
function statusLabel(status: CodeRow['status'], language: 'zh' | 'en'): string {
  if (status === 'used') return language === 'zh' ? '已使用' : 'Used';
  if (status === 'revoked') return language === 'zh' ? '已作废' : 'Revoked';
  return language === 'zh' ? '未使用' : 'Unused';
}
