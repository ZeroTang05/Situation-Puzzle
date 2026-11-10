/**
 * 房间状态与快照（逐行对齐 apps/web/src/rooms/room-state.ts，docs/rebuild/04-ROOM-JEV.md §5）：
 * applyEvent 把服务端事件按类型合并进权威快照；fetchSnapshot 拉一次全量。
 * 纯逻辑无环境依赖，与 web 版本唯一的差异是请求没有 signal 参数
 * （小程序请求不可取消，过期结果由调用方用代际计数丢弃）。
 */
import type { RoomEvent } from '@jev/contracts'
import { api } from '../api.js'

export interface RoomTurn {
  clientRequestId?: string
  turnId: string
  seq: number
  userId: string
  nickname: string
  kind: 'ask' | 'solve'
  text: string
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled'
  result: string | null
  /** 判定来源：ai = Jev；host = 用户主持人 */
  source?: 'ai' | 'host' | null
  confidence?: number | null
}

export interface RoomMember {
  userId: string
  nickname: string
  online: boolean
  isHost: boolean
  /** 用户主持人（17-USER-HOST-MODE）：与 isHost（房主）是两回事 */
  isUserHost: boolean
}

export interface RoomRound {
  roundId: string
  roundNo: number
  puzzleId: string
  versionId: string
  language: 'zh' | 'en'
  title: string
  surface: string
  /** 类别与难度标签：题库题携带，创作题为 null */
  category: 'honkaku' | 'henkaku' | null
  difficulty: 'easy' | 'medium' | 'hard' | null
  hintsRevealed: number
  hints: string[]
  status: 'active' | 'solved' | 'revealed' | 'abandoned' | 'aborted'
  answer: string | null
}

export interface DiscussionMessage {
  clientRequestId?: string
  seq: number
  eventId: string
  userId: string
  nickname: string
  text: string
  at: number
}

export interface RoomState {
  roomId: string
  /** v2：房间自创建即 playing（等待室不入库），closed 为归档终态 */
  roomStatus: 'playing' | 'closed'
  hostUserId: string
  controlVersion: number
  capacity: number
  /** 公开房间：true 时出现在大厅并允许直接加入（18-HALL-PUBLIC-ROOMS） */
  isPublic: boolean
  /** 主持人形态：ai = Jev 主持；user = 用户主持（17-USER-HOST-MODE） */
  hostMode: 'ai' | 'user'
  /** 当前用户主持人（null = 无） */
  userHostId: string | null
  /** 待房主审核的主持人申请 */
  hostRequests: Array<{ userId: string; nickname: string }>
  round: RoomRound | null
  members: RoomMember[]
  turns: RoomTurn[]
  discussions: DiscussionMessage[]
  lastSeq: number
  /** 房主发起「再来一题」后的新房入口（10-ROOM-LIFECYCLE-REVISION §一.7） */
  followupTargetRoomId: string | null
}

/** 服务端事件 → 权威快照（与 web 版逐 case 相同） */
export function applyEvent(state: RoomState, event: RoomEvent): RoomState {
  const p = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'room.member_joined':
    case 'room.member_unrestricted': {
      if (state.members.some((m) => m.userId === p.userId)) return state
      return {
        ...state,
        members: [...state.members, { userId: String(p.userId), nickname: String(p.nickname ?? p.userId), online: true, isHost: state.hostUserId === p.userId, isUserHost: state.userHostId === p.userId }],
      }
    }
    case 'room.member_left': {
      return { ...state, members: state.members.filter((m) => m.userId !== p.userId) }
    }
    case 'room.member_kicked': {
      return { ...state, members: state.members.filter((m) => m.userId !== p.userId) }
    }
    case 'room.host_changed': {
      const userId = String(p.userId)
      return {
        ...state,
        hostUserId: userId,
        members: state.members.map((m) => ({ ...m, isHost: m.userId === userId })),
      }
    }
    case 'round.started': {
      return {
        ...state,
        roomStatus: 'playing' as const,
        round: {
          roundId: String(p.roundId),
          roundNo: Number(p.roundNo),
          puzzleId: String(p.puzzleId),
          versionId: '',
          language: p.language === 'en' ? 'en' : 'zh',
          title: String(p.title),
          surface: String(p.surface),
          category: (p.category as RoomRound['category']) ?? null,
          difficulty: (p.difficulty as RoomRound['difficulty']) ?? null,
          hintsRevealed: 0,
          hints: [],
          status: 'active',
          answer: null,
        },
        turns: [],
      }
    }
    case 'round.ended': {
      if (!state.round || state.round.roundId !== event.roundId) return state
      const status = p.status as RoomRound['status']
      // 一房一题：局结束即房间归档（closed），历史只读
      return { ...state, roomStatus: 'closed', round: { ...state.round, status } }
    }
    case 'turn.accepted': {
      const turn: RoomTurn = {
        ...(typeof p.clientRequestId === 'string' ? { clientRequestId: p.clientRequestId } : {}),
        turnId: String(p.turnId),
        seq: event.seq,
        userId: String(p.userId),
        nickname: String(p.nickname),
        kind: p.kind === 'solve' ? 'solve' : 'ask',
        text: String(p.text),
        status: 'queued',
        result: null,
      }
      if (state.turns.some((t) => t.turnId === turn.turnId)) return state
      return { ...state, turns: [...state.turns, turn] }
    }
    case 'turn.started':
    case 'turn.completed':
    case 'turn.failed':
    case 'turn.cancelled': {
      const status = event.type === 'turn.started' ? 'processing' : event.type === 'turn.completed' ? 'succeeded' : event.type === 'turn.failed' ? 'failed' : 'cancelled'
      return {
        ...state,
        turns: state.turns.map((t) => (t.turnId === p.turnId
          ? {
              ...t,
              status,
              result: p.result ? String(p.result) : t.result,
              ...(typeof p.confidence === 'number' ? { confidence: p.confidence } : {}),
              ...(p.source === 'host' || p.source === 'ai' ? { source: p.source } : {}),
            }
          : t)),
      }
    }
    case 'hint.revealed': {
      if (!state.round) return state
      const hints = state.round.hints.slice()
      const index = Number(p.index)
      while (hints.length <= index) hints.push('')
      hints[index] = String(p.text)
      return { ...state, round: { ...state.round, hints, hintsRevealed: Math.max(state.round.hintsRevealed, index + 1) } }
    }
    case 'discussion.created': {
      const message: DiscussionMessage = {
        ...(typeof p.clientRequestId === 'string' ? { clientRequestId: p.clientRequestId } : {}),
        seq: event.seq,
        eventId: event.eventId,
        userId: String(p.userId),
        nickname: String(p.nickname),
        text: String(p.text),
        at: Date.parse(event.occurredAt),
      }
      if (state.discussions.some((d) => d.eventId === message.eventId)) return state
      return { ...state, discussions: [...state.discussions, message] }
    }
    case 'room.followup_created': {
      // 一房一题：旧房收到新房入口事件（在线成员由此进入）
      return { ...state, followupTargetRoomId: String(p.targetRoomId) }
    }
    case 'room.closed': {
      return { ...state, roomStatus: 'closed' }
    }
    case 'room.invite_rotated': {
      // 邀请令牌刷新后需要房主重新查看邀请链接（通过 HTTP 拉取）
      return state
    }
    case 'room.visibility_changed': {
      // 房主切换了公开 / 私人：大厅列表随之增减，房间内所有人同步看到
      return { ...state, isPublic: p.isPublic === true }
    }
    // ---------- 用户主持人（17-USER-HOST-MODE） ----------
    case 'room.host_requested': {
      const userId = String(p.userId)
      if (state.hostRequests.some((r) => r.userId === userId)) return state
      return {
        ...state,
        hostRequests: [...state.hostRequests, { userId, nickname: String(p.nickname ?? userId) }],
      }
    }
    case 'room.host_approved': {
      const userId = String(p.userId)
      const previousUserId = typeof p.previousUserId === 'string' ? p.previousUserId : null
      return {
        ...state,
        hostMode: 'user',
        userHostId: userId,
        hostRequests: state.hostRequests.filter((r) => r.userId !== userId),
        members: state.members.map((m) => {
          if (m.userId === userId) return { ...m, isUserHost: true }
          if (previousUserId !== null && m.userId === previousUserId) return { ...m, isUserHost: false }
          return m
        }),
      }
    }
    case 'room.host_rejected': {
      const userId = String(p.userId)
      return { ...state, hostRequests: state.hostRequests.filter((r) => r.userId !== userId) }
    }
    case 'room.host_resigned': {
      const userId = String(p.userId)
      return {
        ...state,
        hostMode: 'ai',
        userHostId: null,
        hostRequests: state.hostRequests.filter((r) => r.userId !== userId),
        members: state.members.map((m) => (m.userId === userId ? { ...m, isUserHost: false } : m)),
      }
    }
    default:
      return state
  }
}

/** 拉一次房间快照（对齐 web fetchSnapshot；无 signal，调用方用代际计数丢弃过期结果） */
export async function fetchSnapshot(roomId: string): Promise<{ state: RoomState; answer: string | null }> {
  const snap = await api<{
    roomId: string
    roomStatus: RoomState['roomStatus']
    hostUserId: string
    controlVersion: number
    capacity: number
    isPublic: boolean
    hostMode: RoomState['hostMode']
    userHostId: string | null
    hostRequests: Array<{ userId: string; nickname: string }>
    round: RoomRound | null
    members: RoomMember[]
    turns: RoomTurn[]
    discussions: DiscussionMessage[]
    followupTargetRoomId: string | null
    lastSeq: number
  }>(`/rooms/${roomId}/snapshot`, { timeoutMs: 10_000 })
  return {
    state: {
      roomId: snap.roomId,
      roomStatus: snap.roomStatus,
      hostUserId: snap.hostUserId,
      controlVersion: snap.controlVersion,
      capacity: snap.capacity,
      isPublic: snap.isPublic === true,
      hostMode: snap.hostMode,
      userHostId: snap.userHostId,
      hostRequests: snap.hostRequests ?? [],
      round: snap.round,
      members: snap.members,
      turns: snap.turns,
      discussions: snap.discussions,
      lastSeq: snap.lastSeq,
      followupTargetRoomId: snap.followupTargetRoomId,
    },
    answer: snap.round?.answer ?? null,
  }
}
