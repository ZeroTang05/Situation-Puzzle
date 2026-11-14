/**
 * 加载动画：三点脉冲 + 可选文案。
 * 页面级加载态（房间/会客厅/邀请/大厅/单人开局）用它替代纯文字，
 * 从 UI 上降低等待的焦躁感；动画样式在 app.css .loading-*。
 */
import type { ReactNode } from 'react'
import { Text, View } from '@tarojs/components'

export function Loading({ text }: { text?: string }): ReactNode {
  return (
    <View className="loading-block">
      <View className="loading-dots">
        <View className="loading-dot loading-dot-a" />
        <View className="loading-dot loading-dot-b" />
        <View className="loading-dot loading-dot-c" />
      </View>
      {text ? <Text className="muted loading-text">{text}</Text> : null}
    </View>
  )
}
