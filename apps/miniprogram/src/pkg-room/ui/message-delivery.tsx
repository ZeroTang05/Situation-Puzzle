/**
 * 消息发送状态（对齐 apps/web/src/rooms/message-delivery.tsx）：
 * 正常发送不加状态文字，只展示明确失败或需要继续确认的异常。
 */
import type { ReactNode } from 'react'
import { Text } from '@tarojs/components'
import { format } from '@jev/i18n'
import { useLanguage } from '../../state/language'
import type { PendingCommand } from '../room/room-local'

export function MessageDelivery({ status, error }: { status: PendingCommand['status']; error?: string }): ReactNode {
  const { copy } = useLanguage()
  if (status === 'sent' || status === 'sending') return null
  return (
    <Text className={status === 'rejected' ? 'error-text' : 'muted'}>
      {status === 'confirming' ? copy.confirming : format(copy.notSent, { n: error ?? '' })}
    </Text>
  )
}
