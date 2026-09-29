/** 单人记录按题目与语言恢复，语言之间保留各自的进度。 */
export function latestSessionInLanguage<T extends { language: 'zh' | 'en'; startedAt: number }>(rows: T[], language: 'zh' | 'en'): T | undefined {
  return rows.filter((row) => row.language === language).sort((a, b) => b.startedAt - a.startedAt)[0];
}
