/**
 * 好友页（代码级对齐 apps/web/src/social/friends-page.tsx）：
 * 按邮箱精确搜索站内用户、发送好友申请、处理收到的申请（同意/拒绝）、撤回发出的申请、
 * 好友列表（整行可点直达私聊；删除好友走深海弹窗二次确认）。
 * 申请-同意制：对方同意后才成为好友。
 * 小程序差异：form onSubmit 换成搜索按钮 + 键盘确认（Input onConfirm）；
 * 未登录时显示登录引导卡（web 端由路由层 RequireSession 跳登录），登录返回后
 * useJevSession 的 onShow 自动重拉会话、查询随 enabled 自动开始。
 */
import { useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Input, Text, View } from '@tarojs/components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FriendRelation } from '@jev/contracts'
import type { Copy } from '@jev/i18n'
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { DialogHost, useDialog } from '../../../ui/dialog'
import { goBack } from '../../../ui/back'
import '../../social.css'

interface FriendSearchResult {
  found: boolean
  userId: string | null
  nickname: string | null
  relation: FriendRelation
}

interface FriendSummary {
  userId: string
  nickname: string
  since: string
  /** 与该好友的会话 id：点好友名直接进这个会话 */
  conversationId: string | null
}

interface FriendRequestItem {
  requestId: string
  direction: 'incoming' | 'outgoing'
  userId: string
  nickname: string
  message: string | null
  status: 'pending' | 'accepted' | 'rejected' | 'canceled'
  createdAt: string
}

/** 关系文案：none 表示还没有关系，由调用方渲染「加好友」按钮。 */
function relationLabel(relation: FriendRelation, copy: Copy): string | null {
  switch (relation) {
    case 'self': return copy.friendsRelationSelf
    case 'friends': return copy.friendsRelationFriends
    case 'pending_outgoing': return copy.friendsRelationPendingOutgoing
    case 'pending_incoming': return copy.friendsRelationPendingIncoming
    default: return null
  }
}

export default function Friends(): ReactNode {
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const dialog = useDialog()
  const queryClient = useQueryClient()

  const [email, setEmail] = useState('')
  const [searchEmail, setSearchEmail] = useState<string | null>(null)
  const [requestSent, setRequestSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const loggedIn = session !== null

  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: FriendSummary[] }>('/friends'),
    enabled: loggedIn,
    retry: false,
  })

  const requests = useQuery({
    queryKey: ['friend-requests'],
    queryFn: () => api<{ requests: FriendRequestItem[] }>('/friends/requests'),
    enabled: loggedIn,
    retry: false,
  })

  const search = useQuery({
    queryKey: ['friend-search', searchEmail],
    queryFn: () => api<FriendSearchResult>(`/friends/search?email=${encodeURIComponent(searchEmail ?? '')}`),
    enabled: loggedIn && searchEmail !== null,
    retry: false,
  })

  const friendList = friends.data?.friends ?? []
  const pendingRequests = (requests.data?.requests ?? []).filter((item) => item.status === 'pending')
  const found = search.data?.found === true ? search.data : null
  const foundRelation = found ? relationLabel(found.relation, copy) : null

  /** 搜索：按邮箱精确查找（搜索按钮与键盘确认键共用） */
  const submitSearch = () => {
    const trimmed = email.trim()
    if (trimmed.length === 0) return
    setRequestError(null)
    setActionError(null)
    setRequestSent(false)
    setSearchEmail(trimmed)
  }

  const addFriend = async () => {
    if (sending || searchEmail === null) return
    setSending(true)
    setRequestError(null)
    try {
      await api<{ requestId: string; status: string }>('/friends/requests', { method: 'POST', body: { email: searchEmail } })
      setRequestSent(true)
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
    } catch (err) {
      setRequestError(translateApiError(err, language, copy.friendsRequestFail))
    } finally {
      setSending(false)
    }
  }

  const review = async (requestId: string, accept: boolean) => {
    if (busyId) return
    setBusyId(requestId)
    setActionError(null)
    try {
      await api<{ requestId: string; status: string }>(`/friends/requests/${requestId}/review`, { method: 'POST', body: { accept } })
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
      await queryClient.invalidateQueries({ queryKey: ['friends'] })
      // 同意后服务端建会话：会话相关缓存也要跟着刷新
      await queryClient.invalidateQueries({ queryKey: ['conversations'] })
    } catch (err) {
      setActionError(translateApiError(err, language, copy.friendsActionFail))
    } finally {
      setBusyId(null)
    }
  }

  const cancelRequest = async (requestId: string) => {
    if (busyId) return
    setBusyId(requestId)
    setActionError(null)
    try {
      await api<{ ok: boolean }>(`/friends/requests/${requestId}`, { method: 'DELETE' })
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
    } catch (err) {
      setActionError(translateApiError(err, language, copy.friendsActionFail))
    } finally {
      setBusyId(null)
    }
  }

  /** 删除好友：破坏性操作，先过深海弹窗二次确认 */
  const removeFriend = async (userId: string) => {
    if (removingId) return
    if (!(await dialog.confirm(copy.friendsRemoveConfirm, copy.friendsRemove))) return
    setRemovingId(userId)
    setActionError(null)
    try {
      await api<{ ok: boolean }>(`/friends/${userId}`, { method: 'DELETE' })
      await queryClient.invalidateQueries({ queryKey: ['friends'] })
    } catch (err) {
      setActionError(translateApiError(err, language, copy.friendsActionFail))
    } finally {
      setRemovingId(null)
    }
  }

  /** 好友名整行可点：点谁就跟谁私聊（没有会话时不可点） */
  const openChat = (friend: FriendSummary) => {
    if (friend.conversationId === null) return
    void Taro.navigateTo({ url: `/pkg-social/pages/chat/chat?id=${encodeURIComponent(friend.conversationId)}` })
  }

  const topbar = (
    <View className="topbar topbar-title">
      <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
        {copy.back}
      </Button>
      <Text className="brand brand-sm">{copy.friendsTitle}</Text>
      <View className="topbar-tail" />
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

  // 页面容器不带 stack：web 的 .shell 没有 flex gap，三个 panel 是贴着排的
  return (
    <View className="page">
      {topbar}

      {/* 搜索区：按邮箱精确查找站内用户 */}
      <View className="panel stack">
        <View className="social-search">
          <Input
            className="field social-search-input"
            type="text"
            confirmType="search"
            // 邮箱最长 254（契约 friendsSearchRequestSchema）；weapp Input 默认 maxlength=140
            maxlength={254}
            value={email}
            placeholder={copy.friendsSearchPlaceholder}
            onInput={(e) => setEmail(e.detail.value)}
            onConfirm={submitSearch}
          />
          <Button className="btn btn-primary" onClick={submitSearch}>{copy.friendsSearch}</Button>
        </View>

        {searchEmail !== null && (
          <View className="stack-sm">
            {search.isPending && <Text className="muted">{copy.loadingRound}</Text>}
            {search.isError && (
              <Text className="error-text">{translateApiError(search.error, language, copy.friendsLoadFail)}</Text>
            )}
            {search.data && !search.data.found && <Text className="muted">{copy.friendsSearchEmpty}</Text>}
            {found && (
              <View className="friend-row">
                <View className="friend-row-main">
                  <Text className="friend-row-name">{found.nickname ?? ''}</Text>
                  {foundRelation && <Text className="friend-row-extra muted">{foundRelation}</Text>}
                </View>
                {found.relation === 'none' ? (
                  <Button
                    className="btn btn-sm btn-primary"
                    disabled={sending || requestSent}
                    onClick={() => void addFriend()}
                  >
                    {requestSent ? copy.friendsRequestSent : copy.friendsAdd}
                  </Button>
                ) : null}
              </View>
            )}
          </View>
        )}

        {requestError && <Text className="error-text">{requestError}</Text>}
      </View>

      {/* 好友申请：收到的可同意/拒绝，发出的可撤回 */}
      <View className="panel stack">
        <Text className="h3">{copy.friendsRequestsTitle}</Text>
        {requests.isPending ? (
          <Text className="muted">{copy.loadingRound}</Text>
        ) : requests.isError ? (
          <Text className="error-text">{translateApiError(requests.error, language, copy.friendsLoadFail)}</Text>
        ) : pendingRequests.length === 0 ? (
          <Text className="muted">{copy.friendsRequestsEmpty}</Text>
        ) : (
          <View className="friend-list">
            {pendingRequests.map((item) => (
              <View key={item.requestId} className="friend-row">
                <View className="friend-row-main">
                  <Text className="friend-row-name">{item.nickname}</Text>
                  {item.message && <Text className="friend-row-extra muted">{item.message}</Text>}
                </View>
                {item.direction === 'incoming' ? (
                  <View className="friend-row-actions">
                    <Button
                      className="btn btn-sm btn-primary"
                      disabled={busyId !== null}
                      onClick={() => void review(item.requestId, true)}
                    >
                      {copy.friendsAccept}
                    </Button>
                    <Button
                      className="btn btn-sm"
                      disabled={busyId !== null}
                      onClick={() => void review(item.requestId, false)}
                    >
                      {copy.friendsReject}
                    </Button>
                  </View>
                ) : (
                  <Button
                    className="btn btn-sm"
                    disabled={busyId !== null}
                    onClick={() => void cancelRequest(item.requestId)}
                  >
                    {copy.friendsCancelRequest}
                  </Button>
                )}
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 我的好友 */}
      <View className="panel stack">
        <Text className="h3">{copy.friendsListTitle}</Text>
        {friends.isPending ? (
          <Text className="muted">{copy.loadingRound}</Text>
        ) : friends.isError ? (
          <Text className="error-text">{translateApiError(friends.error, language, copy.friendsLoadFail)}</Text>
        ) : friendList.length === 0 ? (
          <Text className="muted">{copy.friendsListEmpty}</Text>
        ) : (
          <View className="friend-list">
            {friendList.map((friend) => (
              // 整行是私聊入口；「删除好友」按钮 stopPropagation 防止触发整行跳转
              <View key={friend.userId} className="friend-row" onClick={() => openChat(friend)}>
                <View className={`friend-row-open${friend.conversationId === null ? ' is-disabled' : ''}`}>
                  <Text className="friend-row-name">{friend.nickname}</Text>
                  <Text className="friend-row-chevron">›</Text>
                </View>
                <View className="friend-row-actions">
                  <Button
                    className="btn btn-sm btn-danger"
                    disabled={removingId !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void removeFriend(friend.userId)
                    }}
                  >
                    {copy.friendsRemove}
                  </Button>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      {actionError && <Text className="error-text">{actionError}</Text>}

      {/* Taro 小程序 app.tsx 不上屏，每个用到 useDialog 的页面都要挂一个（弹窗在这里渲染） */}
      <DialogHost />
    </View>
  )
}
