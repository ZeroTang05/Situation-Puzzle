/**
 * 项目备份管理：对象存储状态、立即备份、备份文件列表、还原 / 下载 / 删除。
 *
 * 备份文件放在 S3 兼容对象存储里（环境变量接入），页面只操作元信息；
 * 还原是不可逆操作，必须输入 RESTORE 确认，并留下审计理由。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button as MuiButton,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useDialog } from '@jev/ui';
import { useNotify } from 'react-admin';
import { adminAction, adminGet } from './data-provider.js';
import { copy } from './copy.js';
import { useLanguage } from './language.js';

type StorageStatus = {
  configured: boolean;
  bucket: string | null;
  endpoint: string | null;
  region: string | null;
  prefix: string | null;
};

type BackupItem = {
  key: string;
  size: number;
  lastModified: string;
  createdAt: string;
};

type BackupListResponse = { storage: StorageStatus; items: BackupItem[] };

export function BackupList() {
  const { language } = useLanguage(); const c = copy(language);
  const notify = useNotify();
  const dialog = useDialog();
  const [data, setData] = useState<BackupListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = (await adminGet('/backups')) as BackupListResponse;
      setData(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const storage = data?.storage;
  const items = data?.items ?? [];

  /** 立即备份：先要一个理由（审计留痕），再打服务端。 */
  const createBackup = async () => {
    if (busy) return;
    const reason = await dialog.prompt(c.backupPromptReason);
    if (reason === null) return;
    setBusy(true);
    try {
      const result = (await adminAction('/backups', { reason })) as { key: string; size: number };
      notify(`${c.backupCreateDone}（${c.backupSizeText(result.size)}）`);
      await load();
    } catch (err) {
      notify((err as Error).message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const removeBackup = async (item: BackupItem) => {
    if (busy) return;
    if (!(await dialog.confirm(c.backupDeleteConfirm, c.backupDelete))) return;
    const reason = await dialog.prompt(c.backupPromptReason);
    if (reason === null) return;
    setBusy(true);
    try {
      await adminAction('/backups', { key: item.key, reason }, 'DELETE');
      notify(c.backupDeleteDone);
      await load();
    } catch (err) {
      notify((err as Error).message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** 下载：走同一个鉴权会话，用 blob 落地成文件。 */
  const downloadBackup = async (item: BackupItem) => {
    try {
      const response = await fetch(`/api/v1/admin/backups/download?key=${encodeURIComponent(item.key)}`, { credentials: 'include' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? c.backupDownloadFailed);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = item.key.split('/').pop() ?? 'backup.json.gz';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify((err as Error).message || c.backupDownloadFailed, { type: 'error' });
    }
  };

  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h5">{c.backupTitle}</Typography>

          {error && <Alert severity="error">{error}</Alert>}
          {storage && !storage.configured && <Alert severity="warning">{c.backupNotConfigured}</Alert>}

          {storage && storage.configured && (
            <Table size="small">
              <TableBody>
                <TableRow>
                  <TableCell sx={{ width: 160 }}>{c.backupBucket}</TableCell>
                  <TableCell>{storage.bucket ?? '—'}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>{c.backupEndpoint}</TableCell>
                  <TableCell>{storage.endpoint ?? '—'}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>{c.backupRegion}</TableCell>
                  <TableCell>{storage.region ?? '—'}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>{c.backupPrefix}</TableCell>
                  <TableCell>{storage.prefix ?? '—'}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}

          <Stack direction="row" spacing={1}>
            <MuiButton variant="contained" disabled={busy || !storage?.configured} onClick={() => void createBackup()}>
              {c.backupCreate}
            </MuiButton>
            <MuiButton disabled={busy} onClick={() => void load()}>{c.backupRefresh}</MuiButton>
          </Stack>

          <Typography variant="h6">{c.backupListTitle}</Typography>
          {items.length === 0 ? (
            <Typography color="text.secondary">{c.backupEmpty}</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{c.backupTimeCol}</TableCell>
                  <TableCell>{c.backupSizeCol}</TableCell>
                  <TableCell>{c.backupFileCol}</TableCell>
                  <TableCell align="right">{c.backupActionCol}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.key}>
                    <TableCell>{new Date(item.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{c.backupSizeText(item.size)}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{item.key}</TableCell>
                    <TableCell align="right">
                      <MuiButton size="small" color="warning" onClick={() => setRestoreTarget(item)}>{c.backupRestore}</MuiButton>
                      <MuiButton size="small" onClick={() => void downloadBackup(item)}>{c.backupDownload}</MuiButton>
                      <MuiButton size="small" color="error" disabled={busy} onClick={() => void removeBackup(item)}>{c.backupDelete}</MuiButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      </CardContent>

      <RestoreDialog
        item={restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onDone={async () => { setRestoreTarget(null); await load(); }}
      />
    </Card>
  );
}

/** 还原对话框：必须输入 RESTORE 才解锁按钮，再填理由才能提交。 */
function RestoreDialog({ item, onClose, onDone }: {
  item: BackupItem | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { language } = useLanguage(); const c = copy(language);
  const notify = useNotify();
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfirmText('');
    setReason('');
    setError(null);
  }, [item]);

  if (!item) return null;

  const unlocked = confirmText.trim().toUpperCase() === 'RESTORE';

  const submit = async () => {
    if (!unlocked || busy) return;
    if (reason.trim().length < 2) {
      setError(c.backupPromptReason);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminAction('/backups/restore', { key: item.key, confirm: 'RESTORE', reason: reason.trim() });
      notify(c.backupRestoreDone);
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{c.backupRestoreTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography>{c.backupRestoreWarning}</Typography>
          <Typography sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {new Date(item.createdAt).toLocaleString()} · {item.key}
          </Typography>
          <TextField
            label={c.backupRestoreConfirmLabel}
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            helperText={c.backupRestoreConfirmHint}
            inputProps={{ 'aria-label': c.backupRestoreConfirmLabel }}
          />
          <TextField
            label={c.backupRestoreReasonLabel}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            helperText={c.backupPromptReason}
            inputProps={{ 'aria-label': c.backupRestoreReasonLabel }}
          />
          {error && <Typography color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <MuiButton onClick={onClose} disabled={busy}>{c.cancel}</MuiButton>
        <MuiButton variant="contained" color="warning" disabled={!unlocked || busy} onClick={() => void submit()}>
          {c.backupRestore}
        </MuiButton>
      </DialogActions>
    </Dialog>
  );
}
