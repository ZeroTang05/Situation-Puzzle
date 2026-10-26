/**
 * 分享带邀请码：useShareAppMessage 的分享路径附加 `?ref=<邀请码>`。
 *
 * 好友点开分享进入小程序 → 首页捕获 ref 存本地 → 登录后自动领取，
 * 奖励 +5 发给分享者（docs/rebuild/21-MONETIZATION-REVISION.md）。
 * 邀请码从 /me 的 query 缓存读取（未登录或未加载则不带 ref，分享照常可用）。
 */
import { useShareAppMessage } from '@tarojs/taro'
import { queryClient } from '../state/query-client'
import { useLanguage } from '../state/language'

interface MeCache {
  invite: { code: string; invitedCount: number }
}

/** 当前用户的邀请码（缓存里有才返回，读不到给空串） */
export function currentInviteCode(): string {
  const me = queryClient.getQueryData<MeCache>(['me'])
  return me?.invite.code ?? ''
}

/**
 * 注册本页面的分享内容：标题随语言，路径带邀请码。
 * 必须在页面组件顶层调用（Taro 钩子约定）。
 */
export function useInviteShare(fallbackPath = '/pages/index/index'): void {
  const { copy } = useLanguage()
  useShareAppMessage(() => {
    const code = currentInviteCode()
    const ref = code ? `?ref=${code}` : ''
    return {
      title: copy.inviteShareTitle,
      path: `${fallbackPath}${ref}`,
      // 不传 imageUrl：缺省取页面截图，品牌首页自然出图
    }
  })
}
