import { describe, expect, it } from 'vitest';
import { activeRoomsForUser } from './presence-state.js';

describe('activeRoomsForUser', () => {
  it('保留用户在多个房间的在线状态，并按房间合并多标签页', () => {
    const now = 100_000;
    const states = [
      { userId: 'u1', lastActiveAt: 99_000, subscriptions: new Map([['room-a', true], ['room-b', true]]) },
      { userId: 'u1', lastActiveAt: 98_000, subscriptions: new Map([['room-a', true]]) },
      { userId: 'u2', lastActiveAt: 100_000, subscriptions: new Map([['room-c', true]]) },
      { userId: 'u1', lastActiveAt: 1_000, subscriptions: new Map([['room-d', true]]) },
    ];

    expect([...activeRoomsForUser(states, 'u1', now)]).toEqual([['room-a', 99_000], ['room-b', 99_000]]);
  });
});
