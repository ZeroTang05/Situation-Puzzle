/**
 * 私聊页（代码级对齐 apps/web/src/social/chat-page.tsx）：消息气泡 + 顶栏「来一局」。
 *
 * 「来一局」是发起一局：服务端建房开局并给对方发一张邀请卡片，
 * 对方不会自动进房，卡片上的「进入房间」是邀请链接，点了才进。
 * 消息每 3 秒轮询一次；拉完新消息顺手推进已读水位（同一 seq 不重复上报）。
 * 小程序差异：会话 id 从页面参数 ?id= 取；消息区用 ScrollView，新消息到来时
 * scrollIntoView 到最后一条（web 直接改 scrollTop）；页面被压在栈下 / 切后台时
 * 停止轮询，回到前台立刻重拉（useDidShow / useDidHide）；错误与提示走顶部悬浮 Toast。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Taro, { useDidHide, useDidShow, useRouter } from '@tarojs/taro'
import { Button, Input, ScrollView, Text, View } from '@tarojs/components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DmMessageKind, RoomStatus } from '@jev/contracts'
import { DM_TEXT_MAX } from '@jev/contracts'
import { format, type Language } from '@jev/i18n'
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { goBack } from '../../../ui/back'
import { Toast } from '../../../ui/toast'
import '../../social.css'

interface DmMessage {
  id: string
  conversationId: string
  seq: number
  senderUserId: string
  senderNickname: string
  kind: DmMessageKind
  text: string
  roomId: string | null
  /** 邀请卡片背后房间的状态：null = 房间已不存在 */
  roomStatus: RoomStatus | null
  inviteToken: string | null
  peerJoined: boolean
  createdAt: string
}

const POLL_MS = 3000

/** 气泡时间：只到分钟。 */
function messageTime(iso: string, language: Language): string {
  return new Date(iso).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
}

/** scroll-into-view 锚点：微信要求 id 以字母开头，uuid 可能以数字开头，统一加前缀 */
function messageAnchor(id: string): string {
  return `msg-${id}`
}

export default function Chat(): ReactNode {
  const { copy, language } = useLanguage()
  const router = useRouter()
  const conversationId = router.params.id ?? ''
  const { session } = useJevSession()
  const queryClient = useQueryClient()

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 页面在前台才轮询：被压在栈下（进了房间 / 邀请页）或切后台时停掉
  const [visible, setVisible] = useState(true)
  const [scrollAnchor, setScrollAnchor] = useState('')
  const markedSeqRef = useRef(-1)

  const enabled = conversationId !== '' && session !== null

  // 顶栏标题是对方昵称
  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api<{ conversation: { conversationId: string; peerUserId: string; peerNickname: string } }>(`/conversations/${conversationId}`),
    enabled,
    retry: false,
  })
  const peerNickname = conversation.data?.conversation.peerNickname ?? null

  const messages = useQuery({
    queryKey: ['conversation-messages', conversationId],
    queryFn: () => api<{ messages: DmMessage[] }>(`/conversations/${conversationId}/messages`),
    enabled,
    refetchInterval: (q) => (q.state.error || !visible ? false : POLL_MS),
    retry: false,
  })

  useDidShow(() => {
    setVisible(true)
    // 回到前台立即补一次，不等下一个轮询周期（从房间 / 邀请页返回时卡片状态可能已变）
    if (enabled) void messages.refetch()
  })
  useDidHide(() => setVisible(false))

  // 按会话内序号排序：服务端已按 seq 升序返回，这里再排一次保证气泡顺序与已读水位口径一致
  const list = [...(messages.data?.messages ?? [])].sort((a, b) => a.seq - b.seq)
  const myUserId = session?.user.id ?? null

  // 新消息到达时推进已读水位；同一个 seq 不重复上报。
  useEffect(() => {
    if (!enabled) return
    const items = [...(messages.data?.messages ?? [])].sort((a, b) => a.seq - b.seq)
    const last = items[items.length - 1]
    if (!last || last.seq <= markedSeqRef.current) return
    markedSeqRef.current = last.seq
    void api<{ lastReadSeq: number; unreadCount: number }>(`/conversations/${conversationId}/read`, {
      method: 'POST',
      body: { lastReadSeq: last.seq },
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversations'] }))
      .catch(() => {
        // 已读水位推进失败不影响阅读：退回一格，下一轮轮询再试
        markedSeqRef.current = last.seq - 1
      })
  }, [enabled, conversationId, messages.data, queryClient])

  // 新消息滚到底部：把 ScrollView 的 scroll-into-view 指向最后一条消息
  useEffect(() => {
    const items = messages.data?.messages ?? []
    const last = items.reduce<DmMessage | null>((acc, item) => (acc === null || item.seq > acc.seq ? item : acc), null)
    if (last) setScrollAnchor(messageAnchor(last.id))
  }, [messages.data])

  const send = async () => {
    const body = text.trim()
    if (!body || sending || !enabled) return
    setSending(true)
    setError(null)
    try {
      await api<{ message: DmMessage }>(`/conversations/${conversationId}/messages`, { method: 'POST', body: { text: body } })
      setText('')
      await messages.refetch()
      await queryClient.invalidateQueries({ queryKey: ['conversations'] })
    } catch (err) {
      setError(translateApiError(err, language, copy.chatSendFail))
    } finally {
      setSending(false)
    }
  }

  // 来一局：只发起一局并把邀请卡片发给对方，不代替对方进房
  const startGame = async () => {
    if (starting || !enabled) return
    setStarting(true)
    setError(null)
    try {
      await api<{ roomId: string; inviteToken: string; message: DmMessage }>(`/conversations/${conversationId}/start-room`, {
        method: 'POST',
        body: { language: language === 'zh' ? 'zh' : 'en' },
      })
      setNotice(copy.chatInviteSent)
      await messages.refetch()
    } catch (err) {
      setError(translateApiError(err, language, copy.chatStartGameFail))
    } finally {
      setStarting(false)
    }
  }

  /** 卡片「进入房间」：走邀请落地页，与网页端 /room/invite/:token 同一条链路 */
  const enterRoom = (inviteToken: string) => {
    void Taro.navigateTo({ url: `/pkg-room/pages/invite/invite?kind=room&token=${encodeURIComponent(inviteToken)}` })
  }

  const topbar = (
    <View className={session === null ? 'topbar topbar-title' : 'topbar topbar-title topbar-wide-actions'}>
      <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack('/pkg-social/pages/friends/friends')}>
        {copy.back}
      </Button>
      <Text className="brand brand-sm">{peerNickname ?? copy.chatTitle}</Text>
      {/* 未登录没有可发起的对局：不渲染右列，回落基础网格让标题居中 */}
      {session !== null && (
        <View className="topbar-actions topbar-tail">
          <Button className="btn btn-sm" disabled={starting || !enabled} onClick={() => void startGame()}>
            {copy.chatStartGame}
          </Button>
        </View>
      )}
    </View>
  )

  // 未登录：web 端由 RequireSession 跳登录页；小程序改引导卡，登录返回后自动加载
  if (session === null) {
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

  return (
    <View className="page page-full">
      {topbar}

      <ScrollView className="chat-thread" scrollY scrollIntoView={scrollAnchor} scrollWithAnimation enhanced showScrollbar={false}>
        <View className="chat-thread-inner">
          {messages.isPending ? (
            <Text className="muted">{copy.loadingRound}</Text>
          ) : messages.isError ? (
            <Text className="error-text">{translateApiError(messages.error, language, copy.chatMessagesLoadFail)}</Text>
          ) : list.length === 0 ? (
            <Text className="muted">{copy.chatEmpty}</Text>
          ) : (
            list.map((msg) => (
              <View key={msg.id} id={messageAnchor(msg.id)} className={`chat-msg${msg.senderUserId === myUserId ? ' is-mine' : ' is-peer'}`}>
                {msg.kind === 'room_invite' ? (
                  <View className="chat-card">
                    <Text className="chat-card-text">{format(copy.chatRoomInvite, { title: msg.text })}</Text>
                    {/* 卡片按钮按房间当前状态变化：归档 / 已不存在 → 「房间已结束」 */}
                    {msg.roomStatus === null || msg.roomStatus === 'closed' ? (
                      <Text className="chat-card-state">{copy.chatRoomEnded}</Text>
                    ) : msg.inviteToken ? (
                      <Button className="btn btn-sm btn-primary" onClick={() => enterRoom(msg.inviteToken!)}>
                        {copy.chatEnterRoom}
                      </Button>
                    ) : null}
                    {msg.roomStatus !== null && msg.roomStatus !== 'closed' && !msg.peerJoined && msg.senderUserId === myUserId && (
                      <Text className="chat-card-state">{copy.chatWaitingPeer}</Text>
                    )}
                  </View>
                ) : (
                  <Text className="chat-bubble">{msg.text}</Text>
                )}
                <Text className="chat-msg-meta">{messageTime(msg.createdAt, language)}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      <View className="chat-input-row">
        <Input
          className="field chat-input"
          type="text"
          confirmType="send"
          // weapp Input 默认 maxlength=140，契约上限是 1000：显式放开
          maxlength={DM_TEXT_MAX}
          value={text}
          placeholder={copy.chatInputPlaceholder}
          onInput={(e) => setText(e.detail.value)}
          onConfirm={() => void send()}
        />
        <Button className="btn btn-primary" disabled={sending || text.trim().length === 0} onClick={() => void send()}>
          {copy.chatSend}
        </Button>
      </View>

      {error && <Toast message={error} tone="error" durationMs={4000} onDone={() => setError(null)} />}
      {notice && <Toast message={notice} onDone={() => setNotice(null)} />}
    </View>
  )
}
