/** 题库卡片的紧凑票数；千位以上保留一位小数并向下取整。 */
export function compactVoteCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = Math.floor(count / 100) / 10;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
}
