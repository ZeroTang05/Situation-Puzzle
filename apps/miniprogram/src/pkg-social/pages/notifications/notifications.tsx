/**
 * 通知中心（代码级对齐 apps/web/src/social/notifications-page.tsx）：
 * 站内通知列表（好友申请、私聊、房间邀请、站内信、系统公告）。
 * 标题由服务端按阅读者语言拼好，前端直接展示。
 * 点击通知：先标已读，再把网页端跳转路径换算成小程序路径后跳转
 * （换算见 ../notification-route.ts；映射不到的路径只标已读不跳）。
 * 小程序差异：未登录时显示登录引导卡；跳目标是本页（站内信 link=/notifications）时
 * navigateTo 会把当前页再压一层栈，改为只标已读不跳。
 */
import { useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { NotificationType } from '@jev/contracts'
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { goBack } from '../../../ui/back'
import { miniProgramPathOf } from '../../notification-route'
import '../../social.css'

interface NotificationItem {
  id: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
  actorUserId: string | null
  actorNickname: string | null
  conversationId: string | null
  roomId: string | null
  announcementId: string | null
  readAt: string | null
  createdAt: string
}

export default function Notifications(): ReactNode {
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const loggedIn = session !== null

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: NotificationItem[] }>('/notifications'),
    enabled: loggedIn,
    retry: false,
  })

  const list = notifications.data?.notifications ?? []

  const markAllRead = async () => {
    setError(null)
    try {
      await api<{ updated: number }>('/notifications/read', { method: 'POST', body: { all: true } })
      await queryClient.invalidateQueries({ queryKey: ['notifications'] })
    } catch (err) {
      setError(translateApiError(err, language, copy.notificationsLoadFail))
    }
  }

  /** 打开一条通知：先标已读，再按换算结果跳转（映射不到就不跳） */
  const openNotification = async (item: NotificationItem) => {
    setError(null)
    try {
      await api<{ updated: number }>('/notifications/read', { method: 'POST', body: { ids: [item.id] } })
      await queryClient.invalidateQueries({ queryKey: ['notifications'] })
    } catch (err) {
      setError(translateApiError(err, language, copy.notificationsLoadFail))
    }
    if (!item.link) return
    const target = miniProgramPathOf(item.link)
    if (target === null) return
    // 站内信的 link 就是 /notifications：已经在通知页里，再 navigateTo 会叠一层空页
    if (target === '/pkg-social/pages/notifications/notifications') return
    void Taro.navigateTo({ url: target })
  }

  const topbar = (
    <View className={loggedIn ? 'topbar topbar-title topbar-wide-actions' : 'topbar topbar-title'}>
      <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
        {copy.back}
      </Button>
      <Text className="brand brand-sm">{copy.notificationsTitle}</Text>
      {/* 未登录没有可清的未读：不渲染右列，回落基础网格让标题居中 */}
      {loggedIn && (
        <Button className="btn btn-ghost btn-sm topbar-tail" onClick={() => void markAllRead()}>
          {copy.notificationsMarkAllRead}
        </Button>
      )}
    </View>
  )

  // 未登录：web 端由 RequireSession 跳登录页；小程序改引导卡，登录返回后自动加载
  if (!loggedIn) {
    return (
      <View className="page">
        {topbar}
        <View className="panel stack login-prompt">
          <Text className="muted">{copy.meRequiresLogin}</Text>
          <Button className="btn btn-primary" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
            {copy.login}
          </Button>
        </View>
      </View>
    )
  }

  // 页面容器不带 stack：web 的 .shell 没有 flex gap，panel 贴着排
  return (
    <View className="page">
      {topbar}

      <View className="panel stack">
        {notifications.isPending ? (
          <Text className="muted">{copy.loadingRound}</Text>
        ) : notifications.isError ? (
          <Text className="error-text">{translateApiError(notifications.error, language, copy.notificationsLoadFail)}</Text>
        ) : list.length === 0 ? (
          <Text className="muted">{copy.notificationsEmpty}</Text>
        ) : (
          <View className="notification-list">
            {list.map((item) => (
              // 整卡可点：标已读 + 跳转（标已读失败不阻塞跳转，与 web 端一致）
              <View key={item.id} className={`notification-item${item.readAt === null ? ' is-unread' : ''}`} onClick={() => void openNotification(item)}>
                <Text className="notification-title">{item.title}</Text>
                {item.body && <Text className="notification-body">{item.body}</Text>}
                <Text className="notification-time">
                  {new Date(item.createdAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                </Text>
              </View>
            ))}
          </View>
        )}

        {error && <Text className="error-text">{error}</Text>}
      </View>
    </View>
  )
}
