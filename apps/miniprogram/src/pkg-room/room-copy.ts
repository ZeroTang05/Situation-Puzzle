/**
 * 分包本地文案：只有 @jev/i18n 里找不到现成键的少量补充（邀请底部菜单两项）。
 * 其余文案一律取 copy（@jev/i18n），与网页端同一份。
 */
import type { Language } from '@jev/i18n'

export interface RoomText {
  /** 底部菜单：转发小程序卡片给微信好友 */
  inviteShareWechat: string
  /** 底部菜单：复制网页邀请链接 */
  inviteCopyLink: string
}

export const roomText: Record<Language, RoomText> = {
  zh: {
    inviteShareWechat: '邀请微信好友',
    inviteCopyLink: '复制链接',
  },
  en: {
    inviteShareWechat: 'Share to a WeChat friend',
    inviteCopyLink: 'Copy link',
  },
}
