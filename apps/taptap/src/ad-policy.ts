/** 插屏展示时机：一局海龟汤按一个关卡计算，保护首次游玩和对局间隔。 */
export interface InterstitialTiming {
  sessionStartedAt: number;
  completedGames: number;
  lastShownAt: number | null;
  shownCount: number;
}

/** 首分钟和首局结束时不展示；前三局最多一次；三分钟间隔同时覆盖首两分钟限制。 */
export function canShowInterstitial(timing: InterstitialTiming, now: number): boolean {
  if (now - timing.sessionStartedAt < 60_000 || timing.completedGames < 2) return false;
  if (timing.completedGames <= 3 && timing.shownCount > 0) return false;
  return timing.lastShownAt === null || now - timing.lastShownAt >= 180_000;
}
