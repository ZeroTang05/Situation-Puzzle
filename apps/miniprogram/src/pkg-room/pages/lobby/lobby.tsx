/**
 * 会客厅页（v3，逐行对齐 apps/web/src/rooms/lobby-page.tsx）：
 * 每个用户的会客厅 id 永久不变（host_user_id UNIQUE），2 秒轮询即心跳；
 * 开局后（HTTP start 成功或收到 lobby.started 推送）redirectTo 正式房间。
 * 房主：选题（跳题库带回）、开始本局、邀请（底部菜单）、踢人、公开开关、解散。
 * 非房主：离开。用户主持人：申请/审批/撤销/退出（17-USER-HOST-MODE）。
 * 小程序差异：邀请/复制链接区换成一个「邀请」按钮 + 底部菜单（InviteSheet）；
 * 解散/离开后 Taro.reLaunch 回首页。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Taro, { useDidHide, useDidShow, useRouter, useUnload } from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
// 页面在 pkg-room/pages/lobby/ 三层深度：src 级模块要 ../.. 三级；pkg-room 级模块两级
import { api, ApiError, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { queryClient } from '../../../state/query-client'
import { format } from '@jev/i18n'
import { DialogHost, Modal, useDialog } from '../../../ui/dialog'
import { Toast } from '../../../ui/toast'
import { Loading } from '../../../ui/loading'
import { goBack } from '../../../ui/back'
import { useLobbySync } from '../../room/use-lobby-sync'
import { inviteWebLink } from '../../invite-link'
import { MemberList } from '../../ui/member-list'
import { PuzzleSelection } from '../../ui/puzzle-selection'
import { VisibilityToggle } from '../../ui/visibility-toggle'
import { InviteSheet, useInviteSharePath } from '../../ui/invite-sheet'
import '../../room.css'

interface LobbySnapshot {
  lobbyId: string
  hostUserId: string
  capacity: number
  /** 下一局是否公开：true 时开局建出来的房间会出现在大厅 */
  isPublic: boolean
  members: Array<{ userId: string; nickname: string; online: boolean; isHost: boolean; isUserHost: boolean }>
  selectedPuzzle: { puzzleId: string; title: string; language: 'zh' | 'en' } | null
  /** 主持人形态：ai = Jev 主持；user = 用户主持 */
  hostMode: 'ai' | 'user'
  userHostId: string | null
  /** 待房主审核的主持人申请 */
  hostRequests: Array<{ userId: string; nickname: string }>
}

const POLL_MS = 2000

export default function Lobby(): ReactNode {
  const router = useRouter()
  const lobbyId = router.params.id ?? ''
  const dialog = useDialog()
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const me = session?.user.id ?? null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const inviteRef = useRef<string | null>(null)
  // 选题回跳参数（题库 redirectTo 回来时带上）
  const selectPuzzle = router.params.selectPuzzle ?? ''
  // 同一题只提交一次（参数实例上防重复）
  const submittedSelectRef = useRef<string | null>(null)

  const [visible, setVisible] = useState(true)

  const poll = useQuery({
    // queryKey 含 lobbyId；queryFn 内 lobbyId 为空不会被触发（enabled 兜底）
    queryKey: ['lobby', lobbyId],
    queryFn: () => api<LobbySnapshot>(`/lobbies/${lobbyId}`),
    // lobbyId 没就绪时不要发任何请求；出错后停轮询避免刷屏；页面隐藏时停轮询。
    // 不依赖 session：后端 snapshot 走 SessionGuard；用户没登录自然 401。
    refetchInterval: (query) => (visible && lobbyId !== '' && !query.state.error ? POLL_MS : false),
    enabled: lobbyId !== '',
    retry: false,
  })

  const data = poll.data ?? null
  const isHost = data !== null && me !== null && data.hostUserId === me

  // 实时推送：start() 事务成功后服务端广播 lobby.started，客户端收到后立即跳转房间。
  // 房主自己也会收到（同一 broadcastLobbyStarted 不区分身份），导航到结果一致。
  // redirectTo：lobby 是过渡态（已 closed、座位清空、邀请撤销），不应留在页面栈里被返回。
  const lobbySync = useLobbySync(lobbyId || undefined, (event) => {
    if (event.inviteToken) Taro.setStorageSync(`jev.invite.${event.roomId}`, event.inviteToken)
    void Taro.redirectTo({ url: `/pkg-room/pages/room/room?id=${event.roomId}` })
  })

  // 页面前后台：显示时重连 ws + 立即刷一次快照；隐藏/卸载时断开 ws、停轮询（ask 指定）
  useDidShow(() => {
    setVisible(true)
    lobbySync.wake()
    if (lobbyId) void queryClient.invalidateQueries({ queryKey: ['lobby', lobbyId] })
  })
  useDidHide(() => {
    setVisible(false)
    lobbySync.pause()
  })
  useUnload(() => {
    lobbySync.pause()
  })

  // 选题回跳：题库页带 selectPuzzle 回来后提交给等待室
  useEffect(() => {
    if (!selectPuzzle || !lobbyId || !isHost) return
    if (submittedSelectRef.current === selectPuzzle) return
    submittedSelectRef.current = selectPuzzle
    void api(`/lobbies/${lobbyId}/select`, { method: 'POST', body: { puzzleId: selectPuzzle, language } })
      .then(() => void queryClient.invalidateQueries({ queryKey: ['lobby', lobbyId] }))
      .catch((err: unknown) => setError(translateApiError(err, language, copy.selectPuzzleFail)))
  }, [selectPuzzle, lobbyId, isHost, language, copy.selectPuzzleFail])

  const startRound = async () => {
    if (!lobbyId || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api<{ roomId: string; inviteToken: string }>(`/lobbies/${lobbyId}/start`, { method: 'POST' })
      Taro.setStorageSync(`jev.invite.${result.roomId}`, result.inviteToken)
      // redirectTo：lobby 是过渡态（已 closed、座位清空、邀请撤销），不应留在页面栈里被返回。
      void Taro.redirectTo({ url: `/pkg-room/pages/room/room?id=${result.roomId}` })
    } catch (err) {
      setError(translateApiError(err, language, copy.startFail))
    } finally {
      setBusy(false)
    }
  }

  const goHome = () => void Taro.reLaunch({ url: '/pages/index/index' })

  const dismiss = async () => {
    if (!lobbyId || !(await dialog.confirm(copy.dismissLobbyConfirm, copy.dismissLobby))) return
    await api(`/lobbies/${lobbyId}`, { method: 'DELETE' })
    goHome()
  }

  const leave = async () => {
    if (!lobbyId) return
    await api(`/lobbies/${lobbyId}/leave`, { method: 'POST' })
    goHome()
  }

  const kick = (userId: string) => {
    if (!lobbyId) return
    void api(`/lobbies/${lobbyId}/kick`, { method: 'POST', body: { userId } })
      .then(() => void queryClient.invalidateQueries({ queryKey: ['lobby', lobbyId] }))
      .catch((err: unknown) => setError(translateApiError(err, language, copy.startFail)))
  }

  // ---------- 公开 / 私人（18-HALL-PUBLIC-ROOMS） ----------

  /** 房主切换公开状态：这是「下一局」的偏好，start 时复制进新房。幂等。 */
  const toggleVisibility = (next: boolean) => {
    if (!lobbyId || busy) return
    setBusy(true)
    setError(null)
    void api<{ isPublic: boolean }>(`/lobbies/${lobbyId}/visibility`, { method: 'POST', body: { isPublic: next } })
      .then(() => void queryClient.invalidateQueries({ queryKey: ['lobby', lobbyId] }))
      .catch((err: unknown) => setError(translateApiError(err, language, copy.visibilityFail)))
      .finally(() => setBusy(false))
  }

  // ---------- 用户主持人（17-USER-HOST-MODE） ----------

  const [hostPrompt, setHostPrompt] = useState<{ userId: string; nickname: string } | null>(null)
  const promptedRequests = useRef(new Set<string>())

  const refreshLobby = () => queryClient.invalidateQueries({ queryKey: ['lobby', lobbyId] })

  const hostRequest = () => {
    if (!lobbyId) return
    void api(`/lobbies/${lobbyId}/host/request`, { method: 'POST' })
      .then(() => void refreshLobby())
      .catch((err: unknown) => setError(translateApiError(err, language, copy.hostApplyFail)))
  }

  const hostApprove = (userId: string) => {
    if (!lobbyId) return
    void api(`/lobbies/${lobbyId}/host/approve`, { method: 'POST', body: { userId } })
      .then(() => void refreshLobby())
      .catch((err: unknown) => setError(translateApiError(err, language, copy.hostReviewFail)))
  }

  const hostReject = (userId: string) => {
    if (!lobbyId) return
    void api(`/lobbies/${lobbyId}/host/reject`, { method: 'POST', body: { userId } })
      .then(() => void refreshLobby())
      .catch((err: unknown) => setError(translateApiError(err, language, copy.hostReviewFail)))
  }

  /** 房主撤销某人的主持身份：降级为普通玩家 */
  const hostRevoke = (userId: string) => {
    if (!lobbyId) return
    void api(`/lobbies/${lobbyId}/host/revoke`, { method: 'POST', body: { userId } })
      .then(() => void refreshLobby())
      .catch((err: unknown) => setError(translateApiError(err, language, copy.hostReviewFail)))
  }

  const hostResign = () => {
    if (!lobbyId) return
    void api(`/lobbies/${lobbyId}/host/resign`, { method: 'POST' })
      .then(() => void refreshLobby())
      .catch((err: unknown) => setError(translateApiError(err, language, copy.hostResignFail)))
  }

  // 会客厅没有事件流，靠 2 秒轮询快照发现待审申请（同一申请只提示一次）
  useEffect(() => {
    if (!data || !isHost) return
    const current = new Set(data.hostRequests.map((r) => r.userId))
    for (const id of [...promptedRequests.current]) if (!current.has(id)) promptedRequests.current.delete(id)
    const next = data.hostRequests.find((r) => !promptedRequests.current.has(r.userId))
    if (!next) return
    promptedRequests.current.add(next.userId)
    setHostPrompt(next)
  }, [data, isHost])

  // ---------- 邀请（用户指定交互：底部菜单替代网页端的邀请/复制链接区） ----------

  /** 打开邀请菜单：先 POST /lobbies/:id/invite 拿当前邀请 token（网页端 copyInvite 的取 token 步骤） */
  const openInvite = async () => {
    if (!lobbyId || busy) return
    setBusy(true)
    setError(null)
    try {
      const { token } = await api<{ token: string; kind: 'lobby' }>(`/lobbies/${lobbyId}/invite`, { method: 'POST' })
      inviteRef.current = token
      setInviteToken(token)
      setInviteOpen(true)
    } catch (err) {
      setError(translateApiError(err, language, copy.startFail))
    } finally {
      setBusy(false)
    }
  }

  /** 复制网页邀请链接：小程序外的朋友从网页加入 */
  const copyInviteLink = async () => {
    const token = inviteRef.current
    if (!token) return
    await Taro.setClipboardData({ data: inviteWebLink('lobby', token) })
    setInviteCopied(true)
  }

  // 转发卡片的标题与路径（path 带当前邀请 token）
  useInviteSharePath('lobby', inviteRef)

  if (!session) {
    return (
      <View className="page">
        <View className="topbar topbar-title">
          <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
            {copy.back}
          </Button>
          <Text className="brand brand-sm">{copy.lobbyTitle}</Text>
        </View>
        <View className="panel stack login-prompt">
          <Text className="muted">{copy.needLoginForRoom}</Text>
          <Button className="btn btn-primary" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
            {copy.login}
          </Button>
        </View>
      </View>
    )
  }

  // 只有 lobbyId 就绪且查询进行中才显示加载态；空 id（坏链接）直接落到下面的错误分支
  if (poll.isPending && lobbyId !== '') {
    return (
      <View className="page page-loading">
        <Loading text={copy.loadingRound} />
      </View>
    )
  }

  // 等待室被解散 / 闲置回收 / 被移出
  if (poll.isError || !data) {
    const code = poll.error instanceof ApiError ? poll.error.code : null
    // start() 单事务会把 lobby_members 清掉，紧跟其后 broadcastLobbyStarted 推送房间；
    // 推送丢失 / ws 重连中时，snapshot 会返 FORBIDDEN。这里不再主动拉房间：
    // 后端没有"lobby → 最近房间"映射（v3 故意解耦）；真正可靠的兜底是 ws 推送。
    return (
      <View className="page">
        <Text className="error-text">{code === 'MEMBER_RESTRICTED' ? copy.kickedFromRoom : copy.lobbyDismissed}</Text>
        <Button className="btn" onClick={goHome}>
          {copy.back}
        </Button>
      </View>
    )
  }

  return (
    <View className="page">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.lobbyTitle}</Text>
      </View>

      <View className="panel stack">
        <Text className="lobby-summary">
          {format(copy.roomOf, { name: data.members.find((m) => m.isHost)?.nickname ?? '', n: data.members.length, cap: data.capacity })}
        </Text>

        <MemberList
          state={{ members: data.members, hostRequests: data.hostRequests }}
          me={me}
          isHost={isHost}
          onKick={kick}
          onRequestHost={hostRequest}
          onApproveHost={hostApprove}
          onRejectHost={hostReject}
          onRevokeHost={hostRevoke}
          onResignHost={hostResign}
        />

        {data.hostMode === 'user' && <Text className="muted">{copy.hostModeNotice}</Text>}

        {isHost ? (
          <View className="stack">
            <PuzzleSelection
              title={data.selectedPuzzle?.title ?? null}
              onPick={() => void Taro.navigateTo({ url: `/pages/library/library?mode=select&lobby=${lobbyId}&lang=${language}` })}
            />
            <Button className="btn btn-primary" disabled={busy || !data.selectedPuzzle} onClick={() => void startRound()}>
              {busy ? copy.submitting : copy.startRound}
            </Button>
            <View className="visibility-box">
              <VisibilityToggle checked={data.isPublic} disabled={busy} onChange={toggleVisibility} />
            </View>
            <View className="hint-row">
              <Button className="btn" disabled={busy} onClick={() => void openInvite()}>
                {copy.invite}
              </Button>
              <Button className="btn btn-danger" disabled={busy} onClick={() => void dismiss()}>
                {copy.dismissLobby}
              </Button>
            </View>
          </View>
        ) : (
          <View className="stack">
            {data.selectedPuzzle && (
              <Text>
                {copy.currentPuzzle}：{data.selectedPuzzle.title}
              </Text>
            )}
            <Text className="muted">{copy.lobbyWaitingHint}</Text>
            <Button className="btn" onClick={() => void leave()}>
              {copy.leaveLobby}
            </Button>
          </View>
        )}

        {inviteCopied && <Toast message={copy.inviteCopied} onDone={() => setInviteCopied(false)} />}
        {error && <Text className="error-text">{error}</Text>}
      </View>

      {/* 房主审核主持申请：批准后对方接管本局判定 */}
      <Modal
        open={hostPrompt !== null}
        onClose={() => setHostPrompt(null)}
        title={format(copy.hostRequestNotice, { name: hostPrompt?.nickname ?? '' })}
        closeLabel={copy.cancel}
      >
        <Text className="muted">{format(copy.hostRequestConfirm, { name: hostPrompt?.nickname ?? '' })}</Text>
        <View className="hint-row">
          <Button
            className="btn btn-primary"
            onClick={() => {
              const target = hostPrompt
              setHostPrompt(null)
              if (target) hostApprove(target.userId)
            }}
          >
            {copy.hostApprove}
          </Button>
          <Button
            className="btn"
            onClick={() => {
              const target = hostPrompt
              setHostPrompt(null)
              if (target) hostReject(target.userId)
            }}
          >
            {copy.hostReject}
          </Button>
        </View>
      </Modal>

      <InviteSheet open={inviteOpen} token={inviteToken} onClose={() => setInviteOpen(false)} onCopy={() => void copyInviteLink()} />

      {/* Taro 小程序 app.tsx 不上屏，每个用到 useDialog 的页面都要挂一个（弹窗在这里渲染） */}
      <DialogHost />
    </View>
  )
}
