/**
 * 邀请链接参数（Taro storage 版）：
 * 从分享路径 `?ref=CODE` 进站时存本地，登录后静默领取（奖励 +5 发给邀请人）。
 * 与 web 端 apps/web/src/me/invite-ref.ts 同构，差异只在存储介质。
 */
import Taro from '@tarojs/taro'
import { api } from '../api/client'

const REF_KEY = 'jev.mp.inviteRef'
/** 与 @jev/domain INVITE_CODE_PATTERN 同步：8 位、去易混字符的大写表 */
const REF_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/

/** 捕获启动/进页参数里的邀请码：合法才存，重复调用只覆盖不误删。 */
export function captureInviteRef(params: Record<string, string | undefined> | undefined): void {
  const ref = params?.ref
  if (!ref || !REF_PATTERN.test(ref)) return
  Taro.setStorageSync(REF_KEY, ref)
}

/**
 * 登录后领取一次：有会话且有存值才发请求；成功与失败都清掉存值，
 * 避免每次进站反复请求（服务端幂等键 invite-claim:<userId> 兜底重复）。
 */
export async function claimInviteRefOnce(loggedIn: boolean): Promise<void> {
  if (!loggedIn) return
  const ref = Taro.getStorageSync<string>(REF_KEY)
  if (!ref) return
  Taro.removeStorageSync(REF_KEY)
  try {
    await api('/invites/claim', { method: 'POST', body: { code: ref } })
  } catch (err) {
    // 已领过 / 码无效 / 邀请人达上限都无法恢复，静默即可；网络错误可重新点分享链接补领
    console.warn('[invite] 领取邀请奖励失败', err)
  }
}
