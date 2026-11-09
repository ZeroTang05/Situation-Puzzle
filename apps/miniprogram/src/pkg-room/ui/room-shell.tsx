/**
 * 房间页容器（对齐 apps/web/src/rooms/room-shell.tsx）：
 * 游玩中固定屏幕高度（题面与对话各自滚动、输入区常驻）；等待结算态自然滚动，
 * 完整展示管理与答案。布局细节由 room.css 的 .room-shell/.room-playing 承担。
 */
import type { ReactNode } from 'react'
import { View } from '@tarojs/components'

export function RoomShell({ playing, children }: { playing: boolean; children: ReactNode }): ReactNode {
  return <View className={`page room-shell${playing ? ' page-full room-playing' : ''}`}>{children}</View>
}
