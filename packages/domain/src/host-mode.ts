/**
 * 用户主持人规则（docs/rebuild/17-USER-HOST-MODE.md）。
 *
 * 全部为纯函数：输入作用域（房间或会客厅）与调用者的身份快照，
 * 输出判定或直接抛 DomainError。API 层只负责取数与落库。
 */
import { DomainError } from './error.js';

/** 作用域：房间或会客厅。两者的主持人规则完全同构。 */
export type HostScope = 'room' | 'lobby';

/** 用户主持人对「提问」的判定值。 */
export const HOST_ASK_VERDICTS = ['yes', 'no', 'irrelevant'] as const;
/** 用户主持人对「还原」的判定值（与 Jev 的还原判定同域）。 */
export const HOST_SOLVE_VERDICTS = ['solved', 'close', 'not_yet'] as const;

export type HostAskVerdict = (typeof HOST_ASK_VERDICTS)[number];
export type HostSolveVerdict = (typeof HOST_SOLVE_VERDICTS)[number];
export type HostVerdict = HostAskVerdict | HostSolveVerdict;

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

/**
 * 撤销主持身份只有房主能做（被撤销者降级为普通玩家）。
 * 被撤销者自己不能撤销自己——那走「退出主持人」。
 */
export function assertCanRevokeHost(identity: HostIdentity): void {
  if (!identity.isOwner) {
    throw new DomainError('FORBIDDEN', '只有房主可以撤销主持人身份');
  }
}

/** 退出主持人：只有当前用户主持人能退出。 */
export function assertCanResignHost(identity: HostIdentity): void {
  if (!identity.isUserHost) {
    throw new DomainError('FORBIDDEN', '你不是本局主持人');
  }
}

/**
 * 用户主持人判定的前置检查。
 *
 * 只有当前用户主持人、且房间处于用户主持模式时才能判定；
 * 判定对象必须是本局里挂起中的任务（status='queued'），
 * 判定值必须与任务类型匹配（提问用 yes/no/irrelevant，还原用 solved/close/not_yet）。
 */
export function assertHostAnswer(input: {
  isUserHost: boolean;
  hostMode: 'ai' | 'user';
  turnKind: 'ask' | 'solve';
  turnStatus: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  verdict: string;
}): void {
  if (!input.isUserHost || input.hostMode !== 'user') {
    throw new DomainError('FORBIDDEN', '只有本局主持人可以判定玩家提交');
  }
  if (input.turnStatus !== 'queued') {
    throw new DomainError('STATE_CONFLICT', '这个提交已经判定过了');
  }
  const allowed: readonly string[] = input.turnKind === 'ask' ? HOST_ASK_VERDICTS : HOST_SOLVE_VERDICTS;
  if (!allowed.includes(input.verdict)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      input.turnKind === 'ask' ? '提问只能判定为是、否或无关' : '还原只能判定为破解成功、接近真相或还没猜对',
    );
  }
}
