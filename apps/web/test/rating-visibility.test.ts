/** 评价入口只在玩家尝试还原或得知汤底后开放。 */
import { expect, it } from 'vitest';
import { canRateSoloPuzzle } from '../src/solo/rating-visibility.js';
import { canRateRoomPuzzle } from '@jev/contracts';

it('单纯提问和失败请求不显示评价，成功还原请求或揭晓后显示', () => {
  expect(canRateSoloPuzzle(null, [])).toBe(false);
  expect(canRateSoloPuzzle(null, [{ kind: 'ask', status: 'succeeded' }])).toBe(false);
  expect(canRateSoloPuzzle(null, [{ kind: 'solve', status: 'failed' }])).toBe(false);
  expect(canRateSoloPuzzle(null, [{ kind: 'solve', status: 'succeeded' }])).toBe(true);
  expect(canRateSoloPuzzle('汤底', [])).toBe(true);
});

it('多人只在破解或公布答案后开放评价，停止的局不开放', () => {
  expect(canRateRoomPuzzle('active')).toBe(false);
  expect(canRateRoomPuzzle('abandoned')).toBe(false);
  expect(canRateRoomPuzzle('aborted')).toBe(false);
  expect(canRateRoomPuzzle('solved')).toBe(true);
  expect(canRateRoomPuzzle('revealed')).toBe(true);
});
