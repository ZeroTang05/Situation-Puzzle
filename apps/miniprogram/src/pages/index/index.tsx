/**
 * 首页（代码级对齐 apps/web/src/lobby/home-page.tsx）：
 * topbar 品牌区（图标 + 问号玩法入口 + 登录态入口）、hero 卡（主入口单人 / 多人，
 * 次要入口题库 / 大厅 / 我的作品 / 好友）、进行中的房间、开房额度行、玩法介绍走深海弹窗。
 * 未登录点多人 / 大厅 / 作品 / 好友先去登录页，登录返回后由用户再点一次。
 * 邀请链路：分享链接 ?ref= 进站捕获邀请码（页面参数 + 启动参数双来源），登录后自动领取。
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { Button, Image, Text, View } from '@tarojs/components'
import { api, translateApiError } from '../../api/client'
import { useLanguage } from '../../state/language'
import { useJevSession } from '../../state/session'
import { captureInviteRef, claimInviteRefOnce } from '../../invite/invite-ref'
import { useInviteShare } from '../../invite/share'
import { openOrGetLobby, lobbyPath } from '../../lobby/create-lobby'
import { NotificationBell } from '../../notification/notification-bell'
import { formatDateTime } from '../../ui/dates'
import { Modal } from '../../ui/dialog'
import iconPng from '../../assets/icon.png'

export default function Index(): ReactNode {
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const router = useRouter()
  const [introOpen, setIntroOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // 开房额度与当前加入的房间分别读取（与 web 首页同源接口，未登录不拉）
  const entitlement = useQuery({
    queryKey: ['entitlement-preview'],
    queryFn: () => api<{ sponsored: boolean; freeRemaining: number }>('/rooms/entitlement-preview'),
    enabled: session !== null,
    retry: false,
  })
  const activeRooms = useQuery({
    queryKey: ['me-active-rooms'],
    queryFn: () => api<{ rooms: Array<{ roomId: string; createdAt: string; title: string | null }> }>('/me/active-rooms'),
    enabled: session !== null,
    retry: false,
  })
  const joinedRooms = activeRooms.data?.rooms ?? []

  // 分享链接进入：页面参数与启动参数都可能是携带点，合法的邀请码才落本地
  captureInviteRef(router.params)
  captureInviteRef(Taro.getEnterOptionsSync().query)
  useDidShow(() => {
    // 每次回到前台重试领取：覆盖「未登录进站 → 登录返回首页」的路径
    void claimInviteRefOnce(session !== null)
    // 从房间回来时刷新进行中的房间与额度
    if (session) {
      void activeRooms.refetch()
      void entitlement.refetch()
    }
  })
  useInviteShare()

  const go = (url: string) => void Taro.navigateTo({ url })
  /** 需要登录的入口：未登录先去登录页 */
  const goAuthed = (url: string) => go(session ? url : '/pages/login/login')

  /** 多人：拿到（或新建）我的会客厅后进入 */
  const openMulti = () => {
    if (!session) {
      go('/pages/login/login')
      return
    }
    setCreating(true)
    setCreateError(null)
    openOrGetLobby()
      .then((lobby) => go(lobbyPath(lobby.lobbyId)))
      .catch((err: unknown) => setCreateError(translateApiError(err, language, copy.createRoomFail)))
      .finally(() => setCreating(false))
  }

  return (
    <View className="page">
      <View className="topbar">
        <View className="brand brand-identity">
          <Image className="brand-mark" src={iconPng} />
          <Text>{copy.brand}</Text>
        </View>
        <View className="topbar-actions">
          <Button className="btn btn-ghost btn-sm help-btn" onClick={() => setIntroOpen(true)}>?</Button>
          <NotificationBell />
          {session ? (
            <Button className="btn btn-ghost btn-sm" onClick={() => go('/pages/me/me')}>
              {copy.me}
            </Button>
          ) : (
            <Button className="btn btn-sm" onClick={() => go('/pages/login/login')}>
              {copy.login}
            </Button>
          )}
        </View>
      </View>

      <View className="hero-card">
        <Text className="accent tagline">{copy.tagline}</Text>
        <View className="hero-actions">
          <Button className="btn btn-primary btn-lg" onClick={() => go('/pages/library/library')}>
            {copy.solo}
          </Button>
          <Button className="btn btn-lg" disabled={creating} onClick={openMulti}>
            {creating ? copy.creating : session ? copy.multi : `${copy.multi}（${copy.login}）`}
          </Button>
        </View>
        {/* 次要入口单独一行小按钮：主次分明 */}
        <View className="hero-secondary">
          <Button className="btn btn-sm" onClick={() => go('/pages/library/library')}>
            {copy.library}
          </Button>
          <Button className="btn btn-sm" onClick={() => goAuthed('/pkg-room/pages/hall/hall')}>
            {copy.hall}
          </Button>
          <Button className="btn btn-sm" onClick={() => goAuthed('/pkg-creation/pages/list/list')}>
            {copy.myWorks}
          </Button>
          <Button className="btn btn-sm" onClick={() => goAuthed('/pkg-social/pages/friends/friends')}>
            {copy.friends}
          </Button>
        </View>
      </View>

      {createError && <Text className="error-text">{createError}</Text>}

      {joinedRooms.length > 0 && (
        <View className="panel home-rooms">
          <Text className="home-section-title">{copy.activeRooms}</Text>
          {joinedRooms.map((room) => (
            <View key={room.roomId} className="home-room-row" onClick={() => go(`/pkg-room/pages/room/room?id=${room.roomId}`)}>
              <Text className="home-room-title">{room.title ?? formatDateTime(room.createdAt, language)}</Text>
              <Text className="home-room-chevron">›</Text>
            </View>
          ))}
        </View>
      )}

      {session && entitlement.data && (
        <View className="panel entitlement-row">
          <Text className="muted">{copy.freeRooms}</Text>
          <Text className="entitlement-value">
            {entitlement.data.sponsored ? copy.unlimited : `${entitlement.data.freeRemaining} / 10`}
          </Text>
          {entitlement.data.sponsored && <Text className="verdict-badge verdict-solved">{copy.sponsored}</Text>}
        </View>
      )}

      <Modal open={introOpen} onClose={() => setIntroOpen(false)} title={copy.howToPlay} closeLabel={copy.gotIt}>
        <Text className="p">{copy.introWhat}</Text>
        <Text className="p">{copy.introGoal}</Text>
        <Text className="p">{copy.introAdvice}</Text>
      </Modal>
    </View>
  )
}
