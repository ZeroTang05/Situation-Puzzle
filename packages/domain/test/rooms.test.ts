import { describe, expect, it } from 'vitest';
import { assertCanEnqueue, assertRoomTransition, nextHintIndex, pickHostSuccessor } from '../src/rooms.js';
import { DomainError } from '../src/error.js';

describe('房间状态机', () => {
  it('waiting → playing → waiting 循环合法', () => {
    expect(() => assertRoomTransition('waiting', 'playing')).not.toThrow();
    expect(() => assertRoomTransition('playing', 'waiting')).not.toThrow();
  });
  it('closed 是终态', () => {
    expect(() => assertRoomTransition('closed', 'waiting')).toThrow(DomainError);
  });
});

describe('排队容量', () => {
  it('每人最多一个未完成任务', () => {
    expect(() => assertCanEnqueue({ activeCount: 1, userActiveCount: 1 }, true)).toThrow(DomainError);
  });
  it('房间队列上限 8', () => {
    expect(() => assertCanEnqueue({ activeCount: 8, userActiveCount: 0 }, false)).toThrow(/队列已满/);
  });
  it('空队列允许提交', () => {
    expect(() => assertCanEnqueue({ activeCount: 0, userActiveCount: 0 }, false)).not.toThrow();
  });
});

describe('提示解锁', () => {
  it('三条提示按序解锁', () => {
    expect(nextHintIndex(0)).toBe(0);
    expect(nextHintIndex(2)).toBe(2);
    expect(() => nextHintIndex(3)).toThrow(DomainError);
  });
});

describe('房主继任', () => {
  const base = { joinedAt: new Date(0), status: 'joined' as const };
  it('选在线且最早加入的成员', () => {
    const successor = pickHostSuccessor(
      [
        { userId: 'b', online: true, ...base, joinedAt: new Date(2000) },
        { userId: 'a', online: true, ...base, joinedAt: new Date(1000) },
        { userId: 'c', online: false, ...base, joinedAt: new Date(500) },
      ],
      'host',
    );
    expect(successor).toBe('a');
  });
  it('无人在线返回 null', () => {
    expect(pickHostSuccessor([{ userId: 'b', online: false, ...base }], 'host')).toBeNull();
  });
});
