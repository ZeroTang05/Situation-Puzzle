/**
 * 题库页（代码级对齐 apps/web/src/catalog/library-page.tsx）：
 * 筛选胶囊（排序/难度/类别）、卡片（标题 + 徽标横排 + 汤面三行截断 + 署名与赞踩计数）、
 * 页码栏（首尾常驻、中间围绕当前页展开）。已玩标记读本地单人历史。
 * 选题模式（?mode=select）：会客厅选题（&lobby=）或「再来一题」建新房（&followup=），
 * 普通模式卡片多一个「开房」按钮（建/取会客厅后带题进入）。
 * 小程序差异：筛选与页码用组件 state；翻页后把列表滚回顶部（对应 web 的 scrollIntoView）；
 * 未登录点开房先去登录页，登录返回后由用户再点一次（不做 web 的 pick 自动续接）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import { Button, ScrollView, Text, View } from '@tarojs/components'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, translateApiError } from '../../api/client'
import { useLanguage } from '../../state/language'
import { useJevSession } from '../../state/session'
import { openOrGetLobby, lobbyPath } from '../../lobby/create-lobby'
import { goBack } from '../../ui/back'
import { soloStore } from '../../solo/local-store'
import { compactVoteCount } from '../../game/game-display'
import { VoteIcon } from '../../game/components'
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

/** 列表里的只读署名展示（web vote-buttons.tsx AuthorLabel 同款） */
function AuthorLabel({ mode, name }: { mode: 'anonymous' | 'signature'; name: string | null }): ReactNode {
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

/** 最多展示七个位置，小屏也能保留完整的当前页上下文（web pagination.tsx 同款） */
function paginationItems(page: number, totalPages: number): (number | 'ellipsis')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  if (page <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages]
  if (page >= totalPages - 3) return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages]
}

/** 页码栏：摘要 + 页码行 + 步进按钮（web CatalogPagination 的移动端变体） */
function CatalogPagination({ page, totalPages, total, busy, onPage }: {
  page: number
  totalPages: number
  total: number
  busy: boolean
  onPage: (page: number) => void
}): ReactNode {
  const { language, copy } = useLanguage()
  return (
    <View className="library-pagination">
      <Text className="library-pagination-summary">
        {language === 'zh' ? `共 ${total} 题 · 第 ${page} / ${totalPages} 页` : `${total} puzzles · Page ${page} of ${totalPages}`}
      </Text>
      <View className="library-pagination-controls">
        <Button className="library-page-step" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>‹</Button>
        <View className="library-page-numbers">
          {paginationItems(page, totalPages).map((item, index) =>
            item === 'ellipsis' ? (
              <Text className="library-page-ellipsis" key={`gap-${index}`}>…</Text>
            ) : (
              <Button
                key={item}
                className={`library-page-number${item === page ? ' current' : ''}`}
                disabled={busy || item === page}
                onClick={() => onPage(item)}
              >
                {item}
              </Button>
            ),
          )}
        </View>
        <Button className="library-page-step" disabled={busy || page >= totalPages} onClick={() => onPage(page + 1)}>›</Button>
      </View>
    </View>
  )
}

type Sort = 'latest' | 'popular'
type Difficulty = 'easy' | 'medium' | 'hard' | null
type Category = 'honkaku' | 'henkaku' | null

export default function Library(): ReactNode {
  const { copy, language } = useLanguage()
  const { session } = useJevSession()
  const router = useRouter()
  const mode = router.params.mode === 'select' ? 'select' : 'solo'
  const [actionError, setActionError] = useState<string | null>(null)
  const [openingPuzzleId, setOpeningPuzzleId] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('popular')
  const [difficulty, setDifficulty] = useState<Difficulty>(null)
  const [category, setCategory] = useState<Category>(null)
  const [page, setPage] = useState(1)
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set())
  const [scrollTop, setScrollTop] = useState(0)

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

  /** 更新页码并把视线带回新列表的开头（web setPage 的 scrollIntoView） */
  const gotoPage = (value: number) => {
    setPage(value)
    setScrollTop((prev) => (prev === 0 ? 0.1 : 0))
  }

  /** 主按钮：选题模式回会客厅/建新房，普通模式进单人 */
  const onPick = (puzzleId: string) => {
    if (mode === 'select') {
      const followupRoomId = router.params.followup
      if (followupRoomId) {
        // 再来一题：选定新题后建独立新房并迁移合格成员；新房替换题库页
        setActionError(null)
        void api<{ targetRoomId: string }>('/rooms/followup', {
          method: 'POST',
          body: { sourceRoomId: followupRoomId, puzzleId, language },
        })
          .then((result) => void Taro.redirectTo({ url: `/pkg-room/pages/room/room?id=${result.targetRoomId}` }))
          .catch((err: unknown) => setActionError(translateApiError(err, language, copy.createRoomFail)))
        return
      }
      const lobbyId = router.params.lobby
      // 题库是会客厅的「选菜过渡态」：redirectTo 把题库从页面栈移除
      if (lobbyId) void Taro.redirectTo({ url: lobbyPath(lobbyId, { puzzleId, language }) })
      return
    }
    // 题库是单人的「选菜过渡态」：redirectTo 把题库从页面栈移除，单人页按返回直接回首页
    void Taro.redirectTo({ url: `/pages/solo/solo?puzzleId=${puzzleId}` })
  }

  /** 建/取会客厅后直接带上这道题；未登录先去登录 */
  const openRoomWithPuzzle = async (puzzleId: string) => {
    if (!session) {
      void Taro.navigateTo({ url: '/pages/login/login' })
      return
    }
    if (openingPuzzleId) return
    setOpeningPuzzleId(puzzleId)
    setActionError(null)
    try {
      const lobby = await openOrGetLobby()
      void Taro.redirectTo({ url: lobbyPath(lobby.lobbyId, { puzzleId, language }) })
    } catch (err) {
      setActionError(translateApiError(err, language, copy.createRoomFail))
      setOpeningPuzzleId(null)
    }
  }

  return (
    <View className="page page-full">
      <View className="topbar topbar-title">
        <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack()}>
          {copy.back}
        </Button>
        <Text className="brand">{copy.library}</Text>
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
      {actionError && <Text className="error-text">{actionError}</Text>}
      {/* 选题模式未登录提示（对齐 web library-page 的 libraryNeedLogin 行）；
          加底边距，别让提示贴着首卡（上方到筛选区有 16px，下方只有 4px 会显得拥挤） */}
      {!session && mode === 'select' && <Text className="muted library-hint">{copy.libraryNeedLogin}</Text>}

      <ScrollView
        className={`puzzle-grid${isPlaceholderData ? ' is-page-loading' : ''}`}
        scrollY
        scrollTop={scrollTop}
        enhanced
        showScrollbar={false}
      >
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
              <View className="puzzle-card-meta">
                <AuthorLabel mode={puzzle.authorDisplay.mode} name={puzzle.authorDisplay.name} />
                <View className="puzzle-card-votes">
                  <View className="vote-mark vote-mark-up">
                    <VoteIcon direction="up" /> <Text>{compactVoteCount(puzzle.upCount)}</Text>
                  </View>
                  <View className="vote-mark vote-mark-down">
                    <VoteIcon direction="down" /> <Text>{compactVoteCount(puzzle.downCount)}</Text>
                  </View>
                </View>
                <View className="puzzle-card-actions">
                  <Button className="btn btn-sm btn-primary" disabled={isPlaceholderData} onClick={() => onPick(puzzle.id)}>
                    {mode === 'select' ? copy.selectPuzzle : copy.solo}
                  </Button>
                  {mode !== 'select' && (
                    <Button
                      className="btn btn-sm btn-compact"
                      disabled={isPlaceholderData || openingPuzzleId !== null}
                      onClick={() => void openRoomWithPuzzle(puzzle.id)}
                    >
                      {openingPuzzleId === puzzle.id ? copy.creating : copy.catalogOpenRoom}
                    </Button>
                  )}
                </View>
              </View>
            </View>
          </View>
        ))}

        {data && <CatalogPagination page={page} totalPages={data.totalPages} total={data.total} busy={isFetching} onPage={gotoPage} />}
      </ScrollView>
    </View>
  )
}
