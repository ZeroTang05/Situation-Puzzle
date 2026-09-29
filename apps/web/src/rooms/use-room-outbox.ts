/** 可靠发送：本地固定请求编号，持久化证明到达后确认，未知结果先查再重投。 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { loadRoomLocal, saveRoomLocal, type RoomLocal, type PendingCommand } from './room-local.js';
import type { CommandInput, CommandResult, RoomState, SyncStatus } from './use-room-sync.js';

export function useRoomOutbox(userId: string | null, roomId: string, state: RoomState | null, status: SyncStatus, sendCommand: (input: CommandInput) => Promise<CommandResult>) {
  const [local, setLocal] = useState<RoomLocal | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const ref = useRef<RoomLocal | null>(null);
  const persistence = useRef(Promise.resolve());
  const working = useRef(new Set<string>());
  const epoch = useRef(0);

  /** 所有草稿与发件状态按序持久化，输入的新文字不会被旧请求覆盖。 */
  const update = (change: (current: RoomLocal) => RoomLocal): Promise<void> => {
    if (!ref.current) return Promise.reject(new Error('本地记录尚未加载'));
    const next = change(ref.current);
    ref.current = next;
    setLocal(next);
    const revision = epoch.current;
    const saving = persistence.current.then(() => saveRoomLocal(next));
    persistence.current = saving.catch(() => undefined);
    return saving.then(() => { if (revision === epoch.current) setStorageError(null); }, (error: unknown) => {
      if (revision === epoch.current) setStorageError('本地记录未保存，请复制草稿后重试');
      throw error;
    });
  };

  useEffect(() => {
    const revision = ++epoch.current;
    ref.current = null;
    setLocal(null);
    working.current.clear();
    if (userId) void loadRoomLocal(userId, roomId).then((saved) => {
      if (revision !== epoch.current) return;
      ref.current = saved;
      setLocal(saved);
    }).catch(() => { if (revision === epoch.current) setStorageError('无法读取本地草稿，请检查浏览器存储权限'); });
    return () => { epoch.current++; };
  }, [userId, roomId]);

  const patch = (id: string, values: Partial<PendingCommand>) => update((current) => ({
    ...current, pending: current.pending.map((p) => p.input.clientRequestId === id ? { ...p, ...values } : p),
  }));
  const confirm = (item: PendingCommand, result: CommandResult) => update((current) => {
    const mode = item.input.type;
    const text = item.input.payload?.text;
    const drafts = { ...current.drafts };
    if ((mode === 'ask' || mode === 'solve' || mode === 'discussion') && drafts[mode].trim() === text) drafts[mode] = '';
    return { ...current, drafts, pending: current.pending.map((p) => p.input.clientRequestId === item.input.clientRequestId ? { ...p, status: 'sent', result } : p) };
  });

  const execute = async (item: PendingCommand, recovering: boolean): Promise<CommandResult | undefined> => {
    const id = item.input.clientRequestId;
    if (working.current.has(id) || status !== 'ready') return;
    working.current.add(id);
    const revision = epoch.current;
    const current = () => epoch.current === revision;
    try {
      let result: CommandResult | undefined;
      if (recovering) {
        const found = await api<{ status: 'accepted'; result: CommandResult } | { status: 'not_found' }>(`/rooms/${roomId}/commands/${id}`, { timeoutMs: 10_000 });
        if (!current()) return;
        if (found.status === 'accepted') result = found.result;
        else {
          if (state?.roomStatus === 'closed') { await patch(id, { status: 'rejected', error: '房间已结束，该请求未被受理' }); return; }
          const isMessage = ['ask', 'solve', 'discussion'].includes(item.input.type);
          if (!isMessage || item.retries >= 1) { await patch(id, { status: 'confirming', error: '尚未确认，请稍后继续确认' }); return; }
          await patch(id, { retries: item.retries + 1 });
        }
      }
      if (!current()) return;
      result ??= await sendCommand(item.input);
      if (!current()) return;
      await confirm(item, result);
      return result;
    } catch (error) {
      if (!current()) return;
      // 超时、断网和服务器错误无法证明事务未提交，必须保留原请求编号。
      const rejected = error instanceof ApiError && !!error.status && error.status >= 400 && error.status < 500;
      // 已收到持久事件的卡片不会被迟到的网络错误降回失败。
      if (ref.current?.pending.find((p) => p.input.clientRequestId === id)?.status !== 'sent') {
        await patch(id, { status: rejected ? 'rejected' : 'confirming', error: rejected && error instanceof Error ? error.message : '正在确认发送结果' });
      }
      return undefined;
    } finally { if (current()) working.current.delete(id); }
  };

  // 服务端推送是另一条持久化证明，先到时也能立即合并本人消息。
  useEffect(() => {
    if (!local || !state) return;
    const candidates = local.pending.filter((p) => p.status !== 'sent');
    for (const item of candidates) {
      const turn = state.turns.find((t) => t.clientRequestId === item.input.clientRequestId);
      const discussion = state.discussions.find((d) => d.clientRequestId === item.input.clientRequestId);
      if (turn || discussion) void confirm(item, {
        clientRequestId: item.input.clientRequestId, status: 'accepted', controlVersion: state.controlVersion,
        ...(turn ? { turnId: turn.turnId, acceptedSeq: turn.seq } : {}),
        ...(discussion ? { discussionId: discussion.eventId, acceptedSeq: discussion.seq } : {}),
      }).catch(() => undefined);
    }
  }, [state, local]);

  // 每次完成重连或刷新后确认一次；不随每个状态更新无限重发。
  const recoveryCycle = useRef(false);
  useEffect(() => {
    if (status !== 'ready') { recoveryCycle.current = false; return; }
    if (!local || recoveryCycle.current) return;
    recoveryCycle.current = true;
    for (const item of local.pending) if (item.status === 'sending' || item.status === 'confirming') void execute(item, true).catch(() => undefined);
  }, [status, local]);

  const submit = async (input: Omit<CommandInput, 'clientRequestId'>): Promise<CommandResult | undefined> => {
    if (!ref.current || status !== 'ready') return;
    const revision = epoch.current;
    // 同模式有未确认请求时不创建第二个编号。
    if (ref.current.pending.some((p) => p.input.type === input.type && (p.status === 'sending' || p.status === 'confirming'))) return;
    const item: PendingCommand = { input: { ...input, clientRequestId: crypto.randomUUID() }, status: 'sending', retries: 0 };
    await update((current) => ({ ...current, pending: [...current.pending.filter((p) => p.status !== 'rejected' && !(p.status === 'sent' && (state?.turns.some((t) => t.turnId === p.result?.turnId) || state?.discussions.some((d) => d.eventId === p.result?.discussionId) || !['ask', 'solve', 'discussion'].includes(p.input.type)))), item] }));
    if (revision !== epoch.current) return;
    const result = await execute(item, false);
    if (!result && revision === epoch.current && status === 'ready') {
      const unresolved = ref.current?.pending.find((p) => p.input.clientRequestId === item.input.clientRequestId);
      if (unresolved?.status === 'confirming') return execute(unresolved, true);
    }
    return result;
  };

  return { local, storageError, update, submit, retry: (item: PendingCommand) => execute(item, true) };
}
