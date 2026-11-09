/**
 * 通知铃铛（主包组件，代码级对齐 apps/web/src/social/notification-bell.tsx；
 * 小程序侧目录叫 notification/，避免与分包目录 pkg-social/ 的「social」一词撞车）：
 * 顶栏入口 + 未读角标。未登录不发请求；未读数每 10 秒轮询一次；
 * 页面隐藏时停止轮询（useDidShow/useDidHide 挂在所在页面的生命周期上），
 * 回到前台立刻补一次再恢复轮询。点击进入通知中心。
 * 样式：按钮壳复用 app.css 的 btn/btn-ghost/btn-sm，铃铛与角标是本目录 css。
 */
import { useState, type ReactNode } from 'react'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useJevSession } from '../state/session'
import { useLanguage } from '../state/language'
import './notification-bell.css'

const POLL_MS = 10000

export function NotificationBell({ onNavigate }: { onNavigate?: () => void }): ReactNode {
  const { copy } = useLanguage()
  const { session } = useJevSession()
  // 页面在前台才轮询：切后台或页面被压栈时停掉
  const [visible, setVisible] = useState(true)

  const unread = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api<{ unread: number }>('/notifications/unread-count'),
    enabled: session !== null && visible,
    refetchInterval: POLL_MS,
    retry: false,
  })

  useDidShow(() => {
    setVisible(true)
    // 回前台先补一次未读数，不等下一个 10 秒周期
    if (session !== null) void unread.refetch()
  })
  useDidHide(() => setVisible(false))

  const count = unread.data?.unread ?? 0

  return (
    <Button
      className="btn btn-ghost btn-sm notification-bell"
      ariaLabel={copy.notifications}
      onClick={() => {
        onNavigate?.()
        void Taro.navigateTo({ url: '/pkg-social/pages/notifications/notifications' })
      }}
    >
      <Text ariaHidden>🔔</Text>
      {count > 0 && <View className="notification-badge">{count > 99 ? '99+' : count}</View>}
    </Button>
  )
}
