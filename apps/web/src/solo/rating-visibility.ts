/** 玩家完成一次还原，或看到汤底后，才展示题目评价。 */
export function canRateSoloPuzzle(
  revealedAnswer: string | null,
  turns: ReadonlyArray<{ kind: 'ask' | 'solve'; status: 'sending' | 'succeeded' | 'failed' }>,
): boolean {
  return Boolean(revealedAnswer) || turns.some((turn) => turn.kind === 'solve' && turn.status === 'succeeded');
}
