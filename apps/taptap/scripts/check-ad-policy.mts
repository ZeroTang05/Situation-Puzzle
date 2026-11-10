/** 只验证插屏时间和局数规则，不创建广告对象或模拟 TapTap 宿主。 */
import assert from 'node:assert/strict';
import { canShowInterstitial, type InterstitialTiming } from '../src/ad-policy.js';

let checks = 0;
function check(timing: InterstitialTiming, now: number, expected: boolean, label: string): void {
  assert.equal(canShowInterstitial(timing, now), expected, label);
  checks++;
  console.log(`通过：${label}`);
}

const first: InterstitialTiming = { sessionStartedAt: 1_000_000, completedGames: 1, lastShownAt: null, shownCount: 0 };
check(first, 1_600_000, false, '首次结束一局，即使超过一分钟也不展示');
const second = { ...first, completedGames: 2 };
check(second, 1_059_999, false, '首分钟内连续结束多局仍不展示');
check(second, 1_060_000, true, '满一分钟且已结束第二局后可以首次展示');
const shown = { ...second, lastShownAt: 1_060_000, shownCount: 1 };
check({ ...shown, completedGames: 4 }, 1_119_999, false, '首次启动两分钟内最多展示一条');
check({ ...shown, completedGames: 3 }, 1_600_000, false, '前三局最多展示一条，即使间隔足够');
check({ ...shown, completedGames: 4 }, 1_239_999, false, '第四局结束时距离上次不足三分钟不展示');
check({ ...shown, completedGames: 4 }, 1_240_000, true, '第四局结束且间隔满三分钟后可展示');
check({ ...second, completedGames: 3 }, 1_600_000, true, '前三局尚未展示过时可以展示一条');
check({ ...shown, completedGames: 10 }, 1_050_000, false, '系统时钟回拨时不提前展示');
console.log(`全部 ${checks} 项插屏时机检查通过；真实广告加载、展示和关闭仍待真机。`);
