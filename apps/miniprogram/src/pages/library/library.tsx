/**
 * 题库页（口径对齐 apps/web/src/catalog/library-page.tsx）：
 * 筛选（排序/难度/类别）、分页、署名与赞踩计数、已玩标记、单人开始。
 * 小程序差异：URL 参数换组件 state；「选房开局」按钮与投票按钮在多人/社交
 * 里程碑接入，本期只展示计数；翻页栏收成「上一页 / 页码 / 下一页」。
 */
import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, ScrollView, Text, View } from '@tarojs/components'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, translateApiError } from '../../api/client'
import { useLanguage } from '../../state/language'
import { soloStore } from '../../solo/local-store'
import { compactVoteCount } from '../../game/game-display'
import { format } from '@jev/i18n'

interface PuzzleItem {
  id: string
  title: string
  surface: string
  difficulty: 'easy' | 'medium' | 'hard' | null
  category: 'honkaku' | 'henkaku' | null
  authorDisplay: { mode: 'anonymous' | 'signature'; name: string | null }
  upCount: number
  downCount: number
}

interface PuzzlePage {
  items: PuzzleItem[]
  total: number
  totalPages: number
  page: number
}

/** 内置题库署名的 canonical 名（seed 导入固定写入），按语言本地化展示 */
const PLATFORM_LIBRARY_AUTHOR = '初始题库'

function AuthorLabel({ mode, name }: { mode: 'anonymous' | 'signature'; name: string | null }) {
  const { copy } = useLanguage()
  return (
    <Text className="muted puzzle-card-author">
      {mode === 'signature' && name
        ? name === PLATFORM_LIBRARY_AUTHOR
          ? copy.platformLibraryAuthor
          : format(copy.byAuthor, { name })
        : copy.anonymousAuthor}
    </Text>
  )
}

type Sort = 'latest' | 'popular'
type Difficulty = 'easy' | 'medium' | 'hard' | null
type Category = 'honkaku' | 'henkaku' | null

export default function Library() {
  const { copy, language } = useLanguage()
  const [sort, setSort] = useState<Sort>('popular')
  const [difficulty, setDifficulty] = useState<Difficulty>(null)
  const [category, setCategory] = useState<Category>(null)
  const [page, setPage] = useState(1)
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set())

  // 本地已玩标记：单人历史不上传，只在本地提示本人
  useEffect(() => {
    void soloStore.listSessions().then((rows) => {
      setPlayedIds(new Set(rows.map((row) => row.puzzleId)))
    })
  }, [])

  const listKey = ['puzzles', 'numbered', language, sort, difficulty, category] as const
  const { data, isLoading, error, isFetching, isPlaceholderData, refetch } = useQuery<PuzzlePage>({
    queryKey: [...listKey, page],
    queryFn: () => {
      // 小程序没有 URLSearchParams，手动拼 query（值全是安全枚举与数字）
      const qs = [`language=${language}`, `sort=${sort}`, 'limit=50', `page=${page}`]
      if (difficulty) qs.push(`difficulty=${difficulty}`)
      if (category) qs.push(`category=${category}`)
      return api<PuzzlePage>(`/puzzles?${qs.join('&')}`)
    },
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey.slice(0, -1).every((value, index) => value === listKey[index])
        ? keepPreviousData(previousData)
        : undefined,
  })
  const items = data?.items

  /** 切筛选回第一页，避免停在不存在的页码上 */
  const applyFilter = (next: () => void) => {
    next()
    setPage(1)
  }

  const enterSolo = (puzzleId: string) => {
    // 题库是单人的「选菜过渡态」：redirectTo 把题库从页面栈移除，
    // 单人页按返回直接回首页
    void Taro.redirectTo({ url: `/pages/solo/solo?puzzleId=${puzzleId}` })
  }

  return (
    <View className="page page-full">
      <View className="topbar">
        <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateBack()}>
          {copy.back}
        </Button>
        <Text className="brand brand-sm">{copy.library}</Text>
      </View>

      {/* 筛选条：排序 / 难度 / 类别各成一组胶囊 */}
      <View className="filter-bar">
        <View className="filter-row">
          <Text className="filter-label">{copy.sort}</Text>
          <Button className={`chip${sort === 'popular' ? ' active' : ''}`} onClick={() => applyFilter(() => setSort('popular'))}>
            {copy.sortPopular}
          </Button>
          <Button className={`chip${sort === 'latest' ? ' active' : ''}`} onClick={() => applyFilter(() => setSort('latest'))}>
            {copy.sortLatest}
          </Button>
        </View>
        <View className="filter-row">
          <Text className="filter-label">{copy.difficultyField}</Text>
          <Button className={`chip${difficulty === null ? ' active' : ''}`} onClick={() => applyFilter(() => setDifficulty(null))}>
            {copy.difficultyAll}
          </Button>
          <Button className={`chip${difficulty === 'easy' ? ' active' : ''}`} onClick={() => applyFilter(() => setDifficulty('easy'))}>
            {copy.easy}
          </Button>
          <Button className={`chip${difficulty === 'medium' ? ' active' : ''}`} onClick={() => applyFilter(() => setDifficulty('medium'))}>
            {copy.medium}
          </Button>
          <Button className={`chip${difficulty === 'hard' ? ' active' : ''}`} onClick={() => applyFilter(() => setDifficulty('hard'))}>
            {copy.hard}
          </Button>
        </View>
        <View className="filter-row">
          <Text className="filter-label">{copy.categoryField}</Text>
          <Button className={`chip${category === null ? ' active' : ''}`} onClick={() => applyFilter(() => setCategory(null))}>
            {copy.categoryAll}
          </Button>
          <Button className={`chip${category === 'honkaku' ? ' active' : ''}`} onClick={() => applyFilter(() => setCategory('honkaku'))}>
            {copy.honkaku}
          </Button>
          <Button className={`chip${category === 'henkaku' ? ' active' : ''}`} onClick={() => applyFilter(() => setCategory('henkaku'))}>
            {copy.henkaku}
          </Button>
        </View>
      </View>

      {isLoading && <Text className="muted">{copy.libraryLoading}</Text>}
      {error && (
        <View className="stack-sm">
          <Text className="error-text">{copy.libraryLoadFail}</Text>
          <Button className="btn btn-sm" onClick={() => void refetch()}>{copy.retry}</Button>
        </View>
      )}

      <ScrollView className={`puzzle-list${isPlaceholderData ? ' is-page-loading' : ''}`} scrollY>
        {items?.map((puzzle) => (
          <View key={puzzle.id} className="panel puzzle-card">
            <View className="puzzle-card-heading">
              <Text className="puzzle-card-title">{puzzle.title}</Text>
              <View className="puzzle-card-badges">
                {playedIds.has(puzzle.id) && <Text className="puzzle-played">{copy.played}</Text>}
                {puzzle.category && (
                  <Text className="puzzle-card-category">
                    {puzzle.category === 'honkaku' ? copy.honkaku : copy.henkaku}
                  </Text>
                )}
                {puzzle.difficulty && (
                  <Text className={`puzzle-card-difficulty puzzle-card-difficulty-${puzzle.difficulty}`}>
                    {puzzle.difficulty === 'easy' ? copy.easy : puzzle.difficulty === 'hard' ? copy.hard : copy.medium}
                  </Text>
                )}
              </View>
            </View>
            <Text className="puzzle-surface">{puzzle.surface}</Text>
            <View className="puzzle-card-footer">
              <AuthorLabel mode={puzzle.authorDisplay.mode} name={puzzle.authorDisplay.name} />
              <Text className="puzzle-card-votes">
                <Text className="vote-mark vote-mark-up">▲ {compactVoteCount(puzzle.upCount)}</Text>
                <Text className="vote-mark vote-mark-down">▼ {compactVoteCount(puzzle.downCount)}</Text>
              </Text>
              <Button
                className="btn btn-sm btn-primary puzzle-card-action"
                disabled={isPlaceholderData}
                onClick={() => enterSolo(puzzle.id)}
              >
                {copy.solo}
              </Button>
            </View>
          </View>
        ))}

        {data && (
          <View className="me-pager library-pagination">
            <Button
              className="btn btn-ghost btn-sm"
              disabled={isFetching || page <= 1}
              onClick={() => setPage(page - 1)}
            >
              ‹ {copy.previousPage}
            </Button>
            <Text className="me-pager-page">
              {language === 'zh'
                ? `共 ${data.total} 题 · 第 ${page} / ${data.totalPages} 页`
                : `${data.total} puzzles · Page ${page} of ${data.totalPages}`}
            </Text>
            <Button
              className="btn btn-ghost btn-sm"
              disabled={isFetching || page >= data.totalPages}
              onClick={() => setPage(page + 1)}
            >
              {copy.nextPage} ›
            </Button>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
