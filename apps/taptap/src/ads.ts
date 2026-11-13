/** Dirichlet 原生插屏：只在自然结局后展示，遵守首次游玩与三分钟间隔。 */
import { canShowInterstitial, type InterstitialTiming } from './ad-policy.js';
import { isForeground } from './runtime.js';

let timing: InterstitialTiming = { sessionStartedAt: Date.now(), completedGames: 0, lastShownAt: null, shownCount: 0 };
let current: TapInterstitialAd | null = null;

/** 广告库存与网络失败写明日志，游戏结束状态已保存，玩家可继续游玩。 */
export async function showGameEndAd(): Promise<void> {
  timing = { ...timing, completedGames: timing.completedGames + 1 };
  if (!__INTERSTITIAL_AD_UNIT_ID__ || current || !isForeground() || !canShowInterstitial(timing, Date.now())) return;
  const ad = tap.createInterstitialAd({ adUnitId: __INTERSTITIAL_AD_UNIT_ID__ }); current = ad;
  const release = () => { if (current !== ad) return; current = null; ad.destroy(); };
  ad.onClose(release);
  ad.onError((error) => { console.error('[taptap:ads]', error.errCode, error.errMsg); release(); });
  try {
    await ad.load();
    if (current !== ad) return;
    // 请求期间切到后台时释放广告，回前台后等待下一次自然结局。
    if (!isForeground()) { release(); return; }
    await ad.show();
    timing = { ...timing, lastShownAt: Date.now(), shownCount: timing.shownCount + 1 };
  }
  catch (error) { console.error('[taptap:ads] 插屏未展示', error); release(); }
}
