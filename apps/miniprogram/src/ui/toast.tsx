/**
 * 悬浮反馈条（口径对齐 apps/web/src/toast.tsx）：
 * 浮在页面最上层顶部居中，不占布局，短时间后自动消失。
 */
import { useEffect, type ReactNode } from 'react'
import { Text } from '@tarojs/components'

export function Toast({ message, tone = 'info', durationMs = 2000, onDone }: {
  message: string
  tone?: 'info' | 'error'
  durationMs?: number
  onDone?: () => void
}): ReactNode {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => onDone?.(), durationMs)
    return () => clearTimeout(timer)
  }, [message, durationMs, onDone])

  if (!message) return null
  return <Text className={`toast${tone === 'error' ? ' toast-error' : ''}`}>{message}</Text>
}
