import { describe, expect, it } from 'vitest';
import {
  assertCanRequestHost,
  assertCanResignHost,
  assertCanReviewHost,
  assertCanRevokeHost,
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
  it('只有房主可以撤销他人的主持身份', () => {
    expect(() => assertCanRevokeHost({ isOwner: false, isUserHost: false })).toThrow(/只有房主/);
    expect(() => assertCanRevokeHost({ isOwner: true, isUserHost: false })).not.toThrow();
  });
});

describe('用户主持人判定玩家提交', () => {
  const base = { isUserHost: true, hostMode: 'user' as const, turnStatus: 'queued' as const };
  it('提问可判定为是/否/无关', () => {
    for (const verdict of ['yes', 'no', 'irrelevant']) {
      expect(() => assertHostAnswer({ ...base, turnKind: 'ask', verdict })).not.toThrow();
    }
  });
  it('还原可判定为破解成功/接近真相/还没猜对', () => {
    for (const verdict of ['solved', 'close', 'not_yet']) {
      expect(() => assertHostAnswer({ ...base, turnKind: 'solve', verdict })).not.toThrow();
    }
  });
  it('判定值必须与提交类型匹配', () => {
    expect(() => assertHostAnswer({ ...base, turnKind: 'ask', verdict: 'solved' })).toThrow(/只能判定为是、否或无关/);
    expect(() => assertHostAnswer({ ...base, turnKind: 'solve', verdict: 'yes' })).toThrow(/只能判定为破解成功/);
  });
  it('非主持人、非用户主持模式都不能判定', () => {
    expect(() => assertHostAnswer({ ...base, isUserHost: false, turnKind: 'ask', verdict: 'yes' })).toThrow(/只有本局主持人/);
    expect(() => assertHostAnswer({ ...base, hostMode: 'ai', turnKind: 'ask', verdict: 'yes' })).toThrow(/只有本局主持人/);
  });
  it('已判定过的提交不能再判定', () => {
    expect(() => assertHostAnswer({ ...base, turnStatus: 'succeeded', turnKind: 'ask', verdict: 'yes' })).toThrow(/已经判定过/);
  });
});
