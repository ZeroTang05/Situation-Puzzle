/**
 * 游玩页共享组件（代码级对齐 apps/web/src/game/ 与 catalog/）：
 * TurnCard 问答卡片、useHintPlayer/HintCapsule 悬浮提示、LargeModelToggle 自绘拨杆、
 * VoteIcon 三角票数图标。小程序差异：textarea 换 Taro 组件、SVG 换 CSS 边框三角形、
 * hover 态不存在（样式里去掉）。
 *
 * 本目录在主包：单人页（主包）与房间/预览页（pkg-room/pkg-creation 分包）都用它，
 * 按微信分包规则「分包不能引分包」，跨包共享代码必须放主包。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Text, View } from '@tarojs/components'
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

/** 单人与预览共享的问答卡片：提问与还原都贴右侧，判定徽标收在气泡内（web turn-card.tsx 同款） */
export function TurnCard({ turn, copy, language }: { turn: PreviewTurn; copy: { judging: string; failed: string }; language: Language }): ReactNode {
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
            <Text className="muted turn-status">{verdictDetail(turn.result, language)}</Text>
          </View>
        )}
      </View>
    </View>
  )
}

/** 赞/踩图标：CSS 边框三角形，颜色随所在标记（web 用 SVG，同尺寸同色） */
export function VoteIcon({ direction }: { direction: 'up' | 'down' }): ReactNode {
  return <View className={`vote-icon vote-icon-${direction}`} />
}

/** 悬浮提示播放器（口径对齐 web hint-capsule.tsx）：open/index 受控 + 10 秒自动收起计时 */
export function useHintPlayer(hints: string[]) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => setOpen(false), 10_000)
    return () => clearTimeout(timer)
  }, [open, index])
  // show 不判 hints 空：解锁回调里的 hints 是旧渲染闭包（首次为空，判空会把首次弹出吞掉），
  // 解锁引发的列表更新与 open 更新同批渲染；空列表时渲染层兜底不显示
  const show = (at: number) => {
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

/** 悬浮提示胶囊：固定定位不占布局，父层用 useHintPlayer 驱动开关与翻页（web 同款头部导航） */
export function HintCapsule({ hints, total = 3, open, index, onIndex }: { hints: string[]; total?: number; open: boolean; index: number; onIndex: (at: number) => void }): ReactNode {
  const { copy } = useLanguage()
  if (!open || !hints.length) return null
  // index 可能指向尚未到达（状态里）的新提示：渲染时按现有条数收敛
  const current = Math.min(index, hints.length - 1)
  return (
    <View className="hint-capsule">
      <View className="hint-capsule-head">
        <Text className="hint-capsule-title">
          <Text className="hint-icon">💡</Text> {copy.hint} {current + 1}/{total}
        </Text>
        <View className="hint-capsule-nav">
          <Button className="btn btn-sm btn-ghost" onClick={() => onIndex((current - 1 + hints.length) % hints.length)}>←</Button>
          <Button className="btn btn-sm btn-ghost" onClick={() => onIndex((current + 1) % hints.length)}>→</Button>
        </View>
      </View>
      <Text className="hint-capsule-text">{hints[current]}</Text>
    </View>
  )
}

/** 单人、多人、创作试题共用的大模型还原开关：自绘拨杆，尺寸与配色与 web 一致 */
export function LargeModelToggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void }): ReactNode {
  const { copy } = useLanguage()
  return (
    <View
      className="large-model-toggle"
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
    >
      <View className={`lm-switch${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}`}>
        <View className="lm-knob" />
      </View>
      <Text>{copy.largeModel}</Text>
    </View>
  )
}
