/**
 * 社交域规则（docs/rebuild/19-FRIENDS-DM-NOTIFICATIONS.md）。
 *
 * 全部为纯函数：输入状态快照，输出判定或直接抛 DomainError。
 * 服务端与前端共用同一套口径，避免「前端能点、后端拒绝」这种不一致。
 *
 * 三条产品口径在这里定死：
 *  1. 申请-同意制：A→B 与 B→A 互斥（按规范化的一对判定），对方同意才成为好友
 *  2. 邮箱只做精确匹配，不做前缀模糊搜索（避免枚举站内邮箱）
 *  3. 私聊只发生在好友之间；已读水位按会话内序号推进，只前进不后退
 */
import type { ErrorCode } from '@jev/contracts';
import { DomainError } from './error.js';

/** 好友申请状态：pending 待对方处理；其余为终态。 */
export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'canceled';

/**
 * 用户对规范化：字典序小的在前。
 * A→B 与 B→A 落在同一对上，好友申请的互斥判定与数据库唯一索引口径一致。
 */
export function normalizeUserPair(a: string, b: string): { userLow: string; userHigh: string } {
  return a <= b ? { userLow: a, userHigh: b } : { userLow: b, userHigh: a };
}

/**
 * 发好友申请被拒的原因（null = 可以发）。
 * pending_incoming 也拒：让用户先去处理对方发来的申请，
 * 而不是让两条申请互相顶掉（数据库部分唯一索引也会挡下）。
 */
export type FriendRequestBlock = 'self' | 'already_friends' | 'pending_outgoing' | 'pending_incoming';

export function friendRequestBlockReason(input: {
  selfId: string;
  targetId: string;
  isFriend: boolean;
  /** 已存在的待审申请的发起人（null = 没有待审申请） */
  pendingRequesterUserId: string | null;
}): FriendRequestBlock | null {
  if (input.selfId === input.targetId) return 'self';
  if (input.isFriend) return 'already_friends';
  if (input.pendingRequesterUserId === null) return null;
  return input.pendingRequesterUserId === input.selfId ? 'pending_outgoing' : 'pending_incoming';
}

/** 被拒原因 → 稳定错误码与文案（服务端 DomainError 与前端提示共用）。 */
export function friendRequestBlockError(block: FriendRequestBlock): { code: ErrorCode; message: string } {
  switch (block) {
    case 'self':
      return { code: 'FORBIDDEN', message: '不能添加自己为好友' };
    case 'already_friends':
      return { code: 'ALREADY_FRIENDS', message: '你们已经是好友了' };
    case 'pending_outgoing':
      return { code: 'FRIEND_REQUEST_EXISTS', message: '好友申请已经发出，等对方确认吧' };
    case 'pending_incoming':
      return { code: 'FRIEND_REQUEST_EXISTS', message: '对方已经申请你，先处理这条申请' };
  }
}

/** 处理好友申请被拒的原因（null = 可以处理）。 */
export type FriendResponseBlock = 'not_target' | 'already_handled';

export function friendResponseBlockReason(input: {
  /** 当前操作人 */
  responderId: string;
  /** 申请接收方（收到申请的那一方） */
  targetUserId: string;
  status: FriendRequestStatus;
}): FriendResponseBlock | null {
  if (input.responderId !== input.targetUserId) return 'not_target';
  if (input.status !== 'pending') return 'already_handled';
  return null;
}

export function friendResponseBlockError(block: FriendResponseBlock): { code: ErrorCode; message: string } {
  switch (block) {
    case 'not_target':
      return { code: 'FORBIDDEN', message: '只有收到申请的人才能处理这条申请' };
    case 'already_handled':
      return { code: 'STATE_CONFLICT', message: '这条申请已经处理过了' };
  }
}

/** 私聊权限：只有好友能私聊，且不能给自己发消息。 */
export function assertCanMessage(input: { senderId: string; peerId: string; isFriend: boolean }): void {
  if (input.senderId === input.peerId) throw new DomainError('FORBIDDEN', '不能给自己发消息');
  if (!input.isFriend) throw new DomainError('NOT_FRIENDS', '只有好友才能私聊');
}

/** 已读水位只前进不后退：取两个序号里较大的那个。 */
export function nextReadSeq(current: number, messageSeq: number): number {
  return messageSeq > current ? messageSeq : current;
}

/** 未读数：序号大于水位的消息条数。 */
export function unreadMessageCount(input: { messages: { seq: number }[]; lastReadSeq: number }): number {
  return input.messages.filter((message) => message.seq > input.lastReadSeq).length;
}

/**
 * 快捷开局（「来一局」）的房间容量：发起方 + 好友两人。
 * 与普通房间的 ROOM_CAPACITY 无关：这是一场只有两个人的局。
 */
export const QUICK_ROOM_CAPACITY = 2;

/**
 * 好友关系摘要里的昵称回退：查不到 profile 时退回用户 id 片段，
 * 避免前端出现空白行。
 */
export function displayNickname(nickname: string | null | undefined, userId: string): string {
  const trimmed = nickname?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : userId.slice(0, 8);
}
