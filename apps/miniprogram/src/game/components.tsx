/**
 * 游玩页共享组件（小程序版，口径对齐 apps/web/src/game/ 与 catalog/）：
 * TurnCard 问答卡片、useHintPlayer/HintCapsule 悬浮提示、LargeModelToggle 大模型开关。
 * 小程序差异：textarea 用 Taro Input/Textarea 组件、emoji 图标照用、
 * hover 态不存在（样式里去掉）。
 */
import { useEffect, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import { Switch } from '@tarojs/components'
import { useLanguage } from '../state/language'
import { displayVerdict, verdictDetail, type Language } from '@jev/i18n'
import { confidenceLabel } from './game-display'

export interface PreviewTurn {
  localTurnId: string
  kind: 'ask' | 'solve'
  text: string
  status: 'sending' | 'succeeded' | 'failed'
  result: string | null
  confidence?: number
  failNote?: string
}

/** 单人与预览共享的问答卡片：方向由 kind 决定，状态消息贴近文本 */
export function TurnCard({ turn, copy, language }: { turn: PreviewTurn; copy: { judging: string; failed: string }; language: Language }) {
  return (
    <View className={`turn turn-${turn.kind}`}>
      <View className="turn-bubble">
        <Text className="turn-text">{turn.text}</Text>
        {turn.status === 'sending' && <Text className="muted turn-status">{copy.judging}</Text>}
        {turn.status === 'failed' && <Text className="error-text turn-status">{turn.failNote ?? copy.failed}</Text>}
        {turn.status === 'succeeded' && turn.kind === 'ask' && turn.result && (
          <View className="turn-result">
            <Text className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</Text>
            {confidenceLabel(turn.confidence, language) && (
              <Text className="confidence">{confidenceLabel(turn.confidence, language)}</Text>
            )}
          </View>
        )}
        {turn.status === 'succeeded' && turn.kind === 'solve' && turn.result && (
          <View className="turn-result">
            <Text className={`verdict-badge verdict-${turn.result}`}>{displayVerdict(turn.result, language)}</Text>
            {confidenceLabel(turn.confidence, language) && (
              <Text className="confidence">{confidenceLabel(turn.confidence, language)}</Text>
            )}
            <Text className="muted turn-detail">{verdictDetail(turn.result, language)}</Text>
          </View>
        )}
      </View>
    </View>
  )
}

/** 悬浮提示播放器（口径对齐 web 版 hint-capsule）：open 是否悬浮展示、index 当前条；
 *  show 展示指定条（解锁后传新提示下标）、cycle 循环翻阅（收起态从第一条开始）；
 *  打开或翻页都会重置 10 秒自动收起计时 */
export function useHintPlayer(hints: string[]) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => setOpen(false), 10_000)
    return () => clearTimeout(timer)
  }, [open, index])
  const show = (at: number) => {
    if (!hints.length) return
    setOpen(true)
    setIndex(Math.max(0, at))
  }
  const cycle = () => {
    if (!hints.length) return
    setOpen(true)
    setIndex((i) => (open ? (i + 1) % hints.length : 0))
  }
  return { open, index, show, cycle }
}

/** 悬浮提示胶囊：受控组件，固定定位不占布局；父层用 useHintPlayer 驱动开关与翻页 */
export function HintCapsule({ hints, total = 3, open, index, onIndex }: { hints: string[]; total?: number; open: boolean; index: number; onIndex: (at: number) => void }) {
  const { copy } = useLanguage()
  if (!open || !hints.length) return null
  // index 可能指向尚未到达（状态里）的新提示：渲染时按现有条数收敛
  const current = Math.min(index, hints.length - 1)
  return (
    <View className="hint-capsule">
      <View className="hint-capsule-head">
        <Text className="hint-capsule-title">💡 {copy.hint} {current + 1}/{total}</Text>
        <View className="hint-capsule-nav">
          <Button className="btn btn-sm btn-ghost" onClick={() => onIndex((current - 1 + hints.length) % hints.length)}>←</Button>
          <Button className="btn btn-sm btn-ghost" onClick={() => onIndex((current + 1) % hints.length)}>→</Button>
        </View>
      </View>
      <Text className="hint-capsule-text">{hints[current]}</Text>
    </View>
  )
}

/** 单人、多人和创作试题共用的大模型还原开关（微信原生 Switch） */
export function LargeModelToggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  const { copy } = useLanguage()
  return (
    <View className="large-model-toggle">
      <Switch checked={checked} disabled={disabled} color="#7dd8c6" onChange={(event) => onChange(event.detail.value)} />
      <Text>{copy.largeModel}</Text>
    </View>
  )
}
