/** Jev 初审结果决定发布、退回或人工复核；无法确定时保持未公开。 */
export function creationReviewOutcome(verdict: 'review_pass' | 'review_reject' | 'review_uncertain') {
  switch (verdict) {
    case 'review_pass': return { status: 'published' as const, reason: 'Jev 初审通过，已发布' };
    case 'review_reject': return { status: 'changes_requested' as const, reason: 'Jev 初审未通过，请修改内容' };
    case 'review_uncertain': return { status: 'pending_review' as const, reason: 'Jev 无法确定，待后台复核' };
  }
}
