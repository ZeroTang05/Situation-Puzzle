/**
 * 会客厅实时通道（对齐 apps/web/src/rooms/use-lobby-sync.ts）：监听服务端推送的 lobby.started 事件。
 *
 * - 复用 POST /realtime/tickets 票据（30 秒一次性，与房间同步共用）。
 * - 收到 lobby.started 后调用 onStart({ roomId, inviteToken })；调用方负责 redirectTo 房间。
 * - 网络故障 / 鉴权失败静默：轮询快照照常返回，lobby.started 推送丢了由调用方兜底（看 snapshot 状态）。
 * 小程序差异（机制与 room/use-room-sync.ts 同一套）：
 * - 浏览器 WebSocket 换成 Taro.connectSocket 的 SocketTask；断线按 reconnectDelay 指数退避重连；
 * - 页面隐藏/卸载 pause() 关闭连接，显示 wake() 重连（页面 useDidShow/useDidHide/useUnload 接线）。
 */
import { useEffect, useRef } from 'react'
import Taro from '@tarojs/taro'
import { wsServerFrameSchema } from '@jev/contracts'
import { api } from '../../api/client'
import { wsUrl } from '../ws-url'
import { reconnectDelay } from './reliability'

export interface LobbyStartEvent {
  lobbyId: string
  roomId: string
  inviteToken?: string
}

export function useLobbySync(
  lobbyId: string | undefined,
  onStart: (event: LobbyStartEvent) => void,
): { wake: () => void; pause: () => void } {
  const handlerRef = useRef(onStart)
  handlerRef.current = onStart
  // 页面透传的 show/hide 控制入口（effect 内定义，ref 转出，与 use-room-sync 相同）
  const wakeRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!lobbyId) return
    let disposed = false // 页面卸载 / lobbyId 变化：彻底停机
    let paused = false // 页面隐藏：断开连接，显示时重连
    let satisfied = false // 已收到 lobby.started：不再重连（页面即将跳走）
    let socket: Taro.SocketTask | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const send = (frame: unknown) => {
      if (socket && socket.readyState === socket.OPEN) socket.send({ data: JSON.stringify(frame) })
    }
    const clearTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
    }
    const closeSocket = () => {
      if (socket) {
        socket.close({})
        socket = null
      }
    }
    const scheduleRetry = () => {
      if (disposed || paused || satisfied) return
      clearTimer()
      retryTimer = setTimeout(() => void connect(), reconnectDelay(attempt++, Math.random()))
    }

    const connect = async () => {
      if (disposed || paused || satisfied) return
      clearTimer()
      closeSocket()
      try {
        // 先拿一次性票据（30 秒有效），连上后发 auth 帧
        const { ticket } = await api<{ ticket: string }>('/realtime/tickets', { method: 'POST', timeoutMs: 10_000 })
        if (disposed || paused || satisfied) return
        const task = await Taro.connectSocket({ url: wsUrl() })
        if (disposed || paused || satisfied) {
          task.close({})
          return
        }
        socket = task
        task.onOpen(() => {
          if (disposed || paused || satisfied) return
          send({ type: 'auth', ticket })
        })
        task.onMessage((raw) => {
          if (disposed || paused || satisfied) return
          try {
            const frame = wsServerFrameSchema.parse(JSON.parse(String(raw.data)))
            if (frame.type === 'ack' && frame.userId) {
              attempt = 0
              send({ type: 'lobby.subscribe', lobbyId })
              return
            }
            if (frame.type === 'lobby.started' && frame.lobbyId === lobbyId) {
              satisfied = true
              handlerRef.current({
                lobbyId: frame.lobbyId,
                roomId: frame.roomId,
                ...(frame.inviteToken ? { inviteToken: frame.inviteToken } : {}),
              })
              // 开局推送已到手：主动收线，onClose 里的重试由 satisfied 拦住
              closeSocket()
            }
          } catch {
            /* 解析失败忽略，不影响 lobby 页本身的轮询 */
          }
        })
        task.onClose(() => {
          scheduleRetry()
        })
        task.onError(() => {
          /* close 统一触发恢复 */
        })
      } catch {
        scheduleRetry()
      }
    }

    /** 页面显示：从隐藏恢复时重连；连接还活着就补发一次订阅（防丢失订阅） */
    wakeRef.current = () => {
      if (disposed || satisfied) return
      if (paused) {
        paused = false
        attempt = 0
        void connect()
        return
      }
      if (socket && socket.readyState === socket.OPEN) send({ type: 'lobby.subscribe', lobbyId })
      else void connect()
    }
    /** 页面隐藏/卸载：关闭连接（ask 指定；显示时由 wake 重连） */
    pauseRef.current = () => {
      if (disposed) return
      paused = true
      clearTimer()
      closeSocket()
    }

    void connect()
    return () => {
      disposed = true
      clearTimer()
      closeSocket()
      wakeRef.current = null
      pauseRef.current = null
    }
  }, [lobbyId])

  /** 页面 useDidShow 调用：重连（或补发订阅） */
  const wake = () => wakeRef.current?.()
  /** 页面 useDidHide/useUnload 调用：关闭连接 */
  const pause = () => pauseRef.current?.()
  return { wake, pause }
}
