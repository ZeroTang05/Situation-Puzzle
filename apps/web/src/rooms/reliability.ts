/** 连接与发送的纯状态规则，便于直接验证乱序、重复和确认结果。 */
import type { RoomEvent } from '@jev/contracts';
import { applyEvent, type RoomState } from './room-state.js';
import type { PendingCommand, RoomLocal } from './room-local.js';
import type { CommandResult } from './use-room-sync.js';

/** 仅推进连续序号；缺口之后的事件留在缓冲区，等待补齐。 */
export function receiveEvent(state: RoomState, event: RoomEvent, buffer: Map<number, RoomEvent>): RoomState {
  if (event.roomId !== state.roomId || event.seq <= state.lastSeq) return state;
  buffer.set(event.seq, event);
  let next = state;
  while (buffer.has(next.lastSeq + 1)) {
    const item = buffer.get(next.lastSeq + 1)!;
    buffer.delete(item.seq);
    next = { ...applyEvent(next, item), lastSeq: item.seq };
  }
  return next;
}

/** 收到保存证明后，只清除与已发送内容相同的草稿。 */
export function confirmCommand(current: RoomLocal, item: PendingCommand, result: CommandResult): RoomLocal {
  const mode = item.input.type;
  const drafts = { ...current.drafts };
  if ((mode === 'ask' || mode === 'solve' || mode === 'discussion') && drafts[mode].trim() === item.input.payload?.text) drafts[mode] = '';
  return { ...current, drafts, pending: current.pending.map((p) => p.input.clientRequestId === item.input.clientRequestId ? { ...p, status: 'sent', result } : p) };
}

/** 查询仍未知时，消息最多自动重投一次；控制操作保留为待确认。 */
export function recoveryAction(item: PendingCommand, roomClosed: boolean): 'reject' | 'resend' | 'query_only' {
  if (roomClosed) return 'reject';
  return ['ask', 'solve', 'discussion'].includes(item.input.type) && item.retries < 1 ? 'resend' : 'query_only';
}

/** 重试逐渐放缓并加入随机间隔，避免多个玩家同时重连。 */
export function reconnectDelay(attempt: number, random: number): number {
  return Math.min(15_000, 500 * 2 ** Math.min(attempt, 5) + random * 300);
}
