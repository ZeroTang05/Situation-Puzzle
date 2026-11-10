/** 跨端玩家交互约定：选题与评价时机，保持网页和原生小游戏一致。 */

/** 按作品编号排除全部已玩题目，切换语言也不重复抽取同一作品。 */
export function selectUnplayedPuzzle(puzzleIds: readonly string[], playedIds: readonly string[], currentId: string, sample = Math.random()): string | null {
  const excluded = new Set([...playedIds, currentId]);
  const candidates = [...new Set(puzzleIds)].filter((id) => !excluded.has(id));
  if (candidates.length === 0) return null;
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('随机数必须位于 [0, 1)');
  return candidates[Math.floor(sample * candidates.length)]!;
}

/** 完成一次有效还原请求或看到汤底后，才能评价单人题目。 */
export function canRateSoloPuzzle(revealedAnswer: string | null, turns: ReadonlyArray<{ kind: string; status: string }>): boolean {
  return Boolean(revealedAnswer) || turns.some((turn) => turn.kind === 'solve' && turn.status === 'succeeded');
}

/** 多人局只在破解或公布答案后展示评价，主动停止的局不开放。 */
export function canRateRoomPuzzle(roundStatus: string): boolean { return roundStatus === 'solved' || roundStatus === 'revealed'; }
