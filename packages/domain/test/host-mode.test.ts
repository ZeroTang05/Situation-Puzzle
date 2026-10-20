import { describe, expect, it } from 'vitest';
import {
  assertCanRequestHost,
  assertCanResignHost,
  assertCanReviewHost,
  assertHostAnswer,
  hostRequestOutcome,
} from '../src/host-mode.js';
import { DomainError } from '../src/error.js';

describe('主持人申请', () => {
  it('房主自己申请直接通过，其他成员进入待审', () => {
    expect(hostRequestOutcome({ isOwner: true, isUserHost: false })).toBe('approved');
    expect(hostRequestOutcome({ isOwner: false, isUserHost: false })).toBe('pending');
  });
  it('已经是主持人的不能重复申请', () => {
    expect(() => assertCanRequestHost({ isOwner: false, isUserHost: true })).toThrow(DomainError);
    expect(() => assertCanRequestHost({ isOwner: false, isUserHost: false })).not.toThrow();
  });
});

describe('主持人审核与退出', () => {
  it('只有房主可以审核申请', () => {
    expect(() => assertCanReviewHost({ isOwner: false, isUserHost: false })).toThrow(/只有房主/);
    expect(() => assertCanReviewHost({ isOwner: true, isUserHost: false })).not.toThrow();
  });
  it('只有当前用户主持人能退出', () => {
    expect(() => assertCanResignHost({ isOwner: false, isUserHost: false })).toThrow(/不是本局主持人/);
    expect(() => assertCanResignHost({ isOwner: true, isUserHost: true })).not.toThrow();
  });
});

describe('用户主持人判定玩家提问', () => {
  const base = { isUserHost: true, hostMode: 'user' as const, turnKind: 'ask' as const, turnStatus: 'queued' as const };
  it('主持人在用户主持模式下可以回答挂起中的提问', () => {
    expect(() => assertHostAnswer(base)).not.toThrow();
  });
  it('非主持人、非用户主持模式都不能判定', () => {
    expect(() => assertHostAnswer({ ...base, isUserHost: false })).toThrow(/只有本局主持人/);
    expect(() => assertHostAnswer({ ...base, hostMode: 'ai' })).toThrow(/只有本局主持人/);
  });
  it('只能回答提问，且不能重复判定', () => {
    expect(() => assertHostAnswer({ ...base, turnKind: 'solve' })).toThrow(/只能回答玩家提出的问题/);
    expect(() => assertHostAnswer({ ...base, turnStatus: 'succeeded' })).toThrow(/已经判定过/);
  });
});
