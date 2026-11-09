/**
 * 邀请落地页（对齐 apps/web/src/rooms/invite-page.tsx）：
 * 展示房间/等待室信息，登录后加入。kind=lobby|room 各自走固定的后端 endpoint，无 fallback。
 * 小程序差异：
 * - 分享链接参数 kind/token/ref 由 useRouter().params 提供；进页面先用 captureInviteRef
 *   捕获 ref 参数（分享带邀请码，登录后领奖励）；
 * - 未登录 navigateTo 登录页；登录成功返回后 useJevSession 的 useDidShow 重拉会话，
 *   本页继续预览并自动入房；
 * - 入房成功 redirectTo（邀请页通常是分享进入的落地页，不留在栈里）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
// 页面在 pkg-room/pages/invite/ 三层深度：src 级模块要 ../.. 三级
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { format } from '@jev/i18n'
import { captureInviteRef } from '../../../invite/invite-ref'
import { goBack } from '../../../ui/back'
import '../../room.css'

interface LobbyPreview {
  lobbyId: string
  hostNickname: string
  memberCount: number
  capacity: number
}

interface RoomPreview {
  roomId: string
  status: 'playing' | 'closed'
  capacity: number
  memberCount: number
  hostNickname: string
  currentPuzzleTitle: string | null
}

export default function Invite(): ReactNode {
  const router = useRouter()
  const kindParam = router.params.kind
  const kind: 'lobby' | 'room' | null = kindParam === 'lobby' || kindParam === 'room' ? kindParam : null
  const token = router.params.token ?? ''
  const { copy, language } = useLanguage()
  const { session, isPending } = useJevSession()
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 分享链接 ?ref=CODE：合法的邀请码落本地，登录后自动领取（奖励 +5 发给邀请人）
  captureInviteRef(router.params)

  const preview = useQuery({
    queryKey: ['invite', kind, token],
    queryFn: (): Promise<LobbyPreview | RoomPreview> => {
      if (!token || !kind) throw new Error('invite params not ready')
      return kind === 'lobby'
        ? api<LobbyPreview>(`/invites/lobby/${token}`)
        : api<RoomPreview>(`/invites/room/${token}`)
    },
    // 预览接口需要登录态：未登录直接去登录页，别拿 401 当成「链接无效」
    enabled: !!session && !!kind && !!token,
    retry: false,
  })

  // 未登录：去登录页（登录成功后 navigateBack 回到本页，useJevSession 在 onShow 重拉会话）
  useEffect(() => {
    if (isPending || session) return
    void Taro.navigateTo({ url: '/pages/login/login' })
  }, [isPending, session])

  const attempted = useRef<string | null>(null)
  // 登录返回后自动提交加入命令：lobby 邀请 join → 跳等待室；room 邀请 join → 跳房间。
  useEffect(() => {
    if (!session || !token || !kind || !preview.data || attempted.current === `${kind}:${token}`) return
    if (kind === 'room' && (preview.data as RoomPreview).status === 'closed') return
    attempted.current = `${kind}:${token}`
    void join()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- join 是渲染期闭包，与 web 版一致
  }, [session, token, kind, preview.data])

  const join = async () => {
    if (!token || !kind) return
    setJoining(true)
    setError(null)
    try {
      if (kind === 'lobby') {
        const result = await api<{ lobbyId: string }>('/lobbies/join', { method: 'POST', body: { token } })
        void Taro.redirectTo({ url: `/pkg-room/pages/lobby/lobby?id=${result.lobbyId}` })
      } else {
        const result = await api<{ roomId: string; rejoined: boolean }>('/rooms/join', { method: 'POST', body: { token } })
        void Taro.redirectTo({ url: `/pkg-room/pages/room/room?id=${result.roomId}` })
      }
    } catch (err) {
      setError(translateApiError(err, language, copy.invitePreviewFail))
    } finally {
      setJoining(false)
    }
  }

  // 未登录时正在跳登录页：显示加载态，不闪「链接无效」
  if (isPending || !session) return <View className="page page-loading"><Text className="muted">{copy.loadingRound}</Text></View>
  // kind/token 缺失（坏链接）：直接判无效，不进加载态（此时查询被禁用，isPending 恒真）
  if (!kind || !token) {
    return (
      <View className="page">
        <Text className="error-text">{copy.inviteInvalid}</Text>
        <Button className="btn" onClick={() => goBack()}>
          {copy.back}
        </Button>
      </View>
    )
  }
  if (preview.isPending) return <View className="page page-loading"><Text className="muted">{copy.loadingRound}</Text></View>
  if (preview.isError || !preview.data) {
    return (
      <View className="page">
        <Text className="error-text">{copy.inviteInvalid}</Text>
        <Button className="btn" onClick={() => goBack()}>
          {copy.back}
        </Button>
      </View>
    )
  }

  const data = preview.data
  const hostNickname = data.hostNickname
  const memberCount = data.memberCount
  const capacity = data.capacity

  return (
    <View className="page">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
          {copy.back}
        </Button>
        <Text className="brand">{copy.brand}</Text>
      </View>
      <View className="panel stack">
        <Text className="h2">{kind === 'lobby' ? copy.lobbyTitle : copy.waitingRoom}</Text>
        <Text>{format(copy.roomOf, { name: hostNickname, n: memberCount, cap: capacity })}</Text>
        {kind === 'room' && (data as RoomPreview).currentPuzzleTitle && (
          <Text className="muted">{format(copy.playingRoom, { title: (data as RoomPreview).currentPuzzleTitle! })}</Text>
        )}
        {kind === 'room' && (data as RoomPreview).status === 'closed' ? (
          <Text className="error-text">{copy.roomClosedHint}</Text>
        ) : (
          <Button className="btn btn-primary" disabled={joining} onClick={() => void join()}>
            {joining ? copy.joining : copy.joinRoom}
          </Button>
        )}
        {error && <Text className="error-text">{error}</Text>}
      </View>
    </View>
  )
}
