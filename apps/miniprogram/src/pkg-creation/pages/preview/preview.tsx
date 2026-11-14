/**
 * 创作预览私测页（代码级对齐 apps/web/src/creations/creation-preview-page.tsx）：
 * 复用真实单人接口（test-session 领临时凭证 + judge/solve/hints/reveal），
 * 会话与问答只存本地（previewStore，带 previewDigest 复用判断）；UI 对齐单人页
 * （顶部栏 / 汤面卡 / 聊天流 / 提示胶囊 / 大模型开关），提问区写法照抄
 * src/pages/solo/solo.tsx。小程序差异：错误文案直显请求 message（与 web 一致），
 * 公布汤底与 web 预览页相同不带确认弹窗；未登录显示登录引导卡。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import { Button, Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import { creationPreviewSchema, type CreationPreview } from '@jev/contracts'
import { api } from '../../../api/client'
import { useLanguage } from '../../../state/language'
import { useJevSession } from '../../../state/session'
import { goBack } from '../../../ui/back'
import { LoginPrompt } from '../../../ui/login-prompt'
import { HintCapsule, LargeModelToggle, TurnCard, useHintPlayer, type PreviewTurn } from '../../../game/components'
import { previewStore, type PreviewSessionRow } from '../../preview-store'
import { creationCopy } from '../../copy'
import storySea from '../../../assets/story-sea.jpg'
import '../../creation.css'

export default function CreationPreview(): ReactNode {
  const router = useRouter()
  const puzzleId = router.params.id ?? ''
  const { copy, language } = useLanguage()
  const text = creationCopy(language)
  const { session: account } = useJevSession()

  const [preview, setPreview] = useState<CreationPreview | null>(null)
  const [local, setLocal] = useState<PreviewSessionRow | null>(null)
  const [turns, setTurns] = useState<PreviewTurn[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'ask' | 'solve'>('ask')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [useLargeModel, setUseLargeModel] = useState(false)
  const forceNew = useRef(false)
  // 内容重载（reset）用代际计数丢弃过期结果（小程序没有 AbortController）
  const loadGeneration = useRef(0)

  // 已解锁提示文本（hook 依赖它，须在提前 return 之前算好）
  const hintList = turns.filter((turn) => turn.result === 'hint').map((turn) => turn.text)
  const hintPlayer = useHintPlayer(hintList)

  // 开局：领预览凭证，内容没变（versionId + contentHash 都相同）就续用本地对局只换 token
  useEffect(() => {
    if (!account || !puzzleId) return
    const generation = ++loadGeneration.current
    let cancelled = false
    setLocal(null)
    setError(null)
    void (async () => {
      try {
        const token = creationPreviewSchema.parse(await api(`/creations/${puzzleId}/test-session`, { method: 'POST' }))
        const key = `preview:${account.user.id}:${puzzleId}`
        const existing = await previewStore.latestSessionForPuzzle(key, token.language)
        const reuse = !forceNew.current && existing?.versionId === token.versionId && existing.previewDigest === token.contentHash
        const row = reuse
          ? { ...existing!, token: token.token }
          : await previewStore.createSession({
              puzzleId: key,
              versionId: token.versionId,
              language: token.language,
              title: token.title,
              surface: token.surface,
              token: token.token,
              configVersion: token.configVersion,
              previewDigest: token.contentHash,
            })
        if (reuse) await previewStore.updateSession(row.localSessionId, { token: token.token })
        const records = (await previewStore.listTurns(row.localSessionId)) as PreviewTurn[]
        const draft = await previewStore.loadDraft(row.localSessionId)
        if (cancelled || generation !== loadGeneration.current) return
        forceNew.current = false
        setPreview(token)
        setLocal(row)
        setTurns(records)
        setInput(draft?.text ?? '')
        setMode(draft?.inputMode ?? 'ask')
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
    // 依赖 userId 而非 account 对象引用：session 每次 onShow 重拉都是新对象，
    // 引用依赖会让预览在每次回前台时整页重载（web 同款用 account?.user.id）
  }, [account?.user.id, puzzleId, revision])

  // 新回合或揭晓汤底把聊天滚到底（scroll-into-view 锚点，同主包单人页）
  const [scrollAnchor, setScrollAnchor] = useState('')
  useEffect(() => {
    if (turns.length === 0 && !local?.revealedAnswer) return
    setScrollAnchor(`turn-end-${turns.length}-${local?.revealedAnswer ? 'a' : ''}`)
  }, [turns.length, local?.revealedAnswer])

  const ask = async () => {
    if (!local || !preview || !input.trim() || busy) return
    setBusy(true)
    setError(null)
    const question = input.trim()
    const id = await previewStore.addTurn({ localSessionId: local.localSessionId, kind: mode, text: question })
    setTurns((await previewStore.listTurns(local.localSessionId)) as PreviewTurn[])
    try {
      const result = await api<{ result: string; confidence: number; answer?: string }>(
        mode === 'ask' ? '/solo/judge' : '/solo/solve',
        {
          method: 'POST',
          body: mode === 'ask' ? { token: preview.token, question } : { token: preview.token, solution: question, useLargeModel },
        },
      )
      await previewStore.finishTurn(id, { status: 'succeeded', result: result.result, confidence: result.confidence })
      if (result.answer) {
        await previewStore.updateSession(local.localSessionId, { revealedAnswer: result.answer })
        setLocal({ ...local, revealedAnswer: result.answer })
      }
      await previewStore.saveDraft(local.localSessionId, mode, '')
      setInput('')
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err)
      await previewStore.finishTurn(id, { status: 'failed', failNote: note })
      setError(note)
    } finally {
      setTurns((await previewStore.listTurns(local.localSessionId)) as PreviewTurn[])
      setBusy(false)
    }
  }

  const hint = async () => {
    if (!local || !preview || busy) return
    setBusy(true)
    setError(null)
    try {
      const index = local.hintsUnlocked.length
      const result = await api<{ text: string }>('/solo/hints', { method: 'POST', body: { token: preview.token, index } })
      const id = await previewStore.addTurn({ localSessionId: local.localSessionId, kind: 'ask', text: result.text })
      await previewStore.finishTurn(id, { status: 'succeeded', result: 'hint' })
      await previewStore.updateSession(local.localSessionId, { hintsUnlocked: [...local.hintsUnlocked, index] })
      setLocal({ ...local, hintsUnlocked: [...local.hintsUnlocked, index] })
      setTurns((await previewStore.listTurns(local.localSessionId)) as PreviewTurn[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const reveal = async () => {
    if (!local || !preview) return
    setBusy(true)
    setError(null)
    try {
      const result = await api<{ answer: string }>('/solo/reveal', { method: 'POST', body: { token: preview.token, confirmed: true } })
      await previewStore.updateSession(local.localSessionId, { revealedAnswer: result.answer })
      setLocal({ ...local, revealedAnswer: result.answer })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 重开一局：丢弃本地对局按新内容重建（web forceNew + revision 同语义） */
  const reset = () => {
    forceNew.current = true
    setRevision((value) => value + 1)
  }

  // 未登录：web 端 replace 到 /login?next=…；小程序显示引导卡，登录返回后自动进入预览
  if (!account) {
    return (
      <View className="page">
        <View className="topbar topbar-title">
          <Button className="btn btn-ghost btn-sm topbar-lead" onClick={() => goBack(`/pkg-creation/pages/editor/editor?id=${puzzleId}`)}>
            {text.backEditor}
          </Button>
          <Text className="brand brand-sm creation-title">{text.previewTitle}</Text>
          <View className="topbar-tail" />
        </View>
        <LoginPrompt text={text.login} />
      </View>
    )
  }
  if (error && !local) {
    return (
      <View className="page">
        <View className="topbar">
          <Button className="btn btn-ghost btn-sm" onClick={() => goBack(`/pkg-creation/pages/editor/editor?id=${puzzleId}`)}>
            {text.backEditor}
          </Button>
        </View>
        <Text className="error-text">{error}</Text>
      </View>
    )
  }
  if (!local || !preview) return <View className="page page-loading">{text.loading}</View>

  const solved = local.status === 'solved'
  const hintProgress = `${local.hintsUnlocked.length}/${preview.hintsTotal}`

  return (
    <View className="page page-full solo-shell">
      {/* 提示悬浮胶囊：固定定位不占布局，10 秒自动收起 */}
      <HintCapsule hints={hintList} total={preview.hintsTotal} open={hintPlayer.open} index={hintPlayer.index} onIndex={hintPlayer.show} />

      {/* 游玩页顶栏：返回编辑器在左、预览标题居中、重开一局在右（web GameHeader 同构） */}
      <View className="topbar game-topbar">
        <View className="game-topbar-back">
          <Button className="btn btn-ghost btn-sm" onClick={() => goBack(`/pkg-creation/pages/editor/editor?id=${puzzleId}`)}>
            {text.backEditor}
          </Button>
        </View>
        <Text className="brand brand-sm">{text.previewTitle}</Text>
        <View className="game-topbar-action">
          <Button className="btn btn-ghost btn-sm" disabled={busy} onClick={reset}>
            {text.reset}
          </Button>
        </View>
      </View>

      {/* 汤面卡片：海底图铺底，标题与汤面在上层滚动（web StoryCard + accent 标题同构） */}
      <View className="story-wrap">
        <Image className="story-bg" src={storySea} mode="aspectFill" />
        <ScrollView className="story-card" scrollY enhanced showScrollbar={false}>
          <View className="story-inner">
            <Text className="accent creation-preview-story-title">{preview.title}</Text>
            <Text className="story">{preview.surface}</Text>
          </View>
        </ScrollView>
      </View>

      <ScrollView className="chat solo-chat" scrollY scrollIntoView={scrollAnchor} scrollWithAnimation enhanced showScrollbar={false}>
        <View className="chat-stream">
          {turns.filter((turn) => turn.result !== 'hint').map((turn) => (
            <TurnCard key={turn.localTurnId} turn={turn} copy={copy} language={language} />
          ))}
          {solved && (
            <View className="panel verdict-panel slot-in">
              <Text className="verdict-badge verdict-solved">✓</Text>
              <Text className="muted">{text.previewTitle}</Text>
            </View>
          )}
          {local.revealedAnswer && (
            <View className="panel answer-panel slot-in">
              <Text className="h3">{text.answer}</Text>
              <Text className="p">{local.revealedAnswer}</Text>
            </View>
          )}
          <View id={scrollAnchor} />
        </View>
      </ScrollView>

      <View className="solo-bottom">
        {error && <Text className="error-text creation-preview-error">{error}</Text>}
        <View className="solo-action-row">
          <Button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              // 还有未解锁的提示：解锁并悬浮展示最新一条；全部解锁后：按钮变成循环翻阅
              if (local.hintsUnlocked.length < preview.hintsTotal) {
                void hint().then(() => hintPlayer.show(hintList.length))
              } else {
                hintPlayer.cycle()
              }
            }}
          >
            {text.hint} {hintProgress}
          </Button>
          <Button
            className="btn btn-sm"
            disabled={busy || solved || Boolean(local.revealedAnswer)}
            onClick={() => {
              const next = mode === 'solve' ? 'ask' : 'solve'
              setMode(next)
              setInput('')
              void previewStore.saveDraft(local.localSessionId, next, '')
            }}
          >
            {text.solve}
          </Button>
          <Button className="btn btn-sm" disabled={busy || Boolean(local.revealedAnswer)} onClick={() => void reveal()}>
            {text.reveal}
          </Button>
        </View>

        {!solved && !local.revealedAnswer && (
          <View className="composer solo-composer">
            {mode === 'solve' && <LargeModelToggle checked={useLargeModel} disabled={busy} onChange={setUseLargeModel} />}
            <View className="composer-row">
              <Textarea
                className="field composer-input"
                value={input}
                maxlength={mode === 'ask' ? 500 : 1500}
                placeholder={mode === 'ask' ? text.placeholder : text.solvePlaceholder}
                onInput={(e) => {
                  setInput(e.detail.value)
                  void previewStore.saveDraft(local.localSessionId, mode, e.detail.value)
                }}
              />
              <Button className="btn btn-primary" disabled={busy || !input.trim()} onClick={() => void ask()}>
                {text.send}
              </Button>
            </View>
          </View>
        )}
      </View>
    </View>
  )
}
