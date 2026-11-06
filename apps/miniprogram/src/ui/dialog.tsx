/**
 * 深海弹窗（口径对齐 packages/ui/src/dialog.tsx + dialog.css）：
 * DialogHost 挂在 app.tsx 渲染当前弹窗（jev-dialog 同款样式），遮罩点击 = 取消
 * （对齐 web Radix onOpenChange(false) 行为）。小程序没有焦点陷阱与 Escape，
 * 交互上只保留点击选择。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Text, View } from '@tarojs/components'
import { dialogQueue, type DialogRequest } from './dialog-queue'
import { useLanguage } from '../state/language'

/** 所有调用点等待用户明确选择，取消时不执行后续写操作 */
export interface DialogActions {
  confirm: (message: string, title?: string) => Promise<boolean>
}

export function useDialog(): DialogActions {
  return {
    confirm: async (message, title) => (await dialogQueue.ask(message, title)) !== null,
  }
}

/** 应用级弹窗宿主：始终渲染在 app.tsx 里，有请求时盖在最上层 */
export function DialogHost(): ReactNode {
  // 订阅队列变化（useState + subscribe：不依赖 useSyncExternalStore 的类型形态）
  const [request, setRequest] = useState<DialogRequest | null>(() => dialogQueue.current())
  useEffect(
    () =>
      dialogQueue.subscribe(() => {
        setRequest(dialogQueue.current())
      }),
    [],
  )
  const { copy } = useLanguage()
  if (!request) return null
  return (
    <>
      <View className="jev-dialog-overlay" onClick={() => dialogQueue.settle(null)} />
      <View className="jev-dialog">
        <Text className="jev-dialog-title">{request.title ?? copy.confirm}</Text>
        <Text className="jev-dialog-description">{request.message}</Text>
        <View className="jev-dialog-actions">
          <Button className="btn jev-dialog-cancel" onClick={() => dialogQueue.settle(null)}>
            {copy.cancel}
          </Button>
          <Button className="btn jev-dialog-confirm" onClick={() => dialogQueue.settle('confirmed')}>
            {copy.confirm}
          </Button>
        </View>
      </View>
    </>
  )
}

/** 内容弹窗：与 confirm 共用样式，正文由调用方传入（如玩法介绍） */
export function Modal({ open, onClose, title, closeLabel, children }: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel: string
  children: ReactNode
}): ReactNode {
  if (!open) return null
  return (
    <>
      <View className="jev-dialog-overlay" onClick={onClose} />
      <View className="jev-dialog">
        <Text className="jev-dialog-title">{title}</Text>
        <View className="jev-dialog-body">{children}</View>
        <View className="jev-dialog-actions">
          <Button className="btn jev-dialog-cancel" onClick={onClose}>
            {closeLabel}
          </Button>
        </View>
      </View>
    </>
  )
}
