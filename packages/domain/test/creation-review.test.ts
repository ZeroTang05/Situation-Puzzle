/** 检查初审结果的发布边界，避免拒稿或不确定结果公开。 */
import { expect, it } from 'vitest';
import { creationReviewOutcome } from '../src/creation-review.js';

it('只有 Jev 明确通过才能直接发布', () => {
  expect(creationReviewOutcome('review_pass').status).toBe('published');
  expect(creationReviewOutcome('review_reject').status).toBe('changes_requested');
  expect(creationReviewOutcome('review_uncertain').status).toBe('pending_review');
});
