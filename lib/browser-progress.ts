/** 所有网页访客使用同一套页面逻辑；答题记录只存在各自浏览器。 */
export type BrowserProgressEntry = {
  question_count: number;
  last_outcome: '破解成功' | '接近真相' | '还没猜对' | '无法确定' | 'Solved' | 'Close' | 'Not yet' | 'Uncertain' | null;
  solved_at: string | null;
  last_played_at: string;
};

export type BrowserProgress = Record<string, BrowserProgressEntry>;

const PROGRESS_KEY = 'jev-browser-progress';

export function loadBrowserProgress(): BrowserProgress {
  const saved = localStorage.getItem(PROGRESS_KEY);
  return saved ? JSON.parse(saved) as BrowserProgress : {};
}

/** Jev 成功返回后再记一次提问；请求失败不计入记录。 */
export function recordBrowserQuestion(soupId: string): BrowserProgress {
  const progress = loadBrowserProgress();
  const previous = progress[soupId];
  const now = new Date().toISOString();
  progress[soupId] = {
    question_count: (previous?.question_count ?? 0) + 1,
    last_outcome: previous?.last_outcome ?? null,
    solved_at: previous?.solved_at ?? null,
    last_played_at: now,
  };
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  return progress;
}

/** 只有破解成功才标记完成；之后再猜也不会清除完成时间。 */
export function recordBrowserSolution(soupId: string, outcome: BrowserProgressEntry['last_outcome']): BrowserProgress {
  const progress = loadBrowserProgress();
  const previous = progress[soupId];
  const now = new Date().toISOString();
  progress[soupId] = {
    question_count: previous?.question_count ?? 0,
    last_outcome: outcome,
    solved_at: previous?.solved_at ?? (outcome === '破解成功' || outcome === 'Solved' ? now : null),
    last_played_at: now,
  };
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  return progress;
}
