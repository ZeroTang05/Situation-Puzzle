/**
 * 大厅页（逐行对齐 apps/web/src/hall/hall-page.tsx，docs/rebuild/18-HALL-PUBLIC-ROOMS.md）：
 * 列出所有公开房间（房主昵称 / 当前人数 / 当前汤题），点「加入」直接进房。
 *
 * 轮询而非 WebSocket：大厅是全局视图，没有房间级事件流；5 秒一次足够，
 * 且与服务端「每用户每分钟 60 次」的限额对齐（见 16-CONCURRENCY-LIMITS.md）。
 */
import { useRef, useState, type ReactNode } from 'react'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
// 页面在 pkg-room/pages/hall/ 三层深度：src 级模块要 ../.. 三级
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { format } from '@jev/i18n'
import { Loading } from '../../../ui/loading'
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
  // 双保险防重复进房：整行与行内按钮都会触发 join，事件冒泡时两次调用读到的
  // 还是同一个渲染闭包（joining state 尚未更新），ref 立即可见
  const joiningRef = useRef<string | null>(null)
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
    if (joiningRef.current !== null) return
    joiningRef.current = roomId
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
      joiningRef.current = null
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
          <Loading text={copy.loadingRound} />
        ) : hall.isError ? (
          // 出错即停轮询（见 useQuery 配置），给一个手动重试入口，别让用户干等
          <View className="hint-row">
            <Text className="error-text">{copy.hallLoadFail}</Text>
            <Button className="btn" onClick={() => void hall.refetch()}>
              {copy.retry}
            </Button>
          </View>
        ) : rooms.length === 0 ? (
          <Text className="muted">{copy.hallEmpty}</Text>
        ) : (
          <View className="hall-list">
            {rooms.map((room) => (
              <View
                key={room.roomId}
                className="hall-row"
                onClick={() => {
                  if (!room.full && joiningRef.current === null) void join(room.roomId)
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
                  <Button
                    className="btn btn-sm btn-primary"
                    disabled={joining !== null}
                    onClick={(event) => {
                      // 阻止冒泡到整行 onClick：否则同一此点击会触发两次 join（重复进房）
                      event.stopPropagation()
                      void join(room.roomId)
                    }}
                  >
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
