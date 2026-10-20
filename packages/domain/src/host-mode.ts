/**
 * 用户主持人规则（docs/rebuild/17-USER-HOST-MODE.md）。
 *
 * 全部为纯函数：输入作用域（房间或会客厅）与调用者的身份快照，
 * 输出判定或直接抛 DomainError。API 层只负责取数与落库。
 */
import { DomainError } from './error.js';

/** 作用域：房间或会客厅。两者的主持人规则完全同构。 */
export type HostScope = 'room' | 'lobby';

export interface HostIdentity {
  /** 调用者是否是作用域房主（房间 owner / 会客厅 owner） */
  isOwner: boolean;
  /** 调用者是否已经是当前用户主持人 */
  isUserHost: boolean;
}

/**
 * 申请成为主持人的结果：
 * - approved：房主自己申请，直接通过；
 * - pending：其他成员申请，进入待审队列等房主审核。
 */
export type HostRequestOutcome = 'approved' | 'pending';

export function hostRequestOutcome(identity: HostIdentity): HostRequestOutcome {
  return identity.isOwner ? 'approved' : 'pending';
}

/** 申请前检查：已经是主持人的不能重复申请。 */
export function assertCanRequestHost(identity: HostIdentity): void {
  if (identity.isUserHost) {
    throw new DomainError('STATE_CONFLICT', '你已经是本局主持人');
  }
}

/** 审核（批准 / 拒绝）只有房主能做。 */
export function assertCanReviewHost(identity: HostIdentity): void {
  if (!identity.isOwner) {
    throw new DomainError('FORBIDDEN', '只有房主可以审核主持人申请');
  }
}

/** 退出主持人：只有当前用户主持人能退出。 */
export function assertCanResignHost(identity: HostIdentity): void {
  if (!identity.isUserHost) {
    throw new DomainError('FORBIDDEN', '你不是本局主持人');
  }
}

/**
 * 用户主持人回答玩家提问的前置检查。
 *
 * 只有当前用户主持人、且房间处于用户主持模式时才能判定；
 * 判定对象必须是本局里挂起中的提问（kind='ask'、status='queued'）。
 */
export function assertHostAnswer(input: {
  isUserHost: boolean;
  hostMode: 'ai' | 'user';
  turnKind: 'ask' | 'solve';
  turnStatus: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
}): void {
  if (!input.isUserHost || input.hostMode !== 'user') {
    throw new DomainError('FORBIDDEN', '只有本局主持人可以回答玩家提问');
  }
  if (input.turnKind !== 'ask') {
    throw new DomainError('VALIDATION_FAILED', '只能回答玩家提出的问题');
  }
  if (input.turnStatus !== 'queued') {
    throw new DomainError('STATE_CONFLICT', '这个问题已经判定过了');
  }
}
