/**
 * 邀请底部菜单（用户指定的邀请交互）：遮罩 + 底部面板（深海色系，样式在 room.css）。
 *
 * - 「邀请微信好友」必须是 <Button openType="share">：微信规定只有这种按钮或右上角菜单
 *   能发起转发，API 调不起分享卡片；转发内容由页面的 useShareAppMessage 提供。
 * - 「复制链接」由调用方写入剪贴板并提示。
 * - 底部「取消」。点任意项后关闭菜单。
 */
import type { ReactNode } from 'react'
import { Button, View } from '@tarojs/components'
import { useShareAppMessage } from '@tarojs/taro'
import { useLanguage } from '../../state/language'
import { currentInviteCode } from '../../invite/share'
import { roomText } from '../room-copy'

/** 页面级分享注册（会客厅页 / 房间页各调一次）：转发路径带当前邀请 token 与邀请码。 */
export function useInviteSharePath(kind: 'lobby' | 'room', tokenRef: { current: string | null }): void {
  const { copy } = useLanguage()
  useShareAppMessage(() => {
    const token = tokenRef.current
    const code = currentInviteCode()
    const ref = code ? `&ref=${code}` : ''
    return {
      title: copy.inviteShareTitle,
      path: token
        ? `/pkg-room/pages/invite/invite?kind=${kind}&token=${encodeURIComponent(token)}${ref}`
        : '/pages/index/index',
    }
  })
}

export function InviteSheet({
  open,
  token,
  onClose,
  onCopy,
}: {
  open: boolean
  token: string | null
  onClose: () => void
  onCopy: () => void
}): ReactNode {
  const { language, copy } = useLanguage()
  const text = roomText[language]
  if (!open) return null
  return (
    <>
      <View className="invite-sheet-overlay" onClick={onClose} />
      <View className="invite-sheet">
        <Button className="btn invite-sheet-item" openType="share" onClick={onClose}>
          {text.inviteShareWechat}
        </Button>
        <Button
          className="btn invite-sheet-item"
          disabled={!token}
          onClick={() => {
            onCopy()
            onClose()
          }}
        >
          {text.inviteCopyLink}
        </Button>
        <Button className="btn btn-ghost invite-sheet-item" onClick={onClose}>
          {copy.cancel}
        </Button>
      </View>
    </>
  )
}
