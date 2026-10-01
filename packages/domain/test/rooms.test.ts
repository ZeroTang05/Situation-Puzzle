import { describe, expect, it } from 'vitest';
import { assertCanEnqueue, assertRoomTransition, nextHintIndex } from '../src/rooms.js';
import { DomainError } from '../src/error.js';

describe('房间状态机', () => {
  it('waiting → playing → closed 单向（一房一题，局结束即归档）', () => {
    expect(() => assertRoomTransition('waiting', 'playing')).not.toThrow();
    expect(() => assertRoomTransition('playing', 'closed')).not.toThrow();
    expect(() => assertRoomTransition('waiting', 'closed')).not.toThrow();
  });
  it('playing 不再回到 waiting（10-ROOM-LIFECYCLE-REVISION §二）', () => {
    expect(() => assertRoomTransition('playing', 'waiting')).toThrow(DomainError);
  });
  it('closed 是终态', () => {
    expect(() => assertRoomTransition('closed', 'waiting')).toThrow(DomainError);
    expect(() => assertRoomTransition('closed', 'playing')).toThrow(DomainError);
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
