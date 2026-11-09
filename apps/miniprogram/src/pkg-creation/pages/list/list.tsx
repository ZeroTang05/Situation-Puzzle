/**
 * 作品列表页（代码级对齐 apps/web/src/creations/creation-list-page.tsx）：
 * 状态筛选（草稿/审核中/已发布分桶计数）、整卡点进编辑器、已发布作品带「游玩」入口。
 * 小程序差异：未登录时显示「登录后创作」引导卡（登录成功 navigateBack 回来后
 * useJevSession 的 onShow 自动重拉，等价 web 的 Navigate(/login?next=…)）；
 * 空态图标用主包 assets/icon.png（web 用 icon.svg）；
 * 「游玩」进主包单人页（solo 页按界面语言开局，web 会带作品语言 ?lang= 参数，见最终报告）。
 */
import { useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Image, Text, View } from '@tarojs/components'
import { useQuery } from '@tanstack/react-query'
import { type CreationSummary } from '@jev/contracts'
import { api, translateApiError } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { goBack } from '../../../ui/back'
import { compactVoteCount } from '../../../game/game-display'
import { VoteIcon } from '../../../game/components'
import { creationCopy, creationStatusLabel } from '../../copy'
import iconPng from '../../../assets/icon.png'
import '../../creation.css'

/** 筛选分桶：草稿单独一类；已发布含被下架（卡片上仍有状态标签）；其余都算审核流程中 */
type WorkFilter = 'all' | 'draft' | 'review' | 'published'

function bucketOf(work: CreationSummary): Exclude<WorkFilter, 'all'> {
  if (work.status === 'draft') return 'draft'
  if (work.status === 'published' || work.status === 'taken_down') return 'published'
  return 'review'
}

export default function CreationList(): ReactNode {
  const { copy, language } = useLanguage()
  const text = creationCopy(language)
  const { session } = useJevSession()
  const [filter, setFilter] = useState<WorkFilter>('all')
  const query = useQuery({
    queryKey: ['creations', session?.user.id],
    queryFn: () => api<{ items: CreationSummary[] }>('/creations'),
    enabled: !!session,
    retry: false,
  })

  // 未登录：web 端是 replace 到 /login?next=/creations；小程序改引导卡 + 登录返回后自动加载
  if (!session) {
    return (
      <View className="page">
        <View className="topbar topbar-title">
          <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
            {copy.back}
          </Button>
          <Text className="brand brand-sm creation-title">{text.center}</Text>
          <View className="topbar-tail" />
        </View>
        <View className="panel stack login-prompt">
          <Text className="muted">{text.login}</Text>
          <Button className="btn btn-primary" onClick={() => void Taro.navigateTo({ url: '/pages/login/login' })}>
            {copy.login}
          </Button>
        </View>
      </View>
    )
  }

  const items = query.data?.items ?? []
  const counts = { all: items.length, draft: 0, review: 0, published: 0 }
  for (const work of items) counts[bucketOf(work)] += 1
  const visible = filter === 'all' ? items : items.filter((work) => bucketOf(work) === filter)
  // 只有存在两种以上状态时筛选才有意义，单个状态时隐藏避免噪音
  const showFilter = new Set(items.map(bucketOf)).size >= 2
  const filters: Array<{ key: WorkFilter; label: string }> = [
    { key: 'all', label: text.filterAll },
    { key: 'draft', label: text.filterDrafts },
    { key: 'review', label: text.filterReview },
    { key: 'published', label: text.filterPublished },
  ]

  return (
    <View className="page creation-shell">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm creation-title">{text.center}</Text>
        <Button
          className="btn btn-primary btn-sm topbar-tail"
          onClick={() => void Taro.navigateTo({ url: '/pkg-creation/pages/editor/editor' })}
        >
          {text.create}
        </Button>
      </View>

      <Text className="creation-section-title">{text.works}</Text>
      <Text className="muted creation-reward-hint">{text.rewardHint}</Text>
      {showFilter && (
        <View className="mode-tabs">
          {filters.map(({ key, label }) => (
            <Button
              key={key}
              className={`mode-tab${filter === key ? ' active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
              <Text className="mode-tab-count">{counts[key]}</Text>
            </Button>
          ))}
        </View>
      )}

      {query.isPending && <Text className="muted">{text.loading}</Text>}
      {query.isError && (
        <View className="creation-load-error">
          <Text className="error-text">{translateApiError(query.error, language, text.loadFail)}</Text>
          <Button className="btn btn-ghost btn-sm" onClick={() => void query.refetch()}>
            {copy.retry}
          </Button>
        </View>
      )}
      {query.isSuccess && items.length === 0 && (
        <View className="creation-empty">
          <Image className="creation-empty-icon" src={iconPng} mode="aspectFit" />
          <Text>{text.empty}</Text>
          <Button
            className="btn btn-primary creation-empty-btn"
            onClick={() => void Taro.navigateTo({ url: '/pkg-creation/pages/editor/editor' })}
          >
            {text.create}
          </Button>
        </View>
      )}
      {showFilter && visible.length === 0 && <Text className="muted creation-filter-empty">{text.filterEmpty}</Text>}

      {/* 整卡是编辑入口；「游玩」按钮浮在上层，stopPropagation 防止触发整卡跳转 */}
      <View className="creation-works">
        {visible.map((work) => (
          <View
            key={work.puzzleId}
            className="creation-work"
            onClick={() => void Taro.navigateTo({ url: `/pkg-creation/pages/editor/editor?id=${work.puzzleId}` })}
          >
            <View className="creation-work-main">
              <Text className="creation-work-title">{work.title}</Text>
              <View className="creation-item-meta">
                <View className={`creation-status-dot status-${work.status}`} />
                <Text className="muted">{creationStatusLabel(work.status, language)}</Text>
                <Text className="muted">v{work.versionNo}</Text>
                <Text className="muted">{work.language === 'en' ? copy.languageEn : copy.languageZh}</Text>
                <View className="vote-mark vote-mark-up">
                  <VoteIcon direction="up" />
                  <Text>{compactVoteCount(work.upCount)}</Text>
                </View>
                <View className="vote-mark">
                  <VoteIcon direction="down" />
                  <Text>{compactVoteCount(work.downCount)}</Text>
                </View>
                <Text className="muted">{new Date(work.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}</Text>
              </View>
              {work.pendingName && (
                <Text className="creation-item-pending">
                  {text.pendingName}
                  {language === 'zh' ? '：' : ': '}
                  {work.pendingName}
                </Text>
              )}
            </View>
            {work.published && (
              <Button
                className="btn btn-sm creation-item-btn creation-item-btn-play"
                onClick={(event) => {
                  event.stopPropagation()
                  void Taro.navigateTo({ url: `/pages/solo/solo?puzzleId=${work.puzzleId}` })
                }}
              >
                {text.playShort}
              </Button>
            )}
          </View>
        ))}
      </View>
    </View>
  )
}
