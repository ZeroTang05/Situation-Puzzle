/**
 * 赞/踩投票按钮（对齐 apps/web/src/catalog/vote-buttons.tsx，docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §2/§6）。
 *
 * 未登录显示计数、点击跳登录；登录后拉取本人选择。
 * 点击切换 = 明确的 PUT 或 DELETE（取消）；失败恢复原状态可重试，
 * 计数以服务端返回为准，不本地累加。
 */
import { useEffect, useState, type ReactNode } from 'react'
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { api } from '../../api/client'
import { useLanguage } from '../../state/language'
import type { Session } from '../../state/session'
import { VoteIcon } from '../../game/components'

interface RatingState {
  choice: 'up' | 'down' | null
  upCount: number
  downCount: number
}

export function VoteButtons({
  puzzleId,
  session,
  initialUp,
  initialDown,
}: {
  puzzleId: string
  session: Session | null
  initialUp: number
  initialDown: number
}): ReactNode {
  const { copy } = useLanguage()
  const [state, setState] = useState<RatingState>({ choice: null, upCount: initialUp, downCount: initialDown })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  // 登录用户进入页面时恢复本人选择（服务端权威；未登录显示公共计数）
  useEffect(() => {
    if (!session) return
    let cancelled = false
    void api<RatingState>(`/ratings/${puzzleId}`)
      .then((data) => {
        if (!cancelled) setState(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [puzzleId, session])

  const act = (value: 'up' | 'down') => {
    if (busy) return
    if (!session) {
      // 未登录：去登录，登录返回后 useJevSession 刷新、这里重拉本人选择
      void Taro.navigateTo({ url: '/pages/login/login' })
      return
    }
    const previous = state
    const next = previous.choice === value ? null : value
    // 乐观更新：失败恢复原状态
    setState({ ...previous, choice: next })
    setBusy(true)
    setError(false)
    const request =
      next === null
        ? api<RatingState>(`/ratings/${puzzleId}`, { method: 'DELETE' })
        : api<RatingState>(`/ratings/${puzzleId}`, { method: 'PUT', body: { value: next } })
    void request
      .then((data) => setState(data))
      .catch(() => {
        setState(previous)
        setError(true)
      })
      .finally(() => setBusy(false))
  }

  return (
    <View className="vote-row">
      <Button className={`btn btn-sm ${state.choice === 'up' ? 'btn-primary' : 'btn-ghost'}`} disabled={busy} onClick={() => act('up')}>
        <VoteIcon direction="up" /> {state.upCount}
      </Button>
      <Button className={`btn btn-sm ${state.choice === 'down' ? 'btn-primary' : 'btn-ghost'}`} disabled={busy} onClick={() => act('down')}>
        <VoteIcon direction="down" /> {state.downCount}
      </Button>
      {error && <Text className="error-text">{copy.voteFail}</Text>}
    </View>
  )
}
