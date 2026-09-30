/** 用完整作品列表验证排除规则，随机采样值显式传入以覆盖选择边界。 */
import { describe, expect, it } from 'vitest';
import { selectUnplayedPuzzle } from '../src/solo/unplayed-puzzle.js';

describe('随机选择未玩题目', () => {
  it('排除当前题目和已玩作品，不区分作品的游玩语言', () => {
    expect(selectUnplayedPuzzle(['current', 'played', 'new'], ['played'], 'current', 0)).toBe('new');
  });
  it('完整已玩记录超过 50 条时也不重复抽题', () => {
    const played = Array.from({ length: 80 }, (_, index) => `played-${index}`);
    expect(selectUnplayedPuzzle([...played, 'new'], played, 'current', 0)).toBe('new');
  });
  it('候选去重后按随机采样选择，第一题和最后一题均可抽中', () => {
    const ids = ['a', 'a', 'b'];
    expect(selectUnplayedPuzzle(ids, [], 'current', 0)).toBe('a');
    expect(selectUnplayedPuzzle(ids, [], 'current', 0.5)).toBe('b');
    expect(selectUnplayedPuzzle(ids, [], 'current', 0.999)).toBe('b');
  });
  it('没有未玩题目或题库为空时返回空结果', () => {
    expect(selectUnplayedPuzzle(['current', 'played'], ['played'], 'current')).toBeNull();
    expect(selectUnplayedPuzzle([], [], 'current')).toBeNull();
  });
  it.each([-1, 1, NaN, Infinity])('无效采样 %s 立即报错', (sample) => {
    expect(() => selectUnplayedPuzzle(['new'], [], 'current', sample)).toThrow(RangeError);
  });
});
