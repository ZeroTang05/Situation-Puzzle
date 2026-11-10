/**
 * 多人草稿与待确认请求（对齐 apps/web/src/rooms/room-local.ts）：
 * 按账号和房间隔离，退出登录清理；使用 TapTap 原生同步存储。
 */
import type { CommandInput, CommandResult } from './use-room-sync'

export type InputMode = 'ask' | 'solve' | 'discussion'

export interface PendingCommand {
  input: CommandInput
  status: 'sending' | 'confirming' | 'sent' | 'rejected'
  error?: string
  result?: CommandResult
  /** 网络不确定时至多自动重投一次，重进后仍保留该计数。 */
  retries: number
}

export interface RoomLocal {
  key: string
  userId: string
  drafts: Record<InputMode, string>
  pending: PendingCommand[]
  tab: 'qa' | 'discuss'
  mode: InputMode
}

const STORAGE_PREFIX = 'jev.room-local.'

function storageKey(userId: string, roomId: string): string {
  return `${STORAGE_PREFIX}${userId}:${roomId}`
}

/** 读取本地草稿与发件状态；没有存档时给空记录 */
export async function loadRoomLocal(userId: string, roomId: string): Promise<RoomLocal> {
  const key = storageKey(userId, roomId)
  const saved = tap.getStorageSync(key) as RoomLocal | string
  if (saved && typeof saved === 'object') return { ...saved, key }
  return { key, userId, drafts: { ask: '', solve: '', discussion: '' }, pending: [], tab: 'qa', mode: 'ask' }
}

/** 写回本地记录（tap.setStorageSync 同步落盘，保持 async 签名与 web 一致） */
export async function saveRoomLocal(value: RoomLocal): Promise<void> {
  tap.setStorageSync(value.key, value)
}

/** 退出登录时清掉该账号全部房间的本地记录（对齐 web clearRoomLocal 的按 user 索引清理） */
export async function clearRoomLocal(userId: string): Promise<void> {
  const info = tap.getStorageInfoSync()
  const prefix = `${STORAGE_PREFIX}${userId}:`
  for (const key of info.keys) {
    if (key.startsWith(prefix)) tap.removeStorageSync(key)
  }
}

export { newRequestId } from '../ids.js'
