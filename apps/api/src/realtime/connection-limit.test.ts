/** 每用户实时连接数计数（纯函数）。 */
import { describe, expect, it } from 'vitest';
import { countUserConnections } from './connection-limit.js';

describe('每用户实时连接数', () => {
  it('只数已认领身份的连接', () => {
    const states = [
      { userId: 'u1' },
      { userId: 'u1' },
      { userId: 'u2' },
      { userId: null },
    ];
    expect(countUserConnections(states, 'u1')).toBe(2);
    expect(countUserConnections(states, 'u2')).toBe(1);
    expect(countUserConnections(states, 'u3')).toBe(0);
  });

  it('没有连接时为 0', () => {
    expect(countUserConnections([], 'u1')).toBe(0);
  });
});
