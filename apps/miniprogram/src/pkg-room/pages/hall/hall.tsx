/**
 * 大厅页（逐行对齐 apps/web/src/hall/hall-page.tsx，docs/rebuild/18-HALL-PUBLIC-ROOMS.md）：
 * 列出所有公开房间（房主昵称 / 当前人数 / 当前汤题），点「加入」直接进房。
 *
 * 轮询而非 WebSocket：大厅是全局视图，没有房间级事件流；5 秒一次足够，
 * 且与服务端「每用户每分钟 60 次」的限额对齐（见 16-CONCURRENCY-LIMITS.md）。
 */
import { useState, type ReactNode } from 'react'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
// 页面在 pkg-room/pages/hall/ 三层深度：src 级模块要 ../.. 三级
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { format } from '@jev/i18n'
import { goBack } from '../../../ui/back'
import '../../room.css'

interface HallRoom {
  roomId: string
  title: string | null
  language: 'zh' | 'en' | null
  hostNickname: string
  memberCount: number
  capacity: number
  full: boolean
  status: 'waiting' | 'playing'
  createdAt: string
}

const POLL_MS = 5000

export default function Hall(): ReactNode {
  const { copy, language } = useLanguage()
  const [joining, setJoining] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 页面隐藏（进了房间等）时停轮询，回来恢复；浏览器端 react-query 自己认 document 可见性，小程序要手动管
  const [visible, setVisible] = useState(true)
  useDidShow(() => setVisible(true))
  useDidHide(() => setVisible(false))

  const hall = useQuery({
    queryKey: ['hall'],
    queryFn: () => api<{ rooms: HallRoom[] }>('/hall'),
    // 出错就停轮询，避免刷屏；页面隐藏也停；重进页面自然会重试
    refetchInterval: (query) => (visible && !query.state.error ? POLL_MS : false),
    retry: false,
  })

  const rooms = hall.data?.rooms ?? []

  const join = async (roomId: string) => {
    if (joining) return
    setJoining(roomId)
    setError(null)
    try {
      await api<{ roomId: string; joined: boolean }>(`/rooms/${roomId}/join-public`, { method: 'POST' })
      void Taro.navigateTo({ url: `/pkg-room/pages/room/room?id=${roomId}` })
    } catch (err) {
      setError(translateApiError(err, language, copy.hallLoadFail))
      // 房态可能刚变（已满 / 已关闭 / 房主切回私人）：立刻刷新一次列表
      void hall.refetch()
    } finally {
      setJoining(null)
    }
  }

  return (
    <View className="page">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.hallTitle}</Text>
      </View>

      <View className="panel stack">
        {hall.isPending ? (
          <Text className="muted">{copy.loadingRound}</Text>
        ) : hall.isError ? (
          <Text className="error-text">{copy.hallLoadFail}</Text>
        ) : rooms.length === 0 ? (
          <Text className="muted">{copy.hallEmpty}</Text>
        ) : (
          <View className="hall-list">
            {rooms.map((room) => (
              <View
                key={room.roomId}
                className="hall-row"
                onClick={() => {
                  if (!room.full && joining === null) void join(room.roomId)
                }}
              >
                <View className="hall-row-main">
                  <Text className="hall-row-title">{room.title ?? copy.hallNoTitle}</Text>
                  <View className="hall-row-meta">
                    <Text>
                      {copy.host}：{room.hostNickname}
                    </Text>
                    <Text>·</Text>
                    <Text>{format(copy.hallPlayers, { n: room.memberCount, cap: room.capacity })}</Text>
                    <Text>·</Text>
                    <Text>{room.status === 'waiting' ? copy.hallWaiting : copy.hallPlaying}</Text>
                  </View>
                </View>
                {room.full ? (
                  <Text className="verdict-badge verdict-uncertain">{copy.hallFull}</Text>
                ) : (
                  <Button className="btn btn-sm btn-primary" disabled={joining !== null} onClick={() => void join(room.roomId)}>
                    {joining === room.roomId ? copy.hallJoining : copy.hallJoin}
                  </Button>
                )}
              </View>
            ))}
          </View>
        )}

        {error && <Text className="error-text">{error}</Text>}
      </View>
    </View>
  )
}
