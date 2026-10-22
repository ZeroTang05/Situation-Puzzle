/**
 * 公开房间 / 大厅规则回归测试。
 *
 * 这几条口径决定了「大厅里看到什么、谁能进」：
 *  - 开关只有房主能拨；
 *  - 归档房间必须从大厅消失；
 *  - 直接加入的三种拒绝原因要稳定可预期（前端按 code 翻译文案）。
 */
import { describe, expect, it } from 'vitest';
import {
  HALL_LIMIT,
  assertCanToggleVisibility,
  publicJoinBlockError,
  publicJoinBlockReason,
  shouldListInHall,
} from './public-rooms.js';

describe('公开 / 私人开关', () => {
  it('房主可以切换', () => {
    expect(() => assertCanToggleVisibility({ isHost: true })).not.toThrow();
  });

  it('非房主切换直接拒绝', () => {
    expect(() => assertCanToggleVisibility({ isHost: false })).toThrowError(/只有房主/);
  });
});

describe('大厅列表口径', () => {
  it('公开且未归档的房间出现在大厅', () => {
    expect(shouldListInHall({ isPublic: true, status: 'playing' })).toBe(true);
    expect(shouldListInHall({ isPublic: true, status: 'waiting' })).toBe(true);
  });

  it('私人房间不进大厅', () => {
    expect(shouldListInHall({ isPublic: false, status: 'playing' })).toBe(false);
  });

  it('归档房间立刻从大厅消失', () => {
    expect(shouldListInHall({ isPublic: true, status: 'closed' })).toBe(false);
  });

  it('大厅列表有封顶，避免公开房间泛滥时把响应撑爆', () => {
    expect(HALL_LIMIT).toBeGreaterThan(0);
    expect(HALL_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe('直接加入公开房间', () => {
  const open = { isPublic: true, status: 'playing' as const, memberCount: 3, capacity: 8 };

  it('公开、有空位时可以加入', () => {
    expect(publicJoinBlockReason(open)).toBeNull();
  });

  it('私人房间拒绝加入', () => {
    expect(publicJoinBlockReason({ ...open, isPublic: false })).toBe('not_public');
  });

  it('归档房间拒绝加入', () => {
    expect(publicJoinBlockReason({ ...open, status: 'closed' })).toBe('room_closed');
  });

  it('满员房间拒绝加入', () => {
    expect(publicJoinBlockReason({ ...open, memberCount: 8 })).toBe('room_full');
  });

  it('判定顺序：先看公开，再看归档，最后看容量', () => {
    // 既是私人房又满员 → 先报「不是公开房间」，避免暴露房间细节
    expect(publicJoinBlockReason({ ...open, isPublic: false, memberCount: 8 })).toBe('not_public');
    // 已归档且满员 → 先报「房间已关闭」
    expect(publicJoinBlockReason({ ...open, status: 'closed', memberCount: 8 })).toBe('room_closed');
  });

  it('拒绝原因映射到稳定错误码', () => {
    expect(publicJoinBlockError('not_public').code).toBe('FORBIDDEN');
    expect(publicJoinBlockError('room_closed').code).toBe('ROOM_CLOSED');
    expect(publicJoinBlockError('room_full').code).toBe('ROOM_FULL');
  });
});
