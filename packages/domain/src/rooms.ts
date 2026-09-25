/**
 * 房间与排队规则（docs/rebuild/04-ROOM-JEV.md）。
 * 全部为纯函数：输入状态快照，输出判定或直接抛 DomainError。
 */
import { DomainError } from './error.js';

export const ROOM_CAPACITY_MAX = 8;
export const HINTS_PER_PUZZLE = 3;
/** 整个房间未完成任务上限 */
export const ROUND_QUEUE_LIMIT = 8;
/** 每人未完成任务上限 */
export const PER_USER_QUEUE_LIMIT = 1;
/** 讨论限速：每分钟 30 条 */
export const DISCUSSION_PER_MINUTE = 30;
/** 排队 60 秒未开始判为失败 */
export const TURN_QUEUE_TIMEOUT_MS = 60_000;
/** 房主离线 90 秒转让 */
export const HOST_OFFLINE_TRANSFER_MS = 90_000;
/** 全员离线 30 分钟关闭 */
export const ALL_OFFLINE_CLOSE_MS = 30 * 60_000;
/** 等待室 24 小时无活动关闭 */
export const WAITING_ROOM_IDLE_MS = 24 * 60 * 60_000;

export type RoomStatus = 'waiting' | 'playing' | 'closed';
export type RoundStatus = 'active' | 'solved' | 'revealed' | 'abandoned' | 'aborted';
export type TurnStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';

/** 房间状态机：waiting→playing→waiting 循环，终态 closed。 */
export function assertRoomTransition(from: RoomStatus, to: RoomStatus): void {
  const allowed: Record<RoomStatus, RoomStatus[]> = {
    waiting: ['playing', 'closed'],
    playing: ['waiting', 'closed'],
    closed: [],
  };
  if (!allowed[from].includes(to)) {
    throw new DomainError('STATE_CONFLICT', `房间状态不允许从 ${from} 转到 ${to}`);
  }
}

/** 终态局不可逆（docs/rebuild/04-ROOM-JEV.md §2）。 */
export function isRoundTerminal(status: RoundStatus): boolean {
  return status !== 'active';
}

/** 控制命令的乐观并发检查。 */
export function assertControlVersion(expected: number | undefined, actual: number): number | undefined {
  if (expected !== undefined && expected !== actual) {
    throw new DomainError('STATE_CONFLICT', '房间状态已变化，请刷新后重试', { currentControlVersion: actual });
  }
  return expected;
}

export interface QueueUsage {
  activeCount: number;
  userActiveCount: number;
}

/** 判题提交排队检查：进行中、个人与房间容量。 */
export function assertCanEnqueue(usage: QueueUsage, userIdActive: boolean): void {
  if (userIdActive) {
    throw new DomainError('TURN_PENDING', '你已有未完成的提问或还原任务');
  }
  if (usage.activeCount >= ROUND_QUEUE_LIMIT) {
    throw new DomainError('QUEUE_FULL', '当前队列已满，请稍后再试', { limit: ROUND_QUEUE_LIMIT });
  }
}

/** 提示解锁序号：必须还有未解锁提示。 */
export function nextHintIndex(hintsRevealed: number): number {
  if (hintsRevealed >= HINTS_PER_PUZZLE) {
    throw new DomainError('STATE_CONFLICT', '提示已全部解锁');
  }
  return hintsRevealed;
}

/** 房主候选：在线且最早加入的成员（排除现任房主）。 */
export function pickHostSuccessor(
  members: Array<{ userId: string; online: boolean; joinedAt: Date; status: 'joined' | 'left' | 'kicked' }>,
  currentHostId: string,
): string | null {
  const candidates = members
    .filter((m) => m.status === 'joined' && m.userId !== currentHostId && m.online)
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  return candidates[0]?.userId ?? null;
}
