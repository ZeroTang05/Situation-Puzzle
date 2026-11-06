/**
 * 单人游戏页（代码级对齐 apps/web/src/solo/solo-page.tsx，docs/rebuild/08-SOLO.md）：
 * 会话与问答只存小程序本地存储；退出重进恢复；断网保留输入；服务端不存单人对话。
 * 布局对齐 web solo-shell：整屏列结构，题面（海底图汤面卡）与对话各自滚动，输入区常驻。
 * 小程序差异：题目评价（赞踩投票）随社交里程碑接入；换题请求用取消标志代替
 * AbortController；错误提示走顶部悬浮 Toast；公布汤底确认走深海弹窗。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import { api, ApiError, translateApiError } from '../../api/client'
import { useLanguage } from '../../state/language'
import { displayVerdict, verdictDetail } from '@jev/i18n'
import { soloStore, type SoloSessionRow } from '../../solo/local-store'
import { selectUnplayedPuzzle } from '../../solo/unplayed-puzzle'
import { HintCapsule, LargeModelToggle, TurnCard, useHintPlayer } from '../../game/components'
import { Toast } from '../../ui/toast'
import { useDialog } from '../../ui/dialog'
import storySea from '../../assets/story-sea.jpg'

type InputMode = 'ask' | 'solve'

interface TurnRow {
  localTurnId: string
  kind: InputMode | 'solve'
  text: string
  status: 'sending' | 'succeeded' | 'failed'
  result: string | null
  confidence?: number
}

/** 判题请求最多回传的问答条数（契约上限）；实际生效轮数由服务端 JEV_RECENT_QA_LIMIT 裁剪 */
const RECENT_QA_LIMIT = 10

type AskVerdict = 'yes' | 'no' | 'irrelevant' | 'uncertain'
const askVerdicts = new Set(['yes', 'no', 'irrelevant', 'uncertain'])
/** 已判定的提问回合：result 收敛为四种判定之一 */
function isJudgedAsk(turn: TurnRow): turn is TurnRow & { result: AskVerdict } {
  return turn.kind === 'ask' && turn.status === 'succeeded' && turn.result !== null && askVerdicts.has(turn.result)
}

export default function Solo(): ReactNode {
  const puzzleId = Taro.getCurrentInstance().router?.params?.puzzleId ?? ''
  const { copy, language } = useLanguage()
  const dialog = useDialog()

  const [session, setSession] = useState<SoloSessionRow | null>(null)
  const [turns, setTurns] = useState<TurnRow[]>([])
  const [hintBusy, setHintBusy] = useState(false)
  const [changingPuzzle, setChangingPuzzle] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [inputMode, setInputMode] = useState<InputMode>('ask')
  const [useLargeModel, setUseLargeModel] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 换题的随机请求用取消标志收口（小程序没有 AbortController）
  const changingRef = useRef(false)
  // 输入框预提示：随机抽一条常见问题，给不会玩的用户一个起点（进入页面时定一次）
  const askPlaceholder = useMemo(() => {
    const list = copy.askPlaceholderExamples
    return list.length > 0 ? list[Math.floor(Math.random() * list.length)]! : copy.askPlaceholder
  }, [copy.askPlaceholderExamples, copy.askPlaceholder])

  // 已解锁提示列表与悬浮播放器：hook 必须在下方 !session 早退之前调用
  const hintList = turns.filter((turn) => turn.result === 'hint').map((turn) => turn.text)
  const hintPlayer = useHintPlayer(hintList)

  // 开局：恢复本地进行中的对局，或向服务端取固定版本与凭证（无会话、不写服务端业务表）
  useEffect(() => {
    if (!puzzleId) return
    let cancelled = false
    setSession(null)
    setTurns([])
    setText('')
    setInputMode('ask')
    setError(null)
    void (async () => {
      try {
        const existing = await soloStore.latestSessionForPuzzle(puzzleId, language)
        if (existing && existing.status === 'active') {
          const savedTurns = (await soloStore.listTurns(existing.localSessionId)) as TurnRow[]
          const draft = await soloStore.loadDraft(existing.localSessionId)
          if (cancelled) return
          setSession(existing)
          setTurns(savedTurns)
          if (draft) {
            setInputMode(draft.inputMode)
            setText(draft.text)
          }
          return
        }
        const created = await api<{
          token: string
          puzzleId: string
          versionId: string
          language: 'zh' | 'en'
          title: string
          surface: string
          difficulty: 'easy' | 'medium' | 'hard' | null
          category: 'honkaku' | 'henkaku' | null
          hintsTotal: number
          configVersion: string
        }>('/solo/sessions', { method: 'POST', body: { puzzleId, language } })
        if (cancelled) return
        const row = await soloStore.createSession({
          puzzleId,
          versionId: created.versionId,
          language,
          title: created.title,
          surface: created.surface,
          difficulty: created.difficulty,
          category: created.category,
          token: created.token,
          configVersion: created.configVersion,
        })
        if (cancelled) return
        setSession(row)
        setTurns([])
      } catch (err) {
        if (!cancelled) setError(translateApiError(err, language, copy.soloLoadFail))
      }
    })()
    return () => {
      cancelled = true
      changingRef.current = true
    }
  }, [puzzleId, language, copy.soloLoadFail])

  // 新回合或对局状态翻转（解出弹结算、揭晓弹汤底）把聊天滚到底
  const [scrollAnchor, setScrollAnchor] = useState('')
  useEffect(() => {
    if (turns.length === 0) return
    // scroll-into-view 锚点：每次回合数变化后指向聊天流底部的哨兵节点
    setScrollAnchor(`turn-end-${turns.length}-${session?.status ?? ''}`)
  }, [turns.length, session?.status, session?.revealedAnswer])

  const persistDraft = useCallback(
    (mode: InputMode, value: string) => {
      if (session) void soloStore.saveDraft(session.localSessionId, mode, value)
    },
    [session],
  )

  const submit = async () => {
    if (!session || !text.trim() || sending || changingPuzzle) return
    setSending(true)
    setError(null)

    // 1. 先写本地 sending 状态
    const localTurnId = await soloStore.addTurn({ localSessionId: session.localSessionId, kind: inputMode, text: text.trim() })
    const optimistic: TurnRow = { localTurnId, kind: inputMode, text: text.trim(), status: 'sending', result: null }
    setTurns((prev) => [...prev, optimistic])
    const submittedText = text.trim()
    setText('')
    await soloStore.saveDraft(session.localSessionId, inputMode, '')
    await soloStore.bumpProgress(session.puzzleId, { questionDelta: 1 })

    try {
      // 2. 请求模型（单人并发限制在服务端；繁忙时本地保留输入）
      //    带上最近几轮已判定的问答，供判题解析代词指代
      const recentQas = turns.filter(isJudgedAsk).slice(-RECENT_QA_LIMIT).map((t) => ({ question: t.text, verdict: t.result }))
      const result =
        inputMode === 'ask'
          ? await api<{ result: string; confidence: number }>('/solo/judge', {
              method: 'POST',
              body: { token: session.token, question: submittedText, ...(recentQas.length ? { recentQas } : {}) },
            })
          : await api<{ result: string; confidence: number; answer?: string }>('/solo/solve', {
              method: 'POST',
              body: { token: session.token, solution: submittedText, useLargeModel },
            })

      // 3. 回写结果
      await soloStore.finishTurn(localTurnId, { status: 'succeeded', result: result.result, confidence: result.confidence })
      setTurns((prev) => prev.map((t) => (t.localTurnId === localTurnId ? { ...t, status: 'succeeded', result: result.result, confidence: result.confidence } : t)))

      if (inputMode === 'solve' && result.result === 'solved') {
        const answer = (result as { answer?: string }).answer ?? null
        await soloStore.updateSession(session.localSessionId, { status: 'solved', revealedAnswer: answer })
        setSession((prev) => (prev ? { ...prev, status: 'solved', revealedAnswer: answer } : prev))
        await soloStore.bumpProgress(session.puzzleId, { solved: true })
      } else if (inputMode === 'solve') {
        // 一次还原完成后回到普通提问；未答对时仍可继续推理
        setInputMode('ask')
        await soloStore.saveDraft(session.localSessionId, 'ask', '')
      }
    } catch (err) {
      const note = translateApiError(err, language, copy.networkError)
      await soloStore.finishTurn(localTurnId, { status: 'failed', failNote: note })
      setTurns((prev) => prev.map((t) => (t.localTurnId === localTurnId ? { ...t, status: 'failed' } : t)))
      // 失败后本地保留问题：重试按当前输入模式重新提交
      setText(submittedText)
      if (err instanceof ApiError && err.code === 'JEV_BUSY') setError(copy.jevBusy)
      else setError(note)
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        // 凭证过期：重新开局获取
        setError(copy.sessionExpired)
      }
    } finally {
      setSending(false)
    }
  }

  const unlockHint = async (index: number) => {
    if (!session || hintBusy || changingPuzzle || session.hintsUnlocked.includes(index)) return
    setHintBusy(true)
    try {
      const { text: hint } = await api<{ text: string }>('/solo/hints', {
        method: 'POST',
        body: { token: session.token, index },
      })
      const unlocked = [...session.hintsUnlocked, index]
      await soloStore.updateSession(session.localSessionId, { hintsUnlocked: unlocked })
      setSession({ ...session, hintsUnlocked: unlocked })
      // 提示以本地记录展示
      const id = await soloStore.addTurn({ localSessionId: session.localSessionId, kind: 'ask', text: hint })
      await soloStore.finishTurn(id, { status: 'succeeded', result: 'hint' })
      setTurns((await soloStore.listTurns(session.localSessionId)) as TurnRow[])
    } catch {
      setError(copy.hintFail)
    } finally {
      setHintBusy(false)
    }
  }

  const reveal = async () => {
    if (!session || session.revealedAnswer || revealing || changingPuzzle) return
    setRevealing(true)
    try {
      const { answer } = await api<{ answer: string }>('/solo/reveal', {
        method: 'POST',
        body: { token: session.token, confirmed: true },
      })
      await soloStore.updateSession(session.localSessionId, { status: 'revealed', revealedAnswer: answer })
      setSession({ ...session, status: 'revealed', revealedAnswer: answer })
      await soloStore.bumpProgress(session.puzzleId, { revealed: true })
    } catch {
      setError(copy.revealFail)
    } finally {
      setRevealing(false)
    }
  }

  /** 服务端从完整已发布题库随机选题；切换后本地记录按题目独立恢复。 */
  const changePuzzle = async () => {
    if (!session || changingPuzzle || sending || hintBusy || revealing) return
    setChangingPuzzle(true)
    changingRef.current = false
    setError(null)
    try {
      const playedIds = await soloStore.listPlayedPuzzleIds()
      const puzzleIds: string[] = []
      let cursor: string | null = null
      // 按公开题库游标读取全部候选，避免只在第一页抽题；已玩记录不出本机
      do {
        const query = [`language=${language}`, 'limit=100', 'sort=latest']
        if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`)
        const page = await api<{ items: Array<{ id: string }>; nextCursor: string | null }>(`/puzzles?${query.join('&')}`)
        if (changingRef.current) return
        puzzleIds.push(...page.items.map((item) => item.id))
        cursor = page.nextCursor
      } while (cursor !== null)
      if (changingRef.current) return
      const selectedId = selectUnplayedPuzzle(puzzleIds, playedIds, session.puzzleId)
      if (selectedId === null) {
        setError(copy.noOtherPuzzle)
        return
      }
      // redirectTo 不堆页面栈：连换多题后按返回直接回到首页，不落回旧题
      void Taro.redirectTo({ url: `/pages/solo/solo?puzzleId=${selectedId}` })
    } catch (err) {
      if (changingRef.current) return
      setError(err instanceof ApiError && err.code === 'NOT_FOUND' ? copy.noOtherPuzzle : translateApiError(err, language, copy.changePuzzleFail))
    } finally {
      changingRef.current = false
      setChangingPuzzle(false)
    }
  }

  if (!session) {
    // 加载态：仅居中「进入对局中」；错误态：保留返回 + 错误文案（web solo-page 同款两分支）
    if (error) {
      return (
        <View className="page page-full">
          <View className="topbar">
            <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateBack()}>{copy.back}</Button>
          </View>
          <Text className="error-text">{error}</Text>
        </View>
      )
    }
    return <View className="page page-loading">{copy.loadingRound}</View>
  }

  const solved = session.status === 'solved'

  return (
    <View className="page page-full solo-shell">
      {/* 悬浮提示胶囊：固定定位不占布局，10 秒自动收起 */}
      <HintCapsule hints={hintList} open={hintPlayer.open} index={hintPlayer.index} onIndex={hintPlayer.show} />

      {/* 游玩页顶栏：等宽两侧保持题目居中（web .game-topbar） */}
      <View className="topbar game-topbar">
        <View className="game-topbar-back">
          <Button className="btn btn-ghost btn-sm" onClick={() => void Taro.navigateBack()}>{copy.back}</Button>
        </View>
        <Text className="brand brand-sm">{session.title}</Text>
        <View className="game-topbar-action">
          <Button
            className="btn btn-ghost btn-sm"
            disabled={changingPuzzle || sending || hintBusy || revealing}
            onClick={() => void changePuzzle()}
          >
            {changingPuzzle ? copy.changingPuzzle : copy.changePuzzle}
          </Button>
        </View>
      </View>

      {/* 汤面卡片：海底图铺底（贴卡片固定），徽标与汤面文字在上层滚动 */}
      <View className="story-wrap">
        <Image className="story-bg" src={storySea} mode="aspectFill" />
        <ScrollView className="story-card" scrollY enhanced showScrollbar={false}>
          <View className="story-inner">
            {session.category && (
              <Text className="story-badge puzzle-card-category">
                {session.category === 'honkaku' ? copy.honkaku : copy.henkaku}
              </Text>
            )}
            {session.difficulty && (
              <Text className={`story-badge puzzle-card-difficulty puzzle-card-difficulty-${session.difficulty}`}>
                {session.difficulty === 'easy' ? copy.easy : session.difficulty === 'hard' ? copy.hard : copy.medium}
              </Text>
            )}
            <Text className="story">{session.surface}</Text>
          </View>
        </ScrollView>
      </View>

      <ScrollView className="chat solo-chat" scrollY scrollIntoView={scrollAnchor} scrollWithAnimation enhanced showScrollbar={false}>
        <View className="chat-stream">
          {turns.length === 0 && (
            <View className="chat-empty">
              <Text className="chat-empty-title">{copy.soloEmptyTitle}</Text>
              <Text className="muted chat-empty-hint">{copy.soloEmptyHint}</Text>
              <View className="chat-empty-examples">
                {copy.soloEmptyExamples.map((example) => (
                  <Button
                    key={example}
                    className="btn btn-sm chat-empty-example"
                    onClick={() => {
                      setText(example)
                      persistDraft('ask', example)
                    }}
                  >
                    {example}
                  </Button>
                ))}
              </View>
            </View>
          )}
          {turns.filter((turn) => turn.result !== 'hint').map((turn) => (
            <TurnCard key={turn.localTurnId} turn={turn} copy={copy} language={language} />
          ))}
          {solved && (
            <View className="panel verdict-panel slot-in">
              <Text className="verdict-badge verdict-solved">{displayVerdict('solved', language)}</Text>
              <Text className="p">{verdictDetail('solved', language)}</Text>
            </View>
          )}
          {session.revealedAnswer && (
            <View className="panel answer-panel slot-in">
              <Text className="h3">{copy.answer}</Text>
              <Text className="p">{session.revealedAnswer}</Text>
            </View>
          )}
          <View id={scrollAnchor} />
        </View>
      </ScrollView>

      <View className="solo-bottom">
        <View className="solo-action-row">
          <Button
            className="btn btn-sm"
            disabled={changingPuzzle || hintBusy || session.status !== 'active'}
            onClick={() => {
              // 还有未解锁的提示：解锁并悬浮展示最新一条；全部解锁后：按钮变成循环翻阅
              if (session.hintsUnlocked.length < 3) {
                void unlockHint(session.hintsUnlocked.length).then(() => hintPlayer.show(hintList.length))
              } else {
                hintPlayer.cycle()
              }
            }}
          >
            {copy.hint} {session.hintsUnlocked.length}/3
          </Button>
          <Button
            className={'btn btn-sm' + (inputMode === 'solve' ? ' pressed' : '')}
            disabled={changingPuzzle || sending || solved || Boolean(session.revealedAnswer)}
            onClick={() => {
              const next = inputMode === 'solve' ? 'ask' : 'solve'
              setInputMode(next)
              setText('')
              persistDraft(next, '')
            }}
          >
            {copy.solve}
          </Button>
          <Button
            className="btn btn-sm"
            disabled={changingPuzzle || sending || revealing || Boolean(session.revealedAnswer)}
            onClick={async () => {
              if (await dialog.confirm(copy.soloRevealConfirm, copy.soloViewAnswer)) void reveal()
            }}
          >
            {copy.soloViewAnswer}
          </Button>
        </View>

        {/* 输入区在解出/揭晓后整体收起 */}
        {!solved && !session.revealedAnswer && (
          <View className="composer solo-composer">
            {inputMode === 'solve' && (
              <LargeModelToggle checked={useLargeModel} disabled={changingPuzzle || sending} onChange={setUseLargeModel} />
            )}
            <View className="composer-row">
              <Textarea
                className="field composer-input"
                value={text}
                maxlength={inputMode === 'ask' ? 500 : 1500}
                placeholder={inputMode === 'ask' ? askPlaceholder : copy.solvePlaceholder}
                onInput={(e) => {
                  setText(e.detail.value)
                  persistDraft(inputMode, e.detail.value)
                }}
              />
              <Button
                className="btn btn-primary"
                disabled={changingPuzzle || sending || !text.trim()}
                onClick={() => void submit()}
              >
                {sending ? copy.submitting : copy.send}
              </Button>
            </View>
          </View>
        )}
      </View>

      {/* 操作反馈：顶部悬浮条，不挤占布局，到点自动消失 */}
      {error && <Toast message={error} tone="error" durationMs={4000} onDone={() => setError(null)} />}
    </View>
  )
}
