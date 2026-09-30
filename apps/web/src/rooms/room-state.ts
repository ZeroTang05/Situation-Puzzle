/**
 * 房间同步（docs/rebuild/04-ROOM-JEV.md §5）：
 * 快照是权威状态 → WebSocket 订阅 → 事件按 seq 应用（重复忽略、缺口补齐）→
 * 断线重连携带 lastSeq 续传；补不齐（410）就重新拉快照。
 * 写操作统一走 HTTP 命令接口，WebSocket 只负责接收。
 */

import type { RoomEvent } from '@jev/contracts';
import { api } from '../api/client.js';

export interface RoomTurn {
  clientRequestId?: string;
  turnId: string;
  seq: number;
  userId: string;
  nickname: string;
  kind: 'ask' | 'solve';
  text: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  result: string | null;
  confidence?: number | null;
}

export interface RoomMember {
  userId: string;
  nickname: string;
  online: boolean;
  isHost: boolean;
}

export interface RoomRound {
  roundId: string;
  roundNo: number;
  puzzleId: string;
  versionId: string;
  language: 'zh' | 'en';
  title: string;
  surface: string;
  hintsRevealed: number;
  hints: string[];
  status: 'active' | 'solved' | 'revealed' | 'abandoned' | 'aborted';
  answer: string | null;
}

export interface DiscussionMessage {
  clientRequestId?: string;
  seq: number;
  eventId: string;
  userId: string;
  nickname: string;
  text: string;
  at: number;
}

export interface RoomState {
  roomId: string;
  roomStatus: 'waiting' | 'playing' | 'closed';
  hostUserId: string;
  controlVersion: number;
  capacity: number;
  selectedPuzzle: { puzzleId: string; title: string; language: 'zh' | 'en' } | null;
  round: RoomRound | null;
  members: RoomMember[];
  turns: RoomTurn[];
  discussions: DiscussionMessage[];
  lastSeq: number;
  /** 房主发起「再来一题」后的新房入口（10-ROOM-LIFECYCLE-REVISION §一.3） */
  followupTargetRoomId: string | null;
}


export function applyEvent(state: RoomState, event: RoomEvent): RoomState {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'room.puzzle_selected': {
      const selection = (event as RoomEvent<'room.puzzle_selected'>).payload;
      return { ...state, selectedPuzzle: selection };
    }
    case 'room.member_joined':
    case 'room.member_unrestricted': {
      if (state.members.some((m) => m.userId === p.userId)) return state;
      return { ...state, members: [...state.members, { userId: String(p.userId), nickname: String(p.nickname ?? p.userId), online: true, isHost: state.hostUserId === p.userId }] };
    }
    case 'room.member_left': {
      return { ...state, members: state.members.filter((m) => m.userId !== p.userId) };
    }
    case 'room.member_kicked': {
      return { ...state, members: state.members.filter((m) => m.userId !== p.userId) };
    }
    case 'room.host_changed': {
      const userId = String(p.userId);
      return {
        ...state,
        hostUserId: userId,
        members: state.members.map((m) => ({ ...m, isHost: m.userId === userId })),
      };
    }
    case 'round.started': {
      return {
        ...state,
        roomStatus: 'playing',
        round: {
          roundId: String(p.roundId),
          roundNo: Number(p.roundNo),
          puzzleId: String(p.puzzleId),
          versionId: '',
          language: p.language === 'en' ? 'en' : 'zh',
          title: String(p.title),
          surface: String(p.surface),
          hintsRevealed: 0,
          hints: [],
          status: 'active',
          answer: null,
        },
        turns: [],
      };
    }
    case 'round.ended': {
      if (!state.round || state.round.roundId !== event.roundId) return state;
      const status = p.status as RoomRound['status'];
      // 一房一题：局结束即房间归档（closed），历史只读
      return { ...state, roomStatus: 'closed', round: { ...state.round, status } };
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
      };
      if (state.turns.some((t) => t.turnId === turn.turnId)) return state;
      return { ...state, turns: [...state.turns, turn] };
    }
    case 'turn.started':
    case 'turn.completed':
    case 'turn.failed':
    case 'turn.cancelled': {
      const status = event.type === 'turn.started' ? 'processing' : event.type === 'turn.completed' ? 'succeeded' : event.type === 'turn.failed' ? 'failed' : 'cancelled';
      return {
        ...state,
        turns: state.turns.map((t) => (t.turnId === p.turnId ? { ...t, status, result: p.result ? String(p.result) : t.result, ...(typeof p.confidence === 'number' ? { confidence: p.confidence } : {}) } : t)),
      };
    }
    case 'hint.revealed': {
      if (!state.round) return state;
      const hints = state.round.hints.slice();
      const index = Number(p.index);
      while (hints.length <= index) hints.push('');
      hints[index] = String(p.text);
      return { ...state, round: { ...state.round, hints, hintsRevealed: Math.max(state.round.hintsRevealed, index + 1) } };
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
      };
      if (state.discussions.some((d) => d.eventId === message.eventId)) return state;
      return { ...state, discussions: [...state.discussions, message] };
    }
    case 'room.followup_created': {
      // 一房一题：旧房收到新房入口事件（在线成员由此进入）
      return { ...state, followupTargetRoomId: String(p.targetRoomId) };
    }
    case 'room.closed': {
      return { ...state, roomStatus: 'closed' };
    }
    case 'room.invite_rotated': {
      // 邀请令牌刷新后需要房主重新查看邀请链接（通过 HTTP 拉取）
      return state;
    }
    default:
      return state;
  }
}

export async function fetchSnapshot(roomId: string, signal?: AbortSignal): Promise<{ state: RoomState; answer: string | null }> {
  const snap = await api<{
    roomId: string;
    roomStatus: RoomState['roomStatus'];
    hostUserId: string;
    controlVersion: number;
    capacity: number;
    selectedPuzzle: RoomState['selectedPuzzle'];
    round: RoomRound | null;
    members: RoomMember[];
    turns: RoomTurn[];
    discussions: DiscussionMessage[];
    followupTargetRoomId: string | null;
    lastSeq: number;
  }>(`/rooms/${roomId}/snapshot`, { timeoutMs: 10_000, ...(signal ? { signal } : {}) });
  return {
    state: {
      roomId: snap.roomId,
      roomStatus: snap.roomStatus,
      hostUserId: snap.hostUserId,
      controlVersion: snap.controlVersion,
      capacity: snap.capacity,
      selectedPuzzle: snap.selectedPuzzle,
      round: snap.round,
      members: snap.members,
      turns: snap.turns,
      discussions: snap.discussions,
      lastSeq: snap.lastSeq,
      followupTargetRoomId: snap.followupTargetRoomId,
    },
    answer: snap.round?.answer ?? null,
  };
}

