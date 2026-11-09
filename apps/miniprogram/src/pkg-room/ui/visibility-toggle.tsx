/**
 * 公开 / 私人开关（对齐 apps/web/src/rooms/visibility-toggle.tsx，docs/rebuild/18-HALL-PUBLIC-ROOMS.md）。
 * 等待室与房间内共用一个拨杆：外观一致，语义一致（都是「这局要不要进大厅」）。
 * 小程序差异：checkbox 换自绘拨杆（复用 app.css 的 lm-switch 尺寸与配色）。
 */
import type { ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import { useLanguage } from '../../state/language'

export function VisibilityToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): ReactNode {
  const { copy } = useLanguage()
  return (
    <View
      className="visibility-toggle"
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
    >
      <View className={`lm-switch${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}`}>
        <View className="lm-knob" />
      </View>
      <Text>{copy.visibilityToggle}</Text>
    </View>
  )
}
