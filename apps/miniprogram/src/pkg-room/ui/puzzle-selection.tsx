/**
 * 等待室选题入口（对齐 apps/web/src/rooms/puzzle-selection.tsx）：
 * 直接展示已确认的题名，仍可整卡点击重新选题（跳题库选择模式）。
 */
import type { ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import { useLanguage } from '../../state/language'

export function PuzzleSelection({ title, onPick }: { title: string | null; onPick: () => void }): ReactNode {
  const { copy } = useLanguage()
  return (
    <View className="btn puzzle-selection" onClick={onPick}>
      {title ? (
        <View className="puzzle-selection-body">
          <Text className="muted puzzle-selection-small">{copy.currentPuzzle}</Text>
          <Text className="puzzle-selection-title">{title}</Text>
          <Text className="muted puzzle-selection-small">{copy.selectAgain}</Text>
        </View>
      ) : (
        <Text>{copy.selectPuzzle}</Text>
      )}
    </View>
  )
}
