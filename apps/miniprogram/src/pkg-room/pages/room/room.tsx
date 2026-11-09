/**
 * 房间页（逐行对齐 apps/web/src/rooms/room-page.tsx）：
 * 游戏区（成对问答、讨论、提示、还原）与结算，成员管理与邀请。
 * 组队阶段在等待室页；本页从开局后的快照开始。所有写操作走 HTTP 命令。
 * 用户主持人模式（17-USER-HOST-MODE）：主持视角判定（是/否/无关；破解成功/接近真相/还没猜对）
 * 与 GET /rounds/:id/host-view 的汤底视角。
 * 小程序差异：
 * - 实时流由 useRoomSync 提供（SocketTask 版）；页面隐藏/卸载 pause 关连接、显示 wake 重连；
 * - 邀请/复制链接区换成一个「邀请」按钮 + 底部菜单（InviteSheet）；
 * - 成员管理面板是固定悬浮卡片 + 遮罩（点遮罩收起，对应 web 的点外部收起）；
 * - 聊天区用 ScrollView + scrollIntoView 锚点滚到底（web 的 scrollIntoView 等价物）；
 * - 解散/离开/被踢后 Taro.reLaunch 回首页。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Taro, { useDidHide, useDidShow, useRouter, useUnload } from '@tarojs/taro'
import { Button, Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
// 页面在 pkg-room/pages/room/ 三层深度：src 级模块要 ../.. 三级；pkg-room 级模块两级
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { displayVerdict, format } from '@jev/i18n'
import type { HostVerdict } from '@jev/contracts'
import { useRoomSync } from '../../room/use-room-sync'
import { useRoomOutbox } from '../../room/use-room-outbox'
import type { InputMode } from '../../room/room-local'
import { HintCapsule, LargeModelToggle, useHintPlayer } from '../../../game/components'
import { confidenceLabel } from '../../../game/game-display'
import { MemberList } from '../../ui/member-list'
import { MessageDelivery } from '../../ui/message-delivery'
import { RoomShell } from '../../ui/room-shell'
import { VisibilityToggle } from '../../ui/visibility-toggle'
import { InviteSheet, useInviteSharePath } from '../../ui/invite-sheet'
import { VoteButtons } from '../../ui/vote-buttons'
import { Toast } from '../../../ui/toast'
import { DialogHost, Modal, useDialog } from '../../../ui/dialog'
import { goBack } from '../../../ui/back'
import { inviteWebLink } from '../../invite-link'
import storySea from '../../../assets/story-sea.jpg'
import '../../room.css'

export default function Room(): ReactNode {
  const router = useRouter()
  const roomId = router.params.id ?? ''
  const dialog = useDialog()
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const me = session?.user.id ?? null
  const { state, status, kicked, sendCommand, confirmResult, wake, pause } = useRoomSync(roomId, me)
  const outbox = useRoomOutbox(me, roomId, state, status, sendCommand, confirmResult)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [useLargeModel, setUseLargeModel] = useState(false)
  const tab = outbox.local?.tab ?? 'qa'
  const inputMode = outbox.local?.mode ?? 'ask'
  const text = outbox.local?.drafts[inputMode] ?? ''
  const setInputMode = (next: InputMode) => {
    void outbox
      .update((value) => ({ ...value, mode: next, tab: next === 'discussion' ? 'discuss' : 'qa' }))
      .catch(() => undefined)
  }
  const setText = (next: string) => {
    void outbox
      .update((value) => ({ ...value, drafts: { ...value.drafts, [inputMode]: next } }))
      .catch(() => undefined)
  }
  const [managementOpen, setManagementOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const inviteRef = useRef<string | null>(null)
  const atBottomRef = useRef(true)
  const anchorFlipRef = useRef(false)
  const [newMessages, setNewMessages] = useState(false)
  const [showConnection, setShowConnection] = useState(false)
  // ScrollView scrollIntoView 锚点：两个底部哨兵交替触发，保证连续滚动也生效
  const [scrollAnchor, setScrollAnchor] = useState('')
  const pendingCurrent =
    outbox.local?.pending.some((p) => p.input.type === inputMode && (p.status === 'sending' || p.status === 'confirming')) ?? false

  // 被拒绝的操作（房间已关闭等）改走悬浮条：只提示一次，不占状态槽、不挤动游戏区
  const [rejectedNotice, setRejectedNotice] = useState<string | null>(null)
  const shownRejectsRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(false)
  const pendingList = outbox.local?.pending ?? []
  const lastRejected = useMemo(() => {
    for (let index = pendingList.length - 1; index >= 0; index -= 1) {
      const item = pendingList[index]!
      if (['ask', 'solve', 'discussion'].includes(item.input.type)) continue
      if (item.status !== 'rejected') continue
      return item
    }
    return null
  }, [pendingList])
  useEffect(() => {
    if (!mountedRef.current) {
      // 首帧不弹：上一次会话遗留的拒绝记录不该在进页面时再报一遍
      mountedRef.current = true
      return
    }
    if (!lastRejected) return
    const id = lastRejected.input.clientRequestId
    if (shownRejectsRef.current.has(id)) return
    shownRejectsRef.current.add(id)
    setRejectedNotice(lastRejected.error ?? copy.confirm)
  }, [lastRejected, copy.confirm])

  // 输入框预提示：随机抽一条常见问题，给不会玩的用户一个起点（进入页面时定一次）
  const askPlaceholder = useMemo(() => {
    const list = copy.askPlaceholderExamples
    return list.length > 0 ? list[Math.floor(Math.random() * list.length)]! : copy.askPlaceholder
  }, [copy.askPlaceholderExamples, copy.askPlaceholder])

  // 邀请 token：进页面先读本地缓存（对应 web copyInvite 里读 localStorage 的取值）
  useEffect(() => {
    const saved = Taro.getStorageSync<string>(`jev.invite.${roomId}`)
    if (saved) {
      inviteRef.current = saved
      setInviteToken(saved)
    }
  }, [roomId])

  // 页面前后台：隐藏/卸载关闭连接，显示时重连（ask 指定）
  useDidShow(() => {
    wake()
  })
  useDidHide(() => {
    pause()
  })
  useUnload(() => {
    pause()
  })

  // 转发卡片的标题与路径（path 带当前邀请 token）
  useInviteSharePath('room', inviteRef)

  const run = useCallback(
    async (type: string, payload?: Record<string, unknown>, roundId?: string) => {
      if (busy || status !== 'ready') return
      setBusy(true)
      setError(null)
      try {
        const result = await outbox.submit({
          type,
          ...(payload !== undefined ? { payload } : {}),
          ...(roundId !== undefined ? { roundId } : {}),
          expectedControlVersion: state?.controlVersion ?? 0,
        })
        if (result?.inviteToken) {
          // 重置邀请后保存新 token，邀请菜单立即使用新链接
          Taro.setStorageSync(`jev.invite.${roomId}`, result.inviteToken)
          inviteRef.current = result.inviteToken
          setInviteToken(result.inviteToken)
        }
        return result
      } catch (err) {
        setError(translateApiError(err, language, copy.confirm /* 操作失败 fallback */))
      } finally {
        setBusy(false)
      }
    },
    [busy, status, outbox.submit, state?.controlVersion, roomId, language, copy.confirm],
  )

  const round = state?.round ?? null
  const answered = !!(round && (round.status === 'solved' || round.status === 'revealed'))
  const hints = round ? round.hints.filter(Boolean) : []
  // 提示悬浮播放器：房主解锁时展示新提示，其余角色用按钮循环翻阅已开放的提示
  const hintPlayer = useHintPlayer(hints)
  // 游玩中固定屏幕高度：题面与对话各自滚动，输入区常驻（web RoomShell 的 playing）
  const playing = !!(round && round.status === 'active' && state?.roomStatus === 'playing')

  /** 滚到聊天底部：两个底部哨兵交替作为 scrollIntoView 目标，连续触发也能滚动 */
  const goToBottom = useCallback((force: boolean) => {
    if (!force && !atBottomRef.current) return
    anchorFlipRef.current = !anchorFlipRef.current
    setScrollAnchor(anchorFlipRef.current ? 'room-chat-end-b' : 'room-chat-end')
  }, [])

  // 新回合或讨论把聊天滚到底；不在底部时给「有新消息」按钮
  useEffect(() => {
    if (atBottomRef.current) goToBottom(true)
    else setNewMessages(true)
  }, [state?.turns.length, state?.discussions.length, goToBottom])

  // 结算面板排在聊天下方（已归档页自然滚动）：主动滚过去（web answeredRef.scrollIntoView）
  useEffect(() => {
    if (answered) void Taro.pageScrollTo({ selector: '#room-chat-end', duration: 300 }).catch(() => undefined)
  }, [answered])

  useEffect(() => {
    if (status === 'ready') {
      setShowConnection(false)
      return
    }
    if (status === 'offline' || status === 'auth_required' || status === 'forbidden') {
      setShowConnection(true)
      return
    }
    const timer = setTimeout(() => setShowConnection(true), 2000)
    return () => clearTimeout(timer)
  }, [status])

  const translatedPuzzle = useQuery({
    queryKey: ['room-puzzle', round?.puzzleId, language],
    queryFn: () => api<{ title: string; surface: string }>(`/puzzles/${round!.puzzleId}?language=${language}`),
    enabled: !!round && round.language !== language,
    retry: false,
  })
  // 用 round && 显式判空：round?.language === language 的可选链比较不触发 TS 收窄
  const displayedTitle = round && round.language === language ? round.title : translatedPuzzle.data?.title
  const displayedSurface = round && round.language === language ? round.surface : translatedPuzzle.data?.surface
  const isHost = state !== null && me !== null && state.hostUserId === me
  const memberCount = state?.members.length ?? 0
  // 用户主持人形态（17-USER-HOST-MODE）：本房间由玩家主持，Jev 不再自动回答问题
  const isUserHost = state !== null && me !== null && state.userHostId === me
  const userHostMode = (state?.hostMode ?? 'ai') === 'user'
  const hostView = userHostMode && isUserHost
  /** 等待用户主持人回答的提问数 */
  const pendingHostQuestions = state?.turns.filter((t) => t.kind === 'ask' && t.status === 'queued').length ?? 0
  const [hostPrompt, setHostPrompt] = useState<{ userId: string; nickname: string } | null>(null)
  const promptedRequests = useRef(new Set<string>())

  // 房主收到主持申请时弹审核提示（同一申请只提示一次；申请消失后允许再次提示）
  useEffect(() => {
    if (!state) return
    const current = new Set(state.hostRequests.map((r) => r.userId))
    for (const id of [...promptedRequests.current]) if (!current.has(id)) promptedRequests.current.delete(id)
    if (!isHost) return
    const next = state.hostRequests.find((r) => !promptedRequests.current.has(r.userId))
    if (!next) return
    promptedRequests.current.add(next.userId)
    setHostPrompt(next)
  }, [isHost, state])

  const requestHost = useCallback(() => {
    void run('request_host')
  }, [run])
  const approveHost = useCallback(
    (userId: string) => {
      void run('approve_host', { userId })
    },
    [run],
  )
  const rejectHost = useCallback(
    (userId: string) => {
      void run('reject_host', { userId })
    },
    [run],
  )
  const revokeHost = useCallback(
    (userId: string) => {
      void run('revoke_host', { userId })
    },
    [run],
  )
  const resignHost = useCallback(() => {
    void run('resign_host')
  }, [run])
  const answerTurn = useCallback(
    (turnId: string, verdict: HostVerdict) => {
      void run('host_answer', { turnId, verdict }, state?.round?.roundId)
    },
    [run, state?.round?.roundId],
  )

  const send = async () => {
    if (!state?.round || !text.trim() || busy || pendingCurrent || status !== 'ready') return
    await run(inputMode, { text: text.trim(), ...(inputMode === 'solve' ? { useLargeModel } : {}) }, state.round.roundId)
  }

  // ---------- 邀请（用户指定交互：底部菜单替代网页端的邀请/复制链接区） ----------

  /** 打开邀请菜单：本地没有 token 时先 rotate（web copyInvite 的无 token 分支） */
  const openInvite = async () => {
    if (busy) return
    let token = inviteRef.current
    if (!token) {
      const result = await run('rotate_invite')
      token = result?.inviteToken ?? null
    }
    if (token) setInviteOpen(true)
  }

  /** 复制网页邀请链接：小程序外的朋友从网页加入 */
  const copyInviteLink = async () => {
    const token = inviteRef.current
    if (!token) return
    await Taro.setClipboardData({ data: inviteWebLink('room', token) })
    setInviteCopied(true)
  }

  const goHome = () => void Taro.reLaunch({ url: '/pages/index/index' })

  if (kicked) {
    return (
      <View className="page">
        <Text className="error-text">{copy.kickedFromRoom}</Text>
        {text !== '' && <Textarea className="field" value={text} disabled />}
        <Button className="btn" onClick={goHome}>
          {copy.back}
        </Button>
      </View>
    )
  }
  if (!session) {
    return (
      <View className="page">
        <Text className="muted">{copy.needLoginForRoom}</Text>
        <Button className="btn btn-primary" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
          {copy.login}
        </Button>
      </View>
    )
  }
  // 坏链接的空 roomId：不发请求（useRoomSync 已跳过连接），直接给错误页
  if (roomId === '') {
    return (
      <View className="page">
        <Text className="error-text">{copy.kickedFromRoom}</Text>
        <Button className="btn" onClick={goHome}>
          {copy.back}
        </Button>
      </View>
    )
  }
  if (!state) {
    return (
      <View className="page page-loading">
        <Text className="muted">{status === 'auth_required' ? copy.authExpired : status === 'offline' ? copy.offline : copy.loadingRound}</Text>
        {status === 'auth_required' && (
          <Button className="btn" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
            {copy.reconnect}
          </Button>
        )}
      </View>
    )
  }

  // 头部状态行（掉线/存储错误/进行中的非聊天操作）：任一存在即展开状态槽，收起时不顶动游戏区
  const pendingNotices = pendingList.filter((p) => !['ask', 'solve', 'discussion'].includes(p.input.type) && p.status !== 'sent')
  // 被拒绝的不进状态槽：改由悬浮条提示
  const inlineNotices = pendingNotices.filter((p) => p.status !== 'rejected')
  const hasStatus = (showConnection && status !== 'ready') || Boolean(outbox.storageError || translatedPuzzle.isError) || inlineNotices.length > 0

  /** 聊天流内容：playing 时装进 ScrollView，非 playing 时随页面自然滚动 */
  const chatStream = (
    <View className="chat-stream">
      {/* 用户主持人的「查看汤底」子页面：直接展示汤底，不弹确认框 */}
      {hostView && inputMode === 'solve' && round && <HostSecret roundId={round.roundId} />}
      {tab === 'qa' &&
        state.turns.map((turn) => (
          <View key={turn.turnId} className={`turn turn-${turn.kind}`}>
            <View className="turn-bubble">
              <Text className="turn-text">
                <Text className="turn-nickname">{turn.nickname}：</Text>
                {turn.text}
              </Text>
              {turn.status === 'queued' && <Text className="muted turn-status">{userHostMode ? copy.hostWaitingAnswer : copy.queued}</Text>}
              {turn.status === 'processing' && <Text className="muted turn-status">{copy.judging}</Text>}
              {turn.status === 'failed' && <Text className="error-text turn-status">{copy.failed}</Text>}
              {turn.status === 'succeeded' && turn.result && (
                <View className="turn-result">
                  <Text className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</Text>
                  {turn.source === 'host' && <Text className="verdict-badge verdict-uncertain">{copy.hostAnsweredByHost}</Text>}
                  {confidenceLabel(turn.confidence, language) && <Text className="confidence">{confidenceLabel(turn.confidence, language)}</Text>}
                </View>
              )}
            </View>
            {/* 用户主持人：待判定的提交底部给出快捷判定（提问：是/否/无关；还原：破解成功/接近真相/还没猜对） */}
            {hostView && turn.status === 'queued' && turn.kind === 'ask' && inputMode === 'ask' && (
              <HostVerdictButtons disabled={busy || status !== 'ready'} onAnswer={(verdict) => answerTurn(turn.turnId, verdict)} />
            )}
            {hostView && turn.status === 'queued' && turn.kind === 'solve' && inputMode === 'solve' && (
              <HostVerdictButtons disabled={busy || status !== 'ready'} onAnswer={(verdict) => answerTurn(turn.turnId, verdict)} verdicts={['solved', 'close', 'not_yet']} />
            )}
          </View>
        ))}
      {tab === 'discuss' &&
        state.discussions.map((d) => (
          <View key={d.eventId} className="turn turn-ask">
            <View className="turn-bubble">
              <Text className="turn-text">
                {/* 用户主持人标记放在昵称前面，与昵称同行 */}
                {d.userId === state.userHostId && <Text className="verdict-badge verdict-uncertain host-tag">{copy.userHost}</Text>}
                <Text className="turn-nickname">{d.nickname}：</Text>
                {d.text}
              </Text>
            </View>
          </View>
        ))}
      {outbox.local?.pending
        .filter((p) => {
          if (!['ask', 'solve', 'discussion'].includes(p.input.type) || (tab === 'discuss') !== (p.input.type === 'discussion')) return false
          return (
            !state.turns.some((t) => t.clientRequestId === p.input.clientRequestId || t.turnId === p.result?.turnId) &&
            !state.discussions.some((d) => d.clientRequestId === p.input.clientRequestId || d.eventId === p.result?.discussionId)
          )
        })
        .map((p) => {
          const kindClass = p.input.type === 'solve' ? 'turn-solve' : 'turn-ask'
          const self = state.members.find((m) => m.userId === me)
          return (
            <View className={`turn ${kindClass}`} key={p.input.clientRequestId}>
              <View className="turn-bubble">
                <Text className="turn-text">
                  {self ? <Text className="turn-nickname">{self.nickname}：</Text> : null}
                  {String(p.input.payload?.text ?? '')}
                </Text>
                <MessageDelivery status={p.status} {...(p.error !== undefined ? { error: p.error } : {})} />
              </View>
              {p.status === 'confirming' && (
                <Button className="btn btn-sm" disabled={status !== 'ready'} onClick={() => void outbox.retry(p).catch(() => undefined)}>
                  {copy.keepConfirming}
                </Button>
              )}
            </View>
          )
        })}
      {/* 底部滚动哨兵：交替作为 scrollIntoView 目标 / pageScrollTo 选择器 */}
      <View id="room-chat-end" />
      <View id="room-chat-end-b" />
    </View>
  )

  return (
    <RoomShell playing={playing}>
      {/* 游玩页顶栏：等宽两侧保持题目居中，右侧是成员数入口 */}
      <View className="topbar game-topbar">
        <View className="game-topbar-back">
          <Button className="btn btn-ghost btn-sm" onClick={() => goBack()}>
            {copy.back}
          </Button>
        </View>
        <Text className="brand brand-sm">{displayedTitle ?? copy.loadingRound}</Text>
        <View className="game-topbar-action">
          <Button className="btn btn-ghost btn-sm" onClick={() => setManagementOpen((open) => !open)}>
            {format(copy.playersCount, { n: memberCount, cap: state.capacity })}
          </Button>
        </View>
      </View>

      {hasStatus && (
        <View className="status-lines">
          {showConnection && status !== 'ready' && (
            <Text className="offline-banner">
              {status === 'auth_required' ? copy.authExpired : status === 'offline' ? copy.networkKeptDraft : copy.reconnecting}
            </Text>
          )}
          {status === 'auth_required' && (
            <Button className="btn btn-sm" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
              {copy.reconnect}
            </Button>
          )}
          {outbox.storageError && <Text className="error-text">{outbox.storageError}</Text>}
          {/* 翻译源失败提示按界面语言选键（对齐 web room-page.tsx：en 玩家说「英文版不可用」） */}
          {translatedPuzzle.isError && (
            <Text className="error-text">{language === 'zh' ? copy.translatedFail : copy.translatedFailEn}</Text>
          )}
          {inlineNotices.map((p) => (
            <View key={p.input.clientRequestId}>
              <Text className="muted">{p.status === 'sending' ? copy.operationSubmitting : copy.confirming}</Text>
              {p.status === 'confirming' && (
                <Button className="btn btn-sm" disabled={status !== 'ready'} onClick={() => void outbox.retry(p).catch(() => undefined)}>
                  {copy.keepConfirming}
                </Button>
              )}
            </View>
          ))}
        </View>
      )}
      {/* 操作反馈改为悬浮条：不挤占布局，到点自动消失 */}
      {error && <Toast message={error} tone="error" durationMs={4000} onDone={() => setError(null)} />}
      {rejectedNotice && <Toast message={rejectedNotice} tone="error" durationMs={4000} onDone={() => setRejectedNotice(null)} />}
      {/* 邀请链接已复制：悬浮提示，2 秒后自动消失 */}
      {inviteCopied && <Toast message={copy.inviteCopied} onDone={() => setInviteCopied(false)} />}

      {/* 成员管理面板：固定悬浮卡片 + 遮罩，点遮罩收起 */}
      {managementOpen && (
        <>
          <View className="room-management-mask" onClick={() => setManagementOpen(false)} />
          <View className="room-management">
            <ScrollView className="room-management-scroll" scrollY enhanced showScrollbar={false}>
              <View className="stack">
                <Text className="room-management-title">{copy.membersHeader}</Text>
                <MemberList
                  state={state}
                  me={me}
                  isHost={isHost && state.roomStatus !== 'closed'}
                  onKick={(userId) => void run('kick', { userId })}
                  onRequestHost={requestHost}
                  onApproveHost={approveHost}
                  onRejectHost={rejectHost}
                  onRevokeHost={revokeHost}
                  onResignHost={resignHost}
                />
                {isHost && state.roomStatus !== 'closed' && (
                  <>
                    <View className="visibility-box">
                      <VisibilityToggle checked={state.isPublic} disabled={busy} onChange={(next) => void run('set_visibility', { isPublic: next })} />
                    </View>
                    <View className="room-management-actions">
                      <Button
                        className="btn room-management-wide"
                        disabled={busy}
                        onClick={() => {
                          setManagementOpen(false)
                          void openInvite()
                        }}
                      >
                        {copy.invite}
                      </Button>
                      <Button className="btn" disabled={busy} onClick={() => void run('rotate_invite')}>
                        {copy.resettingInvite}
                      </Button>
                      <Button
                        className="btn btn-danger"
                        disabled={busy}
                        onClick={async () => {
                          if (await dialog.confirm(copy.closeRoomConfirm, copy.closeRoom))
                            void run('close_room').then((result) => {
                              if (result) goHome()
                            })
                        }}
                      >
                        {copy.closeRoom}
                      </Button>
                    </View>
                  </>
                )}
                {/* 离开房间收进管理面板：底部操作行只留给本局相关的操作 */}
                {state.roomStatus !== 'closed' && (
                  <Button
                    className="btn btn-ghost room-management-wide"
                    disabled={busy}
                    onClick={() =>
                      void run('leave').then((result) => {
                        if (result) goHome()
                      })
                    }
                  >
                    {copy.leave}
                  </Button>
                )}
              </View>
            </ScrollView>
          </View>
        </>
      )}

      <InviteSheet open={inviteOpen} token={inviteToken} onClose={() => setInviteOpen(false)} onCopy={() => void copyInviteLink()} />

      {/* ---------- 游戏区 ---------- */}
      {round && (
        <>
          {/* 汤面卡片：海底图铺底，徽标与汤面文字在上层滚动 */}
          <View className="story-wrap">
            <Image className="story-bg" src={storySea} mode="aspectFill" />
            <ScrollView className="story-card" scrollY enhanced showScrollbar={false}>
              <View className="story-inner">
                {round.category && (
                  <Text className="story-badge puzzle-card-category">{round.category === 'honkaku' ? copy.honkaku : copy.henkaku}</Text>
                )}
                {round.difficulty && (
                  <Text className={`story-badge puzzle-card-difficulty puzzle-card-difficulty-${round.difficulty}`}>
                    {round.difficulty === 'easy' ? copy.easy : round.difficulty === 'hard' ? copy.hard : copy.medium}
                  </Text>
                )}
                <Text className="story">{displayedSurface}</Text>
              </View>
            </ScrollView>
          </View>

          {/* 聊天区：游玩中固定高度内部滚动（提示胶囊挂在区顶，只遮对话流、不遮 mode-tabs 与输入区），其余随页面滚动 */}
          {playing ? (
            <View className="chat-area">
              {/* 提示悬浮胶囊：10 秒自动收起 */}
              <HintCapsule hints={hints} open={hintPlayer.open} index={hintPlayer.index} onIndex={hintPlayer.show} />
              <ScrollView
                className="chat room-chat"
                scrollY
                scrollIntoView={scrollAnchor}
                scrollWithAnimation
                lowerThreshold={180}
                onScroll={(e) => {
                  if (typeof e.detail.deltaY === 'number' && e.detail.deltaY < 0) atBottomRef.current = false
                }}
                onScrollToLower={() => {
                  atBottomRef.current = true
                  setNewMessages(false)
                }}
                enhanced
                showScrollbar={false}
              >
                {chatStream}
              </ScrollView>
            </View>
          ) : (
            <View className="chat room-chat-flow">{chatStream}</View>
          )}
          {playing && newMessages && (
            <View className="new-messages-row">
              <Button
                className="btn btn-sm"
                onClick={() => {
                  atBottomRef.current = true
                  setNewMessages(false)
                  goToBottom(true)
                }}
              >
                {copy.newMessages} ↓
              </Button>
            </View>
          )}

          {/* ---------- 操作行 ---------- */}
          {round.status === 'active' && (
            <View className="composer room-composer">
              {!hostView && inputMode === 'solve' && (
                <LargeModelToggle checked={useLargeModel} disabled={busy || pendingCurrent || status !== 'ready'} onChange={setUseLargeModel} />
              )}
              <View className="mode-tabs">
                <Button className={`mode-tab${inputMode === 'ask' ? ' active' : ''}`} onClick={() => setInputMode('ask')}>
                  {copy.askTab}
                </Button>
                <Button className={`mode-tab${inputMode === 'solve' ? ' active' : ''}`} onClick={() => setInputMode('solve')}>
                  {hostView ? copy.hostViewAnswer : copy.solve}
                </Button>
                <Button className={`mode-tab${inputMode === 'discussion' ? ' active' : ''}`} onClick={() => setInputMode('discussion')}>
                  {copy.discuss}
                </Button>
              </View>
              <View className="composer-row">
                {/* 用户主持人：提问页由主持形态接管；查看汤底页直接展示汤底，输入区留空；讨论页照常发言 */}
                {hostView && inputMode === 'ask' ? (
                  <Text className="muted host-mode-note">
                    {pendingHostQuestions > 0 ? `${format(copy.hostAnswerTitle, { n: pendingHostQuestions })} · ${copy.hostAnswerHint}` : copy.hostAnswerEmpty}
                  </Text>
                ) : hostView && inputMode === 'solve' ? null : (
                  <>
                    <Textarea
                      className="field composer-input"
                      value={text}
                      maxlength={inputMode === 'ask' ? 500 : inputMode === 'discussion' ? 1000 : 1500}
                      disabled={!outbox.local}
                      placeholder={inputMode === 'ask' ? askPlaceholder : inputMode === 'discussion' ? copy.discussPlaceholder : copy.solvePlaceholder}
                      onInput={(e) => setText(e.detail.value)}
                    />
                    <Button
                      className="btn btn-primary"
                      disabled={busy || pendingCurrent || status !== 'ready' || !outbox.local || !text.trim()}
                      onClick={() => void send()}
                    >
                      {busy ? copy.submitting : copy.send}
                    </Button>
                  </>
                )}
              </View>
              <View className="room-actions">
                {/* 玩家/用户主持人：房主开放提示后，用按钮循环翻阅悬浮窗里的已开放提示 */}
                {!isHost && hints.length > 0 && (
                  <Button className="btn btn-sm" onClick={() => hintPlayer.cycle()}>
                    {copy.hint} {hints.length}/3
                  </Button>
                )}
                {isHost && (
                  <>
                    <Button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => {
                        // 还有未开放的提示：开放并悬浮展示新一条；全部开放后：按钮变成循环翻阅
                        if (round.hintsRevealed < 3) {
                          void run('reveal_hint', undefined, round.roundId).then(() => hintPlayer.show(hints.length))
                        } else {
                          hintPlayer.cycle()
                        }
                      }}
                    >
                      {copy.hint} {round.hintsRevealed}/3
                    </Button>
                    <Button
                      className="btn btn-sm btn-danger"
                      onClick={async () => {
                        if (await dialog.confirm(copy.revealConfirm, copy.reveal)) void run('reveal_answer', undefined, round.roundId)
                      }}
                    >
                      {copy.reveal}
                    </Button>
                    <Button
                      className="btn btn-sm btn-ghost"
                      onClick={async () => {
                        if (await dialog.confirm(copy.endRoundConfirm, copy.endRound)) void run('end_round', undefined, round.roundId)
                      }}
                    >
                      {copy.endRound}
                    </Button>
                  </>
                )}
              </View>
            </View>
          )}
        </>
      )}

      {/* 已结束且未出汤底：输入区原位换成单个继续操作（返回走顶部返回键）；成员无可操作时不渲染 */}
      {state.roomStatus === 'closed' && !answered && (isHost || state.followupTargetRoomId) && (
        <View className="room-closed-bar">
          {state.followupTargetRoomId ? (
            // 续局新房替换旧房（v3 一房一题，旧房已归档）：新房的返回跳过旧房直接回到上一级。
            <Button className="btn btn-primary" onClick={() => void Taro.redirectTo({ url: `/pkg-room/pages/room/room?id=${state.followupTargetRoomId}` })}>
              {copy.enterNewRoom}
            </Button>
          ) : (
            // 已归档房间是过渡态：跳题库时 redirectTo 把旧房从页面栈移除，选完题回退不会落回旧房结算页。
            <Button className="btn btn-primary" onClick={() => void Taro.redirectTo({ url: `/pages/library/library?mode=select&followup=${roomId}&lang=${language}` })}>
              {copy.nextPuzzle}
            </Button>
          )}
        </View>
      )}

      {/* ---------- 结算（房间已归档：一房一题，历史保留可查） ---------- */}
      {answered && round && (
        <View className="panel stack">
          <Text className={`verdict-badge verdict-${round.status === 'solved' ? 'solved' : 'close'}`}>
            {round.status === 'solved' ? copy.solvedByTeam : copy.revealedAnswer}
          </Text>
          <AnswerBlock roundId={round.roundId} />
          {/* 结算投票：多人各账号独立投票（11-VOTES-AND-AUTHORSHIP.md §5） */}
          <VoteButtons puzzleId={round.puzzleId} session={session} initialUp={0} initialDown={0} />
          <View className="hint-row">
            {isHost && (
              // 已归档房间是过渡态：跳题库时 redirectTo 把旧房从页面栈移除。
              <Button className="btn btn-primary" onClick={() => void Taro.redirectTo({ url: `/pages/library/library?mode=select&followup=${roomId}&lang=${language}` })}>
                {copy.nextPuzzle}
              </Button>
            )}
            {state.followupTargetRoomId && (
              // 续局新房替换旧房（v3 一房一题，旧房已归档）。
              <Button className="btn btn-primary" onClick={() => void Taro.redirectTo({ url: `/pkg-room/pages/room/room?id=${state.followupTargetRoomId}` })}>
                {copy.enterNewRoom}
              </Button>
            )}
            <Button className="btn btn-ghost" onClick={() => goBack()}>
              {copy.back}
            </Button>
          </View>
        </View>
      )}

      {/* 房主审核主持申请：批准后对方接管本局判定，拒绝只清掉申请 */}
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
              if (target) approveHost(target.userId)
            }}
          >
            {copy.hostApprove}
          </Button>
          <Button
            className="btn"
            onClick={() => {
              const target = hostPrompt
              setHostPrompt(null)
              if (target) rejectHost(target.userId)
            }}
          >
            {copy.hostReject}
          </Button>
        </View>
      </Modal>
      {/* Taro 小程序 app.tsx 不上屏，每个用到 useDialog 的页面都要挂一个（弹窗在这里渲染） */}
      <DialogHost />
    </RoomShell>
  )
}

/**
 * 用户主持人的快捷判定按钮（17-USER-HOST-MODE §6.1，对齐 web room-page.tsx 的 HostVerdictButtons）：
 * 提问给「是 / 否 / 无关」，还原给「破解成功 / 接近真相 / 还没猜对」。
 */
export function HostVerdictButtons({
  onAnswer,
  disabled,
  verdicts = ['yes', 'no', 'irrelevant'],
}: {
  onAnswer: (verdict: HostVerdict) => void
  disabled?: boolean
  verdicts?: HostVerdict[]
}): ReactNode {
  const { copy, language } = useLanguage()
  return (
    <View className="host-verdict-row">
      {verdicts.map((verdict) => (
        // exactOptionalPropertyTypes：可选属性不能用 undefined 显式传，改条件展开
        <Button key={verdict} className="btn btn-sm" {...(disabled ? { disabled: true } : {})} onClick={() => onAnswer(verdict)}>
          {displayVerdict(verdict, language)}
        </Button>
      ))}
    </View>
  )
}

/** 提示列表的折叠开关：weapp 没有 details/summary，自绘展开收起 */
function HintList({ hints }: { hints: string[] }): ReactNode {
  const { copy } = useLanguage()
  const [open, setOpen] = useState(false)
  if (hints.length === 0) return null
  return (
    <View>
      <View className="hint-fold-toggle" onClick={() => setOpen((value) => !value)}>
        <Text className="muted">
          {copy.hint}（{hints.length}）
        </Text>
      </View>
      {open && hints.map((h, i) => <Text key={i} className="muted">{i + 1}. {h}</Text>)}
    </View>
  )
}

/**
 * 用户主持人的汤底视角（17-USER-HOST-MODE §4.3，对齐 web room-page.tsx 的 HostSecret）：
 * 走专用接口，服务端只放行本房间的用户主持人；汤底不进快照与事件。
 */
function HostSecret({ roundId }: { roundId: string }): ReactNode {
  const { copy } = useLanguage()
  const [answer, setAnswer] = useState<string | null>(null)
  const [hints, setHints] = useState<string[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api<{ answer: string; hints: string[] }>(`/rounds/${roundId}/host-view`)
      .then((data) => {
        if (cancelled) return
        setAnswer(data.answer)
        setHints(data.hints)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [roundId])

  if (error) return <Text className="muted">{copy.hostSecretLoadFail}</Text>
  if (!answer) return <Text className="muted">{copy.loadingRound}</Text>
  return (
    <View className="stack host-secret">
      <Text className="block-title">{copy.hostSecretTitle}</Text>
      <Text className="muted">{copy.hostSecretHint}</Text>
      <Text>{answer}</Text>
      <HintList hints={hints} />
    </View>
  )
}

/** 结算汤底（对齐 web room-page.tsx 的 AnswerBlock）：揭晓后 + 有阅读权才可读 */
function AnswerBlock({ roundId }: { roundId: string }): ReactNode {
  const { copy } = useLanguage()
  const [answer, setAnswer] = useState<string | null>(null)
  const [hints, setHints] = useState<string[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api<{ answer: string; hints: string[] }>(`/rounds/${roundId}/answer`)
      .then((data) => {
        if (cancelled) return
        setAnswer(data.answer)
        setHints(data.hints)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [roundId])

  if (error) return <Text className="muted">{copy.answerLoadFail}</Text>
  if (!answer) return <Text className="muted">{copy.loadingRound}</Text>
  return (
    <View className="stack">
      <Text className="block-title">{copy.answer}</Text>
      <Text>{answer}</Text>
      <HintList hints={hints} />
    </View>
  )
}
