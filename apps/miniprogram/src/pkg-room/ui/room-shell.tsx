/**
 * 房间页容器（对齐 apps/web/src/rooms/room-shell.tsx）：
 * 游玩中固定屏幕高度（题面与对话各自滚动、输入区常驻）；等待结算态自然滚动，
 * 完整展示管理与答案。布局细节由 room.css 的 .room-shell/.room-playing 承担。
 * kbHeight：软键盘高度（px）。键盘弹出不靠微信默认的整体上推（Textarea adjustPosition=false），
 * 而是把可用高度压掉键盘那一截——flex 列里对话区自然收缩，输入行保持在键盘上方。
 */
import type { CSSProperties, ReactNode } from 'react'
import { View } from '@tarojs/components'

export function RoomShell({ playing, kbHeight = 0, children }: { playing: boolean; kbHeight?: number; children: ReactNode }): ReactNode {
  const style: CSSProperties | undefined = playing && kbHeight > 0 ? { height: `calc(100vh - ${kbHeight}px)` } : undefined
  return (
    <View className={`page room-shell${playing ? ' page-full room-playing' : ''}`} {...(style ? { style } : {})}>
      {children}
    </View>
  )
}
