/** Dirichlet 原生插屏：只在自然结局后展示，遵守首次游玩与三分钟间隔。 */
import { canShowInterstitial, type InterstitialTiming } from './ad-policy.js';
import { isForeground } from './runtime.js';
import { api } from './api.js';
import { adIntentResponseSchema, tapAdRewardResponseSchema } from '@jev/contracts';

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

/** TapTap 激励视频：完整观看后由服务端按短期意图令牌入账 +2 次开房额度。 */
export type RewardedAdResult = 'granted' | 'already_claimed' | 'daily_limit' | 'unavailable' | 'skipped';

export async function watchRewardedAd(): Promise<RewardedAdResult> {
  if (!__REWARDED_AD_UNIT_ID__ || !isForeground()) return 'unavailable';
  const intent = await api('/ads/intent', { method: 'POST' }, adIntentResponseSchema);
  const ad = tap.createRewardedVideoAd({ adUnitId: __REWARDED_AD_UNIT_ID__ });
  return new Promise<RewardedAdResult>((resolve) => {
    let settled = false;
    const finish = (result: RewardedAdResult) => { if (settled) return; settled = true; ad.destroy(); resolve(result); };
    ad.onError((error) => { console.error('[taptap:ads] 激励视频失败', error.errCode, error.errMsg); finish('unavailable'); });
    ad.onClose((result) => {
      if (!result.isEnded) { finish('skipped'); return; }
      void api('/ads/taptap/reward', { body: { token: intent.token } }, tapAdRewardResponseSchema)
        .then((value) => finish(value.result))
        .catch((error) => { console.error('[taptap:ads] 激励奖励入账失败', error); finish('unavailable'); });
    });
    void ad.load().then(() => {
      if (!isForeground()) { finish('unavailable'); return; }
      return ad.show();
    }).catch((error) => { console.error('[taptap:ads] 激励视频加载失败', error); finish('unavailable'); });
  });
}
