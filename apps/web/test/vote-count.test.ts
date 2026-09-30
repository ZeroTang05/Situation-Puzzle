/** 票数跨过千位时长度稳定，且不会把 1999 票显示成 2K。 */
import { expect, it } from 'vitest';
import { compactVoteCount } from '../src/catalog/vote-count.js';

it('将千位以上的票数显示为 K', () => {
  expect([0, 999, 1000, 1550, 1999, 10_000].map(compactVoteCount)).toEqual(['0', '999', '1K', '1.5K', '1.9K', '10K']);
});
