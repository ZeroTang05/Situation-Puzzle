/**
 * 弹窗队列（口径对齐 packages/ui/src/dialog-queue.ts）：
 * 一次只显示一个弹窗，ask 返回 Promise，settle 兑现结果后弹下一个。
 * 小程序没有 DOM 焦点管理，队列只负责状态与承诺兑现。
 */
export interface DialogRequest {
  id: number
  message: string
  title?: string
}

type Listener = () => void
type Settle = (value: 'confirmed' | null) => void

export class DialogQueue {
  private req: DialogRequest | null = null
  private settleFn: Settle | null = null
  private listeners = new Set<Listener>()

  current = (): DialogRequest | null => this.req

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }

  /** 请求一个确认弹窗；null = 取消，'confirmed' = 确认 */
  ask(message: string, title?: string): Promise<'confirmed' | null> {
    return new Promise<'confirmed' | null>((resolve) => {
      this.req = { id: Date.now(), message, ...(title !== undefined ? { title } : {}) }
      this.settleFn = resolve
      this.emit()
    })
  }

  settle(value: 'confirmed' | null): void {
    const settle = this.settleFn
    this.req = null
    this.settleFn = null
    settle?.(value)
    this.emit()
  }
}

/** 应用级单例：DialogHost 渲染它，useDialog 调用它 */
export const dialogQueue = new DialogQueue()
