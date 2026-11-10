/**
 * 会客厅实时通道（对齐 apps/web/src/rooms/use-lobby-sync.ts）：监听服务端推送的 lobby.started 事件。
 *
 * - 复用 POST /realtime/tickets 票据（30 秒一次性，与房间同步共用）。
 * - 收到 lobby.started 后调用 onStart({ roomId, inviteToken })；调用方负责 redirectTo 房间。
 * - 连接故障记录日志并重试，快照轮询继续展示当前会客厅。
 * TapTap 宿主适配：
 * - 浏览器 WebSocket 换成 tap.connectSocket 的 SocketTask；断线按 reconnectDelay 指数退避重连；
 * - 进入后台关闭连接，返回前台重连。
 */
import { useEffect, useRef } from 'react'
import { wsServerFrameSchema } from '@jev/contracts'
import { api } from '../api.js'
import { wsUrl } from './ws-url.js'
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
    let socket: TapSocket | null = null
    let socketOpen = false
    let authenticated = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let generation = 0
    const send = (frame: unknown) => {
      if (!socket || !socketOpen) throw new Error('会客厅连接尚未打开')
      const revision = generation
      socket.send({ data: JSON.stringify(frame), fail: (error) => {
        if (disposed || paused || satisfied || revision !== generation) return
        console.error('[taptap:lobby-sync] 发送失败', error.errMsg)
        closeSocket()
        scheduleRetry()
      } })
    }
    const clearTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
    }
    const closeSocket = () => {
      generation++
      socketOpen = false
      authenticated = false
      clearTimeout(deadline)
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
      const revision = generation
      const current = () => !disposed && !paused && !satisfied && revision === generation
      try {
        // 先拿一次性票据（30 秒有效），连上后发 auth 帧
        const { ticket } = await api<{ ticket: string }>('/realtime/tickets', { method: 'POST', timeoutMs: 10_000 })
        if (!current()) return
        const task = tap.connectSocket({ url: wsUrl(), timeout: 10_000 })
        if (!current()) {
          task.close({})
          return
        }
        socket = task
        deadline = setTimeout(() => {
          if (!current()) return
          console.error('[taptap:lobby-sync] 连接或认证超时')
          closeSocket()
          scheduleRetry()
        }, 10_000)
        task.onOpen(() => {
          if (!current()) return
          socketOpen = true
          send({ type: 'auth', ticket })
        })
        task.onMessage((raw) => {
          if (!current()) return
          try {
            const frame = wsServerFrameSchema.parse(JSON.parse(String(raw.data)))
            if (frame.type === 'ack' && frame.userId) {
              authenticated = true
              clearTimeout(deadline)
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
          } catch (error) {
            console.error('[taptap:lobby-sync] 推送无效', error)
            closeSocket()
            scheduleRetry()
          }
        })
        task.onClose(() => {
          if (!current()) return
          closeSocket()
          scheduleRetry()
        })
        task.onError((error) => {
          if (!current()) return
          console.error('[taptap:lobby-sync] 连接失败', error.errMsg)
          closeSocket()
          scheduleRetry()
        })
      } catch (error) {
        if (current()) {
          console.error('[taptap:lobby-sync] 订阅失败', error)
          scheduleRetry()
        }
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
      if (socket && !authenticated) return
      if (socketOpen && authenticated) send({ type: 'lobby.subscribe', lobbyId })
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

    /** 返回前台时重连或补发订阅。 */
  const wake = () => wakeRef.current?.()
    /** 进入后台时关闭连接。 */
  const pause = () => pauseRef.current?.()
  return { wake, pause }
}
