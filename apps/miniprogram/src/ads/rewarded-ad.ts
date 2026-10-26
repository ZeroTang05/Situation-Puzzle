/**
 * 激励视频广告（看广告 +2 次开房次数，docs/rebuild/21-MONETIZATION-REVISION.md）。
 *
 * 完整链路：
 *  1. 客户端 POST /ads/intent 换 5 分钟意图令牌；
 *  2. 创建激励视频广告位，令牌通过 adUnitId 追加 `?out_return_no=<token>` 透传给微信；
 *  3. 用户看完整条广告，微信流量主服务器 GET /api/v1/ads/wechat/notify（服务端验证，
 *     验签 SHA256(secret:trans_id)）→ 服务端凭令牌定位用户 → 免费池 +2 + 幂等流水；
 *  4. 客户端在 onClose(isEnded) 后延迟刷新 /me（服务端验证回调有几秒延迟）。
 *
 * 接入前置（开通流量主后替换本文件常量，其余代码不动）：
 *  - 小程序累计独立访客（UV）达 1000 后可在 mp.weixin.qq.com 开通流量主；
 *  - 创建「激励视频」广告位，把 adunit-xxx 填进 AD_UNIT_ID；
 *  - 流量主后台「服务端验证」填回调地址 https://sp.xiaobaozi.cn/api/v1/ads/wechat/notify，
 *    并设置密钥（与部署的 WECHAT_AD_CALLBACK_SECRET 一致）；
 *  - 真机验证点：out_return_no 透传是否真的出现在回调 query（adUnitId 追加参数的
 *    行为以真机为准；若不透传，需要改用 onResize/close 回调里主动上报的模式）。
 */
import Taro from '@tarojs/taro'
import { api } from '../api/client'

/** 广告位 ID：流量主开通前为空，空值时「看广告」入口提示未开通 */
const AD_UNIT_ID = ''

interface AdIntentResponse {
  token: string
  expiresIn: number
}

export type AdWatchResult = 'rewarded' | 'skipped' | 'unavailable'

/**
 * 看一条激励视频：返回 rewarded（看完，奖励由服务端回调入账）/
 * skipped（中途退出，无奖励）/ unavailable（广告位未开通或加载失败）。
 */
export async function watchRewardedAd(): Promise<AdWatchResult> {
  if (!AD_UNIT_ID) return 'unavailable'

  const intent = await api<AdIntentResponse>('/ads/intent', { method: 'POST' })
  const ad = Taro.createRewardedVideoAd({
    // out_return_no 透传：服务端验证回调里凭它定位发奖用户（真机验证点见文件头）
    adUnitId: `${AD_UNIT_ID}?out_return_no=${intent.token}`,
  })

  return new Promise<AdWatchResult>((resolve) => {
    let settled = false
    const finish = (result: AdWatchResult) => {
      if (settled) return
      settled = true
      ad.offClose(onClose)
      ad.offError(onError)
      resolve(result)
    }
    const onClose = (res: { isEnded?: boolean }) => {
      // isEnded=false 是中途关闭：看完才算奖励，服务端只认微信的验证回调
      finish(res.isEnded ? 'rewarded' : 'skipped')
    }
    const onError = (err: { errCode?: number; errMsg?: string }) => {
      console.warn('[ad] 激励视频加载/播放失败', err)
      finish('unavailable')
    }
    ad.onClose(onClose)
    ad.onError(onError)
    void ad
      .load()
      .then(() => ad.show())
      .catch((err: unknown) => {
        console.warn('[ad] 激励视频 show 失败', err)
        finish('unavailable')
      })
  })
}
