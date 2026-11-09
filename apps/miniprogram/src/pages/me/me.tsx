/**
 * 「我的」页（代码级对齐 apps/web/src/me/me-page.tsx）：
 * 账号卡片（昵称/邮箱骨架屏 + 额度/会员两个关键数字）+ 邀请卡 + 多人历史列表。
 * 历史行与「我的作品」「好友」整卡可点直达对应分包页；
 * 昵称/语言/兑换码/退出登录都收在设置页。
 * 奖励入口（docs/rebuild/21-MONETIZATION-REVISION.md）：邀请好友 +5（转发卡片与复制链接），
 * 看激励视频广告 +2（流量主开通前提示「开通中」）；内测期额度卡显示畅玩徽标。
 */
import { useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
import { api, translateApiError } from '../../api/client'
import { useLanguage } from '../../state/language'
import { useJevSession } from '../../state/session'
import { useInviteShare } from '../../invite/share'
import { watchRewardedAd } from '../../ads/rewarded-ad'
import { format, type Language } from '@jev/i18n'

/** 把服务端 round.status 翻译成用户文案；未识别值回退原值便于排查 */
function roundStatusLabel(
  status: string,
  language: Language,
  copy: {
    roundStatusActive: string
    roundStatusSolved: string
    roundStatusRevealed: string
    roundStatusAbandoned: string
    roundStatusAborted: string
  },
): string {
  switch (status) {
    case 'active': return copy.roundStatusActive
    case 'solved': return copy.roundStatusSolved
    case 'revealed': return copy.roundStatusRevealed
    case 'abandoned': return copy.roundStatusAbandoned
    case 'aborted': return copy.roundStatusAborted
    default: return status
  }
}

/** round.status → 局状态文字颜色（进行中蓝 / 解开绿 / 公布金 / 停止灰） */
function roundStatusClass(status: string): string {
  switch (status) {
    case 'active': return 'st-active'
    case 'solved': return 'st-solved'
    case 'revealed': return 'st-revealed'
    case 'abandoned':
    case 'aborted': return 'st-stopped'
    default: return ''
  }
}

/** 短日期：同年只显示月日，跨年补年份 */
function shortDate(iso: string, language: Language): string {
  const date = new Date(iso)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const options: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }
  return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', options)
}

interface MeResponse {
  userId: string
  nickname: string
  email: string
  sponsorship: { monthlyUntil: string | null; lifetime: boolean }
  freeRooms: { total: number; consumed: number; reserved: number }
  invite: { code: string; invitedCount: number }
  betaOpen: boolean
}

interface HistoryResponse {
  hasMore: boolean
  rooms: Array<{
    roomId: string
    roomStatus: string
    createdAt: string
    rounds: Array<{ roundId: string; roundNo: number; status: string; title: string | null }>
  }>
}

export default function Me(): ReactNode {
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const [historyPage, setHistoryPage] = useState(1)
  const [adBusy, setAdBusy] = useState(false)
  useInviteShare('/pages/index/index')

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/me'),
    enabled: session !== null,
    retry: false,
  })
  const history = useQuery({
    queryKey: ['me-history', session?.user?.id, historyPage],
    queryFn: () => api<HistoryResponse>(`/me/history?page=${historyPage}&limit=5`),
    enabled: session !== null,
    retry: false,
  })

  /** 看激励视频：结果只做提示，奖励由服务端验证回调入账（看完后延迟刷新） */
  const watchAd = async () => {
    if (adBusy) return
    setAdBusy(true)
    try {
      const result = await watchRewardedAd()
      if (result === 'rewarded') {
        void Taro.showToast({ title: copy.adRewarded, icon: 'none', duration: 2000 })
        // 服务端验证回调有几秒延迟，稍等再拉最新额度
        setTimeout(() => void me.refetch(), 5000)
      } else if (result === 'skipped') {
        void Taro.showToast({ title: copy.adSkipped, icon: 'none', duration: 2000 })
      } else {
        void Taro.showToast({ title: copy.adUnavailable, icon: 'none', duration: 2000 })
      }
    } catch (err) {
      console.warn('[ad] 广告流程失败', err)
      void Taro.showToast({ title: copy.adUnavailable, icon: 'none', duration: 2000 })
    } finally {
      setAdBusy(false)
    }
  }

  if (!session) {
    return (
      <View className="page">
        <View className="topbar topbar-title">
          <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => void Taro.navigateBack()}>
            {copy.back}
          </Button>
          <Text className="brand brand-sm">{copy.me}</Text>
        </View>
        <View className="panel stack login-prompt">
          <Text className="muted">{copy.meRequiresLogin}</Text>
          <Button
            className="btn btn-primary"
            onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}
          >
            {copy.login}
          </Button>
        </View>
      </View>
    )
  }

  const freeRooms = me.data?.freeRooms
  const lifetime = !!me.data?.sponsorship.lifetime
  const monthlyUntil = me.data?.sponsorship.monthlyUntil ?? null
  const monthlyExpired = monthlyUntil !== null && new Date(monthlyUntil) < new Date()
  // 到期的月度会员不再给不限次数，展示成「已到期」
  const hasUnlimited = lifetime || (monthlyUntil !== null && !monthlyExpired)
  const betaOpen = me.data?.betaOpen ?? false
  const remaining = freeRooms ? freeRooms.total - freeRooms.consumed - freeRooms.reserved : null
  // 名字与邮箱都来自 /me：没回来就整卡占骨架，回来一起出；不读会话字段，避免分两步加载
  const invite = me.data?.invite ?? null
  // 微信一键登录的账号是占位邮箱（wx-<openid>@wechat.invalid）：对外展示成「微信账号」
  const displayEmail = !me.data
    ? null
    : me.data.email.endsWith('@wechat.invalid')
      ? copy.wechatAccountLabel
      : me.data.email
  // 看广告入口：会员不限次数与内测畅玩期间都不需要
  const showAdEntry = !hasUnlimited && !betaOpen

  return (
    <View className="page">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => void Taro.navigateBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.me}</Text>
      </View>

      {/* 账号卡片：昵称 + 邮箱 + 额度/会员两个关键数字 */}
      <View className="me-card">
        <View className="me-head">
          <View className="me-id">
            {me.data ? <Text className="me-name">{me.data.nickname}</Text> : <Text className="me-skeleton-bar me-name-skeleton"> </Text>}
            <Text className="me-email muted">
              {displayEmail ?? <Text className="me-skeleton-bar me-email-skeleton"> </Text>}
            </Text>
          </View>
        </View>

        <View className="me-stats">
          <View className="me-stat">
            <Text className="me-stat-label">{copy.freeRooms}</Text>
            <Text className={'me-stat-value' + (betaOpen || hasUnlimited ? ' is-ok' : '')}>
              {betaOpen
                ? copy.betaBadge
                : hasUnlimited
                  ? copy.unlimited
                  : remaining === null
                    ? '—'
                    : <>
                        {remaining}
                        <Text className="me-stat-sub"> / {freeRooms!.total}</Text>
                      </>}
            </Text>
          </View>
          {(lifetime || monthlyUntil !== null) && (
            <View className="me-stat">
              <Text className="me-stat-label">{copy.sponsorship}</Text>
              <Text className={'me-stat-value' + (lifetime || !monthlyExpired ? ' is-ok' : ' is-expired')}>
                {lifetime
                  ? copy.lifetime
                  : monthlyExpired
                    ? copy.expired
                    : `${language === 'zh' ? '至 ' : 'until '}${shortDate(monthlyUntil!, language)}`}
              </Text>
            </View>
          )}
        </View>

        {betaOpen && <Text className="muted beta-hint">{copy.betaHint}</Text>}

        {me.isError && (
          <View className="me-load-error">
            <Text className="error-text">{translateApiError(me.error, language, copy.accountLoadFail)}</Text>
            <Button className="btn btn-ghost btn-sm" onClick={() => void me.refetch()}>
              {copy.retry}
            </Button>
          </View>
        )}

        {showAdEntry && (
          <View className="me-card-actions">
            <Button className="btn" disabled={adBusy} onClick={() => void watchAd()}>
              {copy.adWatchButton}
            </Button>
          </View>
        )}
        <View className="me-card-actions">
          <Button className="btn btn-primary" onClick={() => void Taro.navigateTo({ url: '/pkg-creation/pages/list/list' })}>
            {copy.myWorks}
          </Button>
        </View>
        <View className="me-card-actions">
          <Button className="btn" onClick={() => void Taro.navigateTo({ url: '/pkg-social/pages/friends/friends' })}>
            {copy.friends}
          </Button>
          <Button
            className="btn"
            onClick={() => void Taro.navigateTo({ url: '/pages/settings/settings' })}
          >
            {copy.settings}
          </Button>
        </View>
      </View>

      {/* 邀请好友：转发小程序卡片（主入口）+ 复制网页邀请链接（站外渠道） */}
      {invite && (
        <View className="me-section invite-card">
          <View className="me-section-head">
            <Text className="me-section-title">{copy.inviteTitle}</Text>
            <Text className="muted invite-count">{format(copy.invitedCount, { n: invite.invitedCount })}</Text>
          </View>
          <Text className="muted invite-hint">{copy.inviteHint}</Text>
          <View className="invite-link-row">
            <Text className="invite-link" userSelect>{`https://sp.xiaobaozi.cn/?ref=${invite.code}`}</Text>
            <Button
              className="btn btn-sm"
              onClick={() =>
                void Taro.setClipboardData({ data: `https://sp.xiaobaozi.cn/?ref=${invite.code}` })
              }
            >
              {copy.inviteCopy}
            </Button>
          </View>
          <Button className="btn btn-primary" openType="share">{copy.inviteShareButton}</Button>
        </View>
      )}

      {/* 房间历史：v3 一房一题，主卡直接展示该局的题目标题与局状态 */}
      <View className="me-section">
        <View className="me-section-head">
          <Text className="me-section-title">{copy.history}</Text>
          {(historyPage > 1 || history.data?.hasMore) && (
            <View className="me-pager">
              <Button
                className="btn btn-ghost btn-sm"
                disabled={historyPage === 1 || history.isFetching}
                onClick={() => setHistoryPage((p) => p - 1)}
              >
                {copy.previousPage}
              </Button>
              <Text className="me-pager-page">{format(copy.pageNumber, { n: historyPage })}</Text>
              <Button
                className="btn btn-ghost btn-sm"
                disabled={!history.data?.hasMore || history.isFetching}
                onClick={() => setHistoryPage((p) => p + 1)}
              >
                {copy.nextPage}
              </Button>
            </View>
          )}
        </View>

        {history.isPending && (
          <View className="me-skeleton">
            {[0, 1, 2].map((row) => (
              <View key={row} className="me-skeleton-row">
                <Text className="me-skeleton-bar" />
                <Text className="me-skeleton-bar" />
              </View>
            ))}
          </View>
        )}
        {history.isError && <Text className="error-text">{copy.historyLoadFail}</Text>}
        {history.data?.rooms.length === 0 && (
          <Text className="muted me-history-empty">{copy.noRoomHistory}</Text>
        )}

        <View className="me-history">
          {history.data?.rooms.map((room) => {
            const round = room.rounds[0]
            // 房间进行中 + 本局进行中时两个状态文案重复，只保留房间状态
            const showRoundStatus = round && !(room.roomStatus === 'playing' && round.status === 'active')
            return (
              <View key={room.roomId} className="me-history-item" onClick={() => void Taro.navigateTo({ url: `/pkg-room/pages/room/room?id=${room.roomId}` })}>
                <View className="me-history-room">
                  <View className="me-history-head">
                    <Text className="me-history-date">{shortDate(room.createdAt, language)}</Text>
                    <Text className={'me-history-badge' + (room.roomStatus === 'closed' ? ' me-badge-closed' : '')}>
                      {room.roomStatus === 'closed' ? copy.roomStatusClosed : copy.roomStatusActive}
                    </Text>
                    <View className="me-history-right">
                      {showRoundStatus && (
                        <Text className={`me-round-status ${roundStatusClass(round.status)}`}>
                          {roundStatusLabel(round.status, language, copy)}
                        </Text>
                      )}
                      <Text className="me-history-chevron">›</Text>
                    </View>
                  </View>
                  {round?.title && <Text className="me-history-title">{round.title}</Text>}
                </View>
              </View>
            )
          })}
        </View>
      </View>
    </View>
  )
}
