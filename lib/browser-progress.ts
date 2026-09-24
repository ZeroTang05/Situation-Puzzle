/** 普通网页访客的答题记录只存在当前浏览器，不在后端创建用户或会话。 */
export type BrowserProgressEntry = {
  question_count: number;
  last_outcome: '破解成功' | '接近真相' | '还没猜对' | '无法确定' | null;
  solved_at: string | null;
  last_played_at: string;
};

export type BrowserProgress = Record<string, BrowserProgressEntry>;

const BROWSER_ID_KEY = 'jev-browser-id';
const PROGRESS_KEY_PREFIX = 'jev-browser-progress-';

/** 首次访问时建立本机标识；同一浏览器再次打开时沿用它。 */
function progressKey(): string {
  let browserId = localStorage.getItem(BROWSER_ID_KEY);
  if (!browserId) {
    browserId = crypto.randomUUID();
    localStorage.setItem(BROWSER_ID_KEY, browserId);
  }
  return `${PROGRESS_KEY_PREFIX}${browserId}`;
}

export function loadBrowserProgress(): BrowserProgress {
  const saved = localStorage.getItem(progressKey());
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
  localStorage.setItem(progressKey(), JSON.stringify(progress));
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
    solved_at: previous?.solved_at ?? (outcome === '破解成功' ? now : null),
    last_played_at: now,
  };
  localStorage.setItem(progressKey(), JSON.stringify(progress));
  return progress;
}
