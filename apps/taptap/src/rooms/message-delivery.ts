/** 房间消息的本地发送状态：接口确认后继续显示，直到权威消息接替。 */
import type { InputMode, PendingCommand } from './room-local.js';

/** 只读取权威消息的编号，兼容 HTTP 快照与实时事件合并后的状态。 */
interface DeliverySnapshot {
  turns: ReadonlyArray<{ turnId: string; clientRequestId?: string | undefined }>;
  discussions: ReadonlyArray<{ eventId: string; clientRequestId?: string | undefined }>;
}

/** 当前输入类型有未确认请求时，保留新草稿并暂停再次发送。 */
export function hasPendingInput(pending: readonly PendingCommand[], mode: InputMode): boolean {
  return pending.some((item) => item.input.type === mode && (item.status === 'sending' || item.status === 'confirming'));
}

/** 按问答 / 讨论分组；服务端快照或事件出现同一消息后才移除本地显示。 */
export function pendingRoomMessages(
  pending: readonly PendingCommand[],
  state: DeliverySnapshot,
  tab: 'qa' | 'discuss',
): PendingCommand[] {
  return pending.filter((item) => {
    if (!['ask', 'solve', 'discussion'].includes(item.input.type)) return false;
    if ((tab === 'discuss') !== (item.input.type === 'discussion')) return false;
    return !state.turns.some((turn) => turn.clientRequestId === item.input.clientRequestId || turn.turnId === item.result?.turnId)
      && !state.discussions.some((discussion) => discussion.clientRequestId === item.input.clientRequestId || discussion.eventId === item.result?.discussionId);
  });
}
