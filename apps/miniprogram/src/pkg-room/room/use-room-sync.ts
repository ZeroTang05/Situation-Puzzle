/**
 * 房间同步（对齐 apps/web/src/rooms/use-room-sync.ts，docs/rebuild/04-ROOM-JEV.md §5）：
 * 快照是权威状态 → WebSocket 订阅 → 事件按 seq 应用（重复忽略、缺口补齐）→
 * 断线重连携带 lastSeq 续传；补不齐（410）就重新拉快照。
 * 写操作统一走 HTTP 命令接口，WebSocket 只负责接收。
 *
 * 小程序差异（运行环境导致，状态机口径与 web 完全一致）：
 * - 浏览器 WebSocket 换成 Taro.connectSocket 的 SocketTask（onOpen/onMessage/onClose/onError/send/close）；
 * - navigator.onLine / window online/offline 换成 Taro.onNetworkStatusChange；
 * - document.visibilitychange 换成页面透传的 wake()（useDidShow）/ pause()（useDidHide+useUnload）：
 *   pause 关闭连接，show 时 wake 重连；
 * - api 客户端没有 signal，过期结果靠代际计数（generationRef）丢弃。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Taro from '@tarojs/taro'
import { wsServerFrameSchema, type RoomEvent, type WsClientFrame } from '@jev/contracts'
import { api, ApiError } from '../../api/client'
import { wsUrl } from '../ws-url'
import { fetchSnapshot, type RoomState } from './room-state'
import { receiveEvent, reconnectDelay } from './reliability'

export type { RoomState, RoomRound } from './room-state'

export type SyncStatus = 'connecting' | 'syncing' | 'ready' | 'reconnecting' | 'offline' | 'auth_required' | 'forbidden'
export interface CommandInput {
  type: string
  roundId?: string
  payload?: Record<string, unknown>
  expectedControlVersion?: number
  clientRequestId: string
}
export interface CommandResult {
  clientRequestId: string
  status: 'accepted' | 'duplicate'
  turnId?: string
  discussionId?: string
  acceptedSeq?: number
  controlVersion: number
  inviteToken?: string
}

export function useRoomSync(roomId: string, userId: string | null) {
  const [state, setState] = useState<RoomState | null>(null)
  const [status, setStatus] = useState<SyncStatus>('connecting')
  const stateRef = useRef<RoomState | null>(null)
  const generationRef = useRef(0)
  // 页面可见性：由页面 useDidShow/useDidHide 经 wake/pause 翻转，驱动 ping 的 visible 与重连时机
  const visibleRef = useRef(true)
  // 网络在线状态：Taro.onNetworkStatusChange 维护（对齐 web 的 navigator.onLine）
  const onlineRef = useRef(true)
  // 页面透传的 show/hide 控制入口（effect 内定义，ref 转出）
  const wakeRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    stateRef.current = null
    setState(null)
    setStatus('connecting')
    visibleRef.current = true
    // 没有 userId（未登录）或 roomId（坏链接的空参数）时不建连接
    if (!userId || !roomId) return
    let disposed = false
    let stopped = false
    let socket: Taro.SocketTask | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let lastReceived = 0
    let lastActivity = 0
    let syncing = false
    const buffering = new Map<number, RoomEvent>()
    const current = (generation: number) => !disposed && !stopped && generationRef.current === generation
    const update = (next: RoomState) => {
      stateRef.current = next
      setState(next)
    }
    const send = (frame: WsClientFrame) => {
      // SocketTask 没有 web WebSocket 的 OPEN 常量，readyState 直接按数字比（1 = OPEN）
      if (socket && socket.readyState === 1) socket.send({ data: JSON.stringify(frame) })
    }

    /** 旧连接的所有回调先失效，再关闭；close 不会触发第二个重试。 */
    const detach = () => {
      generationRef.current++
      clearTimeout(timer)
      clearTimeout(deadline)
      if (socket) {
        socket.close({})
        socket = null
      }
      syncing = false
      buffering.clear()
    }
    const terminal = (next: 'auth_required' | 'forbidden') => {
      stopped = true
      detach()
      setStatus(next)
    }
    const fail = (error?: unknown) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        terminal(error.status === 401 ? 'auth_required' : 'forbidden')
        return
      }
      // 同步失败要留痕（重连循环静默跑会让页面永远停在「加载中」，无法排查）
      console.warn('[room-sync] fail', error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error ?? ''))
      detach()
      if (disposed || stopped) return
      setStatus(onlineRef.current ? 'reconnecting' : 'offline')
      if (onlineRef.current) timer = setTimeout(() => void connect(), reconnectDelay(attempt++, Math.random()))
    }
    const armDeadline = () => {
      clearTimeout(deadline)
      deadline = setTimeout(() => fail(), 10_000)
    }
    const subscribe = () => {
      if (syncing || !stateRef.current) return
      syncing = true
      setStatus('syncing')
      armDeadline()
      send({ type: 'subscribe', roomId, lastSeq: stateRef.current.lastSeq })
    }
    const snapshot = async (generation: number) => {
      syncing = true
      setStatus('syncing')
      armDeadline()
      let { state: next } = await fetchSnapshot(roomId)
      if (!current(generation)) return
      // 老成员重入（v2 §一.6）：曾加入但不在当前成员表（left）→ 自动恢复后重拉快照；
      // 被踢者由 rejoin/snapshot 直接拒绝并落到 forbidden 页。
      if (userId && next.members.every((m) => m.userId !== userId)) {
        await api(`/rooms/${roomId}/rejoin`, { method: 'POST', timeoutMs: 10_000 })
        if (!current(generation)) return
        const rejoined = await fetchSnapshot(roomId)
        if (!current(generation)) return
        next = rejoined.state
      }
      update(next)
      buffering.clear()
      syncing = false
      subscribe()
    }
    const activity = () => {
      send({ type: 'ping', visible: visibleRef.current })
      lastActivity = Date.now()
    }

    async function connect() {
      if (disposed || stopped) return
      detach()
      if (!onlineRef.current) {
        setStatus('offline')
        return
      }
      const generation = generationRef.current
      setStatus(stateRef.current ? 'reconnecting' : 'connecting')
      armDeadline()
      try {
        // 先拿一次性票据（30 秒有效），连上后发 auth 帧
        const { ticket } = await api<{ ticket: string }>('/realtime/tickets', { method: 'POST', timeoutMs: 10_000 })
        if (!current(generation)) return
        const task = await Taro.connectSocket({ url: wsUrl() })
        if (!current(generation)) {
          task.close({})
          return
        }
        socket = task
        lastReceived = Date.now()
        task.onOpen(() => {
          if (current(generation)) send({ type: 'auth', ticket })
        })
        task.onError(() => {
          /* close 统一触发恢复；连接截止时间处理无 close 的链路 */
        })
        task.onClose((event) => {
          if (!current(generation)) return
          if (event.code === 4403) terminal('forbidden')
          else if (event.code === 4401) terminal('auth_required')
          else {
            if (event.code) console.warn('[room-sync] socket close', event.code, event.reason ?? '')
            fail()
          }
        })
        // 同一连接按消息到达顺序处理，快照请求期间也不交叉改写游标。
        let messages = Promise.resolve()
        task.onMessage((raw) => {
          if (!current(generation)) return
          lastReceived = Date.now()
          messages = messages
            .then(async () => {
              if (!current(generation)) return
              const frame = wsServerFrameSchema.parse(JSON.parse(String(raw.data)))
              if (frame.type === 'ack' && frame.userId) {
                if (stateRef.current) subscribe()
                else await snapshot(generation)
                return
              }
              if (frame.type === 'error') {
                if (frame.code === 'FORBIDDEN') terminal('forbidden')
                else if (frame.code === 'UNAUTHORIZED') terminal('auth_required')
                else if (frame.code === 'RESYNC_REQUIRED') await snapshot(generation)
                else fail()
                return
              }
              if (frame.type === 'sync.ready') {
                if (frame.roomId !== roomId) return
                syncing = false
                if (stateRef.current?.lastSeq !== frame.watermark) {
                  console.warn('[room-sync] sync.ready watermark gap', stateRef.current?.lastSeq, frame.watermark)
                  subscribe()
                  return
                }
                clearTimeout(deadline)
                attempt = 0
                setStatus('ready')
                activity()
                return
              }
              if (frame.type === 'heartbeat') {
                const watermark = frame.watermarks.find((w) => w.roomId === roomId)
                if (watermark && stateRef.current && watermark.seq > stateRef.current.lastSeq) subscribe()
                return
              }
              if (!('seq' in frame) || frame.roomId !== roomId || !stateRef.current) return
              const event = frame as RoomEvent
              if (event.seq <= stateRef.current.lastSeq) return
              const next = receiveEvent(stateRef.current, event, buffering)
              if (buffering.size > 1000) {
                await snapshot(generation)
                return
              }
              update(next)
              if (syncing) armDeadline()
              if (buffering.size) subscribe()
            })
            .catch((error: unknown) => {
              if (current(generation)) fail(error)
            })
        })
      } catch (error) {
        if (current(generation)) fail(error)
      }
    }

    const wake = () => {
      if (disposed || stopped || !visibleRef.current) return
      if (socket && socket.readyState === 1 && Date.now() - lastReceived < 45_000) {
        activity()
        subscribe()
      } else {
        attempt = 0
        void connect()
      }
    }
    /** 页面隐藏/卸载：关闭连接（对齐 ask 指定；显示时由 wake 重连） */
    const pause = () => {
      visibleRef.current = false
      detach()
    }
    wakeRef.current = () => {
      visibleRef.current = true
      wake()
    }
    pauseRef.current = pause

    const onNetwork = (res: { isConnected: boolean }) => {
      onlineRef.current = res.isConnected
      if (res.isConnected) wake()
      else {
        detach()
        setStatus('offline')
      }
    }
    const watchdog = setInterval(() => {
      if (stopped || !visibleRef.current) return
      if (socket && socket.readyState === 1 && Date.now() - lastReceived > 45_000) {
        fail()
        return
      }
      if (socket && socket.readyState === 1 && !syncing && Date.now() - lastActivity >= 30_000) activity()
    }, 5_000)
    Taro.onNetworkStatusChange(onNetwork)
    void Taro.getNetworkType()
      .then((res) => {
        onlineRef.current = res.networkType !== 'none'
      })
      .catch(() => undefined)
    void connect()
    return () => {
      disposed = true
      detach()
      clearInterval(watchdog)
      Taro.offNetworkStatusChange(onNetwork)
      wakeRef.current = null
      pauseRef.current = null
    }
  }, [roomId, userId])

  /** 命令查询与首次响应共用版本更新，断线期间的成功控制操作也能推进版本。 */
  const confirmResult = useCallback(
    (result: CommandResult) => {
      if (stateRef.current?.roomId === roomId) {
        const next = { ...stateRef.current, controlVersion: Math.max(stateRef.current.controlVersion, result.controlVersion) }
        stateRef.current = next
        setState(next)
      }
    },
    [roomId],
  )
  const sendCommand = useCallback(
    async (input: CommandInput) => {
      // 所有命令在出网时携带 payload；无参数命令使用空对象。
      const result = await api<CommandResult>(`/rooms/${roomId}/commands`, {
        method: 'POST',
        body: { ...input, payload: input.payload ?? {} },
        timeoutMs: 10_000,
      })
      confirmResult(result)
      return result
    },
    [roomId, confirmResult],
  )

  return {
    state: state?.roomId === roomId ? state : null,
    status,
    kicked: status === 'forbidden',
    sendCommand,
    confirmResult,
    /** 页面 useDidShow 调用：重连（或心跳 + 补齐） */
    wake: () => wakeRef.current?.(),
    /** 页面 useDidHide/useUnload 调用：关闭连接 */
    pause: () => pauseRef.current?.(),
  }
}
