/** 按作品编号排除已玩题目，切换语言也不会重复抽到同一作品。 */
export function selectUnplayedPuzzle(puzzleIds: readonly string[], playedIds: readonly string[], currentId: string, sample = Math.random()): string | null {
  const excluded = new Set([...playedIds, currentId]);
  const candidates = [...new Set(puzzleIds)].filter((id) => !excluded.has(id));
  if (candidates.length === 0) return null;
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('随机数必须位于 [0, 1)');
  return candidates[Math.floor(sample * candidates.length)]!;
}
