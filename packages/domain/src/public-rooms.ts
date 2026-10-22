/**
 * 公开房间与大厅规则（docs/rebuild/18-HALL-PUBLIC-ROOMS.md）。
 *
 * 全部为纯函数：输入状态快照，输出判定或直接抛 DomainError。
 * 服务端与前端共用同一套口径，避免「大厅里能点进、点进去却被拒」这种不一致。
 */
import type { ErrorCode } from '@jev/contracts';
import { DomainError } from './error.js';

/** 大厅列表最多返回多少个房间（公开房间数量本身不可控，需要封顶） */
export const HALL_LIMIT = 50;

export type PublicRoomStatus = 'waiting' | 'playing' | 'closed';

/**
 * 公开/私人开关的权限：只有房主能改。
 * 会客厅与房间各有一份开关，但判定口径相同（谁拥有这个作用域谁说了算）。
 */
export function assertCanToggleVisibility(input: { isHost: boolean }): void {
  if (!input.isHost) {
    throw new DomainError('FORBIDDEN', '只有房主可以切换公开 / 私人');
  }
}

/**
 * 是否出现在大厅列表：公开且没有归档。
 * 已归档（closed）的房间必须立刻从大厅消失，否则会出现「点进去发现已结束」。
 */
export function shouldListInHall(input: { isPublic: boolean; status: PublicRoomStatus }): boolean {
  return input.isPublic && input.status !== 'closed';
}

/** 直接加入公开房间被拒的原因（null = 可以加入）。 */
export type PublicJoinBlock = 'not_public' | 'room_closed' | 'room_full';

export interface PublicJoinState {
  isPublic: boolean;
  status: PublicRoomStatus;
  memberCount: number;
  capacity: number;
}

/**
 * 直接加入公开房间的前置判定（不含成员资格，那部分需要查库）。
 * 顺序固定：先看是不是公开房，再看房还在不在，最后看满没满。
 */
export function publicJoinBlockReason(state: PublicJoinState): PublicJoinBlock | null {
  if (!state.isPublic) return 'not_public';
  if (state.status === 'closed') return 'room_closed';
  if (state.memberCount >= state.capacity) return 'room_full';
  return null;
}

/** 直接加入被拒时的错误码与文案：与服务端 DomainError 对齐。 */
export function publicJoinBlockError(block: PublicJoinBlock): { code: ErrorCode; message: string } {
  switch (block) {
    case 'not_public':
      return { code: 'FORBIDDEN', message: '这个房间不是公开房间' };
    case 'room_closed':
      return { code: 'ROOM_CLOSED', message: '房间已关闭' };
    case 'room_full':
      return { code: 'ROOM_FULL', message: '房间已经满了。' };
  }
}
